-- ============================================================
-- pax: PAXG/XAUT Arbitrage Monitor
-- Migration 0001: arb schema (spec section 11)
-- 10 tables + indexes + RLS + grants
-- ============================================================

create schema if not exists arb;

-- ------------------------------------------------------------
-- assets: 監視対象トークン（起動時オンチェーン検証の結果を保持）
-- ------------------------------------------------------------
create table arb.assets (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null,
  symbol text not null,
  address text not null,
  decimals integer not null,
  is_gold_token boolean not null default false,
  is_quote_asset boolean not null default false,
  onchain_symbol text,
  onchain_decimals integer,
  verified_onchain_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, address)
);

-- ------------------------------------------------------------
-- pools: 発見済みDEXプール（allowlist管理）
-- ------------------------------------------------------------
create table arb.pools (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null,
  dex text not null,
  address text not null,
  token0 text not null,
  token1 text not null,
  fee_tier_bps integer,
  is_allowed boolean not null default false,
  tvl_usd numeric,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (chain_id, dex, address)
);

-- ------------------------------------------------------------
-- block_observations: ブロックごとの観測（reorg検出用にhash保持）
-- ------------------------------------------------------------
create table arb.block_observations (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  block_number bigint not null,
  block_hash text not null,
  block_timestamp timestamptz not null,
  base_fee_per_gas numeric,
  priority_fee_per_gas numeric,
  eth_usd numeric,
  rpc_provider text not null,
  rpc_latency_ms integer,
  orphaned boolean not null default false,
  created_at timestamptz not null default now(),
  unique (chain_id, block_number, block_hash)
);

create index idx_block_observations_number
  on arb.block_observations (chain_id, block_number desc);

-- ------------------------------------------------------------
-- quotes: 失敗も含む全Quote（成功データだけ保存するのは禁止 — spec §27）
-- ------------------------------------------------------------
create table arb.quotes (
  id uuid primary key default gen_random_uuid(),
  observation_id bigint references arb.block_observations(id),
  route_hash text not null,
  dex text not null,
  route jsonb not null,
  amount_in_raw numeric not null,
  amount_out_raw numeric,
  amount_in_usd numeric,
  amount_out_usd numeric,
  fee_usd numeric,
  price_impact_bps integer,
  estimated_gas_units numeric,
  quote_latency_ms integer,
  success boolean not null,
  error_code text,
  created_at timestamptz not null default now()
);

create index idx_quotes_route_created
  on arb.quotes (route_hash, created_at desc);
create index idx_quotes_observation
  on arb.quotes (observation_id);
create index idx_quotes_failed
  on arb.quotes (created_at desc) where success = false;

-- ------------------------------------------------------------
-- opportunities: 機会評価結果（不成立も削除しない — spec §27）
-- ------------------------------------------------------------
create table arb.opportunities (
  id uuid primary key default gen_random_uuid(),
  observation_id bigint references arb.block_observations(id),
  route_hash text not null,
  route jsonb not null,
  input_asset text not null,
  amount_in_usd numeric not null,
  amount_out_usd numeric,
  reference_divergence_pct numeric,
  executable_divergence_pct numeric,
  gross_profit_usd numeric,
  gas_cost_low_usd numeric,
  gas_cost_expected_usd numeric,
  gas_cost_high_usd numeric,
  safety_buffer_usd numeric,
  net_profit_usd numeric,
  net_profit_pct numeric,
  max_price_impact_bps integer,
  status text not null,
  rejection_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint chk_opportunity_status check (status in (
    'REFERENCE_ONLY',
    'EXECUTABLE_DIVERGENCE',
    'GROSS_PROFITABLE',
    'NET_PROFITABLE',
    'PAPER_TRADE_CANDIDATE',
    'REJECTED'
  ))
);

create index idx_opportunities_status_created
  on arb.opportunities (status, created_at desc);
create index idx_opportunities_route
  on arb.opportunities (route_hash, created_at desc);
create index idx_opportunities_net_profit
  on arb.opportunities (net_profit_usd desc nulls last);
create index idx_opportunities_observation
  on arb.opportunities (observation_id);

-- ------------------------------------------------------------
-- alerts: Telegram通知履歴（失敗・再送も記録）
-- ------------------------------------------------------------
create table arb.alerts (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references arb.opportunities(id),
  channel text not null,
  severity text not null,
  dedupe_key text not null,
  payload jsonb not null,
  sent_at timestamptz,
  delivery_status text not null,
  provider_response jsonb,
  retry_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint chk_alert_severity check (severity in (
    'INFO', 'OPPORTUNITY', 'PROFITABLE', 'SYSTEM'
  )),
  constraint chk_alert_delivery check (delivery_status in (
    'PENDING', 'SENT', 'FAILED', 'RETRYING'
  ))
);

