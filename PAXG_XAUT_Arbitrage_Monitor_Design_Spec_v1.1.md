# PAXG / XAUT アービトラージ監視・通知システム
## Claude Code 実装仕様書 v1.1

作成日: 2026-07-19  
対象: Ethereum Mainnet  
利用基盤: Vercel / Supabase / XServer VPS / Render / Cloudflare  
目的: PAXG・XAUT間の価格乖離が、実際の約定条件と全コスト控除後にアービトラージとして成立するかを継続検証し、0.5%以上の乖離をTelegram通知する。将来の自動トレードへ安全に拡張可能な構造とする。

---

# 1. 最重要方針

本システムは単純な表示価格差モニターではない。以下を分離する。

1. **Reference Divergence**
   - 外部参考価格によるPAXG/XAUT価格差
   - CoinGecko等は補助情報
   - 売買判断の直接根拠にはしない

2. **Executable Divergence**
   - DEX上で指定数量を実際に交換したQuoteによる価格差
   - 買値、売値、流動性、手数料、スリッページを反映

3. **Net Arbitrage Profit**
   - ガス代、安全マージン、将来の借入手数料まで控除した純利益

Telegram通知は3段階とする。

- INFO: Reference Divergence >= 0.50%
- OPPORTUNITY: Executable Divergence >= 0.50%
- PROFITABLE: High gas想定でも最低純利益条件を満たす

0.5%の乖離を0.5%の利益として表示してはならない。

---

# 2. インフラ役割

| サービス | 役割 | 常時処理 | 秘密鍵 |
|---|---|---:|---:|
| Vercel | Next.js管理画面、閲覧API | 不向き | 禁止 |
| Supabase | PostgreSQL、Auth、Realtime、監査 | DB | 取引鍵禁止 |
| XServer VPS | メイン監視Worker、RPC購読、Quote計算 | 対応 | Phase 1/2禁止 |
| Render | Standby Worker、死活監視、集計 | 対応 | Phase 1/2禁止 |
| Cloudflare | DNS、WAF、Tunnel、Access、Rate Limit | N/A | 禁止 |

```text
Ethereum RPC / DEX / Reference APIs
                 |
                 v
       XServer VPS Main Worker
       - block watcher
       - quote engine
       - opportunity evaluator
       - Telegram dispatcher
                 |
                 v
          Supabase PostgreSQL
                 |
        +--------+--------+
        |                 |
        v                 v
Vercel Dashboard   Render Standby Worker
        |
        v
Cloudflare DNS / WAF / Access
```

Vercel FunctionsやSupabase Edge Functionsを秒単位の常時監視プロセスとして使わない。XServer VPS上のDockerコンテナを主系とする。Renderは待機系、障害検知、集計に利用する。

二重保存・二重通知防止のため、Supabase上のleaseとepoch fencing tokenを実装する。

---

# 3. 開発フェーズ

## Phase 1: 監視・検証専用

実資金を一切動かさない。

- Ethereumブロック監視
- DEXプール探索
- Quote取得
- 価格乖離、ガス、純利益シミュレーション
- Supabase保存
- Vercelダッシュボード
- Telegram通知
- CSV、日次、週次レポート

## Phase 2: ペーパートレード

- 発生ブロック保存
- `eth_call`による実行シミュレーション
- 次ブロック時点での事後評価
- 機会の持続時間
- MEVや価格移動による消失率
- 想定利益と事後利益の誤差

## Phase 3: 自動トレード

Phase 1/2の合格条件を満たした場合のみ別途有効化する。

Phase 1/2では以下を禁止する。

- 秘密鍵読み込み
- approve送信
- swap送信
- フラッシュローン
- 自動署名

`TRADING_ENABLED=false`を固定デフォルトとする。

---

# 4. 対象トークン

```text
USDT  0xdAC17F958D2ee523a2206206994597C13D831ec7
USDC  0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
WETH  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
PAXG  0x45804880DE22913DAFE09F4980848ECE6ECBAF78
XAUT  0x68749665FF8D2D112FA859AA293F07A622782F38
```

起動時に以下をオンチェーン確認し、不一致なら停止する。

