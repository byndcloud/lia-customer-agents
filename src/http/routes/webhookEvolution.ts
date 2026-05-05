import type { Context } from "hono";
import { Hono } from "hono";
import type { EnvConfig } from "../../config/env.js";
import type { LiaHttpVariables } from "../honoVariables.js";
import {
  createWhatsAppConversation,
  updateConversationStatus,
  type WhatsappConversa,
} from "../../db/conversations.js";
import {
  finalizarAtendimentoWhatsAppComoResolvido,
  resolveAtendimentoIdForPersistedMessage,
  transicionarParaAtendimentoWhatsApp,
} from "../../db/atendimentos.js";
import { getOrganizationByInstanceName } from "../../db/instances.js";
import {
  saveChatbotMessage,
  saveIncomingMessage,
  saveMediaMessage,
} from "../../db/messages.js";
import { isSupportedAudioFormat } from "../../services/audioTranscription.js";
import { checkAndRestart } from "../../services/conversationRestarter.js";
import { sendEvolutionMessage } from "../../services/evolutionApi.js";
import {
  uploadMediaToStorage,
  validateMediaSize,
} from "../../services/mediaStorage.js";
import { handlePhoneNumber } from "../../services/phone.js";
import { queueService } from "../../services/queueService.js";
import { getConversaByPhoneNumber } from "../../services/whatsapp.js";
import type { EvolutionWebhookData } from "../../types/evolution.js";

export interface WebhookEvolutionDeps {
  env: EnvConfig;
}

/**
 * Cria o router que recebe o webhook da Evolution.
 *
 * Mantém o mesmo comportamento da edge function:
 *  - Resolve organização pela instância.
 *  - Cria conversa quando não existe (respeitando flag de triagem).
 *  - Reinicia conversa encerrada conforme preferências da pessoa.
 *  - Salva mensagem (texto/áudio/mídia) e faz upload de mídia para Storage.
 *  - Marca encerramento por marcador `⚖️⚖️⚖️` (atendente humano).
 *  - Transiciona para `em_atendimento_whatsapp` quando o atendente envia
 *    mensagem com `fromMe = true`.
 *  - Enfileira mensagem para o chatbot (Cloud Tasks) quando aplicável.
 */
type WebhookCtx = Context<{ Variables: LiaHttpVariables }>;

export function buildWebhookEvolutionRouter(
  deps: WebhookEvolutionDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();
  r.post("/", async (c) => handleWebhook(c, deps));
  return r;
}

/** Pega o JID válido (algumas mensagens usam `remoteJidAlt`). */
function getValidRemoteJid(key: {
  remoteJid: string;
  remoteJidAlt?: string;
}): string {
  if (key.remoteJid.includes("@s.whatsapp.net")) return key.remoteJid;
  return key.remoteJidAlt || key.remoteJid;
}

interface MessageProcessingState {
  messageContent: string;
  shouldEnqueueToAI: boolean;
  audioData?: { storageUrl: string; mimetype: string };
  /** Última mensagem persistida do cliente neste webhook (para correlacionar a task). */
  triggerMensagem?: { id: string; created_at: string };
}

function requestOriginalUrl(c: WebhookCtx): string {
  try {
    const u = new URL(c.req.url, "http://localhost");
    return `${u.pathname}${u.search}`;
  } catch {
    return c.req.url;
  }
}

/** Diagnóstico de o que chegou no POST `/webhook-evolution` (após auth global). */
function logWebhookEvolutionIncoming(c: WebhookCtx): void {
  const authRaw = c.req.header("authorization");
  const logSecrets = process.env.LOG_SENSITIVE_REQUEST === "1";
  const forwarded = c.req.header("x-forwarded-for");
  const ip =
    c.req.header("x-real-ip")?.trim() ||
    forwarded?.split(",")[0]?.trim() ||
    undefined;
  console.info(
    JSON.stringify({
      level: "info",
      event: "webhook_evolution_request",
      method: c.req.method,
      path: c.req.path,
      originalUrl: requestOriginalUrl(c),
      ip,
      forwardedFor: forwarded,
      userAgent: c.req.header("user-agent"),
      cloudTrace: c.req.header("x-cloud-trace-context"),
      hasAuthorizationHeader: authRaw !== undefined,
      authorizationPreview: authRaw
        ? logSecrets
          ? authRaw
          : `[redacted prefix=${authRaw.slice(0, 12)}… len=${authRaw.length}]`
        : null,
      contentType: c.req.header("content-type"),
      contentLength: c.req.header("content-length"),
    }),
  );
}

