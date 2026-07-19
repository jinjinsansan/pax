/**
 * Docker HEALTHCHECK エントリ（仕様書§13）。
 * health.jsonが90秒以内に更新されていれば正常(exit 0)。
 */
import { readFile, stat } from "node:fs/promises";

const HEALTH_FILE = process.env["HEALTH_FILE"] ?? "./health.json";
const MAX_AGE_MS = 90_000;

try {
  const s = await stat(HEALTH_FILE);
  const age = Date.now() - s.mtimeMs;
  if (age > MAX_AGE_MS) {
    console.error(`health file stale: ${Math.round(age / 1000)}s`);
    process.exit(1);
  }
  const body = JSON.parse(await readFile(HEALTH_FILE, "utf-8")) as {
    lastBlockAt: string | null;
  };
  console.log(`ok (lastBlockAt=${body.lastBlockAt})`);
  process.exit(0);
} catch (err) {
  console.error(`healthcheck failed: ${(err as Error).message}`);
  process.exit(1);
}
