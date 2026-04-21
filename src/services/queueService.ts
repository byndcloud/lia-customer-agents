import {
  createPrivateKey,
  createSign,
  type KeyObject,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { loadEnv, type EnvConfig } from "../config/env.js";

/**
 * Integração com Google Cloud Tasks para a janela de agregação de mensagens.
 *
 * Fluxo:
 *  1. `webhook-evolution` recebe a mensagem.
 *  2. Salva no banco e chama `enqueueChatbotMessage` com delay (default 22s).
 *  3. Cloud Tasks dispara `POST <SELF_PUBLIC_BASE_URL>/generate-ai-response`.
 *  4. A rota agrega tudo o que chegou na janela e responde via OpenAI.
 *
 * O target é `lia-customer-agents` (Cloud Run) — não mais a edge function.
 */

export interface ChatbotQueuePayload {
  conversaId: string;
  mensagem: string;
  numeroWhatsapp: string;
  instancia: string;
  clienteId: string;
  organizacaoId: string;
  isAutoResponse?: boolean | undefined;
  /** Incrementado pela rota quando o lote ainda está aberto e re-enfileira. */
  _queueRetryCount?: number | undefined;
  audioData?:
    | {
        storageUrl: string;
        mimetype: string;
      }
    | undefined;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id: string;
}

function encodeBase64Url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function encodeBase64UrlString(str: string): string {
  return encodeBase64Url(Buffer.from(str, "utf8"));
}

class QueueService {
  private readonly projectId: string;
  private readonly location: string;
  private readonly queueName: string;
  private readonly credentials: ServiceAccountCredentials;
  private readonly env: EnvConfig;
  private privateKey: KeyObject | null = null;

  constructor(env: EnvConfig) {
    this.env = env;

    if (!env.googleServiceAccountKey) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY environment variable is required",
      );
    }

    let parsed: ServiceAccountCredentials;
    try {
      parsed = JSON.parse(env.googleServiceAccountKey);
    } catch (error) {
      throw new Error(
        `Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON: ${(error as Error).message}`,
      );
    }

    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY missing required fields (client_email, private_key, project_id)",
      );
    }

    this.credentials = parsed;
    this.projectId = parsed.project_id;
    this.location = env.googleCloudTasksLocation;
    this.queueName = env.chatbotQueueName;
  }

  private getPrivateKey(): KeyObject {
    if (!this.privateKey) {
      this.privateKey = createPrivateKey({
        key: this.credentials.private_key,
        format: "pem",
      });
    }
    return this.privateKey;
  }

  private async getAccessToken(): Promise<string> {
    const jwt = this.createJwt();

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Google OAuth token error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  private createJwt(): string {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.credentials.client_email,
      scope: "https://www.googleapis.com/auth/cloud-tasks",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };

    const headerB64 = encodeBase64UrlString(JSON.stringify(header));
    const payloadB64 = encodeBase64UrlString(JSON.stringify(payload));
    const message = `${headerB64}.${payloadB64}`;

    const signer = createSign("RSA-SHA256");
    signer.update(message);
    signer.end();
    const signature = signer.sign(this.getPrivateKey());

    return `${message}.${encodeBase64Url(signature)}`;
  }

  private getTargetUrl(): string {
    if (!this.env.selfPublicBaseUrl) {
      throw new Error(
        "SELF_PUBLIC_BASE_URL is required (target Cloud Run URL of this service)",
      );
    }
    return `${this.env.selfPublicBaseUrl.replace(/\/+$/, "")}/generate-ai-response`;
  }

  /**
   * Enfileira uma mensagem com delay (segundos). Se omitido, usa
   * `CHATBOT_QUEUE_DELAY_SECONDS` (default 22s).
   */
  async enqueueChatbotMessage(
    payload: ChatbotQueuePayload,
    scheduleAfterSeconds?: number,
  ): Promise<void> {
    const delaySec =
      scheduleAfterSeconds ?? this.env.chatbotQueueDelaySeconds;

    const accessToken = await this.getAccessToken();
    const targetUrl = this.getTargetUrl();
    const queuePath = `projects/${this.projectId}/locations/${this.location}/queues/${this.queueName}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const internalBearer =
      this.env.supabaseServiceRoleKey ?? this.env.supabaseAnonKey;
    if (internalBearer) {
      headers.Authorization = `Bearer ${internalBearer}`;
    }

    const scheduleAfter = Math.max(1, Math.floor(delaySec));
    console.error(
      `\n${JSON.stringify(
        {
          level: "info",
          event: "chatbot_enqueue_payload",
          targetUrl,
          scheduleAfterSeconds: scheduleAfter,
          payload,
        },
        null,
        2,
      )}\n`,
    );

    const task = {
      httpRequest: {
        httpMethod: "POST",
        url: targetUrl,
        headers,
        body: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      },
      scheduleTime: {
        seconds: Math.floor(Date.now() / 1000) + scheduleAfter,
      },
    };

    const response = await fetch(
      `https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ task }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Google Cloud Tasks API error (${response.status}): ${errorBody}`,
      );
    }
  }
}

let cachedInstance: QueueService | null = null;
let cachedKey: string | null = null;

function getInstance(env?: EnvConfig): QueueService {
  const cfg = env ?? loadEnv();
  const cacheKey = `${cfg.googleServiceAccountKey?.slice(-12) ?? ""}::${cfg.selfPublicBaseUrl ?? ""}::${cfg.chatbotQueueName}`;
  if (!cachedInstance || cachedKey !== cacheKey) {
    cachedInstance = new QueueService(cfg);
    cachedKey = cacheKey;
  }
  return cachedInstance;
}

/**
 * Façade estável usada pelas rotas. Não propaga erro: se o Cloud Tasks falhar
 * o webhook não retorna 500 — apenas loga o aviso (mesmo comportamento da
 * edge function original).
 */
export const queueService = {
  async enqueueChatbotMessage(
    payload: ChatbotQueuePayload,
    scheduleAfterSeconds?: number,
    env?: EnvConfig,
  ): Promise<void> {
    try {
      await getInstance(env).enqueueChatbotMessage(
        payload,
        scheduleAfterSeconds,
      );
    } catch (error) {
      console.warn(
        "⚠️ Queue do chatbot não disponível:",
        (error as Error).message,
      );
    }
  },
  /** Reseta o cache (uso em testes). */
  __resetForTests(): void {
    cachedInstance = null;
    cachedKey = null;
  },
};
