import { Router, type Request, type Response } from "express";
import type { EnvConfig } from "../../config/env.js";
import { getSupabaseClient } from "../../db/client.js";
import { getActiveWhatsAppInstance } from "../../db/instances.js";
import { resolveAtendimentoIdForPersistedMessage } from "../../db/atendimentos.js";
import { saveOutgoingMessage } from "../../db/messages.js";
import {
  sendEvolutionAudio,
  sendEvolutionMedia,
  sendEvolutionMessage,
} from "../../services/evolutionApi.js";
import {
  convertUrlToBase64,
  isValidUrl,
} from "../../services/mediaConverter.js";
import { getConversaByPhoneNumber } from "../../services/whatsapp.js";

export interface DeliverResponseDeps {
  env: EnvConfig;
}

interface DeliverRequestBody {
  number?: string;
  text?: string;
  conversa_id?: string;
  organization_id?: string;
  mediatype?: string;
  media?: string;
  mimetype?: string;
  caption?: string;
  fileName?: string;
  messageId?: string;
  userId?: string;
}

/**
 * Rota responsável por entregar uma mensagem (texto, áudio, mídia) via
 * Evolution API. Pode ser chamada com `conversa_id` (rápido) ou apenas com
 * `number + organization_id` (resolve a conversa pelo número).
 */
export function buildDeliverResponseRouter(
  deps: DeliverResponseDeps,
): Router {
  const router = Router();
  router.post("/", (req: Request, res: Response) =>
    handleDeliver(req, res, deps),
  );
  return router;
}

async function handleDeliver(
  req: Request,
  res: Response,
  deps: DeliverResponseDeps,
): Promise<void> {
  const env = deps.env;
  const supabase = getSupabaseClient(env);
  const body = (req.body ?? {}) as DeliverRequestBody;

  if (!body.number) {
    res.status(400).json({ error: "Missing required field: number" });
    return;
  }

  try {
    let conversaId: string | undefined = body.conversa_id;

    if (!conversaId) {
      if (!body.organization_id) {
        res.status(400).json({
          error: "Missing required field: organization_id or conversa_id",
        });
        return;
      }
      const conversa = await getConversaByPhoneNumber(
        body.number,
        body.organization_id,
        env,
      );
      if (!conversa) {
        res
          .status(404)
          .json({ error: "No conversation found for this number" });
        return;
      }
      conversaId = conversa.id;
    }

    const { data: conversaOrg, error: conversaOrgError } = await supabase
      .from("whatsapp_conversas")
      .select("organization_id, status, chatbot_ativo")
      .eq("id", conversaId)
      .maybeSingle<{
        organization_id: string;
        status: string;
        chatbot_ativo: boolean;
      }>();

    if (conversaOrgError) throw conversaOrgError;

    if (!conversaOrg?.organization_id) {
      res.status(404).json({ error: "Conversation organization not found" });
      return;
    }

    const activeInstance = await getActiveWhatsAppInstance(
      conversaOrg.organization_id,
      env,
    );
    if (!activeInstance) {
      res.status(409).json({
        error:
          "No active WhatsApp instance configured for this organization",
      });
      return;
    }

    let evolutionResult: unknown;
    let messageType: string;
    let content: string;
    let anexoUrl: string | undefined;

    if (body.mediatype && body.media) {
      messageType = body.mediatype;

      if (body.mediatype === "document") {
        content = body.fileName || body.caption || "Documento";
      } else {
        content = body.caption || "";
      }
      anexoUrl = body.media;

      if (body.mediatype === "audio") {
        evolutionResult = await sendEvolutionAudio(
          activeInstance,
          body.number,
          body.media,
          undefined,
          env,
        );
      } else if (body.mediatype === "document") {
        let mediaData = body.media;
        const fileName = body.fileName || `documento_${Date.now()}.pdf`;
        if (isValidUrl(body.media)) {
          mediaData = await convertUrlToBase64(body.media);
        }
        evolutionResult = await sendEvolutionMedia(
          activeInstance,
          body.number,
          mediaData,
          body.mediatype,
          {
            mimetype: body.mimetype,
            caption: body.caption,
            fileName,
          },
          env,
        );
      } else {
        evolutionResult = await sendEvolutionMedia(
          activeInstance,
          body.number,
          body.media,
          body.mediatype,
          { mimetype: body.mimetype, caption: body.caption },
          env,
        );
      }
    } else {
      messageType = "texto";
      content = body.text || "";

      if (!content) {
        res.status(400).json({
          error: "Missing required field: text for conversation message",
        });
        return;
      }

      let prefix = "";
      if (body.userId) {
        const { data: userData } = await supabase
          .from("profiles")
          .select("nome")
          .eq("user_id", body.userId)
          .single<{ nome: string }>();
        if (userData?.nome) {
          prefix = `*${userData.nome}:*\n`;
        }
      }

      evolutionResult = await sendEvolutionMessage(
        activeInstance,
        body.number,
        `${prefix}${content}`,
        env,
      );
    }

    const atendimentoId = await resolveAtendimentoIdForPersistedMessage(
      {
        id: conversaId,
        status: conversaOrg.status,
        chatbot_ativo: conversaOrg.chatbot_ativo,
      },
      conversaOrg.organization_id,
      "atendente",
      env,
    );

    const savedMessage = await saveOutgoingMessage(
      conversaId,
      messageType,
      content,
      body.messageId,
      anexoUrl,
      body.userId,
      env,
      atendimentoId,
    );

    res.status(200).json({
      message: "Message sent successfully",
      messageType,
      messageId: savedMessage.id,
      evolutionResponse: evolutionResult,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    console.error("❌ Erro em deliverResponse:", err);
    res
      .status(500)
      .json({ error: "Internal server error", details: errorMessage });
  }
}
