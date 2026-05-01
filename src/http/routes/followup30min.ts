import type { EnvConfig } from "../../config/env.js";
import { processFollowup30min } from "../../services/followupService.js";
import type { LiaHttpVariables } from "../honoVariables.js";
import { Hono } from "hono";

export interface Followup30minDeps {
  env: EnvConfig;
}

/**
 * Router para `POST /followup-30min`.
 *
 * Disparado por scheduler externo (`pg_cron`). Processa conversas inativas
 * há ~30 min, gerando uma mensagem de "ainda precisa de ajuda?".
 */
export function buildFollowup30minRouter(
  deps: Followup30minDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();

  r.post("/", async (c) => {
    try {
      const result = await processFollowup30min(deps.env);
      return c.json({ success: true, ...result }, 200);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [followup-30min] Erro:", errorMessage);
      return c.json({ error: errorMessage }, 500);
    }
  });

  return r;
}
