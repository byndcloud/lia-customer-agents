import type { IncomingHttpHeaders } from "node:http";
import { Hono } from "hono";
import { ZodError } from "zod";
import { loadEnv, type EnvConfig } from "../config/env.js";
import {
  AuthConfigError,
  UnauthorizedError,
  extractBearerToken,
  verifySupabaseKey,
} from "./auth.js";
import type { LiaHttpVariables } from "./honoVariables.js";
import { buildDeliverResponseRouter } from "./routes/deliverResponse.js";
import { buildFollowup24hRouter } from "./routes/followup24h.js";
import { buildFollowup30minRouter } from "./routes/followup30min.js";
import { buildGenerateAiResponseRouter } from "./routes/generateAiResponse.js";
import { buildRunRouter } from "./routes/run.js";
import { buildWebhookEvolutionRouter } from "./routes/webhookEvolution.js";
import { buildInternalErrorLogDetail } from "./internalErrorLog.js";

/** App HTTP principal (Hono). */
export type LiaHonoApp = Hono<{ Variables: LiaHttpVariables }>;

/**
 * Parâmetros opcionais para montar o app (ex.: `env` em testes).
 */
export interface BuildAppParams {
  /** Configuração de ambiente. Quando omitida, é carregada via `loadEnv()`. */
  readonly env?: EnvConfig;
}

const JSON_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB (igual ao antigo `express.json({ limit: "1mb" })`).

/**
 * Monta a instância Hono da Cloud Function.
 *
 * Rotas expostas:
 *  - `GET  /health`               — liveness probe.
 *  - `POST /run`                  — executa os agentes (uso direto/testes).
 *  - `POST /webhook-evolution`    — recebe webhook da Evolution.
 *  - `POST /generate-ai-response` — disparado pelo Cloud Tasks (batch agregado).
 *  - `POST /deliver-response`     — entrega mensagem via Evolution.
 *  - `POST /followup-30min`       — disparado pelo `pg_cron`.
 *  - `POST /followup-24h`         — disparado pelo `pg_cron`.
 *
 * **Todas** as rotas exigem `Authorization: Bearer <SUPABASE_ANON_KEY | SUPABASE_SERVICE_ROLE_KEY>`
 * (comparação time-safe com o env). Erros são mapeados em `onError`.
 */
export function buildApp(params: BuildAppParams = {}): LiaHonoApp {
  const env = params.env ?? loadEnv();

  const app = new Hono<{ Variables: LiaHttpVariables }>();

  app.use(async (c, next) => {
    c.set("env", env);
    await next();
  });

  app.use(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      await next();
      return;
    }
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("application/json")) {
      c.set("jsonBody", undefined);
      await next();
      return;
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, "utf8") > JSON_BODY_LIMIT_BYTES) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    try {
      c.set("jsonBody", text.length === 0 ? {} : JSON.parse(text) as unknown);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    await next();
  });

  app.use(async (c, next) => {
    try {
      verifySupabaseKey({
        authorizationHeader: c.req.header("authorization"),
        anonKey: env.supabaseAnonKey,
        serviceRoleKey: env.supabaseServiceRoleKey,
      });
      await next();
    } catch (error) {
      throw error;
    }
  });

  app.get("/health", (c) => c.json({ status: "ok" }, 200));

  app.route("/run", buildRunRouter({ env }));
  app.route("/webhook-evolution", buildWebhookEvolutionRouter({ env }));
  app.route("/generate-ai-response", buildGenerateAiResponseRouter({ env }));
  app.route("/deliver-response", buildDeliverResponseRouter({ env }));
  app.route("/followup-30min", buildFollowup30minRouter({ env }));
  app.route("/followup-24h", buildFollowup24hRouter({ env }));

  app.onError((err, c) => {
    if (err instanceof UnauthorizedError) {
      const envConfig = c.var.env;
      logIncomingRequest(c, "unauthorized", {
        authError: true,
        unauthorizedReason: err.reason,
        env: envConfig,
      });
      logError("unauthorized", err.reason);
      return c.json({ error: "unauthorized" }, 401);
    }

    if (err instanceof AuthConfigError) {
      logIncomingRequest(c, "auth_config_error", { authError: true });
      logError("auth_config_error", err.message);
      return c.json({ error: "server_misconfigured" }, 500);
    }

    if (err instanceof ZodError) {
      if (c.finalized) {
        logError("invalid_input_after_headers_sent", {
          issues: err.issues,
          request: requestSummary(c),
        });
        return new Response(null, { status: 204 });
      }
      return c.json({ error: "invalid_input", details: err.issues }, 400);
    }

    logError(
      "internal_error",
      buildInternalErrorLogDetail(err, {
        method: c.req.method,
        path: requestPath(c),
        originalUrl: requestOriginalUrl(c),
        baseUrl: "",
      }),
    );

    if (!c.finalized) {
      return c.json({ error: "internal_error" }, 500);
    }
    return new Response(null, { status: 204 });
  });

  return app;
}

