import { Agent } from "@openai/agents";
import type { EnvConfig } from "../config/env.js";
import {
  getChatbotAiConfig,
  type ChatbotAiConfig,
} from "../db/chatbotAiConfig.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import {
  PROCESS_INFO_AGENT_HANDOFF_DESCRIPTION,
  PROCESS_INFO_AGENT_NAME,
} from "./instructions/process-info.instructions.js";
import { buildProcessInfoInstructions } from "./instructions/process-info.personalization.js";

export interface BuildProcessInfoAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Resolver de `chatbot_ai_config` por organização. Útil para testes —
   * em produção usa `getChatbotAiConfig` direto contra o Supabase.
   */
  readonly fetchChatbotAiConfig?: (
    organizationId: string,
    env: EnvConfig,
  ) => Promise<ChatbotAiConfig | null>;
}

/**
 * Constrói o agente de Consulta de Informações Processuais.
 *
 * Este agente é o principal consumidor do MCP `legis-mcp`. A tool do MCP é
 * instanciada a cada run porque os headers dependem do contexto da requisição
 * (conversa, organização, cliente, calendário).
 *
 * As `instructions` são resolvidas dinamicamente: o SDK chama a função abaixo
 * antes de cada turno, hidratando as regras com a config de IA da organização
 * (`chatbot_ai_config`) e anexando o bloco de transbordo quando há calendário
 * conectado.
 */
export function buildProcessInfoAgent(
  params: BuildProcessInfoAgentParams,
): Agent<AgentRunContext> {
  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
  });
  const fetchConfig = params.fetchChatbotAiConfig ?? getChatbotAiConfig;

  return new Agent<AgentRunContext>({
    name: PROCESS_INFO_AGENT_NAME,
    handoffDescription: PROCESS_INFO_AGENT_HANDOFF_DESCRIPTION,
    instructions: async (runContext) => {
      const ctx = runContext.context;
      const config = ctx?.organizationId
        ? await fetchConfig(ctx.organizationId, params.env)
        : null;

      return buildProcessInfoInstructions({
        config,
        calendarConnectionId: ctx?.calendarConnectionId,
        organizationId: ctx?.organizationId,
        clientLinked: Boolean(ctx?.clientId),
      });
    },
    model: params.env.aiModel,
    tools: [legisMcp],
  });
}
