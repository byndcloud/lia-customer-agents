/**
 * Monta detalhes de erro para logs de `internal_error`: cadeia de `cause`,
 * texto agregado para heurística e palpites de qual integração falhou.
 */

/** Um nível da cadeia `Error.cause` / `AggregateError`. */
export interface ErrorCauseSlice {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * Extrai name/message (e code em erros de sistema Node) de um valor
 * desconhecido para logging.
 */
function sliceUnknownError(value: unknown): ErrorCauseSlice | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) {
    const slice: ErrorCauseSlice = { name: value.name, message: value.message };
    const errnoCode = (value as NodeJS.ErrnoException).code;
    if (typeof errnoCode === "string") {
      return { ...slice, code: errnoCode };
    }
    return slice;
  }
  if (typeof value === "string") {
    return { name: "string", message: value };
  }
  try {
    return { name: typeof value, message: JSON.stringify(value) };
  } catch {
    return { name: typeof value, message: String(value) };
  }
}

/**
 * Percorre apenas `Error.cause` e erros dentro de `AggregateError` (não
 * repete o erro raiz — ele já vai em `message` / `stack` do log).
 */
export function flattenErrorCauses(err: unknown): ErrorCauseSlice[] {
  const out: ErrorCauseSlice[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (value === undefined || value === null || seen.has(value)) return;
    seen.add(value);

    if (value instanceof AggregateError) {
      const slice = sliceUnknownError(value);
      if (slice) out.push(slice);
      for (const e of value.errors) {
        visit(e);
      }
      return;
    }

    const slice = sliceUnknownError(value);
    if (slice) out.push(slice);

    if (value instanceof Error && value.cause !== undefined) {
      visit(value.cause);
    }
  };

  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      visit(e);
    }
    return out;
  }

  if (err instanceof Error && err.cause !== undefined) {
    visit(err.cause);
  }

  return out;
}

/**
 * Junta mensagens e stack em um único blob para busca de padrões.
 */
export function collectDiagnosticText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.name, err.message, err.stack ?? "");
  } else {
    parts.push(String(err));
  }
  for (const c of flattenErrorCauses(err)) {
    parts.push(c.name, c.message, c.code ?? "");
  }
  return parts.join("\n");
}

export interface UpstreamInferenceRule {
  readonly id: string;
  readonly test: (text: string) => boolean;
}

/** Ordem importa: regras mais específicas primeiro. */
export const UPSTREAM_INFERENCE_RULES: readonly UpstreamInferenceRule[] = [
  {
    id: "google_cloud_tasks",
    test: (t) => /cloudtasks\.googleapis\.com/i.test(t),
  },
  {
    id: "google_oauth",
    test: (t) => /oauth2\.googleapis\.com/i.test(t),
  },
  {
    id: "evolution_api",
    test: (t) =>
      /evolution api returned/i.test(t) ||
      /cannot connect to evolution api/i.test(t),
  },
  {
    id: "openai_http",
    test: (t) => /api\.openai\.com/i.test(t),
  },
  {
    id: "openai_agents_sdk",
    test: (t) =>
      /@openai\/agents-core/i.test(t) ||
      /@openai\/agents-openai/i.test(t) ||
      /@openai\/agents\b/i.test(t),
  },
  {
    id: "legis_mcp",
    test: (t) =>
      /mcp_server_url|legis-mcp|hostedmcptool|mcp\/invoke/i.test(t),
  },
  {
    id: "supabase_client",
    test: (t) =>
      /node_modules\/@supabase\//i.test(t) ||
      /supabase\.co\/rest/i.test(t) ||
      /postgrest|claim_pending_chatbot/i.test(t),
  },
  {
    id: "cloudflare_tunnel_or_edge",
    test: (t) =>
      /cloudflared/i.test(t) ||
      /502 bad gateway/i.test(t) ||
      /unable to reach the origin service/i.test(t),
  },
];

/**
 * Lista heurística de integrações prováveis (0..N) com base no texto do erro.
 */
export function inferLikelyUpstreams(diagnosticText: string): string[] {
  const hits: string[] = [];
  for (const rule of UPSTREAM_INFERENCE_RULES) {
    if (rule.test(diagnosticText)) hits.push(rule.id);
  }
  return hits;
}

/**
 * Caminho HTTP usado para heurísticas (montagens Express preservam o prefixo).
 */
export function resolvePathForIntegrationHints(req: {
  readonly originalUrl: string;
  readonly baseUrl?: string;
  readonly path: string;
}): string {
  const fromOriginal = (req.originalUrl ?? "").split("?")[0] ?? "";
  if (fromOriginal.length > 0) {
    return fromOriginal.replace(/\/+$/, "") || "/";
  }
  const composed = `${req.baseUrl ?? ""}${req.path ?? ""}`;
  return composed.replace(/\/+$/, "") || "/";
}

/**
 * Dica fixa por prefixo de rota: o que normalmente roda naquela URL.
 */
export function integrationHintForPath(path: string): string | undefined {
  if (path === "/run" || path.startsWith("/run/")) {
    return "Rota /run: OpenAI Agents SDK (modelo) e, se o fluxo usar process_info, MCP em MCP_SERVER_URL (legis-mcp).";
  }
  if (path.startsWith("/generate-ai-response")) {
    return "Rota /generate-ai-response: Supabase (tabelas/RPC) → runAgents (OpenAI + MCP) → envio Evolution se houver numeroWhatsapp.";
  }
  if (path.startsWith("/webhook-evolution")) {
    return "Rota /webhook-evolution: Supabase + storage; enfileiramento Cloud Tasks (Google).";
  }
  if (path.startsWith("/deliver-response")) {
    return "Rota /deliver-response: Supabase + Evolution API + possível fetch de mídia (URL pública).";
  }
  if (path.startsWith("/followup-30min") || path.startsWith("/followup-24h")) {
    return "Rota follow-up: Supabase e mensagens via Evolution.";
  }
  return undefined;
}

/**
 * Objeto serializável para `console.error` no handler global.
 */
export function buildInternalErrorLogDetail(
  err: unknown,
  req: { method: string; path: string; originalUrl: string; baseUrl?: string },
): Record<string, unknown> {
  const diagnosticText = collectDiagnosticText(err);
  const likelyUpstreams = inferLikelyUpstreams(diagnosticText);
  const pathForHints = resolvePathForIntegrationHints(req);
  const routeHint = integrationHintForPath(pathForHints);

  const base: Record<string, unknown> = {
    request: {
      method: req.method,
      path: req.path,
      baseUrl: req.baseUrl,
      pathUsedForHints: pathForHints,
      originalUrl: req.originalUrl,
    },
    likelyUpstreams,
    ...(routeHint ? { routeIntegrationHint: routeHint } : {}),
    diagnosticPreview: diagnosticText.slice(0, 2000),
  };

  if (err instanceof Error) {
    return {
      ...base,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        causes: flattenErrorCauses(err),
      },
    };
  }

  return { ...base, error: { raw: err } };
}