async function handleWebhook(
  c: WebhookCtx,
  deps: WebhookEvolutionDeps,
): Promise<Response> {
  logWebhookEvolutionIncoming(c);
  const body = (c.var.jsonBody ?? {}) as EvolutionWebhookData;

  if (
    !body.event ||
    !body.data?.key ||
    !body.data.message ||
    !body.data.messageType
  ) {
    return c.json({ error: "Invalid payload structure" }, 400);
  }

  if (body.event !== "messages.upsert") {
    return c.json({ message: "Event ignored" }, 200);
  }

  const remoteJid = getValidRemoteJid(body.data.key);
  const phoneNumber = remoteJid.replace(/@.*/, "").replace(/:.*/, "");

  const activeInstance = await getOrganizationByInstanceName(
    body.instance,
    deps.env,
  );

  if (!activeInstance) {
    return c.json({
      message: "Message ignored - no active WhatsApp instance found",
      instance: body.instance,
    }, 200);
  }

  const organizationId = activeInstance.organization_id;

  if (!organizationId) {
    return c.json({
      error: "Organization not found for instance",
      instance: body.instance,
    }, 404);
  }

  let conversa: WhatsappConversa | null = await getConversaByPhoneNumber(
    phoneNumber,
    organizationId,
    deps.env,
  );

  if (!conversa) {
    const triageEnabled = activeInstance.triage_enabled ?? false;
    conversa = await createWhatsAppConversation(
      organizationId,
      phoneNumber,
      triageEnabled,
      deps.env,
    );

    if (!conversa) {
      return c.json({
        message: triageEnabled
          ? "Error creating conversation for unknown number"
          : "Triage disabled - phone number not registered as a client",
        phoneNumber,
      }, 200);
    }
  } else if (conversa.status) {
    const restart = await checkAndRestart(
      conversa.id,
      conversa.status,
      conversa.pessoa_id,
      organizationId,
      deps.env,
    );

    if (restart.shouldRestart) {
      conversa.status = restart.newStatus;
      conversa.chatbot_ativo = restart.chatbotAtivo ?? conversa.chatbot_ativo;
    }
  }

  const triageEnabledOnInstance = activeInstance.triage_enabled ?? false;
  if (
    !body.data.key.fromMe &&
    !conversa.pessoa_id &&
    !triageEnabledOnInstance
  ) {
    console.info(
      `[webhook-evolution] organization_id=${organizationId}: mensagem ignorada (não cliente e whatsapp_numeros.triage_enabled=false).`,
    );
    return c.json({
      message:
        "Message ignored — triage disabled for non-client on this WhatsApp instance",
      organizationId,
    }, 200);
  }

  const state = await processMessage(
    body,
    conversa,
    activeInstance.instance_name,
    phoneNumber,
    organizationId,
    deps.env,
  );

  await maybeEncerrarConversaPorMarcador(
    body,
    conversa,
    state.messageContent,
    organizationId,
    deps.env,
  );

  await maybeTransicionarParaWhatsApp(
    body,
    conversa,
    remoteJid,
    organizationId,
    state.messageContent,
    deps.env,
  );

  await maybeEnfileirarChatbot(
    body,
    conversa,
    state,
    activeInstance.instance_name,
    organizationId,
    remoteJid,
    deps.env,
  );

  return c.json({ message: "Message processed successfully" }, 200);
}

/**
 * Salva a mensagem (texto/áudio/mídia) e devolve o estado para o restante do
 * fluxo decidir o que fazer (encerrar, enfileirar, etc).
 */
