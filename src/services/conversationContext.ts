import type { EnvConfig } from "../config/env.js";
import { getActiveServiceConversationThread } from "../db/atendimentos.js";
import { getSupabaseClient } from "../db/client.js";

/**
 * Resolve o contexto de sessão OpenAI (`conv_...`) do atendimento ativo.
 *
 * **Legado:** o fluxo `POST /generate-ai-response` não usa mais este módulo
 * (histórico vem de `whatsapp_mensagens` + `agente_responsavel`). Mantido para
 * testes e possíveis consumidores antigos (`getLastResponseIfActive`).
 */

export interface ActiveServiceSessionContext {
  atendimentoId: string | null;
  openAiConversationId: string | null;
  lastResponseId: string | null;
  isNewService: boolean;
  chainDecisionReason:
    | "no_active_service"
    | "active_service_without_openai_conversation"
    | "active_service_with_openai_conversation"
    | "no_response_row_for_service"
    | "query_error_fallback_to_null"
    | "response_found";
}

/**
 * Compatibilidade legada: mantém o contrato antigo de `previousResponseId`
 * para consumidores que ainda não migraram totalmente para Session.
 */
export interface LastResponseResult {
  lastResponseId: string | null;
  isNewService: boolean;
  chainDecisionReason:
    | "no_active_service"
    | "no_response_row_for_service"
    | "query_error_fallback_to_null"
    | "response_found";
}

async function getLastResponseForService(
  conversaId: string,
  atendimentoIniciado: string,
  env?: EnvConfig,
): Promise<{ responseId: string | null; foundRow: boolean; hadError: boolean }> {
  const supabase = getSupabaseClient(env);

  type Row = {
    response_id: string | null;
    created_at: string;
    whatsapp_mensagem: { conversa_id: string; created_at: string };
  };

  const { data, error } = await supabase
    .from("whatsapp_conversation_responses")
    .select(
      `response_id, created_at, whatsapp_mensagem:whatsapp_mensagens!inner(conversa_id, created_at)`,
    )
    .eq("whatsapp_mensagem.conversa_id", conversaId)
    .gte("created_at", atendimentoIniciado)
    .not("response_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Row>();

  if (error) {
    console.error("❌ Erro ao buscar último response:", error);
    return { responseId: null, foundRow: false, hadError: true };
  }

  return {
    responseId: data?.response_id ?? null,
    foundRow: data !== null && data !== undefined,
    hadError: false,
  };
}

function logPreviousResponseDecision(params: {
  conversaId: string;
  hasActiveService: boolean;
  openAiConversationIdPresent: boolean;
  foundResponseRow: boolean;
  previousResponseIdPresent: boolean;
  reason: ActiveServiceSessionContext["chainDecisionReason"];
}): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "openai_session_context_decision",
      ...params,
    }),
  );
}

/**
 * Retorna o contexto de sessão do atendimento ativo.
 */
export async function getActiveServiceSessionContext(
  conversaId: string,
  env?: EnvConfig,
): Promise<ActiveServiceSessionContext> {
  const activeService = await getActiveServiceConversationThread(conversaId, env);

  if (!activeService) {
    const reason: ActiveServiceSessionContext["chainDecisionReason"] =
      "no_active_service";
    logPreviousResponseDecision({
      conversaId,
      hasActiveService: false,
      openAiConversationIdPresent: false,
      foundResponseRow: false,
      previousResponseIdPresent: false,
      reason,
    });
    return {
      atendimentoId: null,
      openAiConversationId: null,
      lastResponseId: null,
      isNewService: true,
      chainDecisionReason: reason,
    };
  }

  const responseResult = await getLastResponseForService(
    conversaId,
    activeService.iniciadoEm,
    env,
  );
  const lastResponseId = responseResult.responseId;

  const reason: ActiveServiceSessionContext["chainDecisionReason"] =
    activeService.openAiConversationId
      ? "active_service_with_openai_conversation"
      : "active_service_without_openai_conversation";

  logPreviousResponseDecision({
    conversaId,
    hasActiveService: true,
    openAiConversationIdPresent: Boolean(activeService.openAiConversationId),
    foundResponseRow: responseResult.foundRow,
    previousResponseIdPresent: Boolean(lastResponseId),
    reason,
  });

  if (responseResult.hadError) {
    return {
      atendimentoId: activeService.atendimentoId,
      openAiConversationId: activeService.openAiConversationId,
      lastResponseId: null,
      isNewService: false,
      chainDecisionReason: "query_error_fallback_to_null",
    };
  }

  return {
    atendimentoId: activeService.atendimentoId,
    openAiConversationId: activeService.openAiConversationId,
    lastResponseId,
    isNewService: false,
    chainDecisionReason: lastResponseId
      ? "response_found"
      : "no_response_row_for_service",
  };
}

export async function getLastResponseIfActive(
  conversaId: string,
  env?: EnvConfig,
): Promise<LastResponseResult> {
  const ctx = await getActiveServiceSessionContext(conversaId, env);
  const chainDecisionReason: LastResponseResult["chainDecisionReason"] =
    ctx.chainDecisionReason === "no_active_service" ||
      ctx.chainDecisionReason === "query_error_fallback_to_null" ||
      ctx.chainDecisionReason === "response_found" ||
      ctx.chainDecisionReason === "no_response_row_for_service"
      ? ctx.chainDecisionReason
      : ctx.lastResponseId
        ? "response_found"
        : "no_response_row_for_service";

  return {
    lastResponseId: ctx.lastResponseId,
    isNewService: ctx.isNewService,
    chainDecisionReason,
  };
}
