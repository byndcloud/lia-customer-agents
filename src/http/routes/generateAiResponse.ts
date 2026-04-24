import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { EnvConfig } from "../../config/env.js";
import { getSupabaseClient } from "../../db/client.js";
import {
  ensureActiveService,
  setActiveServiceOpenAiConversationId,
} from "../../db/atendimentos.js";
import { updateConversationStatus } from "../../db/conversations.js";
import { saveChatbotMessage } from "../../db/messages.js";
import { insertWhatsappConversationResponse } from "../../db/responses.js";
import { transcribeAudioFromStorage } from "../../services/audioTranscription.js";
import { getActiveServiceSessionContext } from "../../services/conversationContext.js";
import { shouldInterceptMessage } from "../../services/conversationFlowInterceptor.js";
import { sendEvolutionMessage } from "../../services/evolutionApi.js";
import {
  queueService,
  type ChatbotQueuePayload,
} from "../../services/queueService.js";
import { resolveWhatsAppInstance } from "../../services/whatsappInstanceResolver.js";
import { runAgents } from "../../runtime/run-agents.js";
import type { AgentInputItem } from "../../types.js";

/** Janela de agregação em segundos (mantém o mesmo valor da edge function). */
const CHATBOT_AGGREGATION_WINDOW_SEC = 20;

/** Limite de re-enfileiramentos quando a janela ainda está aberta. */
const CHATBOT_QUEUE_SELF_RETRY_MAX = 12;

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

  /** Preenchido após carregar contexto da sessão OpenAI — usado no `catch`. */
  let openAiSessionContext: {
    openAiConversationId: string | null;
    lastResponseId: string | null;
    chainDecisionReason: string;
  } | null = null;

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
      .select("status")
      .eq("id", conversaId)
      .single<{ status: string }>();

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

    if (organizacaoId) {
      await ensureActiveService(conversaId, organizacaoId, env);
    }

    const {
      openAiConversationId,
      lastResponseId,
      isNewService,
      chainDecisionReason,
    } = await getActiveServiceSessionContext(
      conversaId,
      env,
    );
    openAiSessionContext = {
      openAiConversationId,
      lastResponseId,
      chainDecisionReason,
    };

    const calendarConnectionId = await resolveCalendarConnection(
      organizacaoId,
      env,
    );

    const { data: claimedMessages, error: claimError } = await supabase.rpc(
      "claim_pending_chatbot_messages",
      { _conversa_id: conversaId, _window_seconds: 20 },
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

    const inputs = await buildAgentInputs(pendingMessages, env);

    if (inputs.length === 0) {
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

    if (!organizacaoId) {
      console.error(
        "❌ organizacaoId ausente — não é possível chamar runAgents",
      );
      res.status(400).json({
        error: "organizacaoId é obrigatório para gerar resposta",
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
      hasOpenAiConversationId: Boolean(openAiConversationId),
      openAiSessionDecision: chainDecisionReason,
      hasPreviousResponseRow: Boolean(lastResponseId),
      clientIdForAgents: Boolean(clientIdForAgents),
    });

    const result = await runAgents(
      {
        inputs,
        conversaId,
        conversationId: openAiConversationId ?? undefined,
        organizationId: organizacaoId,
        clientId: clientIdForAgents,
        calendarConnectionId,
        extra: pessoaId ? { pessoaId } : undefined,
      },
      { env },
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
      openaiConversationId: result.openaiConversationId ?? null,
    });

    if (
      result.openaiConversationId &&
      result.openaiConversationId !== openAiConversationId
    ) {
      await setActiveServiceOpenAiConversationId(
        conversaId,
        result.openaiConversationId,
        env,
      );
      logGenerateAi("generate_ai_openai_conversation_persisted", {
        conversaId,
        openaiConversationId: result.openaiConversationId,
      });
    }

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
          previousResponseId: lastResponseId ?? undefined,
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
        openai_conversation_id: result.openaiConversationId,
        tokens_used: tokensUsed,
        had_previous_response: Boolean(lastResponseId),
        resumed_openai_conversation: Boolean(openAiConversationId),
        is_new_service: isNewService,
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
          openAiConversationId:
            openAiSessionContext?.openAiConversationId ?? null,
          lastResponseId: openAiSessionContext?.lastResponseId ?? null,
          chainDecisionReason: openAiSessionContext?.chainDecisionReason ?? null,
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
 *  - Cloud Tasks disparou cedo demais (janela de agregação ainda aberta).
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

  logGenerateAi("generate_ai_handle_empty_claim", {
    conversaId: params.conversaId,
    queueRetryCount: params.queueRetryCount,
    organizacaoId: params.organizacaoId ?? null,
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
    ageSec < CHATBOT_AGGREGATION_WINDOW_SEC &&
    params.queueRetryCount < CHATBOT_QUEUE_SELF_RETRY_MAX &&
    params.organizacaoId &&
    params.instancia &&
    params.numeroWhatsapp;

  if (podeReenfileirar) {
    const waitSec = Math.max(
      1,
      Math.ceil(CHATBOT_AGGREGATION_WINDOW_SEC - (ageSec ?? 0)) + 2,
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
    ageSec < CHATBOT_AGGREGATION_WINDOW_SEC &&
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
 * Constrói o array de `AgentInputItem` a partir do batch agregado.
 *
 * Para áudios, faz a transcrição via Whisper e usa o texto retornado. Falhas
 * de transcrição não derrubam o batch — viram um placeholder para o agente
 * saber que houve áudio.
 */
async function buildAgentInputs(
  pendingMessages: ClaimedPendingMessage[],
  env: EnvConfig,
): Promise<AgentInputItem[]> {
  const inputs: AgentInputItem[] = [];

  for (const pending of pendingMessages) {
    const messageType = pending.tipo_mensagem ?? "texto";

    if (messageType === "audio" && pending.anexo_url) {
      const t = await transcribeAudioFromStorage(
        pending.anexo_url,
        "audio/ogg",
        env,
      );
      const content = t.success && t.transcription
        ? t.transcription.trim()
        : "[áudio sem transcrição]";
      if (content) {
        inputs.push({ role: "user", content });
      }
      continue;
    }

    if (messageType === "texto" && pending.conteudo?.trim()) {
      inputs.push({ role: "user", content: pending.conteudo });
    }
  }

  return inputs;
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
