/**
 * Leitura de variáveis de ambiente da aplicação.
 *
 * O alvo principal é Node (Cloud Functions / Cloud Run), mas o código suporta
 * Deno para permitir consumo do módulo em outros runtimes caso necessário.
 */

type EnvHost = {
  process?: { env?: Record<string, string | undefined> };
  Deno?: { env?: { get(name: string): string | undefined } };
};

function readEnv(name: string): string | undefined {
  const host = globalThis as unknown as EnvHost;

  const fromProcess = host.process?.env?.[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) {
    return fromProcess;
  }

  const fromDeno = host.Deno?.env?.get?.(name);
  if (typeof fromDeno === "string" && fromDeno.length > 0) {
    return fromDeno;
  }

  return undefined;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Primeira variável de ambiente em `names` com número finito > 0; senão `fallback`. */
function readPositiveNumberFirst(names: readonly string[], fallback: number): number {
  for (const name of names) {
    const raw = readEnv(name);
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export interface EnvConfig {
  /** Modelo OpenAI padrão. */
  readonly aiModel: string;
  /** API key da OpenAI (Whisper + Agents). */
  readonly openaiApiKey: string | undefined;
  /** URL do MCP legis. */
  readonly mcpServerUrl: string | undefined;
  /** API key opcional do MCP. */
  readonly mcpServerApiKey: string | undefined;
  /** URL do projeto Supabase (https://<ref>.supabase.co). */
  readonly supabaseUrl: string | undefined;
  /** Anon key do projeto Supabase. */
  readonly supabaseAnonKey: string | undefined;
  /** Service role key do projeto Supabase (usada para acessar DB e Storage). */
  readonly supabaseServiceRoleKey: string | undefined;
  /** URL base da Evolution API (sem barra final). */
  readonly evolutionApiUrl: string | undefined;
  /** API key da Evolution API. */
  readonly evolutionApiKey: string | undefined;
  /** Service account key do GCP (JSON serializado) para Cloud Tasks. */
  readonly googleServiceAccountKey: string | undefined;
  /** Localização da fila Cloud Tasks (default: us-central1). */
  readonly googleCloudTasksLocation: string;
  /** Nome da fila Cloud Tasks (default: lia). */
  readonly chatbotQueueName: string;
  /**
   * URL pública deste serviço (Cloud Run). Usada como `targetUrl` para o
   * Cloud Tasks chamar `POST /generate-ai-response`.
   */
  readonly selfPublicBaseUrl: string | undefined;
  /**
   * Atraso da fila Cloud Tasks (segundos). Fonte: `CHATBOT_QUEUE_DELAY_SECONDS`
   * ou, se ausente/inválida, `DEFAULT_QUEUE_DELAY_SECONDS` no ambiente; por fim
   * {@link DEFAULT_QUEUE_DELAY_SECONDS} (export — hoje 20s se nada estiver definido).
   */
  readonly chatbotQueueDelaySeconds: number;
  /** Bucket de mídia do WhatsApp no Supabase Storage. */
  readonly whatsappStorageBucket: string;
  /** Intervalo (segundos) considerado inativo no followup-30min. */
  readonly followup30minSeconds: number;
  /** Intervalo (segundos) considerado inativo no followup-24h. */
  readonly followup24hSeconds: number;
  /** Porta do servidor HTTP (Cloud Run). */
  readonly port: number;
}

const DEFAULT_MODEL = "gpt-5";
/** Porta local padrão (evita 8080 e 3000). Em Cloud Run, `PORT` é definido pela plataforma. */
const DEFAULT_PORT = 3333;
/**
 * Atraso padrão (segundos) do Cloud Tasks quando `CHATBOT_QUEUE_DELAY_SECONDS`
 * e `DEFAULT_QUEUE_DELAY_SECONDS` não estão definidos ou são inválidos no ambiente.
 */
export const DEFAULT_QUEUE_DELAY_SECONDS = 20;

/**
 * Folga (s) entre o delay da fila e o `_window_seconds` do RPC
 * `claim_pending_chatbot_messages` — evita claim vazio quando o primeiro
 * disparo coincide com o limiar da janela.
 */
export const CHATBOT_QUEUE_CLAIM_WINDOW_SLACK_SECONDS = 2;

/** Buffer (s) somado ao re-enfileiramento após claim vazio dentro da janela. */
export const CHATBOT_QUEUE_REQUEUE_BUFFER_SECONDS = 2;

/** `_window_seconds` do claim: `max(1, delayDaFila - slack)`. */
export function chatbotQueueClaimWindowSeconds(delaySeconds: number): number {
  const d = Math.floor(delaySeconds);
  return Math.max(1, d - CHATBOT_QUEUE_CLAIM_WINDOW_SLACK_SECONDS);
}
const DEFAULT_FOLLOWUP_30MIN_SECONDS = 1800;
const DEFAULT_FOLLOWUP_24H_SECONDS = 86400;
const DEFAULT_STORAGE_BUCKET = "whatsapp-files";
const DEFAULT_GCT_LOCATION = "us-central1";
const DEFAULT_QUEUE_NAME = "lia";

/**
 * Constrói o objeto de ambiente. Chamada no startup; falhas são lançadas pelo
 * chamador quando faltar alguma configuração crítica.
 */
export function loadEnv(): EnvConfig {
  const rawPort = readEnv("PORT");
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

  return {
    aiModel: readEnv("AI_MODEL") ?? DEFAULT_MODEL,
    openaiApiKey: readEnv("OPENAI_API_KEY"),
    mcpServerUrl: readEnv("MCP_SERVER_URL"),
    mcpServerApiKey: readEnv("MCP_SERVER_API_KEY"),
    supabaseUrl: readEnv("SUPABASE_URL") ?? readEnv("LOCAL_SUPABASE_URL"),
    supabaseAnonKey:
      readEnv("SUPABASE_ANON_KEY") ?? readEnv("LOCAL_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey:
      readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
      readEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY"),
    evolutionApiUrl: readEnv("EVOLUTION_API_URL"),
    evolutionApiKey: readEnv("EVOLUTION_API_KEY"),
    googleServiceAccountKey: readEnv("GOOGLE_SERVICE_ACCOUNT_KEY"),
    googleCloudTasksLocation:
      readEnv("GOOGLE_CLOUD_TASKS_LOCATION") ?? DEFAULT_GCT_LOCATION,
    chatbotQueueName: readEnv("CHATBOT_QUEUE_NAME") ?? DEFAULT_QUEUE_NAME,
    selfPublicBaseUrl: readEnv("SELF_PUBLIC_BASE_URL"),
    chatbotQueueDelaySeconds: readPositiveNumberFirst(
      ["CHATBOT_QUEUE_DELAY_SECONDS", "DEFAULT_QUEUE_DELAY_SECONDS"],
      DEFAULT_QUEUE_DELAY_SECONDS,
    ),
    whatsappStorageBucket:
      readEnv("STORAGE_BUCKET_WHATSAPP_FILES") ?? DEFAULT_STORAGE_BUCKET,
    followup30minSeconds: readNumberEnv(
      "FOLLOWUP_30MIN_SECONDS",
      DEFAULT_FOLLOWUP_30MIN_SECONDS,
    ),
    followup24hSeconds: readNumberEnv(
      "FOLLOWUP_24H_SECONDS",
      DEFAULT_FOLLOWUP_24H_SECONDS,
    ),
    port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT,
  };
}
