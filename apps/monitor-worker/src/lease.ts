import type { Repositories } from "@pax/database";
import { logger } from "./logger.js";

/**
 * リース管理（仕様書§14, §22）。
 * リース保持中のみ「leader」。leaderでないWorkerはDB保存・通知禁止。
 * epochはfencing token — 保持者交代で増える。古いepochの書込は将来的に拒否可能。
 */
export class LeaseService {
  private leader = false;
  private epoch = 0n;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly leaseName: string,
    private readonly holderId: string,
    private readonly ttlSeconds: number,
    private readonly onChange: (isLeader: boolean, epoch: bigint) => void,
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  get currentEpoch(): bigint {
    return this.epoch;
  }

  async start(): Promise<void> {
    await this.tick();
    // TTLの1/3間隔で更新（TTL45秒 → 15秒ごと）
    this.timer = setInterval(() => void this.tick(), (this.ttlSeconds * 1000) / 3);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.leader) {
      try {
        await this.repos.leases.release(this.leaseName, this.holderId);
        logger.info({ lease: this.leaseName }, "lease released");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "lease release failed");
      }
      this.setLeader(false, this.epoch);
    }
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.repos.leases.acquire(
        this.leaseName,
        this.holderId,
        this.ttlSeconds,
      );
      this.setLeader(result.acquired, BigInt(result.current_epoch));
      if (!result.acquired) {
        logger.debug(
          { holder: result.current_holder },
          "lease held by another worker",
        );
      }
    } catch (err) {
      // リース状態が確認できない場合は安全側（非leader）へ
      logger.error({ err: (err as Error).message }, "lease acquire failed");
      this.setLeader(false, this.epoch);
    }
  }

  private setLeader(isLeader: boolean, epoch: bigint): void {
    const changed = isLeader !== this.leader || epoch !== this.epoch;
    this.leader = isLeader;
    this.epoch = epoch;
    if (changed) this.onChange(isLeader, epoch);
  }
}
