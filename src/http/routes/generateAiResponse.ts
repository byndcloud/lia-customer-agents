import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  CHATBOT_QUEUE_REQUEUE_BUFFER_SECONDS,
  chatbotQueueClaimWindowSeconds,
  type EnvConfig,
} from "../../config/env.js";
import { getSupabaseClient } from "../../db/client.js";
import {
  clampAtendimentoIniciadoEmIfEarlier,
  ensureActiveService,
  updateActiveServiceResponsibleAgent,
} from "../../db/atendimentos.js";
import { updateConversationStatus } from "../../db/conversations.js";
import {
  getMensagensByAtendimentoId,
  getWhatsappMensagensByIds,
  mergeWhatsappMensagensChronological,
  saveChatbotMessage,
  type WhatsappMensagem,
} from "../../db/messages.js";
import { insertWhatsappConversationResponse } from "../../db/responses.js";
import { transcribeAudioFromStorage } from "../../services/audioTranscription.js";
import { shouldInterceptMessage } from "../../services/conversationFlowInterceptor.js";
import { sendEvolutionMessage } from "../../services/evolutionApi.js";
import {
  queueService,
  type ChatbotQueuePayload,
} from "../../services/queueService.js";
import { resolveWhatsAppInstance } from "../../services/whatsappInstanceResolver.js";
import { runAgents } from "../../runtime/run-agents.js";
import type { AgentId, AgentInputItem } from "../../types.js";

/** Limite de re-enfileiramentos quando a janela ainda está aberta. */
const CHATBOT_QUEUE_SELF_RETRY_MAX = 12;

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

/** Menor `created_at` válido entre as mensagens em claim (batch atual). */
function earliestCreatedAtIsoInBatch(
  batch: ReadonlyArray<ClaimedPendingMessage>,
): string | null {
  let minMs = Infinity;
  for (const m of batch) {
    if (!m.created_at) continue;
    const t = new Date(m.created_at).getTime();
    if (!Number.isNaN(t) && t < minMs) minMs = t;
  }
  return minMs === Infinity ? null : new Date(minMs).toISOString();
}

/**
 * Primeiro run de um **atendimento novo**: não carrega histórico do banco;
 * envia só a mensagem de sistema do agente + o lote em claim (mensagens
 * recém-chegadas / agregadas neste processamento).
 */
