import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Operações sobre `whatsapp_conversas` e a relação com `pessoas`.
 *
 * Toda função recebe `env` opcional para permitir uso em testes que injetam
 * uma configuração diferente; em produção o cliente é cacheado.
 */

/** Linha mínima de `whatsapp_conversas` consumida pelos fluxos. */
export interface WhatsappConversa {
  id: string;
  organization_id: string;
  numero_whatsapp: string;
  pessoa_id: string | null;
  status: string;
  chatbot_ativo: boolean;
  created_at?: string;
  updated_at?: string | null;
  inactive_since?: string | null;
}

/**
 * Busca conversa pelo número de WhatsApp considerando o "9 extra" brasileiro.
 *
 * Se a conversa existir mas estiver sem `pessoa_id`, tenta associar a uma
 * pessoa cadastrada no escritório (mesma lógica da edge function original).
 */
export async function findConversaByPhoneNumber(
  params: {
    phoneNumber: string;
    firstFive: string;
    lastEight: string;
    organizationId: string;
  },
  env?: EnvConfig,
): Promise<WhatsappConversa | null> {
  const supabase = getSupabaseClient(env);
  const { phoneNumber, firstFive, lastEight, organizationId } = params;

  const { data, error } = await supabase
    .from("whatsapp_conversas")
    .select("*")
    .eq("organization_id", organizationId)
    .or(
      `numero_whatsapp.eq.${phoneNumber},numero_whatsapp.eq.${firstFive}9${lastEight}`,
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<WhatsappConversa>();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  if (!data) return null;

  if (!data.pessoa_id && data.organization_id) {
    const pessoaId = await findPessoaByWhatsAppNumber(
      data.organization_id,
      phoneNumber,
      env,
    );

    if (pessoaId) {
      const { data: updated, error: updateError } = await supabase
        .from("whatsapp_conversas")
        .update({ pessoa_id: pessoaId })
        .eq("id", data.id)
        .select()
        .single<WhatsappConversa>();

      if (updateError) {
        console.error(
          "❌ Erro ao atualizar pessoa_id da conversa:",
          updateError,
        );
        return data;
      }

      return updated;
    }
  }

  return data;
}

/**
 * Cria conversa para um número novo. Se a triagem do escritório estiver
 * desabilitada e o número não corresponder a nenhuma pessoa cadastrada,
 * retorna `null` (não criamos conversa para desconhecidos).
 */
export async function createWhatsAppConversation(
  organizationId: string,
  numeroWhatsapp: string,
  triageEnabled: boolean = false,
  env?: EnvConfig,
): Promise<WhatsappConversa | null> {
  const supabase = getSupabaseClient(env);
  const pessoaId = await findPessoaByWhatsAppNumber(
    organizationId,
    numeroWhatsapp,
    env,
  );

  if (!pessoaId && !triageEnabled) {
    console.log(
      `⚠️ Triage disabled: Number ${numeroWhatsapp} not registered - conversation not created`,
    );
    return null;
  }

  const normalizedPhone = numeroWhatsapp.startsWith("+")
    ? numeroWhatsapp
    : `+${numeroWhatsapp}`;

  const { data, error } = await supabase
    .from("whatsapp_conversas")
    .insert({
      organization_id: organizationId,
      numero_whatsapp: normalizedPhone,
      pessoa_id: pessoaId,
      status: "em_atendimento_chatbot",
      chatbot_ativo: true,
    })
    .select()
    .maybeSingle<WhatsappConversa>();

  if (error) {
    throw error;
  }

  return data;
}

/** Atualiza apenas o campo `status` da conversa. */
export async function updateConversationStatus(
  conversaId: string,
  status: string,
  env?: EnvConfig,
): Promise<WhatsappConversa> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase
    .from("whatsapp_conversas")
    .update({ status })
    .eq("id", conversaId)
    .select()
    .maybeSingle<WhatsappConversa>();

  if (error) throw error;
  if (!data) throw new Error(`Conversation with id ${conversaId} not found`);
  return data;
}

