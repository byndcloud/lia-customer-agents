import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Vinculação entre mensagens do chatbot e o `response_id` do OpenAI/Agents
 * (auditoria). O fluxo principal não usa mais encadeamento por
 * `previous_response_id`.
 */

interface InsertWhatsappConversationResponseParams {
  responseId: string;
  whatsappMensagemId: string;
  modelUsed: string;
  tokensUsed?: number | undefined;
  error?: string | undefined;
}

export async function insertWhatsappConversationResponse(
  responseData: InsertWhatsappConversationResponseParams,
  env?: EnvConfig,
): Promise<unknown> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase.rpc(
    "insert_whatsapp_conversation_response",
    {
      p_response_id: responseData.responseId,
      p_whatsapp_mensagem_id: responseData.whatsappMensagemId,
      p_model_used: responseData.modelUsed,
      p_tokens_used: responseData.tokensUsed,
      p_error: responseData.error,
      p_previous_response_id: null,
    },
  );

  if (error) throw error;
  return data;
}

/**
 * Retorna o último `response_id` salvo para a conversa, ou `null` se for a
 * primeira interação.
 */
export async function getLastConversationResponse(
  conversaId: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase.rpc(
    "get_last_conversation_response",
    { p_conversa_id: conversaId },
  );

  if (error) throw error;
  return (data as string | null) || null;
}
