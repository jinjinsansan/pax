/**
 * arbスキーマの行型。
 * 方針: bigint/numeric列はJSの精度落ちを避けるため文字列で受け渡す
 * （block_numberのみ2^53未満が保証されるためnumberを許容）。
 */

export interface BlockObservationInsert {
  chain_id: number;
  block_number: number;
  block_hash: string;
  block_timestamp: string; // ISO 8601
  base_fee_per_gas?: string | null;
  priority_fee_per_gas?: string | null;
  eth_usd?: string | null;
  rpc_provider: string;
  rpc_latency_ms?: number | null;
  orphaned?: boolean;
}

export interface BlockObservationRow extends BlockObservationInsert {
  id: number;
  created_at: string;
}

export interface QuoteInsert {
  observation_id: number | null;
  route_hash: string;
  dex: string;
  route: string[];
  amount_in_raw: string;
  amount_out_raw?: string | null;
  amount_in_usd?: string | null;
  amount_out_usd?: string | null;
  fee_usd?: string | null;
  price_impact_bps?: number | null;
  estimated_gas_units?: string | null;
  quote_latency_ms?: number | null;
  success: boolean;
  error_code?: string | null;
}

export interface OpportunityInsert {
  observation_id: number | null;
  route_hash: string;
  route: string[];
  input_asset: string;
  amount_in_usd: string;
  amount_out_usd?: string | null;
  reference_divergence_pct?: string | null;
  executable_divergence_pct?: string | null;
  gross_profit_usd?: string | null;
  gas_cost_low_usd?: string | null;
  gas_cost_expected_usd?: string | null;
  gas_cost_high_usd?: string | null;
  safety_buffer_usd?: string | null;
  net_profit_usd?: string | null;
  net_profit_pct?: string | null;
  max_price_impact_bps?: number | null;
  status: string;
  rejection_reasons?: string[];
}

export interface AlertInsert {
  opportunity_id?: string | null;
  channel: string;
  severity: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  delivery_status: string;
  sent_at?: string | null;
  provider_response?: Record<string, unknown> | null;
  retry_count?: number;
}

export interface HeartbeatUpsert {
  worker_id: string;
  role: string;
  hostname?: string | null;
  version?: string | null;
  status: string;
  last_block_number?: number | null;
  last_seen_at: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface LeaseResult {
  acquired: boolean;
  current_holder: string;
  current_epoch: number;
}

export interface SystemConfigRow {
  key: string;
  value: unknown;
  is_secret: boolean;
  updated_at: string;
}
