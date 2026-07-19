import type { AlertSeverity } from "@pax/shared-types";
import type { Notifier } from "./telegram.js";

/**
 * アラートゲート＆配信（仕様書§10）。
 *
 * dedupe key: route_hash + amount_in + severity + divergence_bucket
 * cooldown中でも再通知する条件:
 *   - レベル上昇（INFO < OPPORTUNITY < PROFITABLE）
 *   - 純利益が前回最高値を更新（25%以上増を包含）
 *   - recovery threshold以下へ戻った後の再発
 *   - cooldown経過（=5分以上経過）
 *
 * 状態はin-memory（Worker再起動でリセット。再起動直後に1回重複通知があり得るが許容）。
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  INFO: 1,
  OPPORTUNITY: 2,
  PROFITABLE: 3,
  SYSTEM: 0, // SYSTEMは独立キーで扱い、ランク比較に参加しない
};

interface GateState {
  lastSentAtMs: number;
  lastRank: number;
  maxNetProfitUsd: number | null;
  wentBelowRecovery: boolean;
}

export interface AlertRequest {
  severity: AlertSeverity;
  dedupeKey: string;
  text: string;
  opportunityId?: string | undefined;
  netProfitUsd?: number | undefined;
  divergencePct?: number | undefined;
}

export interface AlertRecord {
  insert(row: {
    opportunity_id?: string | null;
    channel: string;
    severity: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    delivery_status: string;
  }): Promise<string>;
  updateDelivery(
    id: string,
    deliveryStatus: string,
    providerResponse?: Record<string, unknown>,
    retryCount?: number,
  ): Promise<void>;
}

export interface AlertServiceOptions {
  cooldownSeconds: number;
  recoveryThresholdPct: number;
  alertThresholdPct: number;
  maxRetries?: number;
  /** テスト用: backoff遅延（ms）を差し替え */
  retryDelaysMs?: number[];
}

export type GateDecision =
  | { send: true; reason: string }
  | { send: false; reason: string };

export class AlertService {
  private readonly states = new Map<string, GateState>();
  private readonly retryDelays: number[];
  private readonly maxRetries: number;

  constructor(
    private readonly repo: AlertRecord,
    private readonly notifier: Notifier,
    private readonly opts: AlertServiceOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.maxRetries = opts.maxRetries ?? 5;
    this.retryDelays = opts.retryDelaysMs ?? [1000, 2000, 4000, 8000, 16000];
  }

  /** ゲート判定のみ（送信しない） — テスト可能な純粋ロジック */
  decide(req: AlertRequest): GateDecision {
    const state = this.states.get(req.dedupeKey);
    const cooldownMs = this.opts.cooldownSeconds * 1000;
    const rank = SEVERITY_RANK[req.severity] ?? 0;

    // recovery追跡: 乖離が閾値未満へ落ちたら記録（送信はしない）
    if (
      state &&
      req.divergencePct !== undefined &&
      req.divergencePct < this.opts.recoveryThresholdPct
    ) {
      state.wentBelowRecovery = true;
      return { send: false, reason: "below_recovery_threshold" };
    }

    if (!state) return { send: true, reason: "first" };

    const elapsed = this.now() - state.lastSentAtMs;
    if (elapsed >= cooldownMs) return { send: true, reason: "cooldown_expired" };
    if (rank > state.lastRank) return { send: true, reason: "level_up" };
    if (
      req.netProfitUsd !== undefined &&
      state.maxNetProfitUsd !== null &&
      req.netProfitUsd > state.maxNetProfitUsd
    ) {
      return { send: true, reason: "new_high" };
    }
    if (
      state.wentBelowRecovery &&
      req.divergencePct !== undefined &&
      req.divergencePct >= this.opts.alertThresholdPct
    ) {
      return { send: true, reason: "recovered_and_recrossed" };
    }
    return { send: false, reason: "cooldown" };
  }

  /** ゲート判定 → alerts記録 → 送信 → 結果更新（失敗時はbackoff再送、最大5回） */
  async raise(req: AlertRequest): Promise<{ sent: boolean; reason: string }> {
    const decision = this.decide(req);
    if (!decision.send) return { sent: false, reason: decision.reason };

    this.markSent(req);

    const alertId = await this.repo.insert({
      opportunity_id: req.opportunityId ?? null,
      channel: "telegram",
      severity: req.severity,
      dedupe_key: req.dedupeKey,
      payload: { text: req.text, gateReason: decision.reason },
      delivery_status: "PENDING",
    });

    const first = await this.notifier.send(req.text);
    if (first.ok) {
      await this.repo.updateDelivery(
        alertId,
        "SENT",
        first.response as Record<string, unknown>,
        0,
      );
      return { sent: true, reason: decision.reason };
    }

    await this.repo.updateDelivery(
      alertId,
      "RETRYING",
      first.response as Record<string, unknown>,
      0,
    );
    // 再送はバックグラウンドで（パイプラインをブロックしない）
    void this.retryLoop(alertId, req.text);
    return { sent: true, reason: `${decision.reason} (retrying)` };
  }

  private markSent(req: AlertRequest): void {
    const prev = this.states.get(req.dedupeKey);
    const netProfit = req.netProfitUsd ?? null;
    this.states.set(req.dedupeKey, {
      lastSentAtMs: this.now(),
      lastRank: SEVERITY_RANK[req.severity] ?? 0,
      maxNetProfitUsd:
        prev?.maxNetProfitUsd !== null && prev?.maxNetProfitUsd !== undefined
          ? Math.max(prev.maxNetProfitUsd, netProfit ?? -Infinity)
          : netProfit,
      wentBelowRecovery: false,
    });
  }

  private async retryLoop(alertId: string, text: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const delay = this.retryDelays[attempt - 1] ?? 16000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const result = await this.notifier.send(text);
      if (result.ok) {
        await this.repo
          .updateDelivery(
            alertId,
            "SENT",
            result.response as Record<string, unknown>,
            attempt,
          )
          .catch(() => {});
        return;
      }
      await this.repo
        .updateDelivery(
          alertId,
          attempt === this.maxRetries ? "FAILED" : "RETRYING",
          result.response as Record<string, unknown>,
          attempt,
        )
        .catch(() => {});
    }
  }
}
