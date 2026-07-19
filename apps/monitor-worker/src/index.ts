import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { loadMonitorEnv } from "@pax/validation";
import { createRepositories, createServiceClient } from "@pax/database";
import { CHAIN_ID, ROUTES, type RouteId } from "@pax/chain-config";
import { UniswapV3Adapter } from "@pax/dex-uniswap-v3";
import { RouteQuoter } from "@pax/quote-engine";
import { QuoteStage } from "./quotes.js";
import { ReferencePriceService } from "./reference.js";
import { logger } from "./logger.js";
import { RpcManager, type RpcEndpoint } from "./rpc.js";
import { LeaseService } from "./lease.js";
import { HeartbeatService } from "./heartbeat.js";
import { BlockProcessor } from "./blocks.js";
import { updateHealth } from "./health.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  // 最初に必ず環境検証 — PRIVATE_KEYが設定されていたらここで起動失敗する（仕様書§18）
  const env = loadMonitorEnv();
  logger.info(
    { workerId: env.WORKER_ID, role: env.WORKER_ROLE, phase: env.PHASE },
    "monitor-worker starting (Phase 1: monitoring only, no trading)",
  );

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (!env.ETH_RPC_HTTP_PRIMARY) {
    throw new Error("ETH_RPC_HTTP_PRIMARY is required");
  }

  const db = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const repos = createRepositories(db);

  const endpoints: RpcEndpoint[] = [
    {
      name: "primary",
      httpUrl: env.ETH_RPC_HTTP_PRIMARY,
      wsUrl: env.ETH_RPC_WS_PRIMARY || undefined,
    },
  ];
  if (env.ETH_RPC_HTTP_SECONDARY) {
    endpoints.push({
      name: "secondary",
      httpUrl: env.ETH_RPC_HTTP_SECONDARY,
      wsUrl: env.ETH_RPC_WS_SECONDARY || undefined,
    });
  }

  const heartbeat = new HeartbeatService(
    repos,
    env.WORKER_ID,
    env.WORKER_ROLE,
    VERSION,
  );

  const lease = new LeaseService(
    repos,
    env.LEASE_NAME,
    env.WORKER_ID,
    env.LEASE_TTL_SECONDS,
    (isLeader, epoch) => {
      logger.info({ isLeader, epoch: epoch.toString() }, "leadership changed");
      heartbeat.setStatus(isLeader ? "active" : "standby");
      updateHealth({ isLeader });
    },
  );

  // Quote用クライアントはPrimary HTTPを直接使う（TODO: M5でRpcManagerのfailoverと統合）
  const quoteClient = createPublicClient({
    chain: mainnet,
    transport: http(env.ETH_RPC_HTTP_PRIMARY),
  });
  const adapter = new UniswapV3Adapter(quoteClient);
  const routeQuoter = new RouteQuoter(adapter, 3);
  const reference = new ReferencePriceService(10_000);
  const quoteStage = new QuoteStage(
    repos,
    routeQuoter,
    Object.keys(ROUTES) as RouteId[],
    reference,
  );

  const processor = new BlockProcessor(
    repos,
    CHAIN_ID,
    () => lease.isLeader,
    () => rpc.httpClient(),
    (observationId, blockNumber, gasInfo) =>
      quoteStage.run(observationId, blockNumber, gasInfo),
    () => reference.snapshot()?.ethUsd ?? null,
  );

  const rpc = new RpcManager(
    endpoints,
    async (event) => {
      if (event.block.number !== null) {
        heartbeat.setLastBlock(Number(event.block.number));
      }
      await processor.onNewBlock(event);
    },
    (status) => {
      logger.warn({ rpc: status }, "rpc status change");
      updateHealth({ rpcProvider: status.provider });
      // TODO(M6): SYSTEM通知（RPC切断・切替 — 仕様書§10）
    },
  );

  // 起動順: 参考価格 → lease → heartbeat → RPC購読
  await reference.start();
  await lease.start();
  await heartbeat.start();
  await rpc.start();

  logger.info("monitor-worker started");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    rpc.stop();
    reference.stop();
    await lease.stop();
    await heartbeat.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// 想定外例外でもエラーを記録してから終了する（docker restart: unless-stoppedで再起動）
process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: String(reason) }, "unhandled rejection");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "startup failed");
  process.exit(1);
});
