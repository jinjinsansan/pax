import { describe, expect, it } from "vitest";
import { loadMonitorEnv } from "../src/index.js";

const validBase = {
  CHAIN_ID: "1",
  PHASE: "1",
  TRADING_ENABLED: "false",
};

describe("loadMonitorEnv — Phase 1/2 安全ガード（仕様書§18）", () => {
  it("正常な最小構成でパースできる", () => {
    const env = loadMonitorEnv(validBase);
    expect(env.CHAIN_ID).toBe(1);
    expect(env.PHASE).toBe(1);
    expect(env.TRADING_ENABLED).toBe(false);
  });

  it("PRIVATE_KEYが設定されていたら起動失敗する", () => {
    expect(() =>
      loadMonitorEnv({ ...validBase, PRIVATE_KEY: "0xdeadbeef" }),
    ).toThrow(/PRIVATE_KEY must NOT be set/);
  });

  it("PRIVATE_KEYが空文字なら起動できる", () => {
    expect(() =>
      loadMonitorEnv({ ...validBase, PRIVATE_KEY: "" }),
    ).not.toThrow();
  });

  it("TRADING_ENABLED=trueなら起動失敗する", () => {
    expect(() =>
      loadMonitorEnv({ ...validBase, TRADING_ENABLED: "true" }),
    ).toThrow(/TRADING_ENABLED must be false/);
  });

  it("Phase 2でもPRIVATE_KEYガードは有効", () => {
    expect(() =>
      loadMonitorEnv({ ...validBase, PHASE: "2", PRIVATE_KEY: "0xabc" }),
    ).toThrow(/PRIVATE_KEY must NOT be set/);
  });

  it("CHAIN_IDが1以外なら拒否する", () => {
    expect(() => loadMonitorEnv({ ...validBase, CHAIN_ID: "137" })).toThrow(
      /CHAIN_ID must be 1/,
    );
  });

  it("デフォルト閾値が仕様書§9と一致する", () => {
    const env = loadMonitorEnv(validBase);
    expect(env.REFERENCE_ALERT_PCT).toBe(0.5);
    expect(env.EXECUTABLE_ALERT_PCT).toBe(0.5);
    expect(env.MIN_NET_PROFIT_USD).toBe(25);
    expect(env.MIN_NET_PROFIT_PCT).toBe(0.1);
    expect(env.MAX_PRICE_IMPACT_PCT).toBe(0.3);
    expect(env.ALERT_COOLDOWN_SECONDS).toBe(300);
  });
});
