import { describe, expect, it } from "vitest";
import {
  TOKENS,
  ROUTES,
  tokenByAddress,
  isCircularRoute,
  routeAddresses,
  DEFAULT_SIMULATION_AMOUNTS_USD,
} from "../src/index.js";

describe("TOKENS", () => {
  it("仕様書§4のアドレスと一致する（小文字正規化 — viemのEIP-55検証対策）", () => {
    expect(TOKENS.USDT.address).toBe(
      "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase(),
    );
    expect(TOKENS.USDC.address).toBe(
      "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".toLowerCase(),
    );
    expect(TOKENS.WETH.address).toBe(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(),
    );
    expect(TOKENS.PAXG.address).toBe(
      "0x45804880DE22913DAFE09F4980848ECE6ECBAF78".toLowerCase(),
    );
    expect(TOKENS.XAUT.address).toBe(
      "0x68749665FF8D2D112FA859AA293F07A622782F38".toLowerCase(),
    );
  });

  it("decimals期待値が正しい（USDT/USDC/XAUT=6, WETH/PAXG=18）", () => {
    expect(TOKENS.USDT.decimals).toBe(6);
    expect(TOKENS.USDC.decimals).toBe(6);
    expect(TOKENS.XAUT.decimals).toBe(6);
    expect(TOKENS.WETH.decimals).toBe(18);
    expect(TOKENS.PAXG.decimals).toBe(18);
  });

  it("金トークンはPAXGとXAUTのみ", () => {
    const gold = Object.values(TOKENS).filter((t) => t.isGoldToken);
    expect(gold.map((t) => t.symbol).sort()).toEqual(["PAXG", "XAUT"]);
  });

  it("tokenByAddressは大文字小文字を区別しない", () => {
    const paxg = tokenByAddress(
      "0x45804880de22913dafe09f4980848ece6ecbaf78",
    );
    expect(paxg?.symbol).toBe("PAXG");
  });
});

describe("ROUTES", () => {
  it("全6ルートが定義されている", () => {
    expect(Object.keys(ROUTES).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
  });

  it("全ルートが循環している（開始資産 == 終了資産）", () => {
    for (const route of Object.values(ROUTES)) {
      expect(isCircularRoute(route), `route ${route.id}`).toBe(true);
    }
  });

  it("三角ルートA-Dは金トークンを2つ経由する", () => {
    for (const id of ["A", "B", "C", "D"] as const) {
      const goldLegs = ROUTES[id].symbols.filter(
        (s) => TOKENS[s].isGoldToken,
      );
      expect(goldLegs.sort()).toEqual(["PAXG", "XAUT"]);
    }
  });

  it("routeAddressesがシンボルと同じ長さのアドレス列を返す", () => {
    const addrs = routeAddresses(ROUTES.A);
    expect(addrs).toHaveLength(ROUTES.A.symbols.length);
    expect(addrs.every((a) => a.startsWith("0x"))).toBe(true);
  });
});

describe("シミュレーション金額", () => {
  it("仕様書§7の6段階が昇順で定義されている", () => {
    expect(DEFAULT_SIMULATION_AMOUNTS_USD).toEqual([
      1_000, 5_000, 10_000, 25_000, 50_000, 100_000,
    ]);
  });
});
