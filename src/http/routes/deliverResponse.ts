import type { Context } from "hono";
import { Hono } from "hono";
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
import type { LiaHttpVariables } from "../honoVariables.js";

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

type DeliverCtx = Context<{ Variables: LiaHttpVariables }>;

/**
 * Rota responsável por entregar uma mensagem (texto, áudio, mídia) via
 * Evolution API. Pode ser chamada com `conversa_id` (rápido) ou apenas com
 * `number + organization_id` (resolve a conversa pelo número).
 */
export function buildDeliverResponseRouter(
  deps: DeliverResponseDeps,
): Hono<{ Variables: LiaHttpVariables }> {
  const r = new Hono<{ Variables: LiaHttpVariables }>();
  r.post("/", async (c) => handleDeliver(c, deps));
  return r;
}

async function handleDeliver(
  c: DeliverCtx,
  deps: DeliverResponseDeps,
): Promise<Response> {
  const env = deps.env;
  const supabase = getSupabaseClient(env);
  const body = (c.var.jsonBody ?? {}) as DeliverRequestBody;

  if (!body.number) {
    return c.json({ error: "Missing required field: number" }, 400);
  }

  try {
    let conversaId: string | undefined = body.conversa_id;

    if (!conversaId) {
      if (!body.organization_id) {
        return c.json({
          error: "Missing required field: organization_id or conversa_id",
        }, 400);
      }
      const conversa = await getConversaByPhoneNumber(
        body.number,
        body.organization_id,
        env,
      );
      if (!conversa) {
        return c.json({ error: "No conversation found for this number" }, 404);
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
      return c.json({ error: "Conversation organization not found" }, 404);
    }

    const activeInstance = await getActiveWhatsAppInstance(
      conversaOrg.organization_id,
      env,
    );
    if (!activeInstance) {
      return c.json({
        error:
          "No active WhatsApp instance configured for this organization",
      }, 409);
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
        return c.json({
          error: "Missing required field: text for conversation message",
        }, 400);
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
        {
          conversaId,
          route: "deliver_response",
        },
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

    return c.json({
      message: "Message sent successfully",
      messageType,
      messageId: savedMessage.id,
      evolutionResponse: evolutionResult,
    }, 200);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    console.error("❌ Erro em deliverResponse:", err);
    return c.json(
      { error: "Internal server error", details: errorMessage },
      500,
    );
  }
}
