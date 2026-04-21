import { Router, type Request, type Response } from "express";
import type { EnvConfig } from "../../config/env.js";
import { processFollowup24h } from "../../services/followupService.js";

export interface Followup24hDeps {
  env: EnvConfig;
}

/**
 * Router para `POST /followup-24h`.
 *
 * Disparado por scheduler externo (`pg_cron`). Encerra conversas inativas
 * há 24h com uma mensagem de despedida.
 */
export function buildFollowup24hRouter(deps: Followup24hDeps): Router {
  const router = Router();
  router.post("/", async (_req: Request, res: Response) => {
    try {
      const result = await processFollowup24h(deps.env);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [followup-24h] Erro:", errorMessage);
      res.status(500).json({ error: errorMessage });
    }
  });
  return router;
}