async function buildAgentInputsNewAtendimentoPendingOnly(params: {
  pendingMessages: ClaimedPendingMessage[];
  agenteResponsavel: AgentId;
  env: EnvConfig;
}): Promise<AgentInputItem[]> {
  const items: AgentInputItem[] = [
    buildResponsibleAgentSystemMessage(params.agenteResponsavel),
  ];

  for (const pending of params.pendingMessages) {
    const messageType = pending.tipo_mensagem ?? "texto";

    if (messageType === "audio" && pending.anexo_url) {
      const t = await transcribeAudioFromStorage(
        pending.anexo_url,
        "audio/ogg",
        params.env,
      );
      const content = t.success && t.transcription
        ? t.transcription.trim()
        : "[áudio sem transcrição]";
      if (content) {
        items.push({
          role: "user",
          content,
          type: "message",
        });
      }
      continue;
    }

    if (messageType === "texto" && pending.conteudo?.trim()) {
      items.push({
        role: "user",
        content: pending.conteudo,
        type: "message",
      });
      continue;
    }

    if (pending.anexo_url && messageType !== "texto") {
      items.push(
        buildUserInputFromMedia({
          tipoMensagem: messageType,
          anexoUrl: pending.anexo_url,
          caption: pending.conteudo,
        }),
      );
    }
  }

  return items;
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

interface ClaimedPendingMessage {
  id: string;
  conteudo: string;
  tipo_mensagem: string | null;
  anexo_url: string | null;
  created_at: string;
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
  /** Definido ao re-enfileirar quando a janela de agregação ainda está aberta. */
  _queueRetryCount?: number;
}

export interface GenerateAiResponseDeps {
  env: EnvConfig;
}

/**
 * Cria o router que processa o batch agregado de mensagens e gera uma
 * resposta com os agentes OpenAI internos. É chamado pelo Cloud Tasks (com
 * delay) e não recebe a mensagem em si — apenas os identificadores
 * necessários para hidratar o contexto e claim do batch.
 */
export function buildGenerateAiResponseRouter(
  deps: GenerateAiResponseDeps,
): Router {
  const router = Router();
  router.post("/", (req: Request, res: Response, next: NextFunction) => {
    void handleGenerate(req, res, deps, next);
  });
  return router;
}

async function handleGenerate(
  req: Request,
  res: Response,
  deps: GenerateAiResponseDeps,
  next: NextFunction,
): Promise<void> {
  const env = deps.env;
  const supabase = getSupabaseClient(env);

  const body = (req.body ?? {}) as GenerateAiRequestBody;

  const {
    conversaId,
    mensagem,
    instancia,
    numeroWhatsapp,
    pessoaId,
    organizacaoId,
    clienteId,
    audioData,
    _queueRetryCount: rawQueueRetry,
  } = body;

  const queueRetryCount =
    typeof rawQueueRetry === "number" && rawQueueRetry >= 0
      ? Math.floor(rawQueueRetry)
      : 0;

  if (!conversaId) {
    res.status(400).json({ error: "conversaId é obrigatório" });
    return;
  }

  try {
    logGenerateAi("generate_ai_request", {
      conversaId,
      organizacaoId: organizacaoId ?? null,
      hasNumeroWhatsapp: Boolean(
        typeof numeroWhatsapp === "string" && numeroWhatsapp.trim().length > 0,
      ),
      instancia: instancia ?? null,
      queueRetryCount,
      hasAudioPayload: Boolean(audioData),
    });

    const { data: conversa, error: conversaError } = await supabase
      .from("whatsapp_conversas")
      .select("status, organization_id")
      .eq("id", conversaId)
      .single<{ status: string; organization_id: string }>();

    if (conversaError) {
      console.error("❌ Erro ao buscar status da conversa:", conversaError);
      res.status(500).json({ error: "Erro ao verificar status da conversa" });
      return;
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
      res.status(200).json({
        message:
          "Conversa em atendimento humano - mensagem não processada pelo chatbot",
        status: "skipped",
        reason: "human_service_active",
      });
      return;
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

    await updateConversationStatus(conversaId, "em_atendimento_chatbot", env);

    if (!organizacaoId || String(organizacaoId).trim() === "") {
      res.status(400).json({
        error: "organizacaoId é obrigatório para gerar resposta",
      });
      return;
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

    const claimWindowSeconds = chatbotQueueClaimWindowSeconds(
      env.chatbotQueueDelaySeconds,
    );

    const { data: claimedMessages, error: claimError } = await supabase.rpc(
      "claim_pending_chatbot_messages",
      {
        _conversa_id: conversaId,
        _window_seconds: claimWindowSeconds,
      },
    );

    if (claimError) {
      console.error("❌ Erro ao fazer claim das mensagens pendentes:", claimError);
      res
        .status(500)
        .json({ error: "Erro ao preparar mensagens para processamento" });
      return;
    }

    const pendingMessages = (claimedMessages ?? []) as ClaimedPendingMessage[];

    logGenerateAi("generate_ai_claim", {
      conversaId,
      claimedCount: pendingMessages.length,
      claimedMessageIds: pendingMessages.map((m) => m.id),
      chatbotQueueDelaySeconds: env.chatbotQueueDelaySeconds,
      claimWindowSeconds,
    });

    if (pendingMessages.length === 0) {
      logGenerateAi("generate_ai_empty_claim_batch", {
        conversaId,
        queueRetryCount,
      });

      const handled = await handleEmptyClaim({
        conversaId,
        organizacaoId,
        instancia,
        numeroWhatsapp,
        clienteId,
        mensagem,
        audioData,
        queueRetryCount,
        env,
      });

      res.status(200).json(handled);
      return;
    }

    let serviceAtendimento = activeService;
    const earliestClaimIso = earliestCreatedAtIsoInBatch(pendingMessages);
    if (earliestClaimIso) {
      const patchedIniciado = await clampAtendimentoIniciadoEmIfEarlier(
        serviceAtendimento.atendimentoId,
        earliestClaimIso,
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
          earliestFromClaimBatch: earliestClaimIso,
        });
      }
    }

    let inputs: AgentInputItem[];
    if (serviceAtendimento.isNew) {
      inputs = await buildAgentInputsNewAtendimentoPendingOnly({
        pendingMessages,
        agenteResponsavel: serviceAtendimento.agenteResponsavel,
        env,
      });
    } else {
      inputs = await buildAgentInputsFromAtendimentoWindow({
        atendimentoId: serviceAtendimento.atendimentoId,
        agenteResponsavel: serviceAtendimento.agenteResponsavel,
        ensureMessageIds: pendingMessages.map((m) => m.id),
        env,
      });
    }

    logGenerateAi("generate_ai_input_scope", {
      conversaId,
      isNewAtendimento: serviceAtendimento.isNew,
      inputMode: serviceAtendimento.isNew
        ? "pending_batch_only"
        : "full_atendimento_history",
      pendingCount: pendingMessages.length,
      inputsCount: inputs.length,
    });

    const hasUserTurn = inputs.some((item) => item.role === "user");
    if (!hasUserTurn) {
      logGenerateAi("generate_ai_skipped", {
        conversaId,
        reason: "no_ai_eligible_messages",
        claimedCount: pendingMessages.length,
      });
      res.status(200).json({
        message: "Lote sem mensagens elegíveis para IA",
        status: "skipped",
        reason: "no_ai_eligible_messages",
        data: { claimed_count: pendingMessages.length },
      });
      return;
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
      await insertWhatsappConversationResponse(
        {
          responseId,
          whatsappMensagemId: mensagemData.id,
          modelUsed: env.aiModel,
          tokensUsed,
        },
        env,
      );
    }

    const { instancia: resolvedInstancia, error: instanceError } =
      await resolveWhatsAppInstance({ instancia, conversaId }, env);

    if (instanceError) {
      const status = instanceError === "Conversation not found" ? 404 : 409;
      res.status(status).json({ error: instanceError });
      return;
    }

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
      );
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

    res.status(200).json({
      message: "AI response generated successfully",
      status: "completed",
      data: {
        conversaId,
        response_content: responseContent,
        mensagem_id: mensagemData.id,
        response_id: responseId,
        tokens_used: tokensUsed,
        is_new_atendimento: activeService.isNew,
        claimed_messages_count: pendingMessages.length,
        aggregated_messages_count: inputs.length,
        agent_used: result.agentUsed,
      },
    });
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
    next(error);
  }
}

