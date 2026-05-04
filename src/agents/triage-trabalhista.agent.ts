import { Agent } from "@openai/agents";
import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import { getTriageSpecialistInstrucoesCached } from "../db/triageSpecialistAgentsConfig.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import {
  appendChatbotTomVocabToInstructions,
  type FetchChatbotAiConfigFn,
} from "./chatbot-instructions-appendix.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import {
  TRIAGE_TRABALHISTA_AGENT_HANDOFF_DESCRIPTION,
  TRIAGE_TRABALHISTA_AGENT_NAME,
  buildTriageTrabalhistaInstructionsWithExtras,
} from "./instructions/triage-trabalhista.instructions.js";

export interface BuildTriageTrabalhistaAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Carrega `instrucoes` de `triage_specialist_agents_config` por org + nome do agente.
   * Útil em testes para não depender do Supabase.
   */
  readonly fetchTriageSpecialistInstrucoes?: (
    organizationId: string,
    nome: string,
    env: EnvConfig,
  ) => Promise<string | null>;
  /** Ver `BuildOrchestratorAgentParams.fetchChatbotAiConfig`. */
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
}

/**
 * Constrói o agente especialista de triagem trabalhista.
 *
 * Este agente mantém o escopo detalhado de Direito do Trabalho e só enxerga
 * a tool `concluir_triagem` no MCP `legis-mcp`. O prompt inclui, quando houver
 * linha no banco, a seção **Instruções extras** com `instrucoes` da org.
 */
export function buildTriageTrabalhistaAgent(
  params: BuildTriageTrabalhistaAgentParams,
): Agent<AgentRunContext> {
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const fetchInstrucoes =
    params.fetchTriageSpecialistInstrucoes ?? getTriageSpecialistInstrucoesCached;

  return new Agent<AgentRunContext>({
    name: TRIAGE_TRABALHISTA_AGENT_NAME,
    handoffDescription: TRIAGE_TRABALHISTA_AGENT_HANDOFF_DESCRIPTION,
    instructions: async (runContext) => {
      const ctx = runContext.context;
      const orgId = ctx?.organizationId;
      const extras =
        orgId !== undefined && orgId !== ""
          ? await fetchInstrucoes(orgId, TRIAGE_TRABALHISTA_AGENT_NAME, params.env)
          : null;
      const body = buildTriageTrabalhistaInstructionsWithExtras(extras);
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
