import type { Context } from "hono";
import { Hono } from "hono";
import { type EnvConfig } from "../../config/env.js";
import type { LiaHttpVariables } from "../honoVariables.js";
import { getSupabaseClient } from "../../db/client.js";
import {
  clampAtendimentoIniciadoEmIfEarlier,
  ensureActiveService,
  updateActiveServiceResponsibleAgent,
} from "../../db/atendimentos.js";
import { updateConversationStatus } from "../../db/conversations.js";
import {
  getMensagensByAtendimentoId,
  hasClienteMensagemStrictlyAfter,
  saveChatbotMessage,
  type WhatsappMensagem,
} from "../../db/messages.js";
import { insertWhatsappConversationResponse } from "../../db/responses.js";
import { transcribeAudioFromStorage } from "../../services/audioTranscription.js";
import { shouldInterceptMessage } from "../../services/conversationFlowInterceptor.js";
import { sendEvolutionMessage } from "../../services/evolutionApi.js";
import { resolveWhatsAppInstance } from "../../services/whatsappInstanceResolver.js";
import { runAgents } from "../../runtime/run-agents.js";
import type { AgentId, AgentInputItem } from "../../types.js";

/** Rótulos para a mensagem de sistema do agente responsável no atendimento. */
const AGENT_SYSTEM_LABEL: Record<AgentId, string> = {
  orchestrator: "recepção (orquestrador)",
  triage: "triagem simples",
  triage_trabalhista: "triagem trabalhista",
  process_info: "consulta processual",
};

function buildResponsibleAgentSystemMessage(agente: AgentId): AgentInputItem {
  const label = AGENT_SYSTEM_LABEL[agente];
  return {
    role: "system",
    content: `esse atendimento se encontra no agente ${label}.`,
    type: "message",
  };
}

/** Menor `created_at` válido entre linhas de `whatsapp_mensagens`. */
function earliestCreatedAtInRows(
  rows: ReadonlyArray<WhatsappMensagem>,
): string | null {
  let minMs = Infinity;
  for (const m of rows) {
    if (!m.created_at) continue;
    const t = new Date(m.created_at).getTime();
    if (!Number.isNaN(t) && t < minMs) minMs = t;
  }
  return minMs === Infinity ? null : new Date(minMs).toISOString();
}

/**
 * Log estruturado (uma linha JSON) para depuração do fluxo
 * `POST /generate-ai-response`.
 */