/**
 * Trata o caso em que `claim_pending_chatbot_messages` retorna vazio. Pode
 * acontecer quando:
 *  - Cloud Tasks disparou cedo demais (janela do claim ainda aberta — alinhada
 *    a `chatbotQueueClaimWindowSeconds(env.chatbotQueueDelaySeconds)`).
 *  - As mensagens já foram processadas por outro batch (idempotência).
 */
async function handleEmptyClaim(params: {
  conversaId: string;
  organizacaoId?: string | undefined;
  instancia?: string | undefined;
  numeroWhatsapp?: string | undefined;
  clienteId?: string | undefined;
  mensagem?: string | undefined;
  audioData?: ChatbotQueuePayload["audioData"];
  queueRetryCount: number;
  env: EnvConfig;
}): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient(params.env);
  const claimWindowSeconds = chatbotQueueClaimWindowSeconds(
    params.env.chatbotQueueDelaySeconds,
  );

  logGenerateAi("generate_ai_handle_empty_claim", {
    conversaId: params.conversaId,
    queueRetryCount: params.queueRetryCount,
    organizacaoId: params.organizacaoId ?? null,
    chatbotQueueDelaySeconds: params.env.chatbotQueueDelaySeconds,
    claimWindowSeconds,
  });

  const { data: latestPending, error: peekError } = await supabase
    .from("whatsapp_mensagens")
    .select("id, created_at")
    .eq("conversa_id", params.conversaId)
    .eq("remetente", "cliente")
    .is("processed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; created_at: string }>();

  if (peekError) {
    console.error("❌ Peek mensagens pendentes:", peekError);
  }

  let ageSec: number | null = null;
  if (latestPending?.created_at) {
    ageSec =
      (Date.now() - new Date(latestPending.created_at).getTime()) / 1000;
  }

  const podeReenfileirar =
    ageSec !== null &&
    ageSec < claimWindowSeconds &&
    params.queueRetryCount < CHATBOT_QUEUE_SELF_RETRY_MAX &&
    params.organizacaoId &&
    params.instancia &&
    params.numeroWhatsapp;

  if (podeReenfileirar) {
    const waitSec = Math.max(
      1,
      Math.ceil(claimWindowSeconds - (ageSec ?? 0)) +
        CHATBOT_QUEUE_REQUEUE_BUFFER_SECONDS,
    );

    await queueService.enqueueChatbotMessage(
      {
        conversaId: params.conversaId,
        mensagem: params.mensagem ?? "",
        instancia: params.instancia!,
        numeroWhatsapp: params.numeroWhatsapp!,
        clienteId: params.clienteId ?? "",
        organizacaoId: params.organizacaoId!,
        audioData: params.audioData,
        _queueRetryCount: params.queueRetryCount + 1,
      },
      waitSec,
      params.env,
    );

    logGenerateAi("generate_ai_requeued_aggregation_window", {
      conversaId: params.conversaId,
      waitSec,
      nextRetryCount: params.queueRetryCount + 1,
    });

    return {
      message: "Janela de agregação — nova tentativa agendada",
      status: "skipped",
      reason: "aggregation_window_requeued",
      data: {
        retryInSeconds: waitSec,
        retryCount: params.queueRetryCount + 1,
      },
    };
  }

  if (
    ageSec !== null &&
    ageSec < claimWindowSeconds &&
    params.queueRetryCount >= CHATBOT_QUEUE_SELF_RETRY_MAX
  ) {
    console.error(
      `❌ Limite de re-enfileiramentos (${CHATBOT_QUEUE_SELF_RETRY_MAX}) atingido com pendente ainda na janela`,
    );
  }

  logGenerateAi("generate_ai_empty_claim_final", {
    conversaId: params.conversaId,
    reason: "no_eligible_batch",
    queueRetryCount: params.queueRetryCount,
    ageSec,
  });

  return {
    message: "Sem lote elegível para processamento",
    status: "skipped",
    reason: "no_eligible_batch",
  };
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
 * mensagem de sistema do agente responsável. Une ids do claim que ainda não
 * tenham `atendimento_id` preenchido (ex.: legado imediato).
 */
async function buildAgentInputsFromAtendimentoWindow(params: {
  atendimentoId: string;
  agenteResponsavel: AgentId;
  /** Mensagens do claim que devem entrar mesmo sem vínculo na coluna nova. */
  ensureMessageIds?: readonly string[] | undefined;
  env: EnvConfig;
}): Promise<AgentInputItem[]> {
  let rows = await getMensagensByAtendimentoId(
    params.atendimentoId,
    params.env,
  );

  const ensureIds = params.ensureMessageIds ?? [];
  if (ensureIds.length > 0) {
    const have = new Set(rows.map((r) => r.id));
    const missing = ensureIds.filter((id) => !have.has(id));
    if (missing.length > 0) {
      const extra = await getWhatsappMensagensByIds(missing, params.env);
      rows = mergeWhatsappMensagensChronological(rows, extra);
    }
  }

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
