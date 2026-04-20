import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/**
 * Erro sinalizado quando a autenticação falha. Mantém a mensagem genérica
 * para não vazar detalhes internos; o `reason` fica em log estruturado.
 */
export class UnauthorizedError extends Error {
  constructor(
    public readonly reason: string,
    message = "Unauthorized",
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Erro sinalizado quando a configuração do servidor impede autenticar (ex.:
 * nenhuma das chaves do Supabase está definida). Tratado como 500.
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Papel inferido a partir da chave que foi apresentada. */
export type SupabaseAuthRole = "anon" | "service_role";

export interface AuthResult {
  /** Qual chave do Supabase foi reconhecida. */
  readonly role: SupabaseAuthRole;
}

export interface VerifySupabaseKeyParams {
  /** Header Authorization (ex.: "Bearer eyJhbGciOi..."). */
  readonly authorizationHeader: string | undefined;
  /** SUPABASE_ANON_KEY do projeto. */
  readonly anonKey: string | undefined;
  /** SUPABASE_SERVICE_ROLE_KEY do projeto. */
  readonly serviceRoleKey: string | undefined;
}

/**
 * Autentica um chamador comparando o Bearer token com a SUPABASE_ANON_KEY ou
 * a SUPABASE_SERVICE_ROLE_KEY do projeto.
 *
 * Comparação é feita com `timingSafeEqual` para evitar ataques de tempo. O
 * servidor exige que ao menos uma das chaves esteja configurada — caso
 * contrário, lança `AuthConfigError` (500).
 */
export function verifySupabaseKey(
  params: VerifySupabaseKeyParams,
): AuthResult {
  const { authorizationHeader, anonKey, serviceRoleKey } = params;

  if (!anonKey && !serviceRoleKey) {
    throw new AuthConfigError(
      "Neither SUPABASE_ANON_KEY nor SUPABASE_SERVICE_ROLE_KEY is configured.",
    );
  }

  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new UnauthorizedError("missing_bearer_token");
  }

  if (serviceRoleKey && safeEqual(token, serviceRoleKey)) {
    return { role: "service_role" };
  }

  if (anonKey && safeEqual(token, anonKey)) {
    return { role: "anon" };
  }

  throw new UnauthorizedError("invalid_bearer_token");
}

/**
 * Comparação byte a byte resistente a ataques de tempo. Diferenças de tamanho
 * geram `false` imediatamente (após uma comparação dummy também time-safe).
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Extrai o token de um header `Authorization: Bearer <token>`.
 * Retorna `undefined` se o formato não casar.
 */
export function extractBearerToken(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export interface VerifyApiSecretParams {
  /** Header `Authorization` (ex.: `Bearer <token>`). Só o token após `Bearer` é validado. */
  readonly authorizationHeader: string | undefined;
  /** Valor esperado de `API_SECRET_TOKEN` no env. */
  readonly expectedToken: string | undefined;
}

/**
 * Valida o segredo **server-to-server** em **toda** requisição: o cliente envia
 * `Authorization: Bearer <API_SECRET_TOKEN>` e comparamos o token (após
 * `Bearer`) com `API_SECRET_TOKEN` no env. Comparação time-safe.
 */
export function verifyApiSecret(params: VerifyApiSecretParams): void {
  const { authorizationHeader, expectedToken } = params;

  if (!expectedToken) {
    throw new AuthConfigError(
      "API_SECRET_TOKEN is not configured. Set the env var to enable auth.",
    );
  }

  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new UnauthorizedError("missing_bearer_token");
  }

  if (!safeEqual(token, expectedToken)) {
    throw new UnauthorizedError("invalid_api_secret_token");
  }
}