- `chainId == 1`
- コントラクトコード存在
- symbol
- decimals
- 設定アドレス一致

初期ルート:

```text
A: USDT -> PAXG -> XAUT -> USDT
B: USDT -> XAUT -> PAXG -> USDT
C: USDC -> PAXG -> XAUT -> USDC
D: USDC -> XAUT -> PAXG -> USDC
E: USDT -> PAXG -> USDT
F: USDT -> XAUT -> USDT
```

中継候補はUSDT、USDC、WETH。MVPはUniswap V3を優先し、V4、Curve、Balancer、0x、1inch等はアダプター追加方式にする。

---

# 5. 技術構成

- Node.js 22 LTS
- TypeScript strict
- `viem`
- `zod`
- `pino`
- `decimal.js`
- `prom-client`
- Supabase JS
- pnpm workspace
- Turborepo
- Vitest
- Playwright
- Foundry（fork検証）

数量計算にJavaScriptの`number`を使用しない。Weiとトークンraw amountは`bigint`、USDや率は任意精度Decimalを使用する。

---

# 6. DEXアダプター

```ts
export interface DexAdapter {
  readonly name: string;

  discoverPools(
    tokenA: Address,
    tokenB: Address
  ): Promise<PoolDescriptor[]>;

  getQuoteExactInput(params: QuoteInput): Promise<QuoteResult>;
  getQuoteExactOutput(params: QuoteOutput): Promise<QuoteResult>;
  getPoolState(pool: PoolDescriptor): Promise<PoolState>;
  estimateSwapGas(params: QuoteInput): Promise<bigint>;

  buildExecutionPlan?(
    opportunity: Opportunity
  ): Promise<ExecutionPlan>;
}
```

```ts
export interface QuoteResult {
  chainId: 1;
  blockNumber: bigint;
  dex: string;
  poolAddress?: Address;
  route: Address[];
  amountInRaw: bigint;
  amountOutRaw: bigint;
  amountInUsd: string;
  amountOutUsd: string;
  feeAmountUsd: string;
  priceImpactBps: number;
  estimatedGasUnits: bigint;
  quoteLatencyMs: number;
  source: "ONCHAIN_QUOTER" | "LOCAL_SIMULATION";
  success: boolean;
  errorCode?: string;
}
```

必須:

- Quoteブロック番号保存
- 同一または最大1ブロック差で比較
- 失敗Quoteも保存
- RPCとQuoteの遅延保存
- Spot priceだけで判定しない
- 指定数量ごとに個別Quoteする

---

# 7. 監視Worker

優先順:

1. WebSocket RPCで`newHeads`
2. 切断時HTTP polling
3. WebSocket再接続
4. Primary RPC障害時Secondaryへ切替

新ブロック処理:

```text
new block
 -> gas data取得
 -> 対象プール状態取得
 -> 各取引額・各ルートをQuote
 -> opportunity評価
 -> DB保存
 -> Telegram条件判定
 -> heartbeat更新
```

間隔:

- 新ブロックごと
- 補助polling: 5秒
- 参考価格API: 30～60秒
- Heartbeat: 15秒
- Standby死活判定: 45秒
- 日次集計: UTC 00:05
- 週次集計: 月曜 UTC 00:15

初期シミュレーション金額:

```text
1,000
5,000
10,000
25,000
50,000
100,000 USDT
```

管理画面から変更可能にする。

---

# 8. 計算仕様

## 8.1 参考乖離率

```text
reference_divergence_pct =
 abs(reference_paxg - reference_xaut)
 / min(reference_paxg, reference_xaut)
 * 100
```

## 8.2 実行可能価格

```text
effective_buy_price  = quote_asset_spent / gold_token_received
effective_sell_price = quote_asset_received / gold_token_sold
```

買値と売値を分ける。

## 8.3 粗利益

```text
gross_profit_usd =
 final_quote_asset_usd - initial_quote_asset_usd
```

## 8.4 純利益

```text
net_profit_usd =
 final_quote_asset_usd
 - initial_quote_asset_usd
 - gas_cost_usd
 - flash_loan_fee_usd
 - mev_safety_buffer_usd
 - additional_safety_buffer_usd
```

