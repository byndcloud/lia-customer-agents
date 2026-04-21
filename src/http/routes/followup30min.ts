import { Router, type Request, type Response } from "express";
import type { EnvConfig } from "../../config/env.js";
import { processFollowup30min } from "../../services/followupService.js";

export interface Followup30minDeps {
  env: EnvConfig;
}

/**
 * Router para `POST /followup-30min`.
 *
 * Disparado por scheduler externo (`pg_cron`). Processa conversas inativas
 * há ~30 min, gerando uma mensagem de "ainda precisa de ajuda?".
 */
export function buildFollowup30minRouter(deps: Followup30minDeps): Router {
  const router = Router();
  router.post("/", async (_req: Request, res: Response) => {
    try {
      const result = await processFollowup30min(deps.env);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [followup-30min] Erro:", errorMessage);
      res.status(500).json({ error: errorMessage });
    }
  });
  return router;
}
