-- ============================================================
-- pax seed: 初期設定値（spec §4, §7, §9）
-- system_configの値が実行時の真実。ここは初期投入のみ（既存keyは上書きしない）
-- ============================================================

insert into arb.system_config (key, value, is_secret) values
  ('thresholds', '{
    "reference_alert_pct": "0.50",
    "executable_alert_pct": "0.50",
    "minimum_net_profit_usd": "25",
    "minimum_net_profit_pct": "0.10",
    "maximum_price_impact_pct": "0.30",
    "maximum_quote_age_blocks": 1,
    "maximum_quote_latency_ms": 3000,
    "alert_cooldown_seconds": 300,
    "recovery_threshold_pct": "0.35"
  }'::jsonb, false),
  ('simulation_amounts_usd', '[1000, 5000, 10000, 25000, 50000, 100000]'::jsonb, false),
  ('quote_trigger', '{
    "full_quote_trigger_pct": "0.30",
    "degraded_mode_block_interval": 30,
    "degraded_mode_amounts_usd": [10000]
  }'::jsonb, false),
  ('routes_enabled', '["A", "B", "C", "D", "E", "F"]'::jsonb, false)
on conflict (key) do nothing;

-- 対象トークン（spec §4 — decimalsは起動時にオンチェーン照合される期待値）
insert into arb.assets (chain_id, symbol, address, decimals, is_gold_token, is_quote_asset) values
  (1, 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6,  false, true),
  (1, 'USDC', '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6,  false, true),
  (1, 'WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, false, false),
  (1, 'PAXG', '0x45804880DE22913DAFE09F4980848ECE6ECBAF78', 18, true,  false),
  (1, 'XAUT', '0x68749665FF8D2D112FA859AA293F07A622782F38', 6,  true,  false)
on conflict (chain_id, address) do nothing;