QuoteにDEX手数料・価格影響が含まれる場合は二重控除しない。

```text
net_profit_pct =
 net_profit_usd / initial_quote_asset_usd * 100
```

## 8.5 ガス代

```text
gas_cost_native =
 estimated_gas_units * effective_gas_price

gas_cost_usd =
 gas_cost_native * ETH_USD
```

Low / Expected / Highの3シナリオを保存する。PROFITABLE判定はHighを使用する。

---

# 9. 判定条件

```ts
type OpportunityStatus =
  | "REFERENCE_ONLY"
  | "EXECUTABLE_DIVERGENCE"
  | "GROSS_PROFITABLE"
  | "NET_PROFITABLE"
  | "PAPER_TRADE_CANDIDATE"
  | "REJECTED";
```

初期設定:

```text
reference_alert_pct       = 0.50
executable_alert_pct      = 0.50
minimum_net_profit_usd    = 25
minimum_net_profit_pct    = 0.10
maximum_price_impact_pct  = 0.30
maximum_quote_age_blocks  = 1
maximum_quote_latency_ms  = 3000
alert_cooldown_seconds    = 300
recovery_threshold_pct    = 0.35
```

`NET_PROFITABLE`は以下を全て満たす。

- 全Quote成功
- Quoteのブロック差が許容内
- 最終資産が開始資産を上回る
- High gas控除後の純利益が最低額以上
- 純利益率が最低率以上
- 最大価格影響が上限以下
- Quote遅延が上限以下
- 許可プールのみ
- データがstaleでない
- RPC品質正常

---

# 10. Telegram通知

## INFO

```text
🟡 PAXG/XAUT 参考価格乖離

乖離率: 0.53%
PAXG: $x,xxx.xx
XAUT: $x,xxx.xx
時刻: UTC

注意: 外部参考価格の差であり、約定可能利益ではありません。
```

## OPPORTUNITY

```text
🟠 実行可能価格乖離を検出

方向: USDT → PAXG → XAUT → USDT
想定元本: 10,000 USDT
実行可能乖離: 0.61%
粗利益: 61.20 USDT
想定ガス: 34.80 USDT
純利益見込: 18.40 USDT
ブロック: 12345678

判定: 純利益条件未達
```

## PROFITABLE

```text
🟢 純利益機会を検出

方向: USDT → XAUT → PAXG → USDT
想定元本: 50,000 USDT
最終見込: 50,184.20 USDT
粗利益: 184.20 USDT
ガス見込（High）: 42.10 USDT
安全マージン: 25.00 USDT
純利益見込: 117.10 USDT
純利益率: 0.2342%
最大価格影響: 0.18%
ブロック: 12345678
機会ID: opp_xxx

監視のみ。取引は実行されていません。
```

## SYSTEM

- Worker停止・復旧
- RPC切断・切替
- Standby昇格
- DB書込失敗
- Telegram失敗
- データ欠落
- 設定変更

重複防止キー:

```text
route_hash + amount_in + severity + divergence_bucket
```

cooldown中でも以下は再通知する。

- 純利益が前回より25%以上増加
- レベル上昇
- recovery threshold以下へ戻った後の再発
- 5分以上経過
- 新最高値

Bot TokenはVPSまたはRender Secretに保存し、ブラウザや公開DBへ出さない。

---

# 11. Supabase DB

`arb` schemaを使用する。

主要テーブル:

- `arb.assets`
- `arb.pools`
- `arb.block_observations`
- `arb.quotes`
- `arb.opportunities`
- `arb.alerts`
- `arb.worker_heartbeats`
- `arb.worker_leases`
- `arb.system_config`
- `arb.audit_logs`

代表DDL:

```sql
create schema if not exists arb;

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
  unique(chain_id, block_number, block_hash)
);

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
  created_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now()
);

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

create table arb.worker_leases (
  lease_name text primary key,
  holder_id text not null,
  lease_until timestamptz not null,
  epoch bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table arb.system_config (
  key text primary key,
  value jsonb not null,
  is_secret boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

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
```

RLS:

- Dashboard閲覧: 認証済み管理者
- 設定変更: adminのみ
- Worker書込: Service Roleのみ
- Service Roleをブラウザへ配布禁止
- 設定変更は監査ログ必須
- 秘密鍵をSupabaseへ保存禁止

