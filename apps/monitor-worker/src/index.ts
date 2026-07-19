import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { loadMonitorEnv } from "@pax/validation";
import { createRepositories, createServiceClient } from "@pax/database";
import { CHAIN_ID, ROUTES, type RouteId } from "@pax/chain-config";
import { UniswapV3Adapter } from "@pax/dex-uniswap-v3";
import { RouteQuoter } from "@pax/quote-engine";
import {
  AlertService,
  TelegramNotifier,
  formatSystem,
  formatBoot,
} from "@pax/notification";
import { DEFAULT_THRESHOLDS } from "@pax/chain-config";
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
      if (alerts) {
        void alerts.raise({
          severity: "SYSTEM",
          dedupeKey: `system:lease:${isLeader}`,
          text: formatSystem(
            isLeader ? "この監視プロセスが主担当になりました" : "主担当を別プロセスへ引き継ぎました",
            isLeader
              ? `測定の二重計上を防ぐリーダー選出の結果、${env.WORKER_ID} が記録係になりました。`
              : `${env.WORKER_ID} は待機に回ります。別プロセスが記録を継続します。`,
          ),
        });
      }
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

  let alerts: AlertService | null = null;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const notifier = new TelegramNotifier(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
    );
    alerts = new AlertService(repos.alerts, notifier, {
      cooldownSeconds: env.ALERT_COOLDOWN_SECONDS,
      recoveryThresholdPct: Number(DEFAULT_THRESHOLDS.recoveryThresholdPct),
      alertThresholdPct: env.REFERENCE_ALERT_PCT,
    });
    logger.info("telegram alerts enabled");
  } else {
    logger.warn("telegram alerts disabled (no token/chat id)");
  }

  const quoteStage = new QuoteStage(
    repos,
    routeQuoter,
    Object.keys(ROUTES) as RouteId[],
    reference,
    alerts,
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
      // RPC切断・切替のSYSTEM通知（仕様書§10、WS_CONNECTEDは平常のため除く）
      if (alerts && status.kind !== "WS_CONNECTED") {
        const explain =
          status.kind === "POLLING_FALLBACK"
            ? "Ethereumへのリアルタイム接続が切れたため、5秒間隔の予備方式に切り替えて監視を継続しています。データは途切れていません。リアルタイム接続の復旧も自動で試みます。"
            : `メインのブロックチェーン接続が不調のため、予備のプロバイダー（${status.provider}）へ自動で切り替えました。監視は継続しています。`;
        void alerts.raise({
          severity: "SYSTEM",
          dedupeKey: `system:rpc:${status.kind}`,
          text: formatSystem(
            status.kind === "POLLING_FALLBACK"
              ? "接続を予備方式へ切替"
              : "接続先を予備へ切替",
            explain,
          ),
        });
      }
    },
  );

  // 起動順: 参考価格 → lease → heartbeat → RPC購読
  await reference.start();
  await lease.start();
  await heartbeat.start();
  await rpc.start();

  logger.info("monitor-worker started");
  if (alerts) {
    await alerts.raise({
      severity: "SYSTEM",
      dedupeKey: "system:boot",
      text: formatBoot({ workerId: env.WORKER_ID, phase: env.PHASE }),
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    rpc.stop();
    reference.stop();
    await lease.stop();
    await heartbeat.stop();
    if (alerts) {
      await alerts
        .raise({
          severity: "SYSTEM",
          dedupeKey: "system:shutdown",
          text: formatSystem(
            "監視システムを停止します",
            `worker ${env.WORKER_ID} が停止信号（${signal}）を受け取りました。メンテナンス等の計画停止であれば、まもなく「起動しました」の通知が続きます。続かない場合は🚨警報が別途届きます。`,
          ),
        })
        .catch(() => {});
    }
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
