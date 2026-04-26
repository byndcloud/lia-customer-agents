import { Agent, handoff } from "@openai/agents";
import {
  RECOMMENDED_PROMPT_PREFIX,
  removeAllTools,
} from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import { buildTriageTrabalhistaAgent } from "./triage-trabalhista.agent.js";
import {
  TRIAGE_AGENT_HANDOFF_DESCRIPTION,
  TRIAGE_AGENT_INSTRUCTIONS,
  TRIAGE_AGENT_NAME,
} from "./instructions/triage.instructions.js";

export interface BuildTriageAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
}

/**
 * Constrói o agente de Triagem Simples/Central.
 * - fallback para áreas sem especialista
 * - orquestra handoff para triagens especialistas quando aplicável
 */
export function buildTriageAgent(
  params: BuildTriageAgentParams,
): Agent<AgentRunContext> {
  const triageTrabalhistaAgent = buildTriageTrabalhistaAgent({
    env: params.env,
    context: params.context,
  });
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  return new Agent<AgentRunContext>({
    name: TRIAGE_AGENT_NAME,
    handoffDescription: TRIAGE_AGENT_HANDOFF_DESCRIPTION,
    instructions: `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${TRIAGE_AGENT_INSTRUCTIONS}`,
    model: params.env.aiModel,
    handoffs: [
      handoff(triageTrabalhistaAgent, {
        inputFilter: removeAllTools,
      }),
    ],
    tools: [legisMcp],
  });
}