async function processMessage(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  instanceName: string,
  phoneNumber: string,
  organizationId: string,
  env: EnvConfig,
): Promise<MessageProcessingState> {
  const state: MessageProcessingState = {
    messageContent: "",
    shouldEnqueueToAI: true,
  };

  const atendimentoIdPersist = await resolveAtendimentoIdForPersistedMessage(
    {
      id: conversa.id,
      status: conversa.status,
      chatbot_ativo: conversa.chatbot_ativo,
    },
    organizationId,
    body.data.key.fromMe ? "atendente" : "cliente",
    env,
  );

  switch (body.data.messageType) {
    case "conversation": {
      state.messageContent = body.data.message.conversation || "";
      {
        const row = await saveIncomingMessage(
          conversa.id,
          body.data.key.fromMe,
          state.messageContent,
          undefined,
          env,
          atendimentoIdPersist,
        );
        if (!body.data.key.fromMe) {
          state.triggerMensagem = { id: row.id, created_at: row.created_at };
        }
      }
      break;
    }

    case "extendedTextMessage": {
      state.messageContent = body.data.message.extendedTextMessage?.text || "";
      {
        const row = await saveIncomingMessage(
          conversa.id,
          body.data.key.fromMe,
          state.messageContent,
          undefined,
          env,
          atendimentoIdPersist,
        );
        if (!body.data.key.fromMe) {
          state.triggerMensagem = { id: row.id, created_at: row.created_at };
        }
      }
      break;
    }

    case "reactionMessage": {
      const reactionMsg = body.data.message.reactionMessage as {
        text?: string;
      };
      state.messageContent = reactionMsg?.text || "";
      {
        const row = await saveIncomingMessage(
          conversa.id,
          body.data.key.fromMe,
          state.messageContent,
          undefined,
          env,
          atendimentoIdPersist,
        );
        if (!body.data.key.fromMe) {
          state.triggerMensagem = { id: row.id, created_at: row.created_at };
        }
      }
      break;
    }

    case "audioMessage": {
      await processAudioMessage(
        body,
        conversa,
        instanceName,
        phoneNumber,
        state,
        env,
        organizationId,
        atendimentoIdPersist,
      );
      break;
    }

    case "imageMessage":
    case "videoMessage":
    case "documentMessage":
    case "stickerMessage": {
      await processUnsupportedMediaMessage(
        body,
        conversa,
        instanceName,
        phoneNumber,
        state,
        env,
        organizationId,
        atendimentoIdPersist,
      );
      break;
    }

    default: {
      console.warn(`⚠️ Tipo de mensagem desconhecido: ${body.data.messageType}`);
      state.shouldEnqueueToAI = false;
      state.messageContent = "";
    }
  }

  return state;
}

const MEDIA_LABEL: Record<string, string> = {
  imageMessage: "imagens",
  videoMessage: "vídeos",
  documentMessage: "documentos",
  stickerMessage: "figurinhas",
};

async function processAudioMessage(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  instanceName: string,
  phoneNumber: string,
  state: MessageProcessingState,
  env: EnvConfig,
  organizationId: string,
  atendimentoIdPersist: string | undefined,
): Promise<void> {
  const audioMsg = body.data.message.audioMessage as {
    caption?: string;
    mimetype?: string;
  };
  const caption = audioMsg?.caption ?? "";
  const mimetype = audioMsg?.mimetype || "audio/ogg";
  const base64Data = body.data.message.base64;
  if (!base64Data) {
    state.shouldEnqueueToAI = false;
    return;
  }

  const sizeValidation = validateMediaSize(base64Data, 10);
  if (!sizeValidation.valid) {
    state.shouldEnqueueToAI = false;
    state.messageContent = "";

    if (
      !body.data.key.fromMe &&
      conversa.status === "em_atendimento_chatbot" &&
      conversa.chatbot_ativo
    ) {
      const errorMessage = `Desculpe, o áudio enviado é muito grande (${sizeValidation.sizeMB}MB). Por favor, envie um áudio menor ou digite sua mensagem. 😊`;
      await sendAndStoreAutoReply(
        instanceName,
        phoneNumber,
        conversa,
        organizationId,
        errorMessage,
        env,
      );
    }
    return;
  }

  const sender = body.data.key.fromMe ? "atendente" : "cliente";
  const mediaUrl = await uploadMediaToStorage(
    { base64: base64Data, mimeType: mimetype, sender },
    env,
  );

  const savedAudio = await saveMediaMessage(
    conversa.id,
    mediaUrl,
    mimetype,
    body.data.key.fromMe,
    caption,
    undefined,
    env,
    atendimentoIdPersist,
  );
  if (!body.data.key.fromMe) {
    state.triggerMensagem = {
      id: savedAudio.id,
      created_at: savedAudio.created_at,
    };
  }

  if (body.data.key.fromMe) return;

  if (!isSupportedAudioFormat(mimetype)) {
    state.shouldEnqueueToAI = false;
    state.messageContent = "";

    if (
      conversa.status === "em_atendimento_chatbot" &&
      conversa.chatbot_ativo
    ) {
      const message = `Desculpe, o formato de áudio enviado não é suportado. Por favor, tente enviar em outro formato ou digite sua mensagem. 😊`;
      await sendAndStoreAutoReply(
        instanceName,
        phoneNumber,
        conversa,
        organizationId,
        message,
        env,
      );
    }
    return;
  }

  state.audioData = { storageUrl: mediaUrl, mimetype };
  state.messageContent = "[Mensagem de áudio]";
  state.shouldEnqueueToAI = true;
}