create index idx_alerts_dedupe
  on arb.alerts (dedupe_key, created_at desc);
create index idx_alerts_severity_created
  on arb.alerts (severity, created_at desc);

-- ------------------------------------------------------------
-- worker_heartbeats: 死活監視（Standby昇格判定の根拠）
-- ------------------------------------------------------------
create table arb.worker_heartbeats (
  worker_id text primary key,
  role text not null,
  hostname text,
  version text,
  status text not null,
  last_block_number bigint,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

-- ------------------------------------------------------------
-- worker_leases: 主系リース（epoch fencing tokenで二重Active防止）
-- ------------------------------------------------------------
create table arb.worker_leases (
  lease_name text primary key,
  holder_id text not null,
  lease_until timestamptz not null,
  epoch bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- system_config: 実行時設定（管理画面から変更、変更は監査ログ必須）
-- ------------------------------------------------------------
create table arb.system_config (
  key text primary key,
  value jsonb not null,
  is_secret boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- audit_logs: 監査ログ
-- ------------------------------------------------------------
create table arb.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_type text not null,
  action text not null,
  target_type text,
  target_id text,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index idx_audit_logs_created
  on arb.audit_logs (created_at desc);

-- ============================================================
-- lease取得/更新の原子的操作（Standby昇格用 — spec §14, §22）
-- ============================================================
create or replace function arb.acquire_lease(
  p_lease_name text,
  p_holder_id text,
  p_ttl_seconds integer
) returns table (acquired boolean, current_holder text, current_epoch bigint)
language plpgsql
security definer
set search_path = arb
as $$
begin
  -- 期限切れ or 自分保持なら取得/更新。他者の有効リースなら失敗
  return query
  with upsert as (
    insert into arb.worker_leases as wl (lease_name, holder_id, lease_until, epoch)
    values (p_lease_name, p_holder_id, now() + make_interval(secs => p_ttl_seconds), 1)
    on conflict (lease_name) do update
      set holder_id = p_holder_id,
          lease_until = now() + make_interval(secs => p_ttl_seconds),
          -- 保持者交代時のみepochを進める（fencing token）
          epoch = case
            when wl.holder_id = p_holder_id then wl.epoch
            else wl.epoch + 1
          end,
          updated_at = now()
      where wl.holder_id = p_holder_id or wl.lease_until < now()
    returning wl.holder_id, wl.epoch
  )
  select
    exists(select 1 from upsert),
    coalesce(
      (select u.holder_id from upsert u),
      (select wl2.holder_id from arb.worker_leases wl2 where wl2.lease_name = p_lease_name)
    ),
    coalesce(
      (select u.epoch from upsert u),
      (select wl2.epoch from arb.worker_leases wl2 where wl2.lease_name = p_lease_name)
    );
end;
$$;

-- ============================================================
-- RLS（spec §11）:
--   閲覧 = 認証済みユーザー（ダッシュボード）
--   書込 = Service Roleのみ（RLSバイパス）。anon/authenticatedに書込ポリシーは作らない
-- ============================================================
alter table arb.assets enable row level security;
alter table arb.pools enable row level security;
alter table arb.block_observations enable row level security;
alter table arb.quotes enable row level security;
alter table arb.opportunities enable row level security;
alter table arb.alerts enable row level security;
alter table arb.worker_heartbeats enable row level security;
alter table arb.worker_leases enable row level security;
alter table arb.system_config enable row level security;
alter table arb.audit_logs enable row level security;

create policy "authenticated_read" on arb.assets
  for select to authenticated using (true);
create policy "authenticated_read" on arb.pools
  for select to authenticated using (true);
create policy "authenticated_read" on arb.block_observations
  for select to authenticated using (true);
create policy "authenticated_read" on arb.quotes
  for select to authenticated using (true);
create policy "authenticated_read" on arb.opportunities
  for select to authenticated using (true);
create policy "authenticated_read" on arb.alerts
  for select to authenticated using (true);
create policy "authenticated_read" on arb.worker_heartbeats
  for select to authenticated using (true);
create policy "authenticated_read" on arb.worker_leases
  for select to authenticated using (true);
create policy "authenticated_read_nonsecret" on arb.system_config
  for select to authenticated using (is_secret = false);
create policy "authenticated_read" on arb.audit_logs
  for select to authenticated using (true);

-- grants: 新規スキーマはデフォルト権限が無いため明示
grant usage on schema arb to authenticated, service_role;
grant select on all tables in schema arb to authenticated;
grant all on all tables in schema arb to service_role;
grant usage, select on all sequences in schema arb to service_role;
grant execute on function arb.acquire_lease(text, text, integer) to service_role;

alter default privileges in schema arb grant select on tables to authenticated;
alter default privileges in schema arb grant all on tables to service_role;
alter default privileges in schema arb grant usage, select on sequences to service_role;
