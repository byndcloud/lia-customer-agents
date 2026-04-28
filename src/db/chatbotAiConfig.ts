import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Modo de triagem definido em `chatbot_ai_config.tipo_triagem`.
 *
 * - `especialista` — triagem central pode fazer handoff para agentes
 *   especialistas (ex.: trabalhista).
 * - `simples` — só triagem central, sem handoffs para especialistas.
 * - `sem_triagem` — mensagens de cliente não entram no fluxo do chatbot
 *   (webhook ignora; generate-ai e followups não disparam IA).
 */
export type ChatbotTipoTriagem =
  | "especialista"
  | "simples"
  | "sem_triagem";

/**
 * Configuração de personalização da IA por organização.
 *
 * Espelha a tabela `chatbot_ai_config` do Supabase. Os valores de `tom_voz`,
 * `vocabulario` e `tipo_atualizacao` são guardados como `text` no banco — o
 * resolver abaixo faz o parse defensivo: shape inesperado vira `null` para o
 * agente cair nos defaults sem quebrar a execução.
 *
 * `tipo_triagem` é preenchido quando a linha existe; se os enums principais
 * forem inválidos, `getChatbotAiConfig` ainda retorna `null`, mas
 * `getChatbotTipoTriagem` continua disponível a partir da mesma linha.
 */
export interface ChatbotAiConfig {
  readonly tom_voz: ChatbotTom;
  readonly vocabulario: ChatbotVocabulario;
  readonly tipo_atualizacao: ChatbotTipoAtualizacao;
  readonly palavras_chave_filtro: readonly string[];
  readonly tipo_triagem: ChatbotTipoTriagem;
}

export type ChatbotTom = "profissional" | "empatico" | "energico";
export type ChatbotVocabulario = "leigo" | "intermediario";
export type ChatbotTipoAtualizacao = "publicacao" | "todas";

const TOM_VALUES: readonly ChatbotTom[] = [
  "profissional",
  "empatico",
  "energico",
];
const VOCAB_VALUES: readonly ChatbotVocabulario[] = ["leigo", "intermediario"];
const TIPO_ATUALIZACAO_VALUES: readonly ChatbotTipoAtualizacao[] = [
  "publicacao",
  "todas",
];

/** Valores aceitos de `chatbot_ai_config.tipo_triagem` (enum no Postgres). */
const CHATBOT_TIPO_TRIAGEM_VALUES: readonly ChatbotTipoTriagem[] = [
  "especialista",
  "simples",
  "sem_triagem",
];

/** Quando não há linha, falha de I/O ou `tipo_triagem` ausente/ inválido no banco. */
const DEFAULT_TIPO_TRIAGEM: ChatbotTipoTriagem = "simples";

interface RawChatbotAiConfig {
  tom_voz: string | null;
  vocabulario: string | null;
  tipo_atualizacao: string | null;
  palavras_chave_filtro: unknown;
  tipo_triagem: string | null;
}

interface OrgAiConfigCacheEntry {
  personalization: ChatbotAiConfig | null;
  tipoTriagem: ChatbotTipoTriagem;
}

/**
 * Cache em memória da `chatbot_ai_config` por organização.
 *
 * Escopo: processo Node (instância Cloud Run). Cada réplica tem seu próprio
 * `Map`; cold start zera tudo. O valor cacheado pode ter `personalization`
 * `null` — é o sinal legítimo de "org sem config válida" — mas `tipoTriagem`
 * é sempre definido (default `simples` quando ausente, em erro de I/O ou inválido).
 */
interface ConfigCacheEntry {
  value: OrgAiConfigCacheEntry;
  timestamp: number;
}

const configCache = new Map<string, ConfigCacheEntry>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

/**
 * Converte o texto vindo do PostgREST para `ChatbotTipoTriagem`.
 * Valores fora do enum ou vazios viram {@link DEFAULT_TIPO_TRIAGEM}, com log.
 */
function parseTipoTriagem(raw: string | null | undefined): ChatbotTipoTriagem {
  if (raw === null || raw === undefined) return DEFAULT_TIPO_TRIAGEM;
  const t = String(raw).trim();
  if (t.length === 0) return DEFAULT_TIPO_TRIAGEM;
  const hit = CHATBOT_TIPO_TRIAGEM_VALUES.find((v) => v === t);
  if (hit) return hit;
  console.warn(
    `⚠️ [chatbotAiConfig] tipo_triagem inválido no banco: ${JSON.stringify(raw)} — usando "${DEFAULT_TIPO_TRIAGEM}".`,
  );
  return DEFAULT_TIPO_TRIAGEM;
}

