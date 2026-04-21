import type { EnvConfig } from "../config/env.js";
import { ensureActiveService } from "../db/atendimentos.js";
import { getSupabaseClient } from "../db/client.js";

/**
 * Reinicia conversas encerradas conforme as preferências da pessoa cadastrada.
 *
 * Regra: se a pessoa tem `tipo_atendimento_padrao = humano` e responsável
 * definido, a conversa volta como `aguardando_atendimento`. Caso contrário
 * (incluindo conversas sem `pessoa_id`), volta para o chatbot.
 */

export interface RestartResult {
  shouldRestart: boolean;
  newStatus: string;
  chatbotAtivo?: boolean;
  responsavelId?: string;
  atendimentoType: "chatbot" | "humano";
}

const STATUS_ENCERRADOS = new Set(["encerrada", "encerrado"]);

export async function checkAndRestart(
  conversaId: string,
  conversaStatus: string,
  pessoaId: string | null,
  organizationId: string,
  env?: EnvConfig,
): Promise<RestartResult> {
  if (!STATUS_ENCERRADOS.has(conversaStatus?.toLowerCase())) {
    return {
      shouldRestart: false,
      newStatus: conversaStatus,
      atendimentoType: "chatbot",
    };
  }

  if (pessoaId) {
    const config = await getPessoaAtendimentoConfig(pessoaId, env);

    if (
      config &&
      config.tipo === "humano" &&
      config.responsavelId
    ) {
      await restartWithHumano(
        conversaId,
        config.responsavelId,
        env,
      );
      return {
        shouldRestart: true,
        newStatus: "aguardando_atendimento",
        responsavelId: config.responsavelId,
        atendimentoType: "humano",
      };
    }
  }

  await restartWithChatbot(conversaId, organizationId, env);
  return {
    shouldRestart: true,
    newStatus: "em_atendimento_chatbot",
    chatbotAtivo: true,
    atendimentoType: "chatbot",
  };
}

async function finalizeOldServices(
  conversaId: string,
  env?: EnvConfig,
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const { error } = await supabase
    .from("whatsapp_atendimentos")
    .update({
      finalizado_em: new Date().toISOString(),
      status_atendimento: "finalizado",
    })
    .eq("conversa_id", conversaId)
    .is("finalizado_em", null);

  if (error) {
    console.error("⚠️ Erro ao finalizar atendimentos antigos:", error);
  }
}

async function getPessoaAtendimentoConfig(
  pessoaId: string,
  env?: EnvConfig,
): Promise<{ tipo: string; responsavelId: string | null } | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("pessoas")
    .select("tipo_atendimento_padrao, responsavel_atendimento_padrao_id")
    .eq("id", pessoaId)
    .maybeSingle<{
      tipo_atendimento_padrao: string | null;
      responsavel_atendimento_padrao_id: string | null;
    }>();

  if (error || !data) return null;

  return {
    tipo: data.tipo_atendimento_padrao || "automatico",
    responsavelId: data.responsavel_atendimento_padrao_id,
  };
}

async function restartWithChatbot(
  conversaId: string,
  organizationId: string,
  env?: EnvConfig,
): Promise<void> {
  await finalizeOldServices(conversaId, env);
  const supabase = getSupabaseClient(env);

  const { error } = await supabase
    .from("whatsapp_conversas")
    .update({
      status: "em_atendimento_chatbot",
      chatbot_ativo: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversaId);

  if (error) {
    throw new Error(`Erro ao reiniciar conversa: ${error.message}`);
  }

  await ensureActiveService(conversaId, organizationId, env);
}

async function restartWithHumano(
  conversaId: string,
  responsavelId: string,
  env?: EnvConfig,
): Promise<void> {
  await finalizeOldServices(conversaId, env);
  const supabase = getSupabaseClient(env);

  const { error } = await supabase
    .from("whatsapp_conversas")
    .update({
      status: "aguardando_atendimento",
      responsavel_id: responsavelId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversaId);

  if (error) {
    throw new Error(`Erro ao reiniciar conversa: ${error.message}`);
  }
}
