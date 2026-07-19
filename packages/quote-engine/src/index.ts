import type { Address, QuoteResult } from "@pax/shared-types";
import {
  ROUTES,
  TOKENS,
  routeAddresses,
  type RouteConfig,
  type RouteId,
} from "@pax/chain-config";
import { UniswapV3Adapter, computeRouteHash } from "@pax/dex-uniswap-v3";

export interface RouteQuote {
  routeId: RouteId;
  routeHash: string;
  route: Address[];
  amountUsd: number;
  result: QuoteResult;
  /** 循環ルートの往復収支（%）: (out/in - 1) * 100。失敗時null */
  roundTripPct: number | null;
}

/**
 * ルート×金額の一括Quote実行（仕様書§7）。
 * - 金額ごとに個別Quote（単純比例の禁止 — §27)
 * - 失敗Quoteもそのまま返す（呼び出し側が保存する）
 */
export class RouteQuoter {
  constructor(
    private readonly adapter: UniswapV3Adapter,
    private readonly concurrency = 4,
  ) {}

  /** 起動時・定期リフレッシュ時に呼ぶ */
  async warmup(routeIds: RouteId[]): Promise<void> {
    for (const id of routeIds) {
      await this.adapter.ensurePoolsForRoute(routeAddresses(ROUTES[id]));
    }
  }

  refreshPools(): void {
    this.adapter.invalidatePoolCache();
  }

  async quoteRoutes(
    routeIds: RouteId[],
    amountsUsd: number[],
    blockNumber?: bigint,
  ): Promise<RouteQuote[]> {
    const jobs: { route: RouteConfig; amountUsd: number }[] = [];
    for (const id of routeIds) {
      for (const amountUsd of amountsUsd) {
        jobs.push({ route: ROUTES[id], amountUsd });
      }
    }

    const results: RouteQuote[] = [];
    for (let i = 0; i < jobs.length; i += this.concurrency) {
      const chunk = jobs.slice(i, i + this.concurrency);
      const chunkResults = await Promise.all(
        chunk.map((job) => this.quoteOne(job.route, job.amountUsd, blockNumber)),
      );
      results.push(...chunkResults);
    }
    return results;
  }

  private async quoteOne(
    route: RouteConfig,
    amountUsd: number,
    blockNumber?: bigint,
  ): Promise<RouteQuote> {
    const addresses = routeAddresses(route);
    const inputSymbol = route.symbols[0];
    if (!inputSymbol) throw new Error(`route ${route.id} is empty`);
    const inputToken = TOKENS[inputSymbol];
    if (!inputToken.isQuoteAsset) {
      throw new Error(`route ${route.id} must start with a quote asset`);
    }

    // USD建て金額 → raw（USDT/USDCは1:1 USDペッグ前提の近似 — Phase 1）
    const amountInRaw =
      BigInt(Math.round(amountUsd)) * 10n ** BigInt(inputToken.decimals);

    const result = await this.adapter.getQuoteExactInput({
      chainId: 1,
      route: addresses,
      amountInRaw,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });

    // 入出力が同一quote資産の循環ルートなのでUSD換算はdecimalsで割るだけ
    const divisor = 10 ** inputToken.decimals;
    const amountInUsd = (Number(result.amountInRaw) / divisor).toFixed(2);
    const amountOutUsd = result.success
      ? (Number(result.amountOutRaw) / divisor).toFixed(2)
      : "0";

    const roundTripPct = result.success
      ? (Number(result.amountOutRaw) / Number(result.amountInRaw) - 1) * 100
      : null;

    return {
      routeId: route.id,
      routeHash: computeRouteHash("uniswap-v3", addresses),
      route: addresses,
      amountUsd,
      result: { ...result, amountInUsd, amountOutUsd },
      roundTripPct,
    };
  }
}

export { computeRouteHash };
