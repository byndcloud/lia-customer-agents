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
import { RunInputSchema } from "../types.js";
import {
  AuthConfigError,
  UnauthorizedError,
  verifyApiSecret,
} from "./auth.js";

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
 * - `GET /health`  — liveness probe (exige `Authorization: Bearer <API_SECRET_TOKEN>`).
 * - `POST /run`    — executa os agentes (mesmo Bearer; token = `API_SECRET_TOKEN`).
 *
 * Responsabilidades:
 *  - Validar em **todas** as rotas: `Authorization: Bearer <token>` onde
 *    `<token>` bate com `API_SECRET_TOKEN` (time-safe).
 *  - Parse do body JSON.
 *  - Validação do `RunInput` via Zod no `POST /run`.
 *  - Tradução de erros em respostas HTTP consistentes.
 */
export function buildApp(params: BuildAppParams = {}): Express {
  const env = params.env ?? loadEnv();
  const runImpl = params.runAgentsImpl ?? runAgents;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    try {
      verifyApiSecret({
        authorizationHeader: req.header("authorization"),
        expectedToken: env.apiSecretToken,
      });
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/run", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = RunInputSchema.parse(req.body);

      const result = await runImpl(input, { env });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

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
    logIncomingRequest(req, "unauthorized");
    logError("unauthorized", err.reason);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (err instanceof AuthConfigError) {
    logIncomingRequest(req, "auth_config_error");
    logError("auth_config_error", err.message);
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "invalid_input", details: err.issues });
    return;
  }

  logError("internal_error", err);
  res.status(500).json({ error: "internal_error" });
}

function logError(kind: string, detail: unknown): void {
  const payload = {
    level: "error",
    kind,
    detail: detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail,
  };

  console.error(`\n${JSON.stringify(payload, null, 2)}\n`);
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Registra o que chegou na requisição (útil para depurar auth). `authorization`
 * é mascarado; use `LOG_SENSITIVE_REQUEST=1` para logar o valor bruto (só em
 * ambiente controlado).
 */
function logIncomingRequest(req: Request, context: string): void {
  const logSecrets = process.env.LOG_SENSITIVE_REQUEST === "1";
  const payload = {
    level: "debug",
    event: "incoming_request",
    context,
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    headers: redactHeaders(req.headers, logSecrets),
    body: req.body,
  };
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