/** Marca/limpa `inactive_since`. */
export async function setConversationInactiveSince(
  conversaId: string,
  iso: string | null,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const { error } = await supabase
    .from("whatsapp_conversas")
    .update({ inactive_since: iso })
    .eq("id", conversaId);
  if (error) throw error;
}

/** Encerra conversa de followup-24h: status `encerrada` + zera inactive_since. */
export async function closeConversation(
  conversaId: string,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const { error } = await supabase
    .from("whatsapp_conversas")
    .update({
      status: "encerrada",
      inactive_since: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversaId);
  if (error) throw error;
}

/**
 * Follow-up 24h com triagem inativa: fila humana em vez de encerrar a conversa.
 * Desliga o chatbot para não enfileirar IA até novo atendimento.
 */
export async function setConversationAguardandoAtendimentoFollowupTriagem(
  conversaId: string,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const { error } = await supabase
    .from("whatsapp_conversas")
    .update({
      status: "aguardando_atendimento",
      inactive_since: null,
      chatbot_ativo: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversaId);
  if (error) throw error;
}

/** Lê apenas `status` da conversa (helper para followups). */
export async function getConversationStatus(
  conversaId: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_conversas")
    .select("status")
    .eq("id", conversaId)
    .single<{ status: string }>();
  if (error) {
    console.warn(`⚠️ Erro ao buscar status da conversa (${conversaId}):`, error);
    return null;
  }
  return data?.status ?? null;
}

/**
 * Normaliza número de telefone removendo caracteres não numéricos e o DDI 55.
 */
function normalizePhoneNumber(phone: string): string {
  const result = phone.replace(/\D/g, "");
  if (result.startsWith("55")) return result.slice(2);
  return result;
}

/**
 * Gera variações considerando o "9 extra" brasileiro:
 *  - 11 dígitos com '9' na 3ª posição -> também tenta sem o 9
 *  - 10 dígitos -> também tenta com 9 inserido na 3ª posição
 */
function generatePhoneVariations(normalizedPhone: string): string[] {
  const variations = [normalizedPhone];

  if (normalizedPhone.length === 11 && normalizedPhone[2] === "9") {
    variations.push(normalizedPhone.slice(0, 2) + normalizedPhone.slice(3));
  } else if (normalizedPhone.length === 10) {
    variations.push(
      normalizedPhone.slice(0, 2) + "9" + normalizedPhone.slice(2),
    );
  }

  return variations;
}

/**
 * Procura pessoa do escritório que tenha qualquer variação do número.
 * Se houver múltiplas, retorna a mais antiga (estável).
 */
async function findPessoaByWhatsAppNumber(
  organizationId: string,
  numeroWhatsapp: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);
  const normalizedSearch = normalizePhoneNumber(numeroWhatsapp);
  const variations = generatePhoneVariations(normalizedSearch);

  const { data: pessoas, error } = await supabase
    .from("pessoas")
    .select("id, whatsapps, created_at")
    .eq("organization_id", organizationId)
    .not("whatsapps", "is", null);

  if (error) {
    console.error("❌ Erro ao buscar pessoas:", error);
    return null;
  }

  if (!pessoas || pessoas.length === 0) return null;

  type PessoaRow = { id: string; whatsapps: unknown; created_at: string };

  const pessoasComNumero = (pessoas as PessoaRow[]).filter((pessoa) => {
    if (!Array.isArray(pessoa.whatsapps)) return false;
    return pessoa.whatsapps.some((w: unknown) => {
      if (typeof w !== "string") return false;
      return variations.includes(normalizePhoneNumber(w));
    });
  });

  if (pessoasComNumero.length === 0) return null;

  pessoasComNumero.sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return pessoasComNumero[0]?.id ?? null;
}
