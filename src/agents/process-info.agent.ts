import { Agent, RunContext } from "@openai/agents";
import type { EnvConfig } from "../config/env.js";
import { getChatbotAiConfig } from "../db/chatbotAiConfig.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import type { FetchChatbotAiConfigFn } from "./chatbot-instructions-appendix.js";
import {
  PROCESS_INFO_AGENT_HANDOFF_DESCRIPTION,
  PROCESS_INFO_AGENT_NAME,
} from "./instructions/process-info.instructions.js";
import { buildProcessInfoInstructions } from "./instructions/process-info.personalization.js";

export interface BuildProcessInfoAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Resolver de `chatbot_ai_config` por organização. Útil para testes — em produção
   * omitir e usar `getChatbotAiConfig` contra o Supabase.
   */
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
}

/** Fetcher efetivo: override de testes ou `getChatbotAiConfig` padrão. */
function resolveChatbotConfigFetcher(
  override: FetchChatbotAiConfigFn | undefined,
): FetchChatbotAiConfigFn {
  return override ?? getChatbotAiConfig;
}

function buildProcessInfoLegisMcp(env: EnvConfig, context: AgentRunContext) {
  return buildLegisMcpTool({
    env,
    context,
  });
}

/**
 * Instruções mudam a cada turno (config da org, calendário, vínculo de cliente).
 */
function createProcessInfoInstructionsResolver(
  fetchChatbotConfig: FetchChatbotAiConfigFn,
  env: EnvConfig,
) {
  return async (
    runContext: RunContext<AgentRunContext>,
    _agent: Agent<AgentRunContext, "text">,
  ): Promise<string> => {
    const ctx = runContext.context;
    const config =
      ctx?.organizationId !== undefined && ctx.organizationId !== ""
        ? await fetchChatbotConfig(ctx.organizationId, env)
        : null;

    return buildProcessInfoInstructions({
      config,
      calendarConnectionId: ctx?.calendarConnectionId,
      organizationId: ctx?.organizationId,
      clientLinked: Boolean(ctx?.clientId),
    });
  };
}

/**
 * Constrói o agente de Consulta de Informações Processuais.
 *
 * Este agente é o principal consumidor do MCP `legis-mcp`. A tool do MCP é
 * instanciada a cada run porque os headers dependem do contexto da requisição
 * (conversa, organização, cliente, calendário).
 *
 * As `instructions` são resolvidas dinamicamente: o SDK chama o resolver antes
 * de cada turno, hidratando as regras com a config de IA da organização
 * (`chatbot_ai_config`) e anexando o bloco de transbordo quando há calendário
 * conectado.
 */
export function buildProcessInfoAgent(
  params: BuildProcessInfoAgentParams,
): Agent<AgentRunContext> {
  const fetchChatbotConfig = resolveChatbotConfigFetcher(params.fetchChatbotAiConfig);
  const resolveInstructions = createProcessInfoInstructionsResolver(
    fetchChatbotConfig,
    params.env,
  );
  const legisMcp = buildProcessInfoLegisMcp(params.env, params.context);

  return new Agent<AgentRunContext>({
    name: PROCESS_INFO_AGENT_NAME,
    handoffDescription: PROCESS_INFO_AGENT_HANDOFF_DESCRIPTION,
    instructions: resolveInstructions,
    model: params.env.aiModel,
    tools: [legisMcp],
  });
}
