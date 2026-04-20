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

export interface EnvConfig {
  /** Modelo OpenAI padrão. */
  readonly aiModel: string;
  /** URL do MCP legis. */
  readonly mcpServerUrl: string | undefined;
  /** API key opcional do MCP. */
  readonly mcpServerApiKey: string | undefined;
  /** URL do projeto Supabase (https://<ref>.supabase.co). */
  readonly supabaseUrl: string | undefined;
  /** Anon key do projeto Supabase. Aceita como Bearer na cloud function. */
  readonly supabaseAnonKey: string | undefined;
  /** Service role key do projeto Supabase. Aceita como Bearer na cloud function. */
  readonly supabaseServiceRoleKey: string | undefined;
  /**
   * Segredo server-to-server: o cliente envia `Authorization: Bearer <token>`
   * e o valor após `Bearer` deve ser igual a este (time-safe).
   */
  readonly apiSecretToken: string | undefined;
  /** Porta do servidor HTTP (Cloud Run). */
  readonly port: number;
}

const DEFAULT_MODEL = "gpt-5-mini";
/** Porta local padrão (evita 8080 e 3000). Em Cloud Run, `PORT` é definido pela plataforma. */
const DEFAULT_PORT = 3333;

/**
 * Constrói o objeto de ambiente. Chamada no startup; falhas são lançadas pelo
 * chamador quando faltar alguma configuração crítica.
 */
export function loadEnv(): EnvConfig {
  const rawPort = readEnv("PORT");
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

  return {
    aiModel: readEnv("AI_MODEL") ?? DEFAULT_MODEL,
    mcpServerUrl: readEnv("MCP_SERVER_URL"),
    mcpServerApiKey: readEnv("MCP_SERVER_API_KEY"),
    supabaseUrl: readEnv("SUPABASE_URL"),
    supabaseAnonKey: readEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    apiSecretToken: readEnv("API_SECRET_TOKEN"),
    port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT,
  };
}
