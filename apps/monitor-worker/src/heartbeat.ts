import { hostname } from "node:os";
import type { Repositories } from "@pax/database";
import { logger } from "./logger.js";
import { updateHealth } from "./health.js";

const HEARTBEAT_INTERVAL_MS = 15_000; // 仕様書§7

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private lastBlockNumber: number | null = null;
  private status: "active" | "standby" | "degraded" | "stopped" = "standby";

  constructor(
    private readonly repos: Repositories,
    private readonly workerId: string,
    private readonly role: string,
    private readonly version: string,
  ) {}

  setStatus(status: "active" | "standby" | "degraded" | "stopped"): void {
    this.status = status;
  }

  setLastBlock(blockNumber: number): void {
    this.lastBlockNumber = blockNumber;
  }

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.status = "stopped";
    await this.beat().catch(() => {});
  }

  private async beat(): Promise<void> {
    try {
      await this.repos.heartbeats.upsert({
        worker_id: this.workerId,
        role: this.role,
        hostname: hostname(),
        version: this.version,
        status: this.status,
        last_block_number: this.lastBlockNumber,
        last_seen_at: new Date().toISOString(),
      });
      updateHealth({ lastHeartbeatAt: new Date().toISOString() });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "heartbeat failed");
    }
  }
}