---

# 12. Vercel / Next.js画面

- `/dashboard`: 稼働状態、最新ブロック、RPC遅延、参考乖離、実行可能乖離、金額別純利益、最新アラート
- `/opportunities`: 期間、ルート、金額、状態、DEX、最低利益フィルター
- `/analytics`: 乖離時系列、成立回数、純利益分布、機会持続時間、時間帯、ガス、価格影響、ルート別
- `/alerts`: Telegram履歴、失敗、再送、テスト
- `/settings`: 閾値、監視額、cooldown、ルート、DEX、最大価格影響
- `/reports`: CSV、日次、週次、Phase移行判定

表示必須:

- 参考値 / 実行可能値
- ガス控除前 / 控除後
- 監視のみ・未執行
- Quoteブロック
- 取得時刻
- stale表示

Supabase Realtimeは最新値・アラートに限定し、長期履歴は通常Queryで取得する。

---

# 13. XServer VPS

推奨:

- Ubuntu 24.04 LTS
- Docker / Compose
- 非rootユーザー
- UFW
- fail2ban
- 自動セキュリティ更新
- chrony
- Cloudflare Tunnel

```yaml
services:
  monitor-worker:
    build:
      context: .
      dockerfile: apps/monitor-worker/Dockerfile
    restart: unless-stopped
    env_file:
      - /opt/arbitrage/secrets/monitor.env
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 3

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
```

Workerの管理ポートを直接公開しない。Cloudflare Tunnel経由のみ。

---

# 14. Render Standby

通常はQuoteと通知を行わず、VPS heartbeatを監視する。

- 45秒以上途絶で候補
- 連続3回失敗
- DB lease取得成功時のみActiveへ昇格
- epochを更新
- Telegram SYSTEM通知
- VPS復旧後5分安定確認
- 安全なhandover
- 二重Active禁止

Render側の定期処理:

- 日次・週次集計
- データ欠落検査
- 通知再送
- Rawデータ圧縮
- RPC比較検証

---

# 15. Cloudflare

例:

- `arb.example.com` → Vercel
- `monitor-api.example.com` → Tunnel → XServer VPS
- 管理画面はCloudflare Access
- APIはWAFとRate Limit
- VPS公開IPへの直接到達を防止
- Internal APIはAccess Service Token + HMAC + timestamp + nonce
- 認証API、Realtime、設定、Healthはキャッシュしない

---

# 16. API

```text
GET   /api/dashboard/summary
GET   /api/opportunities
GET   /api/opportunities/:id
GET   /api/analytics
GET   /api/alerts
POST  /api/alerts/test
GET   /api/reports/daily
GET   /api/reports/export.csv
GET   /api/settings
PATCH /api/settings

GET   /internal/health
GET   /internal/metrics
POST  /internal/reload-config
POST  /internal/standby/promote
POST  /internal/standby/demote
```

Internal APIはCloudflare Access、HMAC、timestamp、nonce、replay防止を必須とする。

---

# 17. モノレポ

```text
/
├─ apps/
│  ├─ dashboard/
│  ├─ monitor-worker/
│  ├─ standby-worker/
│  └─ report-worker/
├─ packages/
│  ├─ chain-config/
│  ├─ dex-adapters/
│  │  ├─ uniswap-v3/
│  │  └─ uniswap-v4/
│  ├─ quote-engine/
│  ├─ opportunity-engine/
│  ├─ notification/
│  ├─ database/
│  ├─ observability/
│  ├─ shared-types/
│  └─ validation/
├─ contracts/
├─ supabase/
│  ├─ migrations/
│  ├─ seed.sql
│  └─ tests/
├─ infrastructure/
│  ├─ docker/
│  └─ scripts/
├─ docs/
│  ├─ architecture.md
│  ├─ operations.md
│  ├─ incident-response.md
│  └─ phase-gates.md
├─ tests/
│  ├─ integration/
│  ├─ fork/
│  └─ fixtures/
├─ .env.example
├─ turbo.json
└─ pnpm-workspace.yaml
```

---

