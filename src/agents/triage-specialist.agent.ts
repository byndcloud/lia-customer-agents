import { Agent } from "@openai/agents";
import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import {
  getTriageSpecialistPromptContentCached,
  type TriageSpecialistPromptContent,
} from "../db/triageSpecialistAgentsConfig.js";
import type { AgentRunContext } from "../types.js";
import {
  appendChatbotTomVocabToInstructions,
  type FetchChatbotAiConfigFn,
} from "./chatbot-instructions-appendix.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import {
  buildTriageSpecialistInstructionsWithExtras,
  triageSpecialistAgentTechnicalName,
  triageSpecialistHandoffDescription,
  type TriageSpecialistAreaSlug,
} from "./instructions/triage-specialist.instructions.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";

export interface BuildTriageSpecialistAgentParams {
  readonly areaSlug: TriageSpecialistAreaSlug;
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Carrega `conhecimento` e `instrucoes` de `triage_specialist_agents_config` por org + `identificador`.
   * Útil em testes para não depender do Supabase.
   */
  readonly fetchTriageSpecialistPromptContent?: (
    organizationId: string,
    identificador: string,
    env: EnvConfig,
  ) => Promise<TriageSpecialistPromptContent>;
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
}

/**
 * Constrói um agente de triagem especialista por área (`identificador`).
 * Prompt-base compartilhado; PERGUNTAS-REFERÊNCIA ← `conhecimento`; Instruções extras ← `instrucoes` formatada.
 */
export function buildTriageSpecialistAgent(
  params: BuildTriageSpecialistAgentParams,
): Agent<AgentRunContext> {
  const agentName = triageSpecialistAgentTechnicalName(params.areaSlug);
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const fetchPromptContent =
    params.fetchTriageSpecialistPromptContent ?? getTriageSpecialistPromptContentCached;

  return new Agent<AgentRunContext>({
    name: agentName,
    handoffDescription: triageSpecialistHandoffDescription(params.areaSlug),
    instructions: async (runContext) => {
      const ctx = runContext.context;
      const orgId = ctx?.organizationId;
      const { conhecimento, instrucoesFormatadas } =
        orgId !== undefined && orgId !== ""
          ? await fetchPromptContent(orgId, params.areaSlug, params.env)
          : ({ conhecimento: null, instrucoesFormatadas: null } satisfies TriageSpecialistPromptContent);
      const body = buildTriageSpecialistInstructionsWithExtras(conhecimento, instrucoesFormatadas);
      const prefix = `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${body}`;
      return appendChatbotTomVocabToInstructions(prefix, {
        organizationId: ctx?.organizationId,
        env: params.env,
        ...(params.fetchChatbotAiConfig !== undefined
          ? { fetchChatbotAiConfig: params.fetchChatbotAiConfig }
          : {}),
      });
    },
    model: params.env.aiModel,
    tools: [legisMcp],
  });
}
