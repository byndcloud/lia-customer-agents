import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv, type EnvConfig } from "../config/env.js";

let cachedClient: SupabaseClient | null = null;
let cachedKey: string | null = null;

/**
 * Cria (ou retorna em cache) um cliente Supabase usando a `service_role`.
 *
 * Usado por toda a camada `db/` e por upload/download de mídia.
 *
 * O cache é invalidado se a configuração mudar (útil para testes que injetam
 * `env` diferente entre cenários).
 */
export function getSupabaseClient(env?: EnvConfig): SupabaseClient {
  const cfg = env ?? loadEnv();

  if (!cfg.supabaseUrl) {
    throw new Error("SUPABASE_URL is required");
  }

  if (!cfg.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }

  const cacheKey = `${cfg.supabaseUrl}::${cfg.supabaseServiceRoleKey.slice(-12)}`;

  if (cachedClient && cachedKey === cacheKey) {
    return cachedClient;
  }

  cachedClient = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  cachedKey = cacheKey;

  return cachedClient;
}

/** Reseta o cache (uso em testes). */
export function resetSupabaseClient(): void {
  cachedClient = null;
  cachedKey = null;
}