# 18. 環境変数

```bash
NODE_ENV=production
CHAIN_ID=1

ETH_RPC_HTTP_PRIMARY=
ETH_RPC_WS_PRIMARY=
ETH_RPC_HTTP_SECONDARY=
ETH_RPC_WS_SECONDARY=

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

WORKER_ID=xserver-main-01
WORKER_ROLE=primary
LEASE_NAME=ethereum-arbitrage-monitor
LEASE_TTL_SECONDS=45

REFERENCE_ALERT_PCT=0.50
EXECUTABLE_ALERT_PCT=0.50
MIN_NET_PROFIT_USD=25
MIN_NET_PROFIT_PCT=0.10
MAX_PRICE_IMPACT_PCT=0.30
ALERT_COOLDOWN_SECONDS=300

INTERNAL_API_HMAC_SECRET=

TRADING_ENABLED=false
PRIVATE_KEY=
```

Phase 1/2では`PRIVATE_KEY`が設定されていたら起動失敗させる。

---

# 19. 将来の自動トレード境界

監視システムはウォレット操作を行わず、`ExecutionCandidate`のみ生成する。

```ts
export interface ExecutionCandidate {
  opportunityId: string;
  chainId: 1;
  blockNumber: bigint;
  deadlineBlock: bigint;
  route: RouteLeg[];
  amountInRaw: bigint;
  minimumAmountOutRaw: bigint;
  expectedNetProfitRaw: bigint;
  minimumNetProfitRaw: bigint;
  maxGasCostRaw: bigint;
  quoteStateHash: `0x${string}`;
}

export interface TradingExecutor {
  simulate(candidate: ExecutionCandidate): Promise<SimulationResult>;
  execute(candidate: ExecutionCandidate): Promise<ExecutionResult>;
}
```

将来の必須安全策:

- 1トランザクションで原子的完結
- 最低利益未達でrevert
- deadline
- max gas
- max slippage
- allowlist
- emergency pause
- per-trade上限
- daily loss limit
- daily gas budget
- nonce管理
- private relay
- hardware signerまたはMPC
- hot wallet残高上限
- 二段階承認
- コントラクト監査
- fork試験
- Canary運用

---

# 20. Phase移行KPI

最低14日、推奨30日監視する。

必須KPI:

- 参考乖離0.5%以上の回数
- 実行可能乖離0.5%以上の回数
- NET_PROFITABLE回数
- 取引額別成立回数
- 純利益合計、中央値、P10/P50/P90
- 機会持続ブロック数
- 次ブロック消失率
- Quote成功率
- RPC遅延
- ガス分布
- 最大価格影響
- 想定資本回転率

Phase 2暫定条件:

- 30日中20日以上正常稼働
- データ欠損1%未満
- Quote成功率99%以上
- NET_PROFITABLEが月30回以上
- 純利益中央値50 USDT以上
- High gasでもプラス
- 50%以上が2ブロック以上持続
- 月次想定利益がインフラ費の5倍以上

Phase 3暫定条件:

- Phase 2を30日以上
- fork simulation成功率99%以上
- 事後検証で正の純利益95%以上
- 想定値と事後値の誤差中央値20%未満
- MEV込みで正の期待値
- セキュリティレビュー
- 緊急停止試験
- 小額Canary承認

---

# 21. テスト

Unit:

- decimals
- divergence
- gross/net profit
- gas換算
- dedupe/cooldown
- stale
- status
- route hash
- lease
- Telegram escape

Integration:

- RPC切替
- Supabase
- Telegram
- Uniswap Quoter
- Pool discovery
- Realtime
- Cloudflare Access
- heartbeat

Mainnet fork:

- 過去ブロック固定
- Quote再現
- router call
- slippage failure
- insufficient liquidity
- deadline
- gas spike
- token approve挙動
- revert理由

E2E:

- Auth
- Dashboard
- 検索
- 設定
- 監査ログ
- CSV
- Telegram test
- 権限制御

---

# 22. 障害処理

RPC:

- Primary 3回失敗でSecondary
- SYSTEM通知
- 復旧後5分安定確認

Supabase:

- ローカル永続スプール
- 復旧後block順再送
- unique keyで重複排除

