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
  TRIAGE_AGENT_HANDOFF_DESCRIPTION_SIMPLES,
  TRIAGE_AGENT_NAME,
  buildTriageAgentInstructions,
} from "./instructions/triage.instructions.js";

export interface BuildTriageAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Quando `false`, não registra handoffs para triagens especialistas
   * (`tipo_triagem` = `simples` na `chatbot_ai_config`).
   */
  readonly specialistHandoffs?: boolean;
}

/**
 * Constrói o agente de Triagem Simples/Central.
 * - fallback para áreas sem especialista
 * - orquestra handoff para triagens especialistas quando aplicável
 */
export function buildTriageAgent(
  params: BuildTriageAgentParams,
): Agent<AgentRunContext> {
  const specialistHandoffs = params.specialistHandoffs !== false;
  const triageTrabalhistaAgent = specialistHandoffs
    ? buildTriageTrabalhistaAgent({
        env: params.env,
        context: params.context,
      })
    : null;
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const instructionsBody = buildTriageAgentInstructions(specialistHandoffs);
  return new Agent<AgentRunContext>({
    name: TRIAGE_AGENT_NAME,
    handoffDescription: specialistHandoffs
      ? TRIAGE_AGENT_HANDOFF_DESCRIPTION
      : TRIAGE_AGENT_HANDOFF_DESCRIPTION_SIMPLES,
    instructions: `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${instructionsBody}`,
    model: params.env.aiModel,
    handoffs: triageTrabalhistaAgent
      ? [
          handoff(triageTrabalhistaAgent, {
            inputFilter: removeAllTools,
          }),
        ]
      : [],
    tools: [legisMcp],
  });
}