async function processUnsupportedMediaMessage(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  instanceName: string,
  phoneNumber: string,
  state: MessageProcessingState,
  env: EnvConfig,
  organizationId: string,
  atendimentoIdPersist: string | undefined,
): Promise<void> {
  const messageType = body.data.messageType;
  const msg = body.data.message[messageType] as
    | {
        caption?: string;
        mimetype?: string;
        fileName?: string;
        title?: string;
      }
    | undefined;
  const caption = msg?.caption ?? "";
  const mimetype = msg?.mimetype || "application/octet-stream";
  const base64Data = body.data.message.base64;
  if (!base64Data) {
    state.shouldEnqueueToAI = false;
    return;
  }

  const sizeValidation = validateMediaSize(base64Data, 10);
  if (!sizeValidation.valid) {
    state.shouldEnqueueToAI = false;
    state.messageContent = "";

    if (
      !body.data.key.fromMe &&
      conversa.status === "em_atendimento_chatbot"
    ) {
      const errorMessage = `Desculpe, o arquivo enviado é muito grande (${sizeValidation.sizeMB}MB). Por favor, envie um arquivo menor. 😊`;
      await sendAndStoreAutoReply(
        instanceName,
        phoneNumber,
        conversa,
        organizationId,
        errorMessage,
        env,
      );
    }
    return;
  }

  const sender = body.data.key.fromMe ? "atendente" : "cliente";
  const mediaUrl = await uploadMediaToStorage(
    {
      base64: base64Data,
      mimeType: mimetype,
      sender,
      originalFileName: msg?.fileName || msg?.title,
    },
    env,
  );

  const savedMedia = await saveMediaMessage(
    conversa.id,
    mediaUrl,
    mimetype,
    body.data.key.fromMe,
    caption,
    undefined,
    env,
    atendimentoIdPersist,
  );
  if (!body.data.key.fromMe) {
    state.triggerMensagem = {
      id: savedMedia.id,
      created_at: savedMedia.created_at,
    };
  }

  const captionText = caption.trim();
  const label = MEDIA_LABEL[messageType] ?? "arquivo";
  state.messageContent = captionText || `[${label} enviado]`;
  state.shouldEnqueueToAI = !body.data.key.fromMe;
}

async function sendAndStoreAutoReply(
  instanceName: string,
  phoneNumber: string,
  conversa: WhatsappConversa,
  organizationId: string,
  message: string,
  env: EnvConfig,
): Promise<void> {
  try {
    await sendEvolutionMessage(instanceName, phoneNumber, message, env, {
      conversaId: conversa.id,
      source: "webhook_evolution_auto_reply",
    });
    const aid = await resolveAtendimentoIdForPersistedMessage(
      {
        id: conversa.id,
        status: conversa.status,
        chatbot_ativo: conversa.chatbot_ativo,
      },
      organizationId,
      "chatbot",
      env,
    );
    await saveChatbotMessage(
      conversa.id,
      message,
      "texto",
      undefined,
      env,
      aid,
    );
  } catch (error) {
    console.error("❌ Erro ao enviar resposta automática:", error);
  }
}

const MARCADOR_ENCERRAMENTO_REGEX = /⚖️\s*⚖️\s*⚖️/;

