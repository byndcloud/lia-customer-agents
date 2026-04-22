import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "../db/client.js";

/**
 * Decide qual `previousResponseId` usar antes de chamar os agentes.
 *
 * Regra: o `responseId` é vinculado ao **atendimento ativo**. Se não houver
 * atendimento, é uma conversa nova (não traz contexto). Se houver, busca o
 * último response salvo desde o início do atendimento — assim conversas
 * reiniciadas começam realmente do zero, mesmo que existam responses antigos
 * na mesma conversa.
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

interface ActiveServiceRow {
  id: string;
  iniciado_em: string;
  tipo_responsavel: string;
}

async function getActiveService(
  conversaId: string,
  env?: EnvConfig,
): Promise<{ data: ActiveServiceRow | null; hadError: boolean }> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .select("id, iniciado_em, tipo_responsavel")
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null)
    .order("iniciado_em", { ascending: false })
    .maybeSingle<ActiveServiceRow>();

  if (error) {
    console.error("❌ Erro ao buscar atendimento ativo:", error);
    return { data: null, hadError: true };
  }

  return { data, hadError: false };
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
  foundResponseRow: boolean;
  previousResponseIdPresent: boolean;
  reason: LastResponseResult["chainDecisionReason"];
}): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "previous_response_id_decision",
      ...params,
    }),
  );
}

/**
 * Retorna o `previousResponseId` adequado para a próxima rodada do agente.
 *
 * Se não há atendimento ativo, devolve `{ lastResponseId: null, isNewService: true }`
 * — o chamador deve tratar como primeira interação (greeting, etc).
 */
export async function getLastResponseIfActive(
  conversaId: string,
  env?: EnvConfig,
): Promise<LastResponseResult> {
  const activeServiceResult = await getActiveService(conversaId, env);
  const activeService = activeServiceResult.data;

  if (!activeService) {
    const reason: LastResponseResult["chainDecisionReason"] =
      "no_active_service";
    logPreviousResponseDecision({
      conversaId,
      hasActiveService: false,
      foundResponseRow: false,
      previousResponseIdPresent: false,
      reason,
    });
    return { lastResponseId: null, isNewService: true, chainDecisionReason: reason };
  }

  const responseResult = await getLastResponseForService(
    conversaId,
    activeService.iniciado_em,
    env,
  );
  const lastResponseId = responseResult.responseId;

  const reason: LastResponseResult["chainDecisionReason"] =
    responseResult.hadError
      ? "query_error_fallback_to_null"
      : lastResponseId
        ? "response_found"
        : "no_response_row_for_service";

  logPreviousResponseDecision({
    conversaId,
    hasActiveService: true,
    foundResponseRow: responseResult.foundRow,
    previousResponseIdPresent: Boolean(lastResponseId),
    reason,
  });

  return { lastResponseId, isNewService: false, chainDecisionReason: reason };
}
