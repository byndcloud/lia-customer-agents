import { hostedMcpTool, type HostedMCPTool } from "@openai/agents";
import type { EnvConfig } from "../config/env.js";
import type { AgentRunContext } from "../types.js";

/**
 * Label fixo esperado pelo servidor MCP `legis-mcp`.
 * Mantido como constante para evitar divergência acidental entre chamadores.
 */
export const LEGIS_MCP_SERVER_LABEL = "legis-mcp";

/**
 * Descrição default usada no registro do MCP quando o modelo lista as tools.
 */
export const LEGIS_MCP_SERVER_DESCRIPTION =
  "MCP server designed to assist with legal actions related to the client.";

export interface BuildLegisMcpToolParams {
  /** Configuração carregada a partir do ambiente. */
  readonly env: EnvConfig;
  /** Contexto do run atual. Headers do MCP são derivados daqui. */
  readonly context: AgentRunContext;
}

/**
 * Monta os headers enviados ao MCP para cada execução.
 *
 * Regras:
 * - `X-Conversation-Id` e `X-Organization-Id` sempre enviados.
 * - `X-Client-Id` só quando há cliente identificado no contexto.
 * - `Authorization` é adicionado apenas quando `MCP_SERVER_API_KEY` existir.
 */
export function buildLegisMcpHeaders(
  params: BuildLegisMcpToolParams,
): Record<string, string> {
  const { env, context } = params;
  const headers: Record<string, string> = {
    "X-Conversation-Id": context.conversationId,
    "X-Organization-Id": context.organizationId,
  };

  if (context.clientId) {
    headers["X-Client-Id"] = context.clientId;
  }

  if (context.calendarConnectionId) {
    headers["X-Calendar-Connection-Id"] = context.calendarConnectionId;
  }

  if (env.mcpServerApiKey) {
    headers["Authorization"] = `Bearer ${env.mcpServerApiKey}`;
  }

  return headers;
}

/**
 * Fábrica do hostedMcpTool do `legis-mcp`. Deve ser chamada a cada execução,
 * já que os headers dependem do contexto da requisição.
 *
 * @throws Error quando `MCP_SERVER_URL` não está configurado.
 */
export function buildLegisMcpTool(
  params: BuildLegisMcpToolParams,
): HostedMCPTool {
  const { env } = params;

  if (!env.mcpServerUrl) {
    throw new Error(
      "MCP_SERVER_URL is not configured. Set the env var before running agents.",
    );
  }

  return hostedMcpTool({
    serverLabel: LEGIS_MCP_SERVER_LABEL,
    serverUrl: env.mcpServerUrl,
    serverDescription: LEGIS_MCP_SERVER_DESCRIPTION,
    headers: buildLegisMcpHeaders(params),
    requireApproval: "never",
  });
}
