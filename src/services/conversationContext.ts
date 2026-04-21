import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "../db/client.js";
import { getLastConversationResponse } from "../db/responses.js";

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
}

interface ActiveServiceRow {
  id: string;
  iniciado_em: string;
  tipo_responsavel: string;
}

async function getActiveService(
  conversaId: string,
  env?: EnvConfig,
): Promise<ActiveServiceRow | null> {
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
    return null;
  }

  return data;
}

async function getLastResponseForService(
  conversaId: string,
  atendimentoIniciado: string,
  env?: EnvConfig,
): Promise<string | null> {
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
    return getLastConversationResponse(conversaId, env);
  }

  return data?.response_id ?? null;
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
  const activeService = await getActiveService(conversaId, env);

  if (!activeService) {
    return { lastResponseId: null, isNewService: true };
  }

  const lastResponseId = await getLastResponseForService(
    conversaId,
    activeService.iniciado_em,
    env,
  );

  return { lastResponseId, isNewService: false };
}