Telegram:

- FAILED記録
- exponential backoff
- 最大5回
- Dashboard Critical表示

Reorg:

- block hash保存
- hash変更検出
- 旧データをorphaned
- opportunity無効化
- 必要に応じ訂正通知

二重Active:

- DB lease
- epoch fencing token
- leaseなしWorkerは保存・通知禁止

---

# 23. 非機能要件

可用性:

- 稼働率99.5%以上
- VPS停止検出60秒以内
- Standby昇格120秒以内
- 障害通知60秒以内

性能:

- 新ブロックからQuote完了P95 5秒
- Dashboard反映P95 10秒
- DB書込P95 1秒
- Telegram P95 10秒

保持:

- Raw Quote 90日
- 1分集計 1年
- 1時間集計 無期限
- Opportunity / Alert / Audit 無期限

---

# 24. セキュリティ

- Phase 1/2で秘密鍵禁止
- `.env`をGitへ入れない
- Secret scanning
- lockfile固定
- RPC URLをログに出さない
- Service Roleをブラウザへ渡さない
- MFA
- Cloudflare Access
- RLS
- CSP/CSRF
- Rate Limit
- HMAC internal API
- Backup/Restore手順
- 開発・Staging・本番分離

---

# 25. Claude Code実装順序

1. Repository Foundation
2. Supabase schema / RLS / typed repository
3. Chain Monitor / RPC failover / heartbeat / lease
4. Uniswap V3 Quote adapter
5. Opportunity Engine
6. Telegram
7. Vercel Dashboard
8. VPS / Render / Cloudflare deployment
9. 30-day monitoring and phase report

各Milestoneでlint、typecheck、unit、integration、buildを成功させてから次へ進む。

---

# 26. Definition of Done

- [ ] Ethereum Mainnetを新ブロックごとに監視
- [ ] PAXG/XAUTルートをQuote
- [ ] 6種類以上の元本額を個別計算
- [ ] 参考乖離と実行可能乖離を分離
- [ ] 全コスト後の純利益を表示
- [ ] 0.5%以上をTelegram通知
- [ ] 純利益機会を別通知
- [ ] Supabase保存
- [ ] Vercel分析画面
- [ ] XServer VPS常時稼働
- [ ] Render Standby
- [ ] Cloudflare保護
- [ ] 二重Worker・通知防止
- [ ] 障害復旧
- [ ] CSV
- [ ] 監査ログ
- [ ] 実資金を動かさない
- [ ] 秘密鍵を保存しない
- [ ] Phase 2/3拡張境界
- [ ] テスト・運用・障害対応文書

---

# 27. 禁止事項

- 外部価格だけで利益判定
- Spot priceだけで利益判定
- `number`でraw amount計算
- 0.5%乖離を0.5%利益と表示
- ガス固定値のみ
- 金額を単純比例
- 異なるブロックQuoteを無条件比較
- 二重Worker通知
- Phase 1で署名機能
- Service Roleのフロント配置
- 実行コードと監視Workerの混在
- エラーを握り潰す
- 成功データだけ保存
- 不成立機会の削除

---

# 28. 公式参考資料

- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs
- Vercel Functions: https://vercel.com/docs/functions
- Supabase Database: https://supabase.com/docs/guides/database/overview
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Scheduled Functions: https://supabase.com/docs/guides/functions/schedule-functions
- Render Background Workers: https://render.com/docs/background-workers
- Render Cron Jobs: https://render.com/docs/cronjobs
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Cloudflare Rate Limiting: https://developers.cloudflare.com/waf/rate-limiting-rules/
- Telegram Bot API: https://core.telegram.org/bots/api
- Uniswap Docs: https://docs.uniswap.org/

---

# 29. Claude Codeへの最終指示

まずPhase 1のみ実装する。

自動トレード、秘密鍵、署名、approve、swap送信、フラッシュローンは実装しない。ただし、将来のExecution Serviceへ渡せる`ExecutionCandidate`とインターフェース境界は作る。

最初の目的は、PAXG/XAUTアービトラージが実際に「どの頻度・どの金額・どの純利益」で成立するかをオンチェーンQuoteに基づいて証明することである。
