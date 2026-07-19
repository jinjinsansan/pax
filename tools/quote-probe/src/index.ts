/**
 * quote-probe: 今この瞬間のPAXG/XAUT裁定ルートを実Quoteして表示するCLI。
 *   pnpm --filter @pax/quote-probe start
 * 「表示価格の乖離」ではなく「実際に交換したらいくら返るか」を出す。
 */
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ROUTES, DEFAULT_SIMULATION_AMOUNTS_USD, type RouteId } from "@pax/chain-config";
import { UniswapV3Adapter } from "@pax/dex-uniswap-v3";
import { RouteQuoter } from "@pax/quote-engine";

const rpcUrl = process.env["ETH_RPC_HTTP_PRIMARY"];
if (!rpcUrl) {
  console.error("ETH_RPC_HTTP_PRIMARY is required (.env.local)");
  process.exit(1);
}

const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
const adapter = new UniswapV3Adapter(client);
const quoter = new RouteQuoter(adapter, 3);

const routeIds = Object.keys(ROUTES) as RouteId[];
const amounts =
  process.argv.length > 2
    ? process.argv.slice(2).map(Number)
    : [...DEFAULT_SIMULATION_AMOUNTS_USD];

const blockNumber = await client.getBlockNumber();
console.log(`\n=== PAXG/XAUT Executable Quote Probe ===`);
console.log(`block: ${blockNumber}  amounts: ${amounts.join(", ")} USD\n`);

await quoter.warmup(routeIds);
const quotes = await quoter.quoteRoutes(routeIds, amounts, blockNumber);

console.log(
  "route  amount$    out$        roundTrip%   impact_bps  gas_units  ms",
);
for (const q of quotes) {
  const r = q.result;
  if (r.success) {
    console.log(
      [
        `${q.routeId} ${ROUTES[q.routeId].description.padEnd(30)}`,
        String(q.amountUsd).padStart(7),
        r.amountOutUsd.padStart(11),
        (q.roundTripPct ?? 0).toFixed(4).padStart(9) + "%",
        String(r.priceImpactBps).padStart(8),
        String(r.estimatedGasUnits).padStart(9),
        String(r.quoteLatencyMs).padStart(5),
      ].join("  "),
    );
  } else {
    console.log(
      `${q.routeId} ${ROUTES[q.routeId].description.padEnd(30)}  ${String(q.amountUsd).padStart(7)}  FAILED: ${r.errorCode}`,
    );
  }
}

const best = quotes
  .filter((q) => q.roundTripPct !== null)
  .sort((a, b) => (b.roundTripPct ?? 0) - (a.roundTripPct ?? 0))[0];
if (best) {
  console.log(
    `\nbest round trip: route ${best.routeId} @ $${best.amountUsd} → ${best.roundTripPct?.toFixed(4)}% (gas未控除)`,
  );
  console.log(
    "注意: これは実行可能乖離であり利益ではない。ガス代・安全マージン控除前。",
  );
}
