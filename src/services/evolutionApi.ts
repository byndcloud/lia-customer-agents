import { loadEnv, type EnvConfig } from "../config/env.js";

/**
 * Cliente HTTP da Evolution API. Cobre apenas o subconjunto usado pelos
 * fluxos migrados: envio de texto, áudio, mídia e leitura de instâncias.
 */

interface EvolutionInstance {
  name: string;
  [key: string]: unknown;
}

function getBaseUrl(env: EnvConfig): string {
  if (!env.evolutionApiUrl) {
    throw new Error("EVOLUTION_API_URL is required");
  }
  return env.evolutionApiUrl.replace(/\/+$/, "");
}

function getApiKey(env: EnvConfig): string {
  if (!env.evolutionApiKey) {
    throw new Error("EVOLUTION_API_KEY is required");
  }
  return env.evolutionApiKey;
}

function evolutionPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Uma linha JSON para o mesmo filtro de logs do `generate_ai_*`. */
function logEvolution(
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

function evolutionLogFields(
  trace: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(trace ?? {}), ...fields };
}

async function makeEvolutionApiCall(
  url: string,
  options: RequestInit,
  apiKey: string,
  retries: number = 2,
  trace?: Record<string, unknown>,
): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const pathHint = evolutionPathFromUrl(url);
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logEvolution(
        "evolution_api_request_start",
        evolutionLogFields(trace, {
          path: pathHint,
          method,
          attempt,
          maxAttempts,
        }),
      );

      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
          ...(options.headers ?? {}),
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const willRetry =
          (response.status >= 500 || response.status === 0) &&
          attempt <= retries;

        logEvolution(
          willRetry
            ? "evolution_api_http_error_will_retry"
            : "evolution_api_http_error",
          evolutionLogFields(trace, {
            path: pathHint,
            method,
            status: response.status,
            attempt,
            maxAttempts,
            bodyPreview: errorText.slice(0, 500),
            willRetry,
          }),
          "warn",
        );

        if (willRetry) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          continue;
        }
        throw new Error(
          `Evolution API returned ${response.status} ${method} ${pathHint}: ${errorText}`,
        );
      }

      logEvolution(
        "evolution_api_response_ok",
        evolutionLogFields(trace, {
          path: pathHint,
          method,
          status: response.status,
          attempt,
        }),
      );

      return response;
    } catch (error) {
      const isLast = attempt > retries;
      /** Erros HTTP já tratados acima; não retentar no `catch`. */
      if (
        error instanceof Error &&
        error.message.startsWith("Evolution API returned ")
      ) {
        throw error;
      }
      if (
        error instanceof TypeError &&
        error.message.includes("fetch")
      ) {
        logEvolution(
          "evolution_api_network_error",
          evolutionLogFields(trace, {
            path: pathHint,
            method,
            attempt,
            maxAttempts,
            message: error.message,
            willRetry: !isLast,
          }),
          "warn",
        );
        if (!isLast) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          continue;
        }
        throw new Error(`Cannot connect to Evolution API at ${url}`);
      }

      if (isLast) throw error;
      logEvolution(
        "evolution_api_throw_will_retry",
        evolutionLogFields(trace, {
          path: pathHint,
          method,
          attempt,
          maxAttempts,
          message: error instanceof Error ? error.message : String(error),
        }),
        "warn",
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw new Error("Max retries exceeded");
}

interface SendMediaOptions {
  mimetype?: string | undefined;
  caption?: string | undefined;
  fileName?: string | undefined;
  delay?: number | undefined;
  linkPreview?: boolean | undefined;
  mentionsEveryOne?: boolean | undefined;
  mentioned?: string[] | undefined;
  quoted?:
    | {
        key: { id: string };
        message: { conversation: string };
      }
    | undefined;
}

interface SendAudioOptions {
  delay?: number | undefined;
  linkPreview?: boolean | undefined;
  mentionsEveryOne?: boolean | undefined;
  mentioned?: string[] | undefined;
  quoted?:
    | {
        key: { id: string };
        message: { conversation: string };
      }
    | undefined;
}

/** Envia mensagem de texto via Evolution. */
export async function sendEvolutionMessage(
  instance: string,
  number: string,
  text: string,
  env?: EnvConfig,
  /** Campos opcionais (ex.: `conversaId`) para correlacionar logs com `/generate-ai-response`. */
  trace?: Record<string, unknown>,
): Promise<unknown> {
  const cfg = env ?? loadEnv();
  const url = `${getBaseUrl(cfg)}/message/sendText/${instance}`;
  const response = await makeEvolutionApiCall(
    url,
    { method: "POST", body: JSON.stringify({ number, text }) },
    getApiKey(cfg),
    2,
    trace,
  );
  return response.json();
}

/** Envia áudio (formato push-to-talk do WhatsApp). `audio` é base64 ou URL. */
export async function sendEvolutionAudio(
  instance: string,
  number: string,
  audio: string,
  options?: SendAudioOptions,
  env?: EnvConfig,
): Promise<unknown> {
  const cfg = env ?? loadEnv();
  const url = `${getBaseUrl(cfg)}/message/sendWhatsAppAudio/${instance}`;
  const response = await makeEvolutionApiCall(
    url,
    {
      method: "POST",
      body: JSON.stringify({ number, audio, ...options }),
    },
    getApiKey(cfg),
  );
  return response.json();
}

/** Envia mídia genérica (image/video/document). `media` é base64 ou URL. */
export async function sendEvolutionMedia(
  instance: string,
  number: string,
  media: string,
  mediatype: string,
  options?: SendMediaOptions,
  env?: EnvConfig,
): Promise<unknown> {
  const cfg = env ?? loadEnv();
  const url = `${getBaseUrl(cfg)}/message/sendMedia/${instance}`;
  const response = await makeEvolutionApiCall(
    url,
    {
      method: "POST",
      body: JSON.stringify({ number, media, mediatype, ...options }),
    },
    getApiKey(cfg),
  );
  return response.json();
}

/** Lista instâncias (opcionalmente filtrada por nome). */
export async function fetchEvolutionInstances(
  instanceName?: string,
  env?: EnvConfig,
): Promise<EvolutionInstance[]> {
  const cfg = env ?? loadEnv();
  const url = `${getBaseUrl(cfg)}/instance/fetchInstances`;
  const response = await makeEvolutionApiCall(
    url,
    { method: "GET" },
    getApiKey(cfg),
  );
  const instances = (await response.json()) as EvolutionInstance[];
  if (instanceName) {
    return instances.filter((i) => i.name === instanceName);
  }
  return instances;
}
