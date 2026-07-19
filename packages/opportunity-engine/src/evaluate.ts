import { Decimal } from "decimal.js";
import type { OpportunityStatus, QuoteResult } from "@pax/shared-types";
import { gasCostUsd, type GasPriceScenarios } from "./gas.js";

Decimal.set({ precision: 50 });

export interface EvaluationThresholds {
  executableAlertPct: number; // 0.50
  minimumNetProfitUsd: number; // 25
  minimumNetProfitPct: number; // 0.10
  maximumPriceImpactPct: number; // 0.30
  maximumQuoteLatencyMs: number; // 3000
  referenceAlertPct: number; // 0.50
  safetyBufferUsd: number; // 25
}

export interface EvaluationInput {
  quote: QuoteResult;
  routeHash: string;
  amountUsd: number;
  /** 循環ルートの往復収支% (out/in - 1)*100。quote失敗時null */
  roundTripPct: number | null;
  referenceDivergencePct: number | null;
  gasPrices: GasPriceScenarios | null;
  ethUsd: number | null;
  thresholds: EvaluationThresholds;
}

export interface EvaluatedOpportunity {
  routeHash: string;
  route: string[];
  inputAsset: string;
  amountInUsd: string;
  amountOutUsd: string | null;
  referenceDivergencePct: string | null;
  executableDivergencePct: string | null;
  grossProfitUsd: string | null;
  gasCostLowUsd: string | null;
  gasCostExpectedUsd: string | null;
  gasCostHighUsd: string | null;
  safetyBufferUsd: string;
  netProfitUsd: string | null;
  netProfitPct: string | null;
  maxPriceImpactBps: number | null;
  status: OpportunityStatus;
  rejectionReasons: string[];
}

/**
 * 機会評価（仕様書§8, §9）。
 * 判定ラダー: NET_PROFITABLE > GROSS_PROFITABLE > EXECUTABLE_DIVERGENCE > REFERENCE_ONLY > REJECTED
 * NET_PROFITABLEはHigh gas控除後の純利益で判定する。
 */
export function evaluateOpportunity(input: EvaluationInput): EvaluatedOpportunity {
  const { quote, thresholds: t } = input;
  const reasons: string[] = [];

  const base: EvaluatedOpportunity = {
    routeHash: input.routeHash,
    route: quote.route,
    inputAsset: quote.route[0] ?? "",
    amountInUsd: quote.amountInUsd,
    amountOutUsd: null,
    referenceDivergencePct:
      input.referenceDivergencePct !== null
        ? input.referenceDivergencePct.toFixed(4)
        : null,
    executableDivergencePct: null,
    grossProfitUsd: null,
    gasCostLowUsd: null,
    gasCostExpectedUsd: null,
    gasCostHighUsd: null,
    safetyBufferUsd: t.safetyBufferUsd.toFixed(2),
    netProfitUsd: null,
    netProfitPct: null,
    maxPriceImpactBps: null,
    status: "REJECTED",
    rejectionReasons: reasons,
  };

  if (!quote.success) {
    reasons.push(`QUOTE_FAILED:${quote.errorCode ?? "unknown"}`);
    return finalizeStatus(base, input, reasons);
  }

  const amountIn = new Decimal(quote.amountInUsd);
  const amountOut = new Decimal(quote.amountOutUsd);
  const gross = amountOut.minus(amountIn);
  base.amountOutUsd = amountOut.toFixed(2);
  base.grossProfitUsd = gross.toFixed(4);
  base.executableDivergencePct =
    input.roundTripPct !== null ? input.roundTripPct.toFixed(4) : null;
  base.maxPriceImpactBps = quote.priceImpactBps;

  // ガス3シナリオ（ETH価格が無いと計算不能）
  let netProfit: Decimal | null = null;
  if (input.gasPrices && input.ethUsd !== null) {
    const gas = input.gasPrices;
    base.gasCostLowUsd = gasCostUsd(
      quote.estimatedGasUnits, gas.lowWeiPerGas, input.ethUsd);
    base.gasCostExpectedUsd = gasCostUsd(
      quote.estimatedGasUnits, gas.expectedWeiPerGas, input.ethUsd);
    base.gasCostHighUsd = gasCostUsd(
      quote.estimatedGasUnits, gas.highWeiPerGas, input.ethUsd);
    // 純利益 = 粗利 - High gas - 安全マージン（flash loan手数料はPhase1では0 — §8.4）
    netProfit = gross
      .minus(new Decimal(base.gasCostHighUsd))
      .minus(t.safetyBufferUsd);
    base.netProfitUsd = netProfit.toFixed(4);
    base.netProfitPct = netProfit.div(amountIn).mul(100).toFixed(4);
  } else {
    reasons.push("NO_ETH_PRICE");
  }

  // NET_PROFITABLE条件（仕様書§9）を全チェックし、満たさない項目を理由として記録
  if (gross.lte(0)) reasons.push("GROSS_NOT_POSITIVE");
  if (netProfit === null || netProfit.lt(t.minimumNetProfitUsd)) {
    reasons.push("NET_PROFIT_BELOW_MIN_USD");
  }
  if (
    netProfit === null ||
    netProfit.div(amountIn).mul(100).lt(t.minimumNetProfitPct)
  ) {
    reasons.push("NET_PROFIT_BELOW_MIN_PCT");
  }
  if (quote.priceImpactBps > t.maximumPriceImpactPct * 100) {
    reasons.push("PRICE_IMPACT_TOO_HIGH");
  }
  if (quote.quoteLatencyMs > t.maximumQuoteLatencyMs) {
    reasons.push("QUOTE_LATENCY_TOO_HIGH");
  }

  return finalizeStatus(base, input, reasons);
}

function finalizeStatus(
  base: EvaluatedOpportunity,
  input: EvaluationInput,
  reasons: string[],
): EvaluatedOpportunity {
  const t = input.thresholds;
  const hasNetBlockers = reasons.length > 0;

  if (!hasNetBlockers) {
    base.status = "NET_PROFITABLE";
    return base;
  }
  const gross = base.grossProfitUsd !== null ? Number(base.grossProfitUsd) : null;
  if (gross !== null && gross > 0) {
    base.status = "GROSS_PROFITABLE";
    return base;
  }
  if (
    input.roundTripPct !== null &&
    input.roundTripPct >= t.executableAlertPct
  ) {
    base.status = "EXECUTABLE_DIVERGENCE";
    return base;
  }
  if (
    input.referenceDivergencePct !== null &&
    input.referenceDivergencePct >= t.referenceAlertPct
  ) {
    base.status = "REFERENCE_ONLY";
    return base;
  }
  base.status = "REJECTED";
  return base;
}
