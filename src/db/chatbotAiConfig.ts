import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Configuração de personalização da IA por organização.
 *
 * Espelha a tabela `chatbot_ai_config` do Supabase. Os valores de `tom_voz`,
 * `vocabulario` e `tipo_atualizacao` são guardados como `text` no banco — o
 * resolver abaixo faz o parse defensivo: shape inesperado vira `null` para o
 * agente cair nos defaults sem quebrar a execução.
 *
 * O modo de triagem (handoff para especialistas, atendimento a não clientes)
 * não vem mais desta tabela: usa-se `whatsapp_numeros.triage_enabled` e
 * `triage_specialist_agents_config` (ver `runAgents`).
 */
export interface ChatbotAiConfig {
  readonly tom_voz: ChatbotTom;
  readonly vocabulario: ChatbotVocabulario;
  readonly tipo_atualizacao: ChatbotTipoAtualizacao;
  readonly palavras_chave_filtro: readonly string[];
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

interface RawChatbotAiConfig {
  tom_voz: string | null;
  vocabulario: string | null;
  tipo_atualizacao: string | null;
  palavras_chave_filtro: unknown;
}

/**
 * Cache em memória da `chatbot_ai_config` por organização.
 *
 * Escopo: processo Node (instância Cloud Run). Cada réplica tem seu próprio
 * `Map`; cold start zera tudo. O valor cacheado pode ser `null` — é o sinal
 * legítimo de "org sem config válida".
 */
interface ConfigCacheEntry {
  value: ChatbotAiConfig | null;
  timestamp: number;
}

const configCache = new Map<string, ConfigCacheEntry>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function loadOrgAiConfigPersonalization(
  organizationId: string,
  env?: EnvConfig,
): Promise<ChatbotAiConfig | null> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase
    .from("chatbot_ai_config")
    .select("tom_voz, vocabulario, tipo_atualizacao, palavras_chave_filtro")
    .eq("organization_id", organizationId)
    .maybeSingle<RawChatbotAiConfig>();

  if (error) {
    console.warn(
      `⚠️ [chatbotAiConfig] Falha ao buscar config para org ${organizationId}: ${error.message}`,
    );
    return null;
  }

  if (!data) {
    console.info(
      `[chatbotAiConfig] organization_id=${organizationId}: sem linha em chatbot_ai_config.`,
    );
    return null;
  }

  const tom = TOM_VALUES.find((v) => v === data.tom_voz);
  const vocab = VOCAB_VALUES.find((v) => v === data.vocabulario);
  const tipo = TIPO_ATUALIZACAO_VALUES.find(
    (v) => v === data.tipo_atualizacao,
  );

  if (!tom || !vocab || !tipo) {
    console.warn(
      `⚠️ [chatbotAiConfig] Config com shape inválido para org ${organizationId} — usando defaults de personalização.`,
    );
    return null;
  }

  return {
    tom_voz: tom,
    vocabulario: vocab,
    tipo_atualizacao: tipo,
    palavras_chave_filtro: parsePalavrasChave(data.palavras_chave_filtro),
  };
}

async function ensureOrgAiConfigCached(
  organizationId: string,
  env?: EnvConfig,
): Promise<ChatbotAiConfig | null> {
  const cached = configCache.get(organizationId);
  if (cached && Date.now() - cached.timestamp < CONFIG_TTL_MS) {
    return cached.value;
  }
  if (cached) {
    configCache.delete(organizationId);
  }

  const value = await loadOrgAiConfigPersonalization(organizationId, env);
  configCache.set(organizationId, { value, timestamp: Date.now() });
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
 */
export async function getChatbotAiConfig(
  organizationId: string,
  env?: EnvConfig,
): Promise<ChatbotAiConfig | null> {
  return ensureOrgAiConfigCached(organizationId, env);
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

function parsePalavrasChave(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
