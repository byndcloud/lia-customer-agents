import { Router, type NextFunction, type Request, type Response } from "express";
import type { EnvConfig } from "../../config/env.js";
import { runAgents } from "../../runtime/run-agents.js";
import { RunInputSchema } from "../../types.js";

export interface RunRouterDeps {
  env: EnvConfig;
  /** Permite mockar `runAgents` em testes. */
  runAgentsImpl?: typeof runAgents;
}

/**
 * Router para `POST /run`: executa os agentes diretamente para um `RunInput`.
 *
 * Uso primário: integrações externas e testes. O fluxo de chat WhatsApp
 * passa por `/generate-ai-response`, que chama `runAgents()` in-process com
 * o batch agregado.
 */
export function buildRunRouter(deps: RunRouterDeps): Router {
  const router = Router();
  const runImpl = deps.runAgentsImpl ?? runAgents;

  router.post(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = RunInputSchema.parse(req.body);
        const result = await runImpl(input, { env: deps.env });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
