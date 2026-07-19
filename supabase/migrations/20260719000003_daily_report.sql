-- ============================================================
-- 日次レポート + dead man's switch 文面改善（2026-07-19 仁さん指示:
-- 通知は監視モニターとして日本語で分かりやすく）
-- 毎朝 09:05 JST (00:05 UTC) に前日の測定サマリーをTelegramチャンネルへ配信。
-- ============================================================

create or replace function arb.deadman_check()
returns void
language plpgsql
security definer
set search_path = arb, public
as $$
declare
  v_last_seen timestamptz;
  v_last_fired timestamptz;
  v_token text;
  v_chat text;
begin
  select max(last_seen_at) into v_last_seen from arb.worker_heartbeats;

  if v_last_seen is not null and v_last_seen > now() - interval '10 minutes' then
    return;
  end if;

  select (value->>'at')::timestamptz into v_last_fired
    from arb.system_config where key = 'deadman_last_fired';
  if v_last_fired is not null and v_last_fired > now() - interval '30 minutes' then
    return;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat
    from vault.decrypted_secrets where name = 'telegram_chat_id';
  if v_token is null or v_chat is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_build_object(
      'chat_id', v_chat,
      'text',
      '🚨 警報: 監視システムが応答していません' || E'\n\n' ||
      '監視プログラムからの生存報告が10分以上途絶えています。' ||
      'サーバー自体が停止している可能性があります。' || E'\n\n' ||
      '最後の生存報告: ' || coalesce(to_char(v_last_seen at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') || ' JST', 'なし') || E'\n\n' ||
      'この警報はデータベース側の見張り番（dead man''s switch）から送信されています。' ||
      '復旧するまで測定データに空白が生じます。管理者はVPSの状態を確認してください。'
    )
  );

  insert into arb.alerts (channel, severity, dedupe_key, payload, delivery_status)
  values ('telegram', 'SYSTEM', 'system:deadman',
          jsonb_build_object('last_seen', v_last_seen), 'SENT');

  insert into arb.system_config (key, value, is_secret)
  values ('deadman_last_fired', jsonb_build_object('at', now()), false)
  on conflict (key) do update
    set value = jsonb_build_object('at', now()), updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- 日次レポート（デフォルト: 前日UTC1日分。引数指定で任意期間）
-- ------------------------------------------------------------
create or replace function arb.daily_report(
  p_start timestamptz default null,
  p_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = arb, public
as $$
declare
  d_start timestamptz := coalesce(p_start, date_trunc('day', now()) - interval '1 day');
  d_end timestamptz := coalesce(p_end, date_trunc('day', now()));
  v_blocks bigint;
  v_quotes bigint;
  v_ok bigint;
  v_best numeric;
  v_profitable bigint;
  v_execdiv bigint;
  v_gross bigint;
  v_hours numeric;
  v_coverage numeric;
  v_token text;
  v_chat text;
  v_text text;
  v_closing text;
begin
  select count(distinct block_number) into v_blocks
    from arb.block_observations
    where created_at >= d_start and created_at < d_end and not orphaned;
  select count(*), count(*) filter (where success) into v_quotes, v_ok
    from arb.quotes where created_at >= d_start and created_at < d_end;
  select max((amount_out_usd - amount_in_usd) / nullif(amount_in_usd, 0) * 100)
    into v_best
    from arb.quotes
    where success and amount_out_usd is not null
      and created_at >= d_start and created_at < d_end;
  select count(*) filter (where status = 'NET_PROFITABLE'),
         count(*) filter (where status = 'EXECUTABLE_DIVERGENCE'),
         count(*) filter (where status = 'GROSS_PROFITABLE')
    into v_profitable, v_execdiv, v_gross
    from arb.opportunities
    where created_at >= d_start and created_at < d_end;

  v_hours := extract(epoch from (d_end - d_start)) / 3600;
  -- Ethereumは約12秒/ブロック ≈ 300ブロック/時
  v_coverage := round(least(v_blocks * 100.0 / nullif(v_hours * 300, 0), 100), 1);

  if v_profitable > 0 then
    v_closing := '🟢 全コスト込みでも利益が残る「本物の機会」が ' || v_profitable ||
      ' 回観測されました。これは重要な記録です。';
  elsif v_execdiv > 0 or v_gross > 0 then
    v_closing := '一瞬プラスになる場面はありましたが、ガス代を差し引くと利益は残りませんでした。' ||
      '「表示上の差」と「実際の利益」の違いがよく分かる1日でした。';
  else
    v_closing := 'この日も「全コスト込みで儲かる瞬間」は一度も観測されませんでした。' ||
      '高利回りを謳う案件の主張とは対照的な実測データが、また1日分積み上がりました。';
  end if;

  v_text :=
    '📊 pax 日次レポート（' || to_char(d_start, 'YYYY-MM-DD') || ' UTC）' || E'\n\n' ||
    '昨日1日、機械が休まず測り続けた結果です。' || E'\n\n' ||
    '・監視したブロック: ' || to_char(v_blocks, 'FM999,999,999') ||
      ' 個（カバー率 約' || coalesce(v_coverage::text, '0') || '%）' || E'\n' ||
    '・DEXへの実測見積もり: ' || to_char(v_quotes, 'FM999,999,999') || ' 回' ||
      case when v_quotes > 0
        then '（成功率 ' || round(v_ok * 100.0 / v_quotes, 1) || '%）'
        else '' end || E'\n' ||
    '・最も良かった往復結果: ' ||
      coalesce(case when v_best >= 0 then '+' else '' end || round(v_best, 3)::text || '%', '計測なし') || E'\n' ||
    '・🟢 純利益機会: ' || v_profitable || ' 回' || E'\n' ||
    '・🟠 実行可能プラス: ' || v_execdiv || ' 回' || E'\n\n' ||
    v_closing;

  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat
    from vault.decrypted_secrets where name = 'telegram_chat_id';
  if v_token is null or v_chat is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_build_object('chat_id', v_chat, 'text', v_text)
  );

  insert into arb.alerts (channel, severity, dedupe_key, payload, delivery_status)
  values ('telegram', 'SYSTEM', 'system:daily-report:' || to_char(d_start, 'YYYY-MM-DD'),
          jsonb_build_object('blocks', v_blocks, 'quotes', v_quotes,
                             'profitable', v_profitable), 'SENT');
end;
$$;

-- 毎日 00:05 UTC = 09:05 JST
select cron.unschedule('daily-report')
  where exists (select 1 from cron.job where jobname = 'daily-report');
select cron.schedule('daily-report', '5 0 * * *', 'select arb.daily_report()');
