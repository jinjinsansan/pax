import {
  createPublicClient,
  http,
  webSocket,
  type PublicClient,
  type Block,
} from "viem";
import { mainnet } from "viem/chains";
import { logger } from "./logger.js";

/**
 * RPC管理（仕様書§7, §22）:
 *   1. WebSocketで newHeads 購読
 *   2. 切断時は HTTP polling（5秒）へ縮退
 *   3. WebSocket再接続を試行
 *   4. 連続3回失敗で Primary <-> Secondary 切替
 */

export interface RpcEndpoint {
  name: string;
  httpUrl: string;
  wsUrl?: string | undefined;
}

export interface NewBlockEvent {
  block: Block;
  provider: string;
  latencyMs: number;
}

export type BlockHandler = (event: NewBlockEvent) => Promise<void>;
export type RpcStatusHandler = (event: {
  kind: "WS_CONNECTED" | "WS_DISCONNECTED" | "POLLING_FALLBACK" | "PROVIDER_SWITCHED";
  provider: string;
  detail?: string;
}) => void;

const POLL_INTERVAL_MS = 5_000;
const WS_RETRY_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export class RpcManager {
  private readonly endpoints: RpcEndpoint[];
  private activeIndex = 0;
  private consecutiveFailures = 0;
  private unwatch: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private wsRetryTimer: NodeJS.Timeout | null = null;
  private lastSeenBlock = 0n;
  private lastSeenHash: string | null = null;
  private stopped = false;

  constructor(
    endpoints: RpcEndpoint[],
    private readonly onBlock: BlockHandler,
    private readonly onStatus: RpcStatusHandler,
  ) {
    if (endpoints.length === 0) {
      throw new Error("at least one RPC endpoint is required");
    }
    this.endpoints = endpoints;
  }

  get active(): RpcEndpoint {
    const ep = this.endpoints[this.activeIndex];
    if (!ep) throw new Error("no active endpoint");
    return ep;
  }

  httpClient(): PublicClient {
    return createPublicClient({
      chain: mainnet,
      transport: http(this.active.httpUrl),
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.active.wsUrl) {
      this.trySubscribeWs();
    } else {
      this.startPolling();
    }
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
  }

  private trySubscribeWs(): void {
    if (this.stopped) return;
    const ep = this.active;
    if (!ep.wsUrl) {
      this.startPolling();
      return;
    }
    try {
      const wsClient = createPublicClient({
        chain: mainnet,
        transport: webSocket(ep.wsUrl, { retryCount: 2 }),
      });
      this.unwatch = wsClient.watchBlocks({
        emitOnBegin: true,
        emitMissed: true,
        onBlock: (block) => {
          this.stopPolling();
          this.consecutiveFailures = 0;
          // WS pushは要求-応答でないため、ブロック時刻からの到達遅延を記録
          const arrivalDelayMs =
            block?.timestamp != null
              ? Math.max(0, Date.now() - Number(block.timestamp) * 1000)
              : 0;
          void this.emitBlock(block, ep.name, arrivalDelayMs);
        },
        onError: (err) => {
          logger.warn({ provider: ep.name, err: err.message }, "ws watch error");
          this.handleFailure("ws error: " + err.message);
        },
      });
      this.onStatus({ kind: "WS_CONNECTED", provider: ep.name });
    } catch (err) {
      logger.warn(
        { provider: ep.name, err: (err as Error).message },
        "ws subscribe failed",
      );
      this.handleFailure("ws subscribe failed");
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    const ep = this.active;
    this.onStatus({ kind: "POLLING_FALLBACK", provider: ep.name });
    const client = this.httpClient();
    this.pollTimer = setInterval(() => {
      void (async () => {
        const started = Date.now();
        try {
          const block = await client.getBlock({ blockTag: "latest" });
          this.consecutiveFailures = 0;
          await this.emitBlock(block, ep.name, Date.now() - started);
        } catch (err) {
          logger.warn(
            { provider: ep.name, err: (err as Error).message },
            "poll failed",
          );
          this.handleFailure("poll failed");
        }
      })();
    }, POLL_INTERVAL_MS);
    // pollingで凌ぎつつWS復帰を試みる
    this.scheduleWsRetry();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleWsRetry(): void {
    if (this.wsRetryTimer || this.stopped || !this.active.wsUrl) return;
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      if (this.pollTimer) {
        logger.info({ provider: this.active.name }, "retrying ws subscription");
        this.trySubscribeWs();
        this.scheduleWsRetry();
      }
    }, WS_RETRY_INTERVAL_MS);
  }

  private handleFailure(detail: string): void {
    this.consecutiveFailures += 1;
    this.unwatch?.();
    this.unwatch = null;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const prev = this.active.name;
      this.activeIndex = (this.activeIndex + 1) % this.endpoints.length;
      this.consecutiveFailures = 0;
      this.stopPolling();
      this.onStatus({
        kind: "PROVIDER_SWITCHED",
        provider: this.active.name,
        detail: `from ${prev}: ${detail}`,
      });
      this.trySubscribeWs();
    } else {
      this.startPolling();
    }
  }

  private async emitBlock(
    block: Block | undefined,
    provider: string,
    latencyMs: number,
  ): Promise<void> {
    // viem WS購読は稀にundefined/不完全なブロックを渡すことがある
    if (!block || block.number === null || block.hash === null) return;
    // 逆行ブロックと完全重複は無視。同番号別hash（reorg）は通す
    if (block.number < this.lastSeenBlock) return;
    if (block.number === this.lastSeenBlock && block.hash === this.lastSeenHash) {
      return;
    }
    this.lastSeenBlock = block.number;
    this.lastSeenHash = block.hash;
    try {
      await this.onBlock({ block, provider, latencyMs });
    } catch (err) {
      // ハンドラ内エラーは握り潰さずログ（仕様書§27: エラーを握り潰すな）
      logger.error(
        { block: block.number.toString(), err: (err as Error).message },
        "block handler failed",
      );
    }
  }
}
