import { Agent, handoff } from "@openai/agents";
import {
  RECOMMENDED_PROMPT_PREFIX,
  removeAllTools,
} from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import {
  appendChatbotTomVocabToInstructions,
  type FetchChatbotAiConfigFn,
} from "./chatbot-instructions-appendix.js";
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
   * (política derivada de `triage_specialist_agents_config` e `triage_enabled`).
   */
  readonly specialistHandoffs?: boolean;
  /** Ver `BuildOrchestratorAgentParams.fetchChatbotAiConfig`. */
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
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
        ...(params.fetchChatbotAiConfig !== undefined
          ? { fetchChatbotAiConfig: params.fetchChatbotAiConfig }
          : {}),
      })
    : null;
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const instructionsBody = buildTriageAgentInstructions(specialistHandoffs);
  const instructionsPrefix = `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${instructionsBody}`;
  return new Agent<AgentRunContext>({
    name: TRIAGE_AGENT_NAME,
    handoffDescription: specialistHandoffs
      ? TRIAGE_AGENT_HANDOFF_DESCRIPTION
      : TRIAGE_AGENT_HANDOFF_DESCRIPTION_SIMPLES,
    instructions: async (runContext) => {
      const ctx = runContext.context;
      return appendChatbotTomVocabToInstructions(instructionsPrefix, {
        organizationId: ctx?.organizationId,
        env: params.env,
        ...(params.fetchChatbotAiConfig !== undefined
          ? { fetchChatbotAiConfig: params.fetchChatbotAiConfig }
          : {}),
      });
    },
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
