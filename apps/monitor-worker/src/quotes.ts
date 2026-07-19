import type { Repositories, QuoteInsert, OpportunityInsert } from "@pax/database";
import type { RouteId } from "@pax/chain-config";
import {
  QUOTE_TRIGGER,
  DEFAULT_THRESHOLDS,
  DEFAULT_SIMULATION_AMOUNTS_USD,
} from "@pax/chain-config";
import type { RouteQuoter, RouteQuote } from "@pax/quote-engine";
import {
  evaluateOpportunity,
  gasScenariosFromBlock,
  type EvaluatedOpportunity,
  type EvaluationThresholds,
} from "@pax/opportunity-engine";
import type { ReferencePriceService } from "./reference.js";
import { logger } from "./logger.js";

const POOL_REFRESH_BLOCKS = 300; // 約1時間ごとにプール探索をやり直す

export interface BlockGasInfo {
  baseFeePerGas: bigint | null;
  priorityFeePerGas: bigint | null;
}

const THRESHOLDS: EvaluationThresholds = {
  executableAlertPct: Number(DEFAULT_THRESHOLDS.executableAlertPct),
  minimumNetProfitUsd: Number(DEFAULT_THRESHOLDS.minimumNetProfitUsd),
  minimumNetProfitPct: Number(DEFAULT_THRESHOLDS.minimumNetProfitPct),
  maximumPriceImpactPct: Number(DEFAULT_THRESHOLDS.maximumPriceImpactPct),
  maximumQuoteLatencyMs: DEFAULT_THRESHOLDS.maximumQuoteLatencyMs,
  referenceAlertPct: Number(DEFAULT_THRESHOLDS.referenceAlertPct),
  safetyBufferUsd: 25,
};

/**
 * ブロックごとのQuote＆機会評価パイプライン（仕様書§7 + トリガー式Quote戦略）。
 *
 * - 縮退モード（平常時）: 全ルート × $10,000 のみ。quotes保存。
 *   機会評価は粗利プラスのものだけopportunitiesへ保存（連続測定はquotesが担う）
 * - 全量モード: CEX参考乖離 >= 0.30% のとき、全ルート × 全6金額。
 *   全評価結果をopportunitiesへ保存（不成立も削除しない — §27）
 */
export class QuoteStage {
  private lastPoolRefresh = 0n;

  constructor(
    private readonly repos: Repositories,
    private readonly quoter: RouteQuoter,
    private readonly routeIds: RouteId[],
    private readonly reference: ReferencePriceService,
  ) {}

  async run(
    observationId: number,
    blockNumber: bigint,
    gasInfo: BlockGasInfo,
  ): Promise<void> {
    if (
      this.lastPoolRefresh === 0n ||
      blockNumber - this.lastPoolRefresh >= BigInt(POOL_REFRESH_BLOCKS)
    ) {
      this.quoter.refreshPools();
      await this.quoter.warmup(this.routeIds);
      this.lastPoolRefresh = blockNumber;
    }

    const ref = this.reference.snapshot();
    const refDivergence = ref?.divergencePct ?? null;
    const fullBurst =
      refDivergence !== null &&
      refDivergence >= Number(QUOTE_TRIGGER.fullQuoteTriggerPct);

    const amounts = fullBurst
      ? [...DEFAULT_SIMULATION_AMOUNTS_USD]
      : [...QUOTE_TRIGGER.degradedModeAmountsUsd];

    const started = Date.now();
    const quotes = await this.quoter.quoteRoutes(
      this.routeIds,
      amounts,
      blockNumber,
    );

    await this.repos.quotes.insertMany(
      quotes.map((q) => toQuoteInsert(q, observationId)),
    );

    // 機会評価
    const gasPrices =
      gasInfo.baseFeePerGas !== null
        ? gasScenariosFromBlock(
            gasInfo.baseFeePerGas,
            gasInfo.priorityFeePerGas ?? 1_000_000_000n,
          )
        : null;
    const evaluated = quotes.map((q) =>
      evaluateOpportunity({
        quote: q.result,
        routeHash: q.routeHash,
        amountUsd: q.amountUsd,
        roundTripPct: q.roundTripPct,
        referenceDivergencePct: refDivergence,
        gasPrices,
        ethUsd: ref?.ethUsd ?? null,
        thresholds: THRESHOLDS,
      }),
    );

    const toSave = fullBurst
      ? evaluated
      : evaluated.filter(
          (e) =>
            e.grossProfitUsd !== null && Number(e.grossProfitUsd) > 0,
        );
    if (toSave.length > 0) {
      await this.repos.opportunities.insertMany(
        toSave.map((e) => toOpportunityInsert(e, observationId)),
      );
    }

    const profitable = evaluated.filter((e) => e.status === "NET_PROFITABLE");
    if (profitable.length > 0) {
      // TODO(M6): Telegram PROFITABLE通知
      logger.warn(
        { block: blockNumber.toString(), count: profitable.length },
        "NET_PROFITABLE opportunities detected!",
      );
    }

    const ok = quotes.filter((q) => q.result.success);
    const bestRt = ok
      .map((q) => q.roundTripPct ?? -999)
      .reduce((a, b) => Math.max(a, b), -999);
    logger.info(
      {
        block: blockNumber.toString(),
        mode: fullBurst ? "FULL_BURST" : "degraded",
        refDivergencePct:
          refDivergence !== null ? Number(refDivergence.toFixed(4)) : null,
        ethUsd: ref?.ethUsd ?? null,
        quotes: quotes.length,
        failed: quotes.length - ok.length,
        bestRoundTripPct: bestRt === -999 ? null : Number(bestRt.toFixed(4)),
        opportunitiesSaved: toSave.length,
        totalMs: Date.now() - started,
      },
      "pipeline done",
    );
  }
}

function toQuoteInsert(q: RouteQuote, observationId: number): QuoteInsert {
  const r = q.result;
  return {
    observation_id: observationId,
    route_hash: q.routeHash,
    dex: r.dex,
    route: q.route,
    amount_in_raw: r.amountInRaw.toString(),
    amount_out_raw: r.success ? r.amountOutRaw.toString() : null,
    amount_in_usd: r.amountInUsd,
    amount_out_usd: r.success ? r.amountOutUsd : null,
    fee_usd: null,
    price_impact_bps: r.success ? r.priceImpactBps : null,
    estimated_gas_units: r.estimatedGasUnits.toString(),
    quote_latency_ms: r.quoteLatencyMs,
    success: r.success,
    error_code: r.errorCode ?? null,
  };
}

function toOpportunityInsert(
  e: EvaluatedOpportunity,
  observationId: number,
): OpportunityInsert {
  return {
    observation_id: observationId,
    route_hash: e.routeHash,
    route: e.route,
    input_asset: e.inputAsset,
    amount_in_usd: e.amountInUsd,
    amount_out_usd: e.amountOutUsd,
    reference_divergence_pct: e.referenceDivergencePct,
    executable_divergence_pct: e.executableDivergencePct,
    gross_profit_usd: e.grossProfitUsd,
    gas_cost_low_usd: e.gasCostLowUsd,
    gas_cost_expected_usd: e.gasCostExpectedUsd,
    gas_cost_high_usd: e.gasCostHighUsd,
    safety_buffer_usd: e.safetyBufferUsd,
    net_profit_usd: e.netProfitUsd,
    net_profit_pct: e.netProfitPct,
    max_price_impact_bps: e.maxPriceImpactBps,
    status: e.status,
    rejection_reasons: e.rejectionReasons,
  };
}
