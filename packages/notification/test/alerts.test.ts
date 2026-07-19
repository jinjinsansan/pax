import { describe, expect, it } from "vitest";
import { AlertService, type AlertRecord } from "../src/index.js";
import type { Notifier } from "../src/index.js";

function makeService(nowRef: { t: number }) {
  const sent: string[] = [];
  const rows: { id: string; status: string }[] = [];
  const notifier: Notifier = {
    send: (text) => {
      sent.push(text);
      return Promise.resolve({ ok: true, response: {} });
    },
  };
  const repo: AlertRecord = {
    insert: (row) => {
      const id = `a${rows.length}`;
      rows.push({ id, status: row.delivery_status });
      return Promise.resolve(id);
    },
    updateDelivery: (id, status) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
      return Promise.resolve();
    },
  };
  const service = new AlertService(
    repo,
    notifier,
    {
      cooldownSeconds: 300,
      recoveryThresholdPct: 0.35,
      alertThresholdPct: 0.5,
    },
    () => nowRef.t,
  );
  return { service, sent, rows };
}

describe("AlertService gate", () => {
  it("初回は送信、cooldown内の同一キーはブロック", async () => {
    const now = { t: 0 };
    const { service, sent } = makeService(now);
    const req = { severity: "INFO" as const, dedupeKey: "k1", text: "m1" };

    expect((await service.raise(req)).sent).toBe(true);
    now.t = 60_000; // 1分後
    expect((await service.raise(req)).sent).toBe(false);
    now.t = 301_000; // cooldown経過
    expect((await service.raise(req)).sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("cooldown中でもレベル上昇は再通知", async () => {
    const now = { t: 0 };
    const { service } = makeService(now);
    await service.raise({ severity: "OPPORTUNITY", dedupeKey: "k", text: "m" });
    now.t = 10_000;
    const result = await service.raise({
      severity: "PROFITABLE",
      dedupeKey: "k",
      text: "m2",
    });
    expect(result.sent).toBe(true);
    expect(result.reason).toBe("level_up");
  });

  it("cooldown中でも純利益の最高値更新は再通知", async () => {
    const now = { t: 0 };
    const { service } = makeService(now);
    await service.raise({
      severity: "PROFITABLE",
      dedupeKey: "k",
      text: "m",
      netProfitUsd: 100,
    });
    now.t = 10_000;
    expect(
      (
        await service.raise({
          severity: "PROFITABLE",
          dedupeKey: "k",
          text: "m",
          netProfitUsd: 90,
        })
      ).sent,
    ).toBe(false);
    const higher = await service.raise({
      severity: "PROFITABLE",
      dedupeKey: "k",
      text: "m",
      netProfitUsd: 130,
    });
    expect(higher.sent).toBe(true);
    expect(higher.reason).toBe("new_high");
  });

  it("recovery閾値未満へ戻った後の再発は再通知", async () => {
    const now = { t: 0 };
    const { service } = makeService(now);
    await service.raise({
      severity: "INFO",
      dedupeKey: "k",
      text: "m",
      divergencePct: 0.55,
    });
    now.t = 10_000;
    // 0.30%へ低下 → 送信されず、recovery記録
    expect(
      (
        await service.raise({
          severity: "INFO",
          dedupeKey: "k",
          text: "m",
          divergencePct: 0.3,
        })
      ).sent,
    ).toBe(false);
    now.t = 20_000;
    // 再度0.5%超え → cooldown中でも再通知
    const again = await service.raise({
      severity: "INFO",
      dedupeKey: "k",
      text: "m",
      divergencePct: 0.58,
    });
    expect(again.sent).toBe(true);
    expect(again.reason).toBe("recovered_and_recrossed");
  });

  it("送信成功でalerts行がSENTになる", async () => {
    const now = { t: 0 };
    const { service, rows } = makeService(now);
    await service.raise({ severity: "SYSTEM", dedupeKey: "s", text: "boot" });
    expect(rows[0]?.status).toBe("SENT");
  });
});
