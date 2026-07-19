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
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6,
    isGoldToken: false,
    isQuoteAsset: true,
  },
  USDC: {
    symbol: "USDC",
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    isGoldToken: false,
    isQuoteAsset: true,
  },
  WETH: {
    symbol: "WETH",
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    decimals: 18,
    isGoldToken: false,
    isQuoteAsset: false,
  },
  PAXG: {
    symbol: "PAXG",
    address: "0x45804880de22913dafe09f4980848ece6ecbaf78",
    decimals: 18,
    isGoldToken: true,
    isQuoteAsset: false,
  },
  XAUT: {
    symbol: "XAUT",
    address: "0x68749665ff8d2d112fa859aa293f07a622782f38",
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
