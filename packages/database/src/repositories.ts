import type { ArbClient } from "./client.js";
import type {
  AlertInsert,
  BlockObservationInsert,
  HeartbeatUpsert,
  LeaseResult,
  OpportunityInsert,
  QuoteInsert,
  SystemConfigRow,
} from "./rows.js";

class DbError extends Error {
  constructor(op: string, cause: { message: string; code?: string }) {
    super(`${op} failed: ${cause.code ?? ""} ${cause.message}`);
    this.name = "DbError";
  }
}

export class BlockObservationRepo {
  constructor(private readonly db: ArbClient) {}

  /** 挿入してIDを返す。同一(chain,block,hash)が既存ならそのIDを返す */
  async insert(row: BlockObservationInsert): Promise<number> {
    const { data, error } = await this.db
      .from("block_observations")
      .upsert(row, {
        onConflict: "chain_id,block_number,block_hash",
        ignoreDuplicates: false,
      })
      .select("id")
      .single();
    if (error) throw new DbError("block_observations.insert", error);
    return (data as { id: number }).id;
  }

  /** reorg検出: 同一block_numberで別hashの行をorphaned化 */
  async markOrphaned(
    chainId: number,
    blockNumber: number,
    canonicalHash: string,
  ): Promise<number> {
    const { data, error } = await this.db
      .from("block_observations")
      .update({ orphaned: true })
      .eq("chain_id", chainId)
      .eq("block_number", blockNumber)
      .neq("block_hash", canonicalHash)
      .eq("orphaned", false)
      .select("id");
    if (error) throw new DbError("block_observations.markOrphaned", error);
    return (data ?? []).length;
  }
}

export class QuoteRepo {
  constructor(private readonly db: ArbClient) {}

  async insertMany(rows: QuoteInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from("quotes").insert(rows);
    if (error) throw new DbError("quotes.insertMany", error);
  }
}

export class OpportunityRepo {
  constructor(private readonly db: ArbClient) {}

  async insertMany(rows: OpportunityInsert[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const { data, error } = await this.db
      .from("opportunities")
      .insert(rows)
      .select("id");
    if (error) throw new DbError("opportunities.insertMany", error);
    return (data ?? []).map((r) => (r as { id: string }).id);
  }
}

export class AlertRepo {
  constructor(private readonly db: ArbClient) {}

  async insert(row: AlertInsert): Promise<string> {
    const { data, error } = await this.db
      .from("alerts")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new DbError("alerts.insert", error);
    return (data as { id: string }).id;
  }

  async updateDelivery(
    id: string,
    deliveryStatus: string,
    providerResponse?: Record<string, unknown>,
    retryCount?: number,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      delivery_status: deliveryStatus,
    };
    if (deliveryStatus === "SENT") patch["sent_at"] = new Date().toISOString();
    if (providerResponse !== undefined) patch["provider_response"] = providerResponse;
    if (retryCount !== undefined) patch["retry_count"] = retryCount;
    const { error } = await this.db.from("alerts").update(patch).eq("id", id);
    if (error) throw new DbError("alerts.updateDelivery", error);
  }

  /** cooldown判定用: 同一dedupe_keyの直近送信時刻 */
  async lastSentAt(dedupeKey: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("alerts")
      .select("sent_at")
      .eq("dedupe_key", dedupeKey)
      .eq("delivery_status", "SENT")
      .order("sent_at", { ascending: false })
      .limit(1);
    if (error) throw new DbError("alerts.lastSentAt", error);
    const row = (data ?? [])[0] as { sent_at: string | null } | undefined;
    return row?.sent_at ?? null;
  }
}

export class HeartbeatRepo {
  constructor(private readonly db: ArbClient) {}

  async upsert(row: HeartbeatUpsert): Promise<void> {
    const { error } = await this.db
      .from("worker_heartbeats")
      .upsert(row, { onConflict: "worker_id" });
    if (error) throw new DbError("worker_heartbeats.upsert", error);
  }
}

export class LeaseRepo {
  constructor(private readonly db: ArbClient) {}

  /** arb.acquire_lease() — 原子的取得/更新。失敗時はacquired=falseと現保持者を返す */
  async acquire(
    leaseName: string,
    holderId: string,
    ttlSeconds: number,
  ): Promise<LeaseResult> {
    const { data, error } = await this.db.rpc("acquire_lease", {
      p_lease_name: leaseName,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new DbError("acquire_lease", error);
    const row = (data as LeaseResult[] | null)?.[0];
    if (!row) throw new Error("acquire_lease returned no rows");
    return row;
  }

  /** graceful shutdown時に自分のリースを手放す */
  async release(leaseName: string, holderId: string): Promise<void> {
    const { error } = await this.db
      .from("worker_leases")
      .delete()
      .eq("lease_name", leaseName)
      .eq("holder_id", holderId);
    if (error) throw new DbError("worker_leases.release", error);
  }
}

export class SystemConfigRepo {
  constructor(private readonly db: ArbClient) {}

  async getAll(): Promise<Map<string, unknown>> {
    const { data, error } = await this.db
      .from("system_config")
      .select("key, value, is_secret, updated_at");
    if (error) throw new DbError("system_config.getAll", error);
    return new Map(
      ((data ?? []) as SystemConfigRow[]).map((r) => [r.key, r.value]),
    );
  }
}

export class AuditLogRepo {
  constructor(private readonly db: ArbClient) {}

  async record(
    actorType: string,
    action: string,
    target?: { type: string; id: string },
    before?: unknown,
    after?: unknown,
  ): Promise<void> {
    const { error } = await this.db.from("audit_logs").insert({
      actor_type: actorType,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      before_data: before ?? null,
      after_data: after ?? null,
    });
    if (error) throw new DbError("audit_logs.record", error);
  }
}

export interface Repositories {
  blockObservations: BlockObservationRepo;
  quotes: QuoteRepo;
  opportunities: OpportunityRepo;
  alerts: AlertRepo;
  heartbeats: HeartbeatRepo;
  leases: LeaseRepo;
  systemConfig: SystemConfigRepo;
  auditLogs: AuditLogRepo;
}

export function createRepositories(db: ArbClient): Repositories {
  return {
    blockObservations: new BlockObservationRepo(db),
    quotes: new QuoteRepo(db),
    opportunities: new OpportunityRepo(db),
    alerts: new AlertRepo(db),
    heartbeats: new HeartbeatRepo(db),
    leases: new LeaseRepo(db),
    systemConfig: new SystemConfigRepo(db),
    auditLogs: new AuditLogRepo(db),
  };
}
