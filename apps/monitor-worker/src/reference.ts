import { logger } from "./logger.js";

/**
 * CEX参考価格レイヤー（設計議論 2026-07-19）。
 * 複数取引所の中央値でPAXG/XAUT/ETHのUSD価格を保持し、参考乖離を常時計算する。
 * この値は補助情報であり売買判断の直接根拠にしない（仕様書§1）。
 * 参考乖離 >= トリガー閾値 のとき全量Quoteバーストへ昇格させる。
 */

export interface ReferenceSnapshot {
  paxgUsd: number | null;
  xautUsd: number | null;
  ethUsd: number | null;
  /** 仕様書§8.1: |paxg - xaut| / min * 100 */
  divergencePct: number | null;
  ageMs: number;
  sourceCount: { paxg: number; xaut: number; eth: number };
}

type Prices = { paxg: number[]; xaut: number[]; eth: number[] };

const FETCH_TIMEOUT_MS = 4_000;
const STALE_MS = 60_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "pax-monitor/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBingx(into: Prices): Promise<void> {
  const symbols: { s: string; key: keyof Prices }[] = [
    { s: "PAXG-USDT", key: "paxg" },
    { s: "XAUT-USDT", key: "xaut" },
    { s: "ETH-USDT", key: "eth" },
  ];
  await Promise.all(
    symbols.map(async ({ s, key }) => {
      const body = (await getJson(
        `https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${s}`,
      )) as { data?: { lastPrice?: number | string }[] };
      const price = Number(body.data?.[0]?.lastPrice);
      if (Number.isFinite(price) && price > 0) into[key].push(price);
    }),
  );
}

async function fetchBitfinex(into: Prices): Promise<void> {
  // XAUTの本拠地。tXAUT:USD と tETHUSD
  const body = (await getJson(
    "https://api-pub.bitfinex.com/v2/tickers?symbols=tXAUT:USD,tETHUSD",
  )) as [string, ...number[]][];
  for (const row of body) {
    const symbol = row[0];
    const lastPrice = row[7]; // LAST_PRICE
    if (typeof lastPrice !== "number" || lastPrice <= 0) continue;
    if (symbol === "tXAUT:USD") into.xaut.push(lastPrice);
    if (symbol === "tETHUSD") into.eth.push(lastPrice);
  }
}

async function fetchKraken(into: Prices): Promise<void> {
  const body = (await getJson(
    "https://api.kraken.com/0/public/Ticker?pair=PAXGUSD",
  )) as { result?: Record<string, { c?: [string, string] }> };
  const first = Object.values(body.result ?? {})[0];
  const price = Number(first?.c?.[0]);
  if (Number.isFinite(price) && price > 0) into.paxg.push(price);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid];
  const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid];
  if (a === undefined || b === undefined) return null;
  return (a + b) / 2;
}

export class ReferencePriceService {
  private timer: NodeJS.Timeout | null = null;
  private last: ReferenceSnapshot | null = null;
  private lastUpdatedAt = 0;

  constructor(private readonly intervalMs = 10_000) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** stale（60秒超）ならnullを返す — 古い参考価格で判定しない（仕様書§9） */
  snapshot(): ReferenceSnapshot | null {
    if (!this.last) return null;
    const ageMs = Date.now() - this.lastUpdatedAt;
    if (ageMs > STALE_MS) return null;
    return { ...this.last, ageMs };
  }

  private async refresh(): Promise<void> {
    const prices: Prices = { paxg: [], xaut: [], eth: [] };
    const results = await Promise.allSettled([
      fetchBingx(prices),
      fetchBitfinex(prices),
      fetchKraken(prices),
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    for (const f of failures) {
      logger.debug(
        { err: (f as PromiseRejectedResult).reason?.message ?? "unknown" },
        "reference source failed",
      );
    }

    const paxg = median(prices.paxg);
    const xaut = median(prices.xaut);
    const eth = median(prices.eth);
    const divergencePct =
      paxg !== null && xaut !== null
        ? (Math.abs(paxg - xaut) / Math.min(paxg, xaut)) * 100
        : null;

    this.last = {
      paxgUsd: paxg,
      xautUsd: xaut,
      ethUsd: eth,
      divergencePct,
      ageMs: 0,
      sourceCount: {
        paxg: prices.paxg.length,
        xaut: prices.xaut.length,
        eth: prices.eth.length,
      },
    };
    this.lastUpdatedAt = Date.now();
  }
}
