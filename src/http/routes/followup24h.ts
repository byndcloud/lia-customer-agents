import type { EnvConfig } from "../../config/env.js";
import { processFollowup24h } from "../../services/followupService.js";
import type { LiaHttpVariables } from "../honoVariables.js";
import { Hono } from "hono";

export interface Followup24hDeps {
  env: EnvConfig;
}

/**
 * Router para `POST /followup-24h`.
 *
 * Disparado por scheduler externo (`pg_cron`). Encerra conversas inativas
 * há 24h com uma mensagem de despedida.
 */
export function buildFollowup24hRouter(
  deps: Followup24hDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();

  r.post("/", async (c) => {
    try {
      const result = await processFollowup24h(deps.env);
      return c.json({ success: true, ...result }, 200);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [followup-24h] Erro:", errorMessage);
      return c.json({ error: errorMessage }, 500);
    }
  });

  return r;
}
