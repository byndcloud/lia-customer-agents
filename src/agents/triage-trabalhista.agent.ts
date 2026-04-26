import { Agent } from "@openai/agents";
import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import {
  TRIAGE_TRABALHISTA_AGENT_HANDOFF_DESCRIPTION,
  TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS,
  TRIAGE_TRABALHISTA_AGENT_NAME,
} from "./instructions/triage-trabalhista.instructions.js";

export interface BuildTriageTrabalhistaAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
}

/**
 * Constrói o agente especialista de triagem trabalhista.
 *
 * Este agente mantém o escopo detalhado de Direito do Trabalho e só enxerga
 * a tool `concluir_triagem` no MCP `legis-mcp`.
 */
export function buildTriageTrabalhistaAgent(
  params: BuildTriageTrabalhistaAgentParams,
): Agent<AgentRunContext> {
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  return new Agent<AgentRunContext>({
    name: TRIAGE_TRABALHISTA_AGENT_NAME,
    handoffDescription: TRIAGE_TRABALHISTA_AGENT_HANDOFF_DESCRIPTION,
    instructions:
      `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS}`,
    model: params.env.aiModel,
    tools: [legisMcp],
  });
}
