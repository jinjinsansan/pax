import type { Repositories, QuoteInsert } from "@pax/database";
import type { RouteId } from "@pax/chain-config";
import { QUOTE_TRIGGER } from "@pax/chain-config";
import type { RouteQuoter, RouteQuote } from "@pax/quote-engine";
import { logger } from "./logger.js";

const POOL_REFRESH_BLOCKS = 300; // 約1時間ごとにプール探索をやり直す

/**
 * ブロックごとのQuoteステージ（M4: 縮退モード固定）。
 * 現状は毎ブロック、縮退モード金額（$10,000）で全ルートをQuoteして保存する。
 * M5で参考価格レイヤーが入り、乖離>=0.30%時に全金額バーストへ昇格する。
 */
export class QuoteStage {
  private lastPoolRefresh = 0n;

  constructor(
    private readonly repos: Repositories,
    private readonly quoter: RouteQuoter,
    private readonly routeIds: RouteId[],
  ) {}

  async run(observationId: number, blockNumber: bigint): Promise<void> {
    if (
      this.lastPoolRefresh === 0n ||
      blockNumber - this.lastPoolRefresh >= BigInt(POOL_REFRESH_BLOCKS)
    ) {
      this.quoter.refreshPools();
      await this.quoter.warmup(this.routeIds);
      this.lastPoolRefresh = blockNumber;
    }

    const started = Date.now();
    const quotes = await this.quoter.quoteRoutes(
      this.routeIds,
      [...QUOTE_TRIGGER.degradedModeAmountsUsd],
      blockNumber,
    );

    await this.repos.quotes.insertMany(quotes.map((q) => toInsert(q, observationId)));

    const ok = quotes.filter((q) => q.result.success);
    const failed = quotes.length - ok.length;
    const bestRt = ok
      .map((q) => q.roundTripPct ?? -999)
      .reduce((a, b) => Math.max(a, b), -999);
    logger.info(
      {
        block: blockNumber.toString(),
        quotes: quotes.length,
        failed,
        bestRoundTripPct: bestRt === -999 ? null : Number(bestRt.toFixed(4)),
        totalMs: Date.now() - started,
      },
      "quotes saved",
    );
  }
}

function toInsert(q: RouteQuote, observationId: number): QuoteInsert {
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
