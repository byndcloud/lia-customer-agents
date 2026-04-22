import type { IncomingHttpHeaders } from "node:http";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ZodError } from "zod";
import { loadEnv, type EnvConfig } from "../config/env.js";
import { runAgents } from "../runtime/run-agents.js";
import {
  AuthConfigError,
  UnauthorizedError,
  extractBearerToken,
  verifySupabaseKey,
} from "./auth.js";
import { buildDeliverResponseRouter } from "./routes/deliverResponse.js";
import { buildFollowup24hRouter } from "./routes/followup24h.js";
import { buildFollowup30minRouter } from "./routes/followup30min.js";
import { buildGenerateAiResponseRouter } from "./routes/generateAiResponse.js";
import { buildRunRouter } from "./routes/run.js";
import { buildWebhookEvolutionRouter } from "./routes/webhookEvolution.js";
import { buildInternalErrorLogDetail } from "./internalErrorLog.js";

/**
 * Dependências injetáveis no app (facilita testes).
 */
export interface BuildAppParams {
  /** Configuração de ambiente. Quando omitida, é carregada via `loadEnv()`. */
  readonly env?: EnvConfig;
  /** Implementação de `runAgents` (substituível em testes). */
  readonly runAgentsImpl?: typeof runAgents;
}

/**
 * Monta a instância Express da Cloud Function.
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
 * (comparação time-safe com o env). Erros são mapeados em `errorHandler`.
 */
export function buildApp(params: BuildAppParams = {}): Express {
  const env = params.env ?? loadEnv();
  const runImpl = params.runAgentsImpl ?? runAgents;

  const app = express();
  app.disable("x-powered-by");
  (app.locals as { env: EnvConfig }).env = env;
  app.use(express.json({ limit: "1mb" }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    try {
      verifySupabaseKey({
        authorizationHeader: req.header("authorization"),
        anonKey: env.supabaseAnonKey,
        serviceRoleKey: env.supabaseServiceRoleKey,
      });
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/run", buildRunRouter({ env, runAgentsImpl: runImpl }));
  app.use("/webhook-evolution", buildWebhookEvolutionRouter({ env }));
  app.use(
    "/generate-ai-response",
    buildGenerateAiResponseRouter({ env, runAgentsImpl: runImpl }),
  );
  app.use("/deliver-response", buildDeliverResponseRouter({ env }));
  app.use("/followup-30min", buildFollowup30minRouter({ env }));
  app.use("/followup-24h", buildFollowup24hRouter({ env }));

  app.use(errorHandler);

  return app;
}

/**
 * Mapeia erros conhecidos para status HTTP estáveis. Erros desconhecidos
 * viram 500 com mensagem genérica — o stack fica apenas no log.
 */
function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express exige 4 params para identificar error handler.
  _next: NextFunction,
): void {
  if (err instanceof UnauthorizedError) {
    const envConfig = (req.app.locals as { env?: EnvConfig }).env;
    logIncomingRequest(req, "unauthorized", {
      authError: true,
      unauthorizedReason: err.reason,
      ...(envConfig !== undefined ? { env: envConfig } : {}),
    });
    logError("unauthorized", err.reason);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (err instanceof AuthConfigError) {
    logIncomingRequest(req, "auth_config_error", { authError: true });
    logError("auth_config_error", err.message);
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }

  if (err instanceof ZodError) {
    if (res.headersSent) {
      logError("invalid_input_after_headers_sent", {
        issues: err.issues,
        request: requestSummary(req),
      });
      return;
    }
    res.status(400).json({ error: "invalid_input", details: err.issues });
    return;
  }

  logError(
    "internal_error",
    buildInternalErrorLogDetail(err, {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
    }),
  );

  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error" });
  }
}

function logError(kind: string, detail: unknown): void {
  const payload = {
    level: "error",
    kind,
    detail: detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail,
  };

  console.error(`\n${JSON.stringify(payload, null, 2)}\n`);
}

function requestSummary(req: Request): Pick<Request, "method" | "path" | "originalUrl"> {
  return {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
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
  req: Request,
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
  const rawAuth = headerValueToString(req.headers.authorization);
  const showPlain =
    !redactAuthInPlainField || logSecrets;

  const payload: Record<string, unknown> = {
    level: "debug",
    event: "incoming_request",
    context,
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    headers: redactHeaders(req.headers, logSecrets),
    body: req.body,
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

