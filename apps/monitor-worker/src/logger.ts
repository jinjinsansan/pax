import { pino } from "pino";

/** RPC URLはAPIキーを含むためログ出力禁止（仕様書§24）— provider名だけを出す */
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { worker: process.env["WORKER_ID"] ?? "unknown" },
});
