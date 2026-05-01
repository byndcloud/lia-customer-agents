import type { EnvConfig } from "../config/env.js";
import type { AgentId } from "../types.js";
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
  iniciadoEm: string;
  agenteResponsavel: AgentId;
}

const KNOWN_AGENT_IDS = new Set<string>([
  "orchestrator",
  "triage",
  "triage_trabalhista",
  "process_info",
]);

/** Normaliza valor persistido em `agente_responsavel` para `AgentId`. */
export function normalizeAgenteResponsavel(
  raw: string | null | undefined,
): AgentId {
  if (raw && KNOWN_AGENT_IDS.has(raw)) {
    return raw as AgentId;
  }
  return "orchestrator";
}

export interface ActiveServiceConversationThread {
  atendimentoId: string;
  iniciadoEm: string;
  openAiConversationId: string | null;
}

/** Atendimento ativo com janela temporal e agente IA responsável (chatbot). */
export interface ActiveChatbotServiceRow {
  readonly atendimentoId: string;
  readonly iniciadoEm: string;
  /**
   * `orchestrator` | `triage` | `triage_trabalhista` | `process_info`
   * — alinhado a `AgentId`.
   */
  readonly agenteResponsavel: AgentId;
}

type ActiveAtendimentoRow = {
  id: string;
  tipo_responsavel: string;
  iniciado_em: string;
  agente_responsavel: string | null;
};

/**
 * Atendimento em aberto mais recente da conversa (por `iniciado_em`).
 * Usa `limit(1)` para nunca cair no caso maybeSingle + múltiplas linhas
 * (o PostgREST mapeia isso para `PGRST116`, que antes era tratado como "sem linha").
 */
async function selectLatestOpenAtendimentoRow(
  conversaId: string,
  env?: EnvConfig,
): Promise<ActiveAtendimentoRow | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .select("id, tipo_responsavel, iniciado_em, agente_responsavel")
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle<ActiveAtendimentoRow>();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Erro ao verificar atendimento: ${error.message}`);
  }

  return data ?? null;
}

/**
 * Valor persistido em `agente_responsavel` do atendimento em aberto mais
 * recente (`finalizado_em` nulo), ou `null` se não houver linha aberta.
 */
export async function getOpenAtendimentoAgenteResponsavelRaw(
  conversaId: string,
  env?: EnvConfig,
): Promise<string | null> {
  const row = await selectLatestOpenAtendimentoRow(conversaId, env);
  return row?.agente_responsavel ?? null;
}

/**
 * Finaliza atendimentos `em_andamento` da conversa como transferidos para a
 * fila humana (follow-up 24h com triagem inativa).
 */
export async function finalizarAtendimentosTransferidosFilaPorFollowup24hTriagem(
  conversaId: string,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const notasFinalizacao =
    "Follow-up 24h: conversa colocada em aguardando atendimento (triagem inativa).";

  const { error } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      status_atendimento: "finalizado",
      finalizado_em: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resultado: "Transferido por ausência de resposta e ser triagem.",
      notas_finalizacao: notasFinalizacao,
    })
    .eq("conversa_id", conversaId)
    .eq("status_atendimento", "em_andamento")
    .is("finalizado_em", null);

  if (error) throw error;
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

  const ativo = await selectLatestOpenAtendimentoRow(conversaId, env);

  if (ativo) {
    return {
      atendimentoId: ativo.id,
      isNew: false,
      iniciadoEm: ativo.iniciado_em,
      agenteResponsavel: normalizeAgenteResponsavel(ativo.agente_responsavel),
    };
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
      agente_responsavel: "orchestrator",
    })
    .select("id, iniciado_em, agente_responsavel")
    .maybeSingle<{
      id: string;
      iniciado_em: string;
      agente_responsavel: string | null;
    }>();

  if (!insertError && novo) {
    return {
      atendimentoId: novo.id,
      isNew: true,
      iniciadoEm: novo.iniciado_em,
      agenteResponsavel: normalizeAgenteResponsavel(novo.agente_responsavel),
    };
  }

  if (insertError?.code === "23505") {
    const existing = await selectLatestOpenAtendimentoRow(conversaId, env);
    if (existing) {
      return {
        atendimentoId: existing.id,
        isNew: false,
        iniciadoEm: existing.iniciado_em,
        agenteResponsavel: normalizeAgenteResponsavel(
          existing.agente_responsavel,
        ),
      };
    }
  }

  throw new Error(
    `Erro ao criar atendimento: ${insertError?.message ?? "unknown"}`,
  );
}

/** Campos mínimos de conversa para decidir vínculo com `whatsapp_atendimentos`. */
export interface ConversaSlimForAtendimento {
  id: string;
  status: string;
  chatbot_ativo: boolean;
}

/**
 * Retorna o id do atendimento com `finalizado_em` nulo para a conversa, se existir.
 * Quando houver mais de um (anomalia), usa o mais recente por `iniciado_em`.
 */
export async function getActiveAtendimentoId(
  conversaId: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .select("id")
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Erro ao buscar atendimento ativo: ${error.message}`);
  }

  return data?.id ?? null;
}

