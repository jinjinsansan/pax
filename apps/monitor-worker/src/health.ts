import { writeFile } from "node:fs/promises";

const HEALTH_FILE = process.env["HEALTH_FILE"] ?? "./health.json";

export interface HealthState {
  lastBlockNumber: number | null;
  lastBlockAt: string | null;
  lastHeartbeatAt: string | null;
  isLeader: boolean;
  rpcProvider: string | null;
  updatedAt: string;
}

const state: HealthState = {
  lastBlockNumber: null,
  lastBlockAt: null,
  lastHeartbeatAt: null,
  isLeader: false,
  rpcProvider: null,
  updatedAt: new Date().toISOString(),
};

export function updateHealth(patch: Partial<HealthState>): void {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  // fire-and-forget — healthcheckはファイルmtimeと内容で判定
  void writeFile(HEALTH_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}

export function getHealth(): HealthState {
  return { ...state };
}
