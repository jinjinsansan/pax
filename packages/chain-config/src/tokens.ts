import type { Address } from "@pax/shared-types";

/**
 * 対象トークン（仕様書 §4）。
 * decimalsは起動時にオンチェーン検証され、不一致ならWorkerは停止する。
 * ここの値は「期待値」であり、オンチェーンが真実。
 */

export type TokenSymbol = "USDT" | "USDC" | "WETH" | "PAXG" | "XAUT";

export interface TokenConfig {
  symbol: TokenSymbol;
  address: Address;
  /** 期待decimals — 起動時オンチェーン照合 */
  decimals: number;
  /** 金トークンか（PAXG/XAUT） */
  isGoldToken: boolean;
  /** Quote資産として使えるか（USDT/USDC） */
  isQuoteAsset: boolean;
}

export const TOKENS: Record<TokenSymbol, TokenConfig> = {
  USDT: {
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    isGoldToken: false,
    isQuoteAsset: true,
  },
  USDC: {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    isGoldToken: false,
    isQuoteAsset: true,
  },
  WETH: {
    symbol: "WETH",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
    isGoldToken: false,
    isQuoteAsset: false,
  },
  PAXG: {
    symbol: "PAXG",
    address: "0x45804880DE22913DAFE09F4980848ECE6ECBAF78",
    decimals: 18,
    isGoldToken: true,
    isQuoteAsset: false,
  },
  XAUT: {
    symbol: "XAUT",
    address: "0x68749665FF8D2D112FA859AA293F07A622782F38",
    decimals: 6,
    isGoldToken: true,
    isQuoteAsset: false,
  },
} as const;

export const CHAIN_ID = 1 as const;

export function tokenBySymbol(symbol: TokenSymbol): TokenConfig {
  return TOKENS[symbol];
}

export function tokenByAddress(address: Address): TokenConfig | undefined {
  const lower = address.toLowerCase();
  return Object.values(TOKENS).find(
    (t) => t.address.toLowerCase() === lower,
  );
}
