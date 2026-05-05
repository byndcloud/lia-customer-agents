import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Leitura do último `response_id` persistido para a conversa (RPC
 * `get_last_conversation_response`), quando o produto ainda expõe esse dado.
 */

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
