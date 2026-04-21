import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Operações sobre `whatsapp_mensagens`.
 *
 * `remetente` aceita: "cliente" | "atendente" | "chatbot".
 * `tipo_mensagem`: "texto" | "audio" | "imagem" | "video" | "document" | etc.
 */

export interface WhatsappMensagem {
  id: string;
  conversa_id: string;
  remetente: "cliente" | "atendente" | "chatbot";
  conteudo: string;
  tipo_mensagem: string;
  anexo_url: string | null;
  user_id: string | null;
  created_at: string;
}

interface SaveWhatsappMessageParams {
  conversaId: string;
  remetente: WhatsappMensagem["remetente"];
  conteudo: string;
  tipoMensagem: string;
  anexoUrl?: string | null | undefined;
  /** ID externo (vindo da Evolution) — usado p/ deduplicação de envios. */
  messageId?: string | undefined;
  userId?: string | undefined;
}

/** Insere uma mensagem genérica. Demais helpers chamam aqui. */
export async function saveWhatsappMessage(
  params: SaveWhatsappMessageParams,
  env?: EnvConfig,
): Promise<WhatsappMensagem> {
  const supabase = getSupabaseClient(env);

  const insertData: Record<string, unknown> = {
    conversa_id: params.conversaId,
    remetente: params.remetente,
    conteudo: params.conteudo,
    tipo_mensagem: params.tipoMensagem,
    anexo_url: params.anexoUrl ?? null,
    user_id: params.userId ?? null,
  };

  if (params.messageId) {
    insertData.id = params.messageId;
  }

  const { data, error } = await supabase
    .from("whatsapp_mensagens")
    .insert(insertData)
    .select()
    .single<WhatsappMensagem>();

  if (error) throw error;
  return data;
}

/** Mensagem entrando do cliente (texto, sem anexo). */
export async function saveIncomingMessage(
  conversaId: string,
  fromMe: boolean,
  content: string,
  userId?: string,
  env?: EnvConfig,
): Promise<WhatsappMensagem> {
  return saveWhatsappMessage(
    {
      conversaId,
      remetente: fromMe ? "atendente" : "cliente",
      conteudo: content,
      tipoMensagem: "texto",
      anexoUrl: undefined,
      userId,
    },
    env,
  );
}

/** Mensagem saindo (atendente humano via Evolution). */
export async function saveOutgoingMessage(
  conversaId: string,
  messageType: string,
  content: string,
  messageId?: string,
  anexoUrl?: string,
  userId?: string,
  env?: EnvConfig,
): Promise<WhatsappMensagem> {
  return saveWhatsappMessage(
    {
      conversaId,
      remetente: "atendente",
      conteudo: content,
      tipoMensagem: messageType === "conversation" ? "texto" : messageType,
      anexoUrl,
      messageId,
      userId,
    },
    env,
  );
}

/** Mensagem do chatbot. */
export async function saveChatbotMessage(
  conversaId: string,
  content: string,
  messageType: string = "texto",
  userId?: string,
  env?: EnvConfig,
): Promise<WhatsappMensagem> {
  return saveWhatsappMessage(
    {
      conversaId,
      remetente: "chatbot",
      conteudo: content,
      tipoMensagem: messageType,
      anexoUrl: undefined,
      userId,
    },
    env,
  );
}

/**
 * Persistência de mensagem de mídia (espera URL pública já gerada pelo
 * upload no Supabase Storage). `tipo_mensagem` é derivado do `mimeType`.
 */
export async function saveMediaMessage(
  conversaId: string,
  mediaUrl: string,
  mimeType: string,
  fromMe: boolean,
  content: string,
  userId?: string,
  env?: EnvConfig,
): Promise<WhatsappMensagem> {
  const sender = fromMe ? "atendente" : "cliente";

  return saveWhatsappMessage(
    {
      conversaId,
      remetente: sender,
      conteudo: content,
      tipoMensagem: mimeType.split("/")?.[0] || "application",
      anexoUrl: mediaUrl,
      userId,
    },
    env,
  );
}

/** Recupera as últimas mensagens de uma conversa. */
export async function getConversationMessages(
  conversaId: string,
  limit = 50,
  env?: EnvConfig,
): Promise<WhatsappMensagem[]> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_mensagens")
    .select("*")
    .eq("conversa_id", conversaId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<WhatsappMensagem[]>();

  if (error) throw error;
  return data ?? [];
}