async function maybeEncerrarConversaPorMarcador(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  messageContent: string,
  organizationId: string,
  env: EnvConfig,
): Promise<void> {
  const deveEncerrar =
    body.data.key.fromMe &&
    conversa.status === "em_atendimento_whatsapp" &&
    MARCADOR_ENCERRAMENTO_REGEX.test(messageContent.trimStart());

  if (!deveEncerrar) return;

  try {
    await updateConversationStatus(conversa.id, "encerrado", env);
    conversa.status = "encerrado";

    await finalizarAtendimentoWhatsAppComoResolvido(
      conversa.id,
      organizationId,
      "Atendimento finalizado via emoji da justiça",
      env,
    );
  } catch (error) {
    console.error(
      "❌ Erro ao encerrar conversa por marcador ⚖️⚖️⚖️:",
      error,
    );
  }
}

async function maybeTransicionarParaWhatsApp(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  remoteJid: string,
  organizationId: string,
  messageContent: string,
  env: EnvConfig,
): Promise<void> {
  const jaEncerrouPorMarcador =
    body.data.key.fromMe &&
    conversa.status === "encerrado" &&
    MARCADOR_ENCERRAMENTO_REGEX.test(messageContent.trimStart());

  const deveTransicionar =
    conversa.status !== "em_atendimento_whatsapp" &&
    body.data.key.fromMe &&
    !jaEncerrouPorMarcador;

  if (!deveTransicionar) return;

  try {
    const updated = await updateConversationStatus(
      conversa.id,
      "em_atendimento_whatsapp",
      env,
    );
    conversa.status = updated.status;

    const phoneData = handlePhoneNumber(
      remoteJid.replace(/@.*/, "").replace(/:.*/, ""),
    );

    if (!phoneData) {
      console.warn(
        `⚠️ Número inválido ao transicionar para atendimento WhatsApp: ${remoteJid}`,
      );
      return;
    }

    await transicionarParaAtendimentoWhatsApp(
      phoneData.phoneNumber,
      conversa.id,
      organizationId,
      env,
    );
  } catch (error) {
    console.error(
      "❌ Erro ao atualizar status para em_atendimento_whatsapp:",
      error,
    );
  }
}

async function maybeEnfileirarChatbot(
  body: EvolutionWebhookData,
  conversa: WhatsappConversa,
  state: MessageProcessingState,
  instanceName: string,
  organizationId: string,
  remoteJid: string,
  env: EnvConfig,
): Promise<void> {
  const podeEnfileirar =
    conversa.status === "em_atendimento_chatbot" &&
    conversa.chatbot_ativo &&
    !body.data.key.fromMe &&
    state.shouldEnqueueToAI &&
    state.messageContent.trim() !== "";

  if (!podeEnfileirar) {
    if (conversa.status === "em_atendimento_humano") {
      console.info(
        `ℹ️ Conversa ${conversa.id} em atendimento humano — não enfileira chatbot.`,
      );
    } else if (conversa.status !== "em_atendimento_chatbot") {
      console.info(
        `ℹ️ Mensagem não enfileirada: status=${conversa.status} chatbot_ativo=${conversa.chatbot_ativo} fromMe=${body.data.key.fromMe}`,
      );
    }
    return;
  }

  const phoneData = handlePhoneNumber(
    remoteJid.replace(/@.*/, "").replace(/:.*/, ""),
  );

  if (!phoneData) {
    console.warn(
      `⚠️ Número inválido ao enfileirar mensagem: ${remoteJid}`,
    );
    return;
  }

  try {
    await queueService.enqueueChatbotMessage(
      {
        conversaId: conversa.id,
        mensagem: state.messageContent,
        numeroWhatsapp: phoneData.phoneNumber,
        instancia: instanceName,
        clienteId: conversa.pessoa_id ?? "",
        organizacaoId: organizationId,
        audioData: state.audioData,
        ...(state.triggerMensagem
          ? {
              triggerMensagemId: state.triggerMensagem.id,
              triggerMensagemCreatedAt: state.triggerMensagem.created_at,
            }
          : {}),
      },
      undefined,
      env,
    );
  } catch (error) {
    console.error("❌ Erro ao enfileirar mensagem para chatbot:", error);
  }
}