function logGenerateAi(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" = "info",
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function buildUserInputFromMedia(params: {
  tipoMensagem: string;
  anexoUrl: string;
  caption?: string | null | undefined;
}): AgentInputItem {
  const caption = params.caption?.trim() || "";
  const text = caption.length > 0
    ? caption
    : "Analise o arquivo enviado e responda com base no conteúdo.";

  /** Campos em camelCase: o bridge `@openai/agents-openai` ignora `file_url` / `image_url` no item. */
  const contentParts: Array<Record<string, string>> = [
    { type: "input_text", text },
  ];

  if (params.tipoMensagem === "image") {
    contentParts.push({ type: "input_image", imageUrl: params.anexoUrl });
  } else {
    contentParts.push({ type: "input_file", fileUrl: params.anexoUrl });
  }

  return {
    role: "user",
    content: contentParts,
    type: "message",
  };
}

interface GenerateAiRequestBody {
  conversaId?: string;
  mensagem?: string;
  instancia?: string;
  numeroWhatsapp?: string;
  pessoaId?: string;
  organizacaoId?: string;
  clienteId?: string;
  audioData?: { storageUrl: string; mimetype: string };
  /** Mensagem do cliente que originou a task (webhook → Cloud Tasks). */
  triggerMensagemId?: string;
  triggerMensagemCreatedAt?: string;
}

export interface GenerateAiResponseDeps {
  env: EnvConfig;
}

/**
 * Cria o router que gera resposta com os agentes. Chamado pelo Cloud Tasks;
 * ignora a invocação se já houver mensagem de cliente mais nova que a da task,
 * senão carrega todo o histórico de `whatsapp_mensagens` do atendimento ativo.
 */
type GenerateCtx = Context<{ Variables: LiaHttpVariables }>;

export function buildGenerateAiResponseRouter(
  deps: GenerateAiResponseDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();
  r.post("/", async (c) => handleGenerate(c, deps));
  return r;
}

async function handleGenerate(
  c: GenerateCtx,
  deps: GenerateAiResponseDeps,
): Promise<Response> {
  const env = deps.env;
  const supabase = getSupabaseClient(env);

  const body = (c.var.jsonBody ?? {}) as GenerateAiRequestBody;

  const {
    conversaId,
    mensagem,
    instancia,
    numeroWhatsapp,
    pessoaId,
    organizacaoId,
    clienteId,
    audioData,
    triggerMensagemId,
    triggerMensagemCreatedAt,
  } = body;

  if (!conversaId) {
    return c.json({ error: "conversaId é obrigatório" }, 400);
  }

  try {
    logGenerateAi("generate_ai_request", {
      conversaId,
      organizacaoId: organizacaoId ?? null,
      hasNumeroWhatsapp: Boolean(
        typeof numeroWhatsapp === "string" && numeroWhatsapp.trim().length > 0,
      ),
      instancia: instancia ?? null,
      hasAudioPayload: Boolean(audioData),
    });

    const { data: conversa, error: conversaError } = await supabase
      .from("whatsapp_conversas")
      .select("status, organization_id")
      .eq("id", conversaId)
      .single<{ status: string; organization_id: string }>();

    if (conversaError) {
      console.error("❌ Erro ao buscar status da conversa:", conversaError);
      return c.json({ error: "Erro ao verificar status da conversa" }, 500);
    }

    if (
      conversa?.status === "em_atendimento_humano" ||
      conversa?.status === "em_atendimento_whatsapp"
    ) {
      logGenerateAi("generate_ai_skipped", {
        conversaId,
        reason: "human_service_active",
        conversaStatus: conversa?.status ?? null,
      });
      return c.json({
        message:
          "Conversa em atendimento humano - mensagem não processada pelo chatbot",
        status: "skipped",
        reason: "human_service_active",
      }, 200);
    }

    const interception = await shouldInterceptMessage(
      conversaId,
      mensagem ?? "",
    );

    if (
      interception.shouldIntercept &&
      interception.action === "finalize_and_restart"
    ) {
      // No-op atual: o sistema de avaliação foi migrado para o MCP.
    }

    const triggerCreatedAt =
      typeof triggerMensagemCreatedAt === "string" &&
      triggerMensagemCreatedAt.trim().length > 0
        ? triggerMensagemCreatedAt.trim()
        : undefined;

    if (triggerCreatedAt) {
      const superseded = await hasClienteMensagemStrictlyAfter(
        conversaId,
        triggerCreatedAt,
        env,
      );
      if (superseded) {
        logGenerateAi("generate_ai_skipped", {
          conversaId,
          reason: "superseded_by_newer_client_message",
          triggerMensagemId: triggerMensagemId ?? null,
          triggerMensagemCreatedAt: triggerCreatedAt,
        });
        return c.json({
          message:
            "Task obsoleta — já existe mensagem do cliente mais recente; não processado",
          status: "skipped",
          reason: "superseded_by_newer_client_message",
        }, 200);
      }
    }

    await updateConversationStatus(conversaId, "em_atendimento_chatbot", env);

    if (!organizacaoId || String(organizacaoId).trim() === "") {
      return c.json({
        error: "organizacaoId é obrigatório para gerar resposta",
      }, 400);
    }

    const activeService = await ensureActiveService(
      conversaId,
      organizacaoId,
      env,
    );

    const calendarConnectionId = await resolveCalendarConnection(
      organizacaoId,
      env,
    );

    const atendimentoMensagens = await getMensagensByAtendimentoId(
      activeService.atendimentoId,
      env,
    );

    logGenerateAi("generate_ai_atendimento_messages", {
      conversaId,
      atendimentoId: activeService.atendimentoId,
      messageCount: atendimentoMensagens.length,
      messageIds: atendimentoMensagens.map((m) => m.id),
    });

    if (atendimentoMensagens.length === 0) {
      logGenerateAi("generate_ai_skipped", {
        conversaId,
        reason: "no_messages_for_atendimento",
        atendimentoId: activeService.atendimentoId,
      });
      return c.json({
        message: "Nenhuma mensagem vinculada a este atendimento",
        status: "skipped",
        reason: "no_messages_for_atendimento",
      }, 200);
    }

    let serviceAtendimento = activeService;
    const earliestRowIso = earliestCreatedAtInRows(atendimentoMensagens);
    if (earliestRowIso) {
      const patchedIniciado = await clampAtendimentoIniciadoEmIfEarlier(
        serviceAtendimento.atendimentoId,
        earliestRowIso,
        env,
      );
      if (patchedIniciado) {
        serviceAtendimento = {
          ...serviceAtendimento,
          iniciadoEm: patchedIniciado,
        };
        logGenerateAi("generate_ai_atendimento_iniciado_em_clamped", {
          conversaId,
          atendimentoId: serviceAtendimento.atendimentoId,
          iniciadoEm: patchedIniciado,
          earliestFromAtendimentoRows: earliestRowIso,
        });
      }
    }

    const inputs = await buildAgentInputsFromAtendimentoWindow({
      atendimentoId: serviceAtendimento.atendimentoId,
      agenteResponsavel: serviceAtendimento.agenteResponsavel,
      env,
    });

    logGenerateAi("generate_ai_input_scope", {
      conversaId,
      isNewAtendimento: serviceAtendimento.isNew,
      inputMode: "full_atendimento_history",
      atendimentoMessageCount: atendimentoMensagens.length,
      inputsCount: inputs.length,
    });

    const hasUserTurn = inputs.some((item) => item.role === "user");
    if (!hasUserTurn) {
      logGenerateAi("generate_ai_skipped", {
        conversaId,
        reason: "no_ai_eligible_messages",
        atendimentoMessageCount: atendimentoMensagens.length,
      });
      return c.json({
        message: "Lote sem mensagens elegíveis para IA",
        status: "skipped",
        reason: "no_ai_eligible_messages",
        data: { atendimento_messages_count: atendimentoMensagens.length },
      }, 200);
    }

    const clientIdForAgents =
      typeof clienteId === "string" && clienteId.trim().length > 0
        ? clienteId
        : undefined;

    logGenerateAi("generate_ai_run_start", {
      conversaId,
      inputsCount: inputs.length,
      agenteResponsavelAtendimento: serviceAtendimento.agenteResponsavel,
      isNewAtendimento: serviceAtendimento.isNew,
      clientIdForAgents: Boolean(clientIdForAgents),
    });

    const result = await runAgents(
      {
        inputs,
        conversaId,
        organizationId: organizacaoId,
        clientId: clientIdForAgents,
        calendarConnectionId,
        agenteResponsavelAtendimento: serviceAtendimento.agenteResponsavel,
        extra: pessoaId ? { pessoaId } : undefined,
      },
      { env },
    );

    await updateActiveServiceResponsibleAgent(
      conversaId,
      result.agentUsed,
      env,
    );

    const responseContent = result.output;
    const responseId = result.responseId;
    const tokensUsed = result.usage.totalTokens || undefined;

    logGenerateAi("generate_ai_run_done", {
      conversaId,
      agentUsed: result.agentUsed,
      outputCharCount: responseContent.length,
      outputTrimmedEmpty:
        typeof responseContent === "string" &&
        responseContent.trim().length === 0,
      responseIdPresent: Boolean(responseId),
      tokensUsed: tokensUsed ?? null,
    });

    if (
      typeof responseContent === "string" &&
      responseContent.trim().length === 0
    ) {
      logGenerateAi(
        "generate_ai_empty_model_output",
        { conversaId, agentUsed: result.agentUsed },
        "warn",
      );
    }

    const mensagemData = await saveChatbotMessage(
      conversaId,
      responseContent,
      "texto",
      undefined,
      env,
      serviceAtendimento.atendimentoId,
    );

    logGenerateAi("generate_ai_message_saved", {
      conversaId,
      mensagemId: mensagemData.id,
    });

    if (responseId) {
      const insertRpcStarted = Date.now();
      logGenerateAi("generate_ai_insert_response_start", {
        conversaId,
        mensagemId: mensagemData.id,
        responseId,
      });
      await insertWhatsappConversationResponse(
        {
          responseId,
          whatsappMensagemId: mensagemData.id,
          modelUsed: env.aiModel,
          tokensUsed,
        },
        env,
      );
      const insertRpcMs = Date.now() - insertRpcStarted;
      logGenerateAi("generate_ai_insert_response_done", {
        conversaId,
        mensagemId: mensagemData.id,
        durationMs: insertRpcMs,
      });
      if (insertRpcMs > 3000) {
        logGenerateAi(
          "generate_ai_insert_response_slow",
          { conversaId, mensagemId: mensagemData.id, durationMs: insertRpcMs },
          "warn",
        );
      }
    } else {
      logGenerateAi("generate_ai_insert_response_skipped", {
        conversaId,
        mensagemId: mensagemData.id,
        reason: "no_response_id",
      });
    }

    logGenerateAi("generate_ai_resolve_instance_start", {
      conversaId,
      instanciaProvided: Boolean(instancia),
    });
    const { instancia: resolvedInstancia, error: instanceError } =
      await resolveWhatsAppInstance({ instancia, conversaId }, env);

    if (instanceError) {
      logGenerateAi(
        "generate_ai_resolve_instance_failed",
        { conversaId, error: instanceError },
        "warn",
      );
      const statusCode =
        instanceError === "Conversation not found" ? 404 : 409;
      return c.json({ error: instanceError }, statusCode);
    }

    logGenerateAi("generate_ai_resolve_instance_done", {
      conversaId,
      instancia: resolvedInstancia,
    });

    if (numeroWhatsapp) {
      logGenerateAi("generate_ai_evolution_send", {
        conversaId,
        instancia: resolvedInstancia,
        outputCharCount: responseContent.length,
        numeroWhatsappLen: numeroWhatsapp.length,
      });
      await sendEvolutionMessage(
        resolvedInstancia,
        numeroWhatsapp,
        responseContent,
        env,
        {
          conversaId,
          mensagemId: mensagemData.id,
          atendimentoId: serviceAtendimento.atendimentoId,
          organizacaoId: organizacaoId ?? null,
        },
      );
      logGenerateAi("generate_ai_evolution_done", {
        conversaId,
        instancia: resolvedInstancia,
      });
    } else {
      logGenerateAi(
        "generate_ai_evolution_skipped",
        { conversaId, reason: "numero_whatsapp_absent" },
        "warn",
      );
      console.warn(
        "⚠️ numeroWhatsapp ausente — resposta gerada mas não enviada via Evolution",
      );
    }

    logGenerateAi("generate_ai_completed", {
      conversaId,
      mensagemId: mensagemData.id,
      sentViaEvolution: Boolean(numeroWhatsapp),
    });

    return c.json({
      message: "AI response generated successfully",
      status: "completed",
      data: {
        conversaId,
        response_content: responseContent,
        mensagem_id: mensagemData.id,
        response_id: responseId,
        tokens_used: tokensUsed,
        is_new_atendimento: serviceAtendimento.isNew,
        atendimento_messages_count: atendimentoMensagens.length,
        aggregated_messages_count: inputs.length,
        agent_used: result.agentUsed,
      },
    }, 200);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (/no tool output found/i.test(errMsg)) {
      logGenerateAi(
        "generate_ai_openai_responses_missing_tool_output",
        {
          conversaId,
          errorMessagePreview: errMsg.slice(0, 800),
          hint: "OpenAI Responses: existe function_call no encadeamento sem function_call_result correspondente. Ver logs run_agents_failed na mesma conversaId.",
        },
        "warn",
      );
    }
    throw error;
  }
}

/**
 * Converte uma linha de `whatsapp_mensagens` em item de input do agente.
 * Cliente → `user`; chatbot/atendente → `assistant`.
 */
async function whatsappRowToAgentInput(
  row: WhatsappMensagem,
  env: EnvConfig,
): Promise<AgentInputItem | null> {
  const tipo = row.tipo_mensagem ?? "texto";
  const role =
    row.remetente === "cliente" ? ("user" as const) : ("assistant" as const);

  if (tipo === "audio" && row.anexo_url) {
    const t = await transcribeAudioFromStorage(
      row.anexo_url,
      "audio/ogg",
      env,
    );
    const content = t.success && t.transcription
      ? t.transcription.trim()
      : "[áudio sem transcrição]";
    return content
      ? { role, content, type: "message" as const }
      : null;
  }

  if (row.remetente === "cliente" && row.anexo_url && tipo !== "texto") {
    return buildUserInputFromMedia({
      tipoMensagem: tipo,
      anexoUrl: row.anexo_url,
      caption: row.conteudo,
    });
  }

  const text = row.conteudo?.trim() ?? "";
  if (!text) return null;
  return { role, content: text, type: "message" as const };
}

/**
 * Histórico do atendimento (`whatsapp_mensagens.atendimento_id`) mais a
 * mensagem de sistema do agente responsável.
 */
async function buildAgentInputsFromAtendimentoWindow(params: {
  atendimentoId: string;
  agenteResponsavel: AgentId;
  env: EnvConfig;
}): Promise<AgentInputItem[]> {
  const rows = await getMensagensByAtendimentoId(
    params.atendimentoId,
    params.env,
  );

  const items: AgentInputItem[] = [
    buildResponsibleAgentSystemMessage(params.agenteResponsavel),
  ];
  for (const row of rows) {
    const item = await whatsappRowToAgentInput(row, params.env);
    if (item) items.push(item);
  }
  return items;
}

async function resolveCalendarConnection(
  organizacaoId: string | undefined,
  env: EnvConfig,
): Promise<string | undefined> {
  if (!organizacaoId) return undefined;
  const supabase = getSupabaseClient(env);
  const { data } = await supabase
    .from("calendar_connections")
    .select("id")
    .eq("organization_id", organizacaoId)
    .eq("is_active", true)
    .maybeSingle<{ id: string }>();
  return data?.id;
}
