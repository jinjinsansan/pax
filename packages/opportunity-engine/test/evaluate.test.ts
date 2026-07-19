import { describe, expect, it } from "vitest";
import type { QuoteResult } from "@pax/shared-types";
import {
  evaluateOpportunity,
  gasScenariosFromBlock,
  gasCostUsd,
  type EvaluationThresholds,
} from "../src/index.js";

const thresholds: EvaluationThresholds = {
  executableAlertPct: 0.5,
  minimumNetProfitUsd: 25,
  minimumNetProfitPct: 0.1,
  maximumPriceImpactPct: 0.3,
  maximumQuoteLatencyMs: 3000,
  referenceAlertPct: 0.5,
  safetyBufferUsd: 25,
};

function makeQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    chainId: 1,
    blockNumber: 100n,
    dex: "uniswap-v3",
    route: ["0xaa", "0xbb", "0xaa"] as `0x${string}`[],
    amountInRaw: 50_000_000_000n,
    amountOutRaw: 50_200_000_000n,
    amountInUsd: "50000.00",
    amountOutUsd: "50200.00",
    feeAmountUsd: "0",
    priceImpactBps: 10,
    estimatedGasUnits: 500_000n,
    quoteLatencyMs: 100,
    source: "ONCHAIN_QUOTER",
    success: true,
    ...overrides,
  };
}

const gasPrices = gasScenariosFromBlock(10_000_000_000n, 2_000_000_000n); // base 10 gwei, tip 2

describe("gasScenariosFromBlock / gasCostUsd", () => {
  it("Low < Expected < High", () => {
    expect(gasPrices.lowWeiPerGas).toBeLessThan(gasPrices.expectedWeiPerGas);
    expect(gasPrices.expectedWeiPerGas).toBeLessThan(gasPrices.highWeiPerGas);
  });

  it("500k gas × 24gwei(High) × ETH$3000 = $36", () => {
    // High = 10*2 + 2*2 = 24 gwei
    expect(gasCostUsd(500_000n, gasPrices.highWeiPerGas, 3000)).toBe("36.0000");
  });
});

describe("evaluateOpportunity", () => {
  it("全条件を満たすとNET_PROFITABLE", () => {
    // gross $200 - High gas $36 - buffer $25 = net $139 (0.278%)
    const result = evaluateOpportunity({
      quote: makeQuote(),
      routeHash: "0xhash",
      amountUsd: 50_000,
      roundTripPct: 0.4,
      referenceDivergencePct: 0.6,
      gasPrices,
      ethUsd: 3000,
      thresholds,
    });
    expect(result.status).toBe("NET_PROFITABLE");
    expect(result.rejectionReasons).toEqual([]);
    expect(Number(result.netProfitUsd)).toBeCloseTo(139, 1);
    expect(result.gasCostHighUsd).toBe("36.0000");
  });

  it("純利益がHigh gasで最低額を割るとGROSS_PROFITABLEに留まり理由が残る", () => {
    const result = evaluateOpportunity({
      quote: makeQuote({ amountOutUsd: "50050.00", amountOutRaw: 50_050_000_000n }),
      routeHash: "0xhash",
      amountUsd: 50_000,
      roundTripPct: 0.1,
      referenceDivergencePct: null,
      gasPrices,
      ethUsd: 3000,
      thresholds,
    });
    // gross $50 - $36 - $25 = -$11
    expect(result.status).toBe("GROSS_PROFITABLE");
    expect(result.rejectionReasons).toContain("NET_PROFIT_BELOW_MIN_USD");
  });

  it("価格影響が上限超過ならNET_PROFITABLEにならない", () => {
    const result = evaluateOpportunity({
      quote: makeQuote({ priceImpactBps: 50 }), // 0.5% > 0.3%
      routeHash: "0xhash",
      amountUsd: 50_000,
      roundTripPct: 0.4,
      referenceDivergencePct: null,
      gasPrices,
      ethUsd: 3000,
      thresholds,
    });
    expect(result.status).not.toBe("NET_PROFITABLE");
    expect(result.rejectionReasons).toContain("PRICE_IMPACT_TOO_HIGH");
  });

  it("ETH価格が無いと純利益計算不能（NO_ETH_PRICE）", () => {
    const result = evaluateOpportunity({
      quote: makeQuote(),
      routeHash: "0xhash",
      amountUsd: 50_000,
      roundTripPct: 0.4,
      referenceDivergencePct: null,
      gasPrices: null,
      ethUsd: null,
      thresholds,
    });
    expect(result.netProfitUsd).toBeNull();
    expect(result.rejectionReasons).toContain("NO_ETH_PRICE");
    expect(result.status).toBe("GROSS_PROFITABLE");
  });

  it("Quote失敗はREJECTED + QUOTE_FAILED", () => {
    const result = evaluateOpportunity({
      quote: makeQuote({ success: false, errorCode: "NO_POOL:x/y" }),
      routeHash: "0xhash",
      amountUsd: 1000,
      roundTripPct: null,
      referenceDivergencePct: null,
      gasPrices,
      ethUsd: 3000,
      thresholds,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.rejectionReasons[0]).toMatch(/^QUOTE_FAILED/);
  });

  it("マイナス往復でも参考乖離が閾値以上ならREFERENCE_ONLY", () => {
    const result = evaluateOpportunity({
      quote: makeQuote({ amountOutUsd: "49900.00", amountOutRaw: 49_900_000_000n }),
      routeHash: "0xhash",
      amountUsd: 50_000,
      roundTripPct: -0.2,
      referenceDivergencePct: 0.7,
      gasPrices,
      ethUsd: 3000,
      thresholds,
    });
    expect(result.status).toBe("REFERENCE_ONLY");
  });
});
