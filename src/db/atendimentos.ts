import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Operações sobre `whatsapp_atendimentos`.
 *
 * Um atendimento representa quem está conduzindo a conversa em determinado
 * momento (chatbot, atendente humano via WhatsApp, etc). Há sempre no máximo
 * um ativo por conversa (sem `finalizado_em`).
 */

export interface EnsureActiveServiceResult {
  atendimentoId: string;
  isNew: boolean;
}

/**
 * Garante que a conversa tem um atendimento em andamento. Se não houver,
 * cria um do tipo `chatbot`. Retorna o id e se foi criado nesta chamada.
 */
export async function ensureActiveService(
  conversaId: string,
  organizationId: string,
  env?: EnvConfig,
): Promise<EnsureActiveServiceResult> {
  const supabase = getSupabaseClient(env);

  const { data: ativo, error: searchError } = await supabase
    .from("whatsapp_atendimentos")
    .select("id, tipo_responsavel, iniciado_em")
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null)
    .maybeSingle<{ id: string; tipo_responsavel: string; iniciado_em: string }>();

  if (searchError && searchError.code !== "PGRST116") {
    throw new Error(
      `Erro ao verificar atendimento: ${searchError.message}`,
    );
  }

  if (ativo) {
    return { atendimentoId: ativo.id, isNew: false };
  }

  const { data: novo, error: insertError } = await supabase
    .from("whatsapp_atendimentos")
    .insert({
      conversa_id: conversaId,
      organization_id: organizationId,
      tipo_responsavel: "chatbot",
      responsavel_id: null,
      status_atendimento: "em_andamento",
      iniciado_em: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !novo) {
    throw new Error(
      `Erro ao criar atendimento: ${insertError?.message ?? "unknown"}`,
    );
  }

  return { atendimentoId: novo.id, isNew: true };
}

/**
 * Finaliza atendimentos em andamento como "resolvido" (resultado positivo
 * informado pela própria Lia).
 */
export async function finalizarAtendimentoWhatsAppComoResolvido(
  conversaId: string,
  organizationId: string,
  notasFinalizacao: string,
  env?: EnvConfig,
): Promise<number> {
  const supabase = getSupabaseClient(env);

  const { data: ativos, error: buscaError } = await supabase
    .from("whatsapp_atendimentos")
    .select("id")
    .eq("conversa_id", conversaId)
    .eq("organization_id", organizationId)
    .eq("status_atendimento", "em_andamento")
    .is("finalizado_em", null)
    .returns<Array<{ id: string }>>();

  if (buscaError) throw buscaError;
  if (!ativos || ativos.length === 0) return 0;

  const ids = ativos.map((a) => a.id);

  const { error: updateError } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      status_atendimento: "finalizado",
      finalizado_em: new Date().toISOString(),
      resultado: "resolvido",
      notas_finalizacao: notasFinalizacao,
    })
    .in("id", ids);

  if (updateError) throw updateError;
  return ids.length;
}

/**
 * Finaliza atendimentos ativos da conversa como "transferido". Antes disso
 * busca o `status` da conversa para escolher a mensagem de notas.
 */
async function finalizarAtendimentosAtivos(
  numeroWhatsapp: string,
  organizationId: string,
  env?: EnvConfig,
): Promise<string[]> {
  const supabase = getSupabaseClient(env);

  const { data: conversa, error: conversaError } = await supabase
    .from("whatsapp_conversas")
    .select("id, status")
    .eq("numero_whatsapp", numeroWhatsapp)
    .eq("organization_id", organizationId)
    .maybeSingle<{ id: string; status: string }>();

  if (conversaError) throw conversaError;
  if (!conversa) return [];

  const { data: ativos, error: ativosError } = await supabase
    .from("whatsapp_atendimentos")
    .select("id")
    .eq("conversa_id", conversa.id)
    .is("finalizado_em", null)
    .returns<Array<{ id: string }>>();

  if (ativosError) throw ativosError;
  if (!ativos || ativos.length === 0) return [];

  const ids = ativos.map((a) => a.id);

  const notasFinalizacao =
    conversa.status === "aguardando_atendimento"
      ? "Lia encerrou e transferiu para humano por transbordo"
      : `Lia finalizou como transferido e encaminhou para "em atendimento por whatsapp"`;

  const { error: updateError } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      status_atendimento: "finalizado",
      finalizado_em: new Date().toISOString(),
      resultado: "transferido",
      notas_finalizacao: notasFinalizacao,
    })
    .in("id", ids);

  if (updateError) throw updateError;
  return ids;
}

async function criarAtendimentoWhatsApp(
  conversaId: string,
  env?: EnvConfig,
): Promise<string> {
  const supabase = getSupabaseClient(env);

  const { data: conversa, error: conversaError } = await supabase
    .from("whatsapp_conversas")
    .select("organization_id")
    .eq("id", conversaId)
    .single<{ organization_id: string }>();

  if (conversaError || !conversa) {
    throw conversaError || new Error("Conversa não encontrada");
  }

  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .insert({
      conversa_id: conversaId,
      organization_id: conversa.organization_id,
      tipo_responsavel: "whatsapp",
      responsavel_id: null,
      status_atendimento: "em_andamento",
      iniciado_em: new Date().toISOString(),
      resultado: null,
      notas_finalizacao: null,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) throw error;
  return data.id;
}

/**
 * Combinação chamada quando a conversa é colocada em espera (atendente humano
 * assumiu): finaliza atendimentos ativos como `transferido` e cria um novo
 * atendimento `whatsapp`.
 */
export async function transicionarParaAtendimentoWhatsApp(
  numeroWhatsapp: string,
  conversaId: string,
  organizationId: string,
  env?: EnvConfig,
): Promise<{ atendimentosFinalizados: string[]; novoAtendimentoId: string }> {
  const atendimentosFinalizados = await finalizarAtendimentosAtivos(
    numeroWhatsapp,
    organizationId,
    env,
  );
  const novoAtendimentoId = await criarAtendimentoWhatsApp(conversaId, env);
  return { atendimentosFinalizados, novoAtendimentoId };
}

/**
 * Finaliza qualquer atendimento ativo da conversa (uso pelo followup-24h).
 * `resultado` pode ser `null` quando o atendimento já foi assumido por humano.
 */
export async function finalizarAtendimentosAtivosPorConversa(
  conversaId: string,
  resultado: string | null,
  notasFinalizacao: string,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);

  const updateData: Record<string, unknown> = {
    status_atendimento: "finalizado",
    finalizado_em: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    notas_finalizacao: notasFinalizacao,
  };

  if (resultado !== null) {
    updateData.resultado = resultado;
  }

  const { error } = await supabase
    .from("whatsapp_atendimentos")
    .update(updateData)
    .eq("conversa_id", conversaId)
    .eq("status_atendimento", "em_andamento")
    .is("finalizado_em", null);

  if (error) throw error;
}
