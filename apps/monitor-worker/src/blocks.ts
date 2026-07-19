import type { PublicClient } from "viem";
import type { Repositories } from "@pax/database";
import { logger } from "./logger.js";
import { updateHealth } from "./health.js";
import type { NewBlockEvent } from "./rpc.js";

/**
 * ブロック処理（仕様書§7の新ブロックパイプラインの土台）:
 *   gas data取得 → block_observation保存 → reorg検出
 * Quote取得と機会評価はM4/M5でこのクラスに接続する。
 */
export class BlockProcessor {
  /** 直近のblock番号→hash（reorg検出用、直近64ブロック保持） */
  private readonly recentHashes = new Map<number, string>();

  constructor(
    private readonly repos: Repositories,
    private readonly chainId: number,
    private readonly isLeader: () => boolean,
    private readonly getHttpClient: () => PublicClient,
  ) {}

  async onNewBlock(event: NewBlockEvent): Promise<void> {
    const { block, provider, latencyMs } = event;
    if (block.number === null || block.hash === null) return;
    const blockNumber = Number(block.number);

    updateHealth({ lastBlockNumber: blockNumber, lastBlockAt: new Date().toISOString() });

    // leaderでなければ保存しない（二重保存防止 — 仕様書§22）
    if (!this.isLeader()) {
      logger.debug({ block: blockNumber }, "not leader, skipping persist");
      return;
    }

    // reorg検出: 同じ番号で別hashを見たら旧行をorphaned化
    const knownHash = this.recentHashes.get(blockNumber);
    if (knownHash && knownHash !== block.hash) {
      logger.warn(
        { block: blockNumber, oldHash: knownHash, newHash: block.hash },
        "reorg detected",
      );
      const orphaned = await this.repos.blockObservations.markOrphaned(
        this.chainId,
        blockNumber,
        block.hash,
      );
      logger.warn({ block: blockNumber, orphaned }, "orphaned rows marked");
    }
    this.recentHashes.set(blockNumber, block.hash);
    this.pruneRecentHashes(blockNumber);

    // priority fee推定（取得失敗は許容し、null保存）
    let priorityFee: bigint | null = null;
    try {
      priorityFee = await this.getHttpClient().estimateMaxPriorityFeePerGas();
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "priority fee fetch failed");
    }

    const observationId = await this.repos.blockObservations.insert({
      chain_id: this.chainId,
      block_number: blockNumber,
      block_hash: block.hash,
      block_timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      base_fee_per_gas: block.baseFeePerGas?.toString() ?? null,
      priority_fee_per_gas: priorityFee?.toString() ?? null,
      eth_usd: null, // M4: 参考価格レイヤーで設定
      rpc_provider: provider,
      rpc_latency_ms: latencyMs,
    });

    logger.info(
      {
        block: blockNumber,
        observationId,
        baseFeeGwei: block.baseFeePerGas
          ? Number(block.baseFeePerGas) / 1e9
          : null,
        provider,
        latencyMs,
      },
      "block observed",
    );

    // TODO(M4): ここでQuoteエンジンを起動（トリガー式: 参考乖離>=0.30%で全量Quote）
    // TODO(M5): Opportunity評価 → DB保存 → Telegram判定
  }

  private pruneRecentHashes(current: number): void {
    for (const key of this.recentHashes.keys()) {
      if (key < current - 64) this.recentHashes.delete(key);
    }
  }
}
