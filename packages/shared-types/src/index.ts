/**
 * @pax/shared-types
 * 仕様書 §6 (DEXアダプター), §9 (判定条件), §19 (自動トレード境界) の型定義。
 * 依存ゼロ。全パッケージがここを参照する。
 *
 * 金額の扱い（仕様書§5）:
 * - Wei / トークンraw amount → bigint
 * - USD額・率 → 文字列化したDecimal（"123.45"）。JSの number でraw金額を扱うことは禁止。
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** USDや率など、任意精度Decimalを文字列表現で持ち回る値 */
export type DecimalString = string;

export type ChainId = 1;

// ---------------------------------------------------------------------------
// プール / Quote（仕様書 §6）
// ---------------------------------------------------------------------------

export interface PoolDescriptor {
  dex: string;
  address: Address;
  token0: Address;
  token1: Address;
  /** Uniswap V3 fee tier 等（bps単位: 0.01% = 1） */
  feeTierBps?: number;
  metadata?: Record<string, unknown>;
}

export interface PoolState {
  pool: PoolDescriptor;
  blockNumber: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
  observedAt: string; // ISO 8601
}

export interface QuoteInput {
  chainId: ChainId;
  /** トークンアドレス列（例: [USDT, PAXG, XAUT, USDT]） */
  route: Address[];
  amountInRaw: bigint;
  /** 指定時はそのブロック時点でQuote */
  blockNumber?: bigint;
}

export interface QuoteOutput {
  chainId: ChainId;
  route: Address[];
  amountOutRaw: bigint;
  blockNumber?: bigint;
}

export interface QuoteResult {
  chainId: ChainId;
  blockNumber: bigint;
  dex: string;
  poolAddress?: Address;
  route: Address[];
  amountInRaw: bigint;
  amountOutRaw: bigint;
  amountInUsd: DecimalString;
  amountOutUsd: DecimalString;
  feeAmountUsd: DecimalString;
  priceImpactBps: number;
  estimatedGasUnits: bigint;
  quoteLatencyMs: number;
  source: "ONCHAIN_QUOTER" | "LOCAL_SIMULATION";
  success: boolean;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// 機会評価（仕様書 §8, §9）
// ---------------------------------------------------------------------------

export type OpportunityStatus =
  | "REFERENCE_ONLY"
  | "EXECUTABLE_DIVERGENCE"
  | "GROSS_PROFITABLE"
  | "NET_PROFITABLE"
  | "PAPER_TRADE_CANDIDATE"
  | "REJECTED";

/** ガス3シナリオ（PROFITABLE判定はHighを使う — 仕様書§8.5） */
export interface GasCostScenarios {
  lowUsd: DecimalString;
  expectedUsd: DecimalString;
  highUsd: DecimalString;
}

export interface Opportunity {
  id: string;
  chainId: ChainId;
  blockNumber: bigint;
  routeHash: string;
  route: Address[];
  inputAsset: Address;
  amountInUsd: DecimalString;
  amountOutUsd: DecimalString | null;
  referenceDivergencePct: DecimalString | null;
  executableDivergencePct: DecimalString | null;
  grossProfitUsd: DecimalString | null;
  gasCost: GasCostScenarios | null;
  safetyBufferUsd: DecimalString;
  netProfitUsd: DecimalString | null;
  netProfitPct: DecimalString | null;
  maxPriceImpactBps: number | null;
  status: OpportunityStatus;
  rejectionReasons: string[];
  quotes: QuoteResult[];
  createdAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// DEXアダプター（仕様書 §6）
// ---------------------------------------------------------------------------

export interface DexAdapter {
  readonly name: string;

  discoverPools(tokenA: Address, tokenB: Address): Promise<PoolDescriptor[]>;

  getQuoteExactInput(params: QuoteInput): Promise<QuoteResult>;
  getQuoteExactOutput(params: QuoteOutput): Promise<QuoteResult>;
  getPoolState(pool: PoolDescriptor): Promise<PoolState>;
  estimateSwapGas(params: QuoteInput): Promise<bigint>;

  buildExecutionPlan?(opportunity: Opportunity): Promise<ExecutionPlan>;
}

export interface ExecutionPlan {
  opportunityId: string;
  legs: RouteLeg[];
  estimatedGasUnits: bigint;
}

// ---------------------------------------------------------------------------
// 将来の自動トレード境界（仕様書 §19）
// Phase 1/2では ExecutionCandidate の生成まで。署名・送信は実装しない。
// ---------------------------------------------------------------------------

export interface RouteLeg {
  dex: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  feeTierBps?: number;
}

export interface ExecutionCandidate {
  opportunityId: string;
  chainId: ChainId;
  blockNumber: bigint;
  deadlineBlock: bigint;
  route: RouteLeg[];
  amountInRaw: bigint;
  minimumAmountOutRaw: bigint;
  expectedNetProfitRaw: bigint;
  minimumNetProfitRaw: bigint;
  maxGasCostRaw: bigint;
  quoteStateHash: Hex;
}

export interface SimulationResult {
  candidate: ExecutionCandidate;
  success: boolean;
  simulatedAmountOutRaw?: bigint;
  simulatedNetProfitRaw?: bigint;
  revertReason?: string;
  simulatedAtBlock: bigint;
}

export interface ExecutionResult {
  candidate: ExecutionCandidate;
  txHash: Hex;
  success: boolean;
  actualAmountOutRaw?: bigint;
  actualGasCostRaw?: bigint;
  failureReason?: string;
}

/** Phase 3でのみ実装される。Phase 1/2のコードベースに実装クラスを置くことは禁止。 */
export interface TradingExecutor {
  simulate(candidate: ExecutionCandidate): Promise<SimulationResult>;
  execute(candidate: ExecutionCandidate): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Worker / アラート（仕様書 §10, §14, §22）
// ---------------------------------------------------------------------------

export type WorkerRole = "primary" | "standby" | "report";

export type WorkerStatus = "active" | "standby" | "degraded" | "stopped";

export type AlertSeverity = "INFO" | "OPPORTUNITY" | "PROFITABLE" | "SYSTEM";

export type AlertDeliveryStatus = "PENDING" | "SENT" | "FAILED" | "RETRYING";

export interface AlertPayload {
  severity: AlertSeverity;
  dedupeKey: string;
  opportunityId?: string;
  text: string;
  createdAt: string; // ISO 8601
}