async function loadOrgAiConfigEntry(
  organizationId: string,
  env?: EnvConfig,
): Promise<OrgAiConfigCacheEntry> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase
    .from("chatbot_ai_config")
    .select(
      "tom_voz, vocabulario, tipo_atualizacao, palavras_chave_filtro, tipo_triagem",
    )
    .eq("organization_id", organizationId)
    .maybeSingle<RawChatbotAiConfig>();

  if (error) {
    console.warn(
      `⚠️ [chatbotAiConfig] Falha ao buscar config para org ${organizationId}: ${error.message}`,
    );
    return { personalization: null, tipoTriagem: DEFAULT_TIPO_TRIAGEM };
  }

  if (!data) {
    console.info(
      `[chatbotAiConfig] organization_id=${organizationId}: sem linha em chatbot_ai_config — tipo_triagem efetivo="${DEFAULT_TIPO_TRIAGEM}" (default).`,
    );
    return { personalization: null, tipoTriagem: DEFAULT_TIPO_TRIAGEM };
  }

  const tipoTriagem = parseTipoTriagem(data.tipo_triagem);
  console.info(
    `[chatbotAiConfig] organization_id=${organizationId}: tipo_triagem no banco=${JSON.stringify(data.tipo_triagem)} → resolvido="${tipoTriagem}".`,
  );

  const tom = TOM_VALUES.find((v) => v === data.tom_voz);
  const vocab = VOCAB_VALUES.find((v) => v === data.vocabulario);
  const tipo = TIPO_ATUALIZACAO_VALUES.find(
    (v) => v === data.tipo_atualizacao,
  );

  if (!tom || !vocab || !tipo) {
    console.warn(
      `⚠️ [chatbotAiConfig] Config com shape inválido para org ${organizationId} — usando defaults de personalização.`,
    );
    return { personalization: null, tipoTriagem };
  }

  const parsed: ChatbotAiConfig = {
    tom_voz: tom,
    vocabulario: vocab,
    tipo_atualizacao: tipo,
    palavras_chave_filtro: parsePalavrasChave(data.palavras_chave_filtro),
    tipo_triagem: tipoTriagem,
  };
  return { personalization: parsed, tipoTriagem };
}

async function ensureOrgAiConfigCached(
  organizationId: string,
  env?: EnvConfig,
): Promise<OrgAiConfigCacheEntry> {
  const cached = configCache.get(organizationId);
  if (cached && Date.now() - cached.timestamp < CONFIG_TTL_MS) {
    return cached.value;
  }
  if (cached) {
    configCache.delete(organizationId);
  }

  const value = await loadOrgAiConfigEntry(organizationId, env);
  cacheSet(organizationId, value);
  return value;
}

/**
 * Busca a configuração de IA da organização.
 *
 * Retorna `null` quando:
 *  - não há linha cadastrada para a org;
 *  - a linha existe mas algum campo principal está fora do enum esperado;
 *  - houve erro de I/O (logado).
 *
 * Em qualquer um desses casos o agente cai nos textos default — equivalente
 * ao comportamento `config === null` da edge function.
 *
 * O resultado (inclusive `null`) é cacheado por `CONFIG_TTL_MS` por org.
 * Use `getChatbotTipoTriagem` para ler `tipo_triagem` mesmo quando este
 * retorno for `null`.
 */
export async function getChatbotAiConfig(
  organizationId: string,
  env?: EnvConfig,
): Promise<ChatbotAiConfig | null> {
  const entry = await ensureOrgAiConfigCached(organizationId, env);
  return entry.personalization;
}

/**
 * Retorna `tipo_triagem` da org (default `simples` se linha ausente, erro de I/O
 * ou valor inválido no banco).
 * Usa o mesmo cache/SELECT que `getChatbotAiConfig`.
 */
export async function getChatbotTipoTriagem(
  organizationId: string,
  env?: EnvConfig,
): Promise<ChatbotTipoTriagem> {
  const entry = await ensureOrgAiConfigCached(organizationId, env);
  return entry.tipoTriagem;
}

/**
 * Remove a entrada de cache de uma org específica. Útil quando o back-office
 * altera a `chatbot_ai_config` e quer refletir a mudança antes do TTL.
 */
export function invalidateChatbotAiConfigCache(organizationId: string): void {
  configCache.delete(organizationId);
}

/** Limpa todo o cache. Uso restrito a testes. */
export function __resetChatbotAiConfigCacheForTests(): void {
  configCache.clear();
}

function cacheSet(
  organizationId: string,
  value: OrgAiConfigCacheEntry,
): void {
  configCache.set(organizationId, { value, timestamp: Date.now() });
}

function parsePalavrasChave(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
