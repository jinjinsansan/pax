import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  rawOutPerRawIn,
  computeIdealOutRaw,
  priceImpactBps,
} from "../src/math.js";

const Q96 = 2n ** 96n;

describe("rawOutPerRawIn", () => {
  it("sqrtPriceX96 = 2^96（価格1）で両方向とも1", () => {
    expect(rawOutPerRawIn(Q96, true).toNumber()).toBeCloseTo(1, 10);
    expect(rawOutPerRawIn(Q96, false).toNumber()).toBeCloseTo(1, 10);
  });

  it("sqrtPriceX96 = 2*2^96（token1/token0 = 4）", () => {
    expect(rawOutPerRawIn(2n * Q96, true).toNumber()).toBeCloseTo(4, 10);
    expect(rawOutPerRawIn(2n * Q96, false).toNumber()).toBeCloseTo(0.25, 10);
  });
});

describe("computeIdealOutRaw", () => {
  it("価格1・fee 0.05%の1ホップで 0.9995倍", () => {
    const ideal = computeIdealOutRaw(1_000_000n, [
      { sqrtPriceX96: Q96, zeroForOne: true, feeRaw: 500 },
    ]);
    expect(ideal.toNumber()).toBeCloseTo(999_500, 0);
  });

  it("複数ホップは乗算合成", () => {
    const ideal = computeIdealOutRaw(1_000_000n, [
      { sqrtPriceX96: 2n * Q96, zeroForOne: true, feeRaw: 0 },
      { sqrtPriceX96: 2n * Q96, zeroForOne: false, feeRaw: 0 },
    ]);
    // ×4 → ×0.25 = 1
    expect(ideal.toNumber()).toBeCloseTo(1_000_000, 0);
  });
});

describe("priceImpactBps", () => {
  it("理想100万・実99万 → 100bps", () => {
    expect(priceImpactBps(new Decimal(1_000_000), 990_000n)).toBe(100);
  });

  it("理想と同じなら0bps、上回っても負にならない", () => {
    expect(priceImpactBps(new Decimal(1_000_000), 1_000_000n)).toBe(0);
    expect(priceImpactBps(new Decimal(1_000_000), 1_000_100n)).toBe(0);
  });
});
