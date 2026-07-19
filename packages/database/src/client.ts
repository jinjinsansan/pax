import { createClient } from "@supabase/supabase-js";

/**
 * Worker用Supabaseクライアント（Service Role・arbスキーマ）。
 * Service Roleキーはブラウザ/フロントへ渡すこと禁止（仕様書§11, §24）。
 */
export function createServiceClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, {
    db: { schema: "arb" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** arbスキーマに束縛されたクライアント型 */
export type ArbClient = ReturnType<typeof createServiceClient>;