/**
 * Define `atendimento_id` ao persistir em `whatsapp_mensagens`.
 * Cliente/chatbot com chatbot ligado na conversa: garante linha de atendimento.
 * Caso contrário: apenas reutiliza atendimento aberto, se houver.
 */
export async function resolveAtendimentoIdForPersistedMessage(
  conversa: ConversaSlimForAtendimento,
  organizationId: string,
  remetenteWillBe: "cliente" | "atendente" | "chatbot",
  env?: EnvConfig,
): Promise<string | undefined> {
  const chatbotLigado =
    conversa.status === "em_atendimento_chatbot" && conversa.chatbot_ativo;

  if (
    (remetenteWillBe === "cliente" || remetenteWillBe === "chatbot") &&
    chatbotLigado
  ) {
    const s = await ensureActiveService(conversa.id, organizationId, env);
    return s.atendimentoId;
  }

  const existing = await getActiveAtendimentoId(conversa.id, env);
  return existing ?? undefined;
}

/**
 * Se `candidateIso` for **anterior** a `iniciado_em` atual, retrocede o marco
 * do atendimento (corrige `iniciado_em` gravado depois da primeira mensagem).
 * Retorna o novo `iniciado_em` quando houve update; caso contrário `null`.
 */
export async function clampAtendimentoIniciadoEmIfEarlier(
  atendimentoId: string,
  candidateIso: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .select("iniciado_em")
    .eq("id", atendimentoId)
    .maybeSingle<{ iniciado_em: string }>();

  if (error && error.code !== "PGRST116") {
    throw new Error(
      `Erro ao ler iniciado_em do atendimento: ${error.message}`,
    );
  }
  if (!data?.iniciado_em) return null;

  const cur = new Date(data.iniciado_em).getTime();
  const cand = new Date(candidateIso).getTime();
  if (Number.isNaN(cur) || Number.isNaN(cand) || cand >= cur) {
    return null;
  }

  const nextIso = new Date(cand).toISOString();
  const { error: upErr } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      iniciado_em: nextIso,
      updated_at: new Date().toISOString(),
    })
    .eq("id", atendimentoId);

  if (upErr) throw upErr;
  return nextIso;
}

/**
 * Atualiza o agente IA responsável no atendimento chatbot ativo da conversa.
 */
export async function updateActiveServiceResponsibleAgent(
  conversaId: string,
  agentId: AgentId,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const { data: ativo, error: searchError } = await supabase
    .from("whatsapp_atendimentos")
    .select("id")
    .eq("conversa_id", conversaId)
    .eq("tipo_responsavel", "chatbot")
    .is("finalizado_em", null)
    .maybeSingle<{ id: string }>();

  if (searchError && searchError.code !== "PGRST116") {
    throw new Error(
      `Erro ao buscar atendimento chatbot ativo: ${searchError.message}`,
    );
  }
  if (!ativo) {
    return;
  }

  const { error } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      agente_responsavel: agentId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ativo.id);

  if (error) throw error;
}

/**
 * Retorna o atendimento ativo mais recente da conversa com o thread OpenAI
 * associado (quando já criado).
 */
export async function getActiveServiceConversationThread(
  conversaId: string,
  env?: EnvConfig,
): Promise<ActiveServiceConversationThread | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_atendimentos")
    .select("id, iniciado_em, openai_conversation_id")
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null)
    .order("iniciado_em", { ascending: false })
    .maybeSingle<{
      id: string;
      iniciado_em: string;
      openai_conversation_id: string | null;
    }>();

  if (error) throw error;
  if (!data) return null;
  return {
    atendimentoId: data.id,
    iniciadoEm: data.iniciado_em,
    openAiConversationId: data.openai_conversation_id,
  };
}

/**
 * Persiste/atualiza o `conv_...` do atendimento ativo da conversa.
 */
export async function setActiveServiceOpenAiConversationId(
  conversaId: string,
  openAiConversationId: string,
  env?: EnvConfig,
): Promise<void> {
  const active = await getActiveServiceConversationThread(conversaId, env);
  if (!active) {
    throw new Error(
      `Active service not found for conversaId=${conversaId} when persisting openai_conversation_id`,
    );
  }
  const supabase = getSupabaseClient(env);
  const { error } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      openai_conversation_id: openAiConversationId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", active.atendimentoId);
  if (error) throw error;
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
