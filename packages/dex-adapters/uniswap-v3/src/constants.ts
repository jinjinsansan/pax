import type { Address } from "@pax/shared-types";

/** Uniswap V3 mainnet コントラクト（公式デプロイ） */
export const UNISWAP_V3_FACTORY: Address =
  "0x1F98431c8aD98523631AE4a59f267346ea31F984";

/** QuoterV2 */
export const UNISWAP_V3_QUOTER_V2: Address =
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

/** fee tier（Uniswap単位: 1e-6。100 = 0.01%） */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * swap実行時のルーター・approve等のオーバーヘッド概算（gas units）。
 * QuoterV2のgasEstimateはプール内swapのみのため加算する。
 */
export const SWAP_GAS_OVERHEAD = 100_000n;
