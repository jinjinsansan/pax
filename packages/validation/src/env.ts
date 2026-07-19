import { z } from "zod";

/**
 * Worker環境変数のスキーマと起動時ガード（仕様書 §18, §24）。
 *
 * 最重要ガード:
 *   Phase 1/2 では PRIVATE_KEY が設定されていたら「起動失敗」させる。
 *   TRADING_ENABLED も false 以外を拒否する。
 */

const nonEmpty = z.string().min(1);
const optionalUrl = z.string().url().optional().or(z.literal("").transform(() => undefined));

export const monitorEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CHAIN_ID: z.coerce.number().int().refine((v) => v === 1, {
      message: "CHAIN_ID must be 1 (Ethereum Mainnet)",
    }),
    PHASE: z.coerce.number().int().min(1).max(3).default(1),

    ETH_RPC_HTTP_PRIMARY: optionalUrl,
    ETH_RPC_WS_PRIMARY: z.string().optional(),
    ETH_RPC_HTTP_SECONDARY: optionalUrl,
    ETH_RPC_WS_SECONDARY: z.string().optional(),

    SUPABASE_URL: optionalUrl,
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),

    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    WORKER_ID: nonEmpty.default("local-dev-01"),
    WORKER_ROLE: z.enum(["primary", "standby", "report"]).default("primary"),
    LEASE_NAME: nonEmpty.default("ethereum-arbitrage-monitor"),
    LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(45),

    REFERENCE_ALERT_PCT: z.coerce.number().positive().default(0.5),
    EXECUTABLE_ALERT_PCT: z.coerce.number().positive().default(0.5),
    MIN_NET_PROFIT_USD: z.coerce.number().nonnegative().default(25),
    MIN_NET_PROFIT_PCT: z.coerce.number().nonnegative().default(0.1),
    MAX_PRICE_IMPACT_PCT: z.coerce.number().positive().default(0.3),
    ALERT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(300),

    INTERNAL_API_HMAC_SECRET: z.string().optional(),

    TRADING_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    PRIVATE_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Phase 1/2 安全ガード（仕様書 §3, §18）
    if (env.PHASE < 3) {
      if (env.PRIVATE_KEY !== undefined && env.PRIVATE_KEY.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PRIVATE_KEY"],
          message:
            "SAFETY GUARD: PRIVATE_KEY must NOT be set in Phase 1/2. Startup aborted (spec §18).",
        });
      }
      if (env.TRADING_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRADING_ENABLED"],
          message:
            "SAFETY GUARD: TRADING_ENABLED must be false in Phase 1/2. Startup aborted (spec §3).",
        });
      }
    }
  });

export type MonitorEnv = z.infer<typeof monitorEnvSchema>;

/**
 * 環境変数をパースし、安全ガード違反があれば例外で起動を失敗させる。
 * Workerのエントリポイントは必ずこれを最初に呼ぶこと。
 */
export function loadMonitorEnv(
  source: Record<string, string | undefined> = process.env,
): MonitorEnv {
  const result = monitorEnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${details}`);
  }
  return result.data;
}
