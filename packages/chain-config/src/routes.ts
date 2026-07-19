import type { Address } from "@pax/shared-types";
import { TOKENS, type TokenSymbol } from "./tokens.js";

/**
 * 初期監視ルート（仕様書 §4）。
 * A/B/C/D: 三角ルート（Quote資産 → 金トークン → 金トークン → Quote資産）
 * E/F:     往復ルート（ベンチマーク用）
 */

export type RouteId = "A" | "B" | "C" | "D" | "E" | "F";

export interface RouteConfig {
  id: RouteId;
  symbols: readonly TokenSymbol[];
  description: string;
}

export const ROUTES: Record<RouteId, RouteConfig> = {
  A: {
    id: "A",
    symbols: ["USDT", "PAXG", "XAUT", "USDT"],
    description: "USDT -> PAXG -> XAUT -> USDT",
  },
  B: {
    id: "B",
    symbols: ["USDT", "XAUT", "PAXG", "USDT"],
    description: "USDT -> XAUT -> PAXG -> USDT",
  },
  C: {
    id: "C",
    symbols: ["USDC", "PAXG", "XAUT", "USDC"],
    description: "USDC -> PAXG -> XAUT -> USDC",
  },
  D: {
    id: "D",
    symbols: ["USDC", "XAUT", "PAXG", "USDC"],
    description: "USDC -> XAUT -> PAXG -> USDC",
  },
  E: {
    id: "E",
    symbols: ["USDT", "PAXG", "USDT"],
    description: "USDT -> PAXG -> USDT",
  },
  F: {
    id: "F",
    symbols: ["USDT", "XAUT", "USDT"],
    description: "USDT -> XAUT -> USDT",
  },
} as const;

/** 中継候補（仕様書 §4）: プール探索時に経由を許可するトークン */
export const INTERMEDIATE_CANDIDATES: readonly TokenSymbol[] = [
  "USDT",
  "USDC",
  "WETH",
];

/**
 * 初期シミュレーション金額（仕様書 §7、USD建て）。
 * arb.system_config で管理画面から変更可能。
 */
export const DEFAULT_SIMULATION_AMOUNTS_USD: readonly number[] = [
  1_000, 5_000, 10_000, 25_000, 50_000, 100_000,
];

export function routeAddresses(route: RouteConfig): Address[] {
  return route.symbols.map((s) => TOKENS[s].address);
}

/** ルートが循環している（開始・終了資産が同一）ことを検証 */
export function isCircularRoute(route: RouteConfig): boolean {
  const first = route.symbols[0];
  const last = route.symbols[route.symbols.length - 1];
  return first !== undefined && first === last;
}
