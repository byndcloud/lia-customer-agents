import type { EnvConfig } from "../../config/env.js";
import { runAgents } from "../../runtime/run-agents.js";
import { RunInputSchema } from "../../types.js";
import type { LiaHttpVariables } from "../honoVariables.js";
import { Hono } from "hono";

export interface RunRouterDeps {
  env: EnvConfig;
}

/**
 * Router para `POST /run`: executa os agentes diretamente para um `RunInput`.
 *
 * Uso primário: integrações externas e testes. O fluxo de chat WhatsApp
 * passa por `/generate-ai-response`, que chama `runAgents()` in-process com
 * o batch agregado.
 */
export function buildRunRouter(
  deps: RunRouterDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();

  r.post("/", async (c) => {
    const input = RunInputSchema.parse(c.var.jsonBody ?? {});
    const result = await runAgents(input, { env: deps.env });
    return c.json(result, 200);
  });

  return r;
}
