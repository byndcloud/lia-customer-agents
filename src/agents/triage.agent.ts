import { Agent, handoff } from "@openai/agents";
import {
  RECOMMENDED_PROMPT_PREFIX,
  removeAllTools,
} from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import type { ActiveTriageSpecialistRow } from "../db/triageSpecialistAgentsConfig.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import {
  appendChatbotTomVocabToInstructions,
  type FetchChatbotAiConfigFn,
} from "./chatbot-instructions-appendix.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import { buildTriageSpecialistAgent } from "./triage-specialist.agent.js";
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
  /**
   * Especialistas ativos (`ativo=true`) para esta org, vindos do banco.
   * Omitir ou passar `[]`: nenhum handoff de especialista (mesmo com `specialistHandoffs` true).
   */
  readonly activeTriageSpecialists?: readonly ActiveTriageSpecialistRow[];
  /** Ver `BuildOrchestratorAgentParams.fetchChatbotAiConfig`. */
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
}

/**
 * Constrói o agente de Triagem Simples/Central.
 * - fallback para áreas sem especialista (no texto das instruções)
 * - handoffs para triagens especialistas só quando `activeTriageSpecialists` não for vazio
 */
export function buildTriageAgent(params: BuildTriageAgentParams): Agent<AgentRunContext> {
  const specialists = params.activeTriageSpecialists ?? [];
  const allowHandoffs =
    params.specialistHandoffs !== false && specialists.length > 0;

  const specialistAgents = allowHandoffs
    ? specialists.map((s) =>
        buildTriageSpecialistAgent({
          areaSlug: s.areaSlug,
          env: params.env,
          context: params.context,
          ...(params.fetchChatbotAiConfig !== undefined
            ? { fetchChatbotAiConfig: params.fetchChatbotAiConfig }
            : {}),
        }),
      )
    : [];

  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const instructionsBody = buildTriageAgentInstructions(
    allowHandoffs,
    allowHandoffs ? specialists : undefined,
  );
  const instructionsPrefix = `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${instructionsBody}`;
  return new Agent<AgentRunContext>({
    name: TRIAGE_AGENT_NAME,
    handoffDescription: allowHandoffs
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
    handoffs: specialistAgents.map((a) =>
      handoff(a, {
        inputFilter: removeAllTools,
      }),
    ),
    tools: [legisMcp],
  });
}
