-- ============================================================
-- Dead man's switch: Render standby の代替（設計判断 2026-07-19）
-- pg_cron が5分ごとに heartbeat の鮮度を確認し、10分以上更新が
-- なければ pg_net で直接 Telegram に通知する。
-- Bot Token / Chat ID は Supabase Vault に保存（このファイルには含めない）:
--   select vault.create_secret('<token>', 'telegram_bot_token');
--   select vault.create_secret('<chat_id>', 'telegram_chat_id');
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

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

  -- 10分以内にheartbeatがあれば正常
  if v_last_seen is not null and v_last_seen > now() - interval '10 minutes' then
    return;
  end if;

  -- 再通知は30分間隔
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
      '🚨 DEAD MAN SWITCH 発動' || E'\n\n' ||
      'monitor workerのheartbeatが10分以上更新されていません。' || E'\n' ||
      '最終確認: ' || coalesce(v_last_seen::text, 'なし') || E'\n\n' ||
      'VPS (162.43.29.102) とコンテナの状態を確認してください。' || E'\n' ||
      '手順: docs/operations.md'
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

-- 5分ごとに実行（既存ジョブがあれば置き換え）
select cron.unschedule('deadman-check')
  where exists (select 1 from cron.job where jobname = 'deadman-check');
select cron.schedule('deadman-check', '*/5 * * * *', 'select arb.deadman_check()');