/**
 * Mapeia erros conhecidos para status HTTP estáveis. Erros desconhecidos
 * viram 500 com mensagem genérica — o stack fica apenas no log.
 */
function logError(kind: string, detail: unknown): void {
  const payload = {
    level: "error",
    kind,
    detail: detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail,
  };

  console.error(`\n${JSON.stringify(payload, null, 2)}\n`);
}

function requestPath(c: { req: { path: string } }): string {
  return c.req.path;
}

function requestOriginalUrl(c: { req: { url: string } }): string {
  try {
    const u = new URL(c.req.url, "http://localhost");
    return `${u.pathname}${u.search}`;
  } catch {
    return c.req.url;
  }
}

function requestSummary(c: { req: { method: string; path: string; url: string } }): {
  method: string;
  path: string;
  originalUrl: string;
} {
  return {
    method: c.req.method,
    path: c.req.path,
    originalUrl: requestOriginalUrl(c),
  };
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Registra o que chegou na requisição (útil para depurar auth).
 *
 * - Em `headers`, `authorization` fica mascarado salvo `LOG_SENSITIVE_REQUEST=1`.
 * - Em erros de auth (`authError`), o campo `authorization_received` repete o
 *   header completo por padrão para depuração. Em produção, defina
 *   `REDACT_AUTHORIZATION_IN_LOGS=1` para omitir.
 * - Para `invalid_bearer_token`, `bearer_token_debug` inclui o token após
 *   `Bearer` (mesmo valor usado na comparação) e os tamanhos das chaves no env.
 */
function logIncomingRequest(
  c: {
    req: {
      method: string;
      path: string;
      url: string;
      header: (name: string) => string | undefined;
      raw: { headers: Headers };
    };
    var: LiaHttpVariables;
  },
  context: string,
  options: {
    authError?: boolean;
    unauthorizedReason?: string;
    env?: EnvConfig;
  } = {},
): void {
  const logSecrets = process.env.LOG_SENSITIVE_REQUEST === "1";
  const redactAuthInPlainField =
    process.env.REDACT_AUTHORIZATION_IN_LOGS === "1";
  const rawAuth = c.req.header("authorization");
  const showPlain =
    !redactAuthInPlainField || logSecrets;

  const headersObj = headersToIncomingLike(c.req.raw.headers);

  const payload: Record<string, unknown> = {
    level: "debug",
    event: "incoming_request",
    context,
    method: c.req.method,
    path: c.req.path,
    originalUrl: requestOriginalUrl(c),
    headers: redactHeaders(headersObj, logSecrets),
    body: c.var.jsonBody,
  };

  if (options.authError && rawAuth !== undefined) {
    if (redactAuthInPlainField && !logSecrets) {
      payload.authorization_received = `[redacted len=${rawAuth.length}]`;
    } else {
      payload.authorization_received = rawAuth;
    }
  }

  if (
    options.unauthorizedReason === "invalid_bearer_token" &&
    options.env
  ) {
    const token = extractBearerToken(rawAuth);
    const { supabaseAnonKey: anon, supabaseServiceRoleKey: sr } =
      options.env;
    payload.bearer_token_debug = {
      // Mesmo string que verifySupabaseKey compara com anon/service_role.
      bearer_token_extracted: token
        ? showPlain
          ? token
          : `[redacted len=${token.length}]`
        : null,
      bearer_token_length: token?.length ?? 0,
      env_key_lengths: {
        anon_key: anon?.length ?? 0,
        service_role_key: sr?.length ?? 0,
      },
      lengths_match_hint:
        token &&
        anon &&
        token.length === anon.length &&
        token !== anon
          ? "same_length_as_anon_but_bytes_differ_check_whitespace_encoding"
          : token &&
              sr &&
              token.length === sr.length &&
              token !== sr
            ? "same_length_as_service_role_but_bytes_differ"
            : undefined,
    };
  }

  console.error(`\n${JSON.stringify(payload, null, 2)}\n`);
}

/** Converte `Headers` do Fetch para formato compatível com `redactHeaders`. */
function headersToIncomingLike(headers: Headers): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    const prev = out[lower];
    if (prev === undefined) {
      out[lower] = value;
    } else if (Array.isArray(prev)) {
      prev.push(value);
    } else {
      out[lower] = [String(prev), value];
    }
  });
  return out;
}

function redactHeaders(
  headers: IncomingHttpHeaders,
  logSecrets: boolean,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      if (logSecrets) {
        out[key] = value as string | string[] | undefined;
      } else {
        const raw = headerValueToString(value);
        out[key] = raw
          ? `[redacted len=${raw.length}]`
          : raw;
      }
    } else {
      out[key] = value as string | string[] | undefined;
    }
  }
  return out;
}

function headerValueToString(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}
