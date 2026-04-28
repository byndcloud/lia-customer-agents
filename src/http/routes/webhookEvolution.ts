import { Router, type Request, type Response } from "express";
import type { EnvConfig } from "../../config/env.js";
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
import { getChatbotTipoTriagem } from "../../db/chatbotAiConfig.js";
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
export function buildWebhookEvolutionRouter(
  deps: WebhookEvolutionDeps,
): Router {
  const router = Router();
  router.post("/", (req: Request, res: Response) =>
    handleWebhook(req, res, deps),
  );
  return router;
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
}

async function handleWebhook(
  req: Request,
  res: Response,
  deps: WebhookEvolutionDeps,
): Promise<void> {
  const body = (req.body ?? {}) as EvolutionWebhookData;

  if (
    !body.event ||
    !body.data?.key ||
    !body.data.message ||
    !body.data.messageType
  ) {
    res.status(400).json({ error: "Invalid payload structure" });
    return;
  }

  if (body.event !== "messages.upsert") {
    res.status(200).json({ message: "Event ignored" });
    return;
  }

  const remoteJid = getValidRemoteJid(body.data.key);
  const phoneNumber = remoteJid.replace(/@.*/, "").replace(/:.*/, "");

  const activeInstance = await getOrganizationByInstanceName(
    body.instance,
    deps.env,
  );

  if (!activeInstance) {
    res.status(200).json({
      message: "Message ignored - no active WhatsApp instance found",
      instance: body.instance,
    });
    return;
  }

  const organizationId = activeInstance.organization_id;

  if (!organizationId) {
    res.status(404).json({
      error: "Organization not found for instance",
      instance: body.instance,
    });
    return;
  }

  const tipoTriagem = await getChatbotTipoTriagem(organizationId, deps.env);
  if (!body.data.key.fromMe && tipoTriagem === "sem_triagem") {
    console.info(
      `[webhook-evolution] organization_id=${organizationId}: mensagem de cliente ignorada (chatbot_ai_config.tipo_triagem="sem_triagem").`,
    );
    res.status(200).json({
      message:
        "Message ignored — organization chatbot tipo_triagem is sem_triagem",
      organizationId,
    });
    return;
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
      res.status(200).json({
        message: triageEnabled
          ? "Error creating conversation for unknown number"
          : "Triage disabled - phone number not registered as a client",
        phoneNumber,
      });
      return;
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

  res.status(200).json({ message: "Message processed successfully" });
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
      await saveIncomingMessage(
        conversa.id,
        body.data.key.fromMe,
        state.messageContent,
        undefined,
        env,
        atendimentoIdPersist,
      );
      break;
    }

    case "extendedTextMessage": {
      state.messageContent = body.data.message.extendedTextMessage?.text || "";
      await saveIncomingMessage(
        conversa.id,
        body.data.key.fromMe,
        state.messageContent,
        undefined,
        env,
        atendimentoIdPersist,
      );
      break;
    }

    case "reactionMessage": {
      const reactionMsg = body.data.message.reactionMessage as {
        text?: string;
      };
      state.messageContent = reactionMsg?.text || "";
      await saveIncomingMessage(
        conversa.id,
        body.data.key.fromMe,
        state.messageContent,
        undefined,
        env,
        atendimentoIdPersist,
      );
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

  await saveMediaMessage(
    conversa.id,
    mediaUrl,
    mimetype,
    body.data.key.fromMe,
    caption,
    undefined,
    env,
    atendimentoIdPersist,
  );

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

  await saveMediaMessage(
    conversa.id,
    mediaUrl,
    mimetype,
    body.data.key.fromMe,
    caption,
    undefined,
    env,
    atendimentoIdPersist,
  );

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
    await sendEvolutionMessage(instanceName, phoneNumber, message, env);
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
      },
      undefined,
      env,
    );
  } catch (error) {
    console.error("❌ Erro ao enfileirar mensagem para chatbot:", error);
  }
}
