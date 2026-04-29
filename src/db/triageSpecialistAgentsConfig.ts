import {
  TRIAGE_TRABALHISTA_AGENT_NAME,
  formatTriageSpecialistInstrucoesForPrompt,
} from "../agents/instructions/triage-trabalhista.instructions.js";
import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

interface CacheEntry {
  /** Texto já formatado para o prompt (JSONB array → lista numerada, ou legado). */
  value: string | null;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

function cacheKey(organizationId: string, nome: string): string {
  return `${organizationId}::${nome}`;
}

/**
 * Indica se existe linha em `triage_specialist_agents_config` para a org com
 * `nome` = {@link TRIAGE_TRABALHISTA_AGENT_NAME} (único especialista de triagem
 * com handoff neste serviço).
 *
 * Usado com `triage_enabled` e vínculo de cliente para decidir se a triagem
 * central expõe handoff para o agente trabalhista.
 */
export async function organizationHasTriageSpecialistAgentsConfig(
  organizationId: string,
  env?: EnvConfig,
): Promise<boolean> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("triage_specialist_agents_config")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .eq("nome", TRIAGE_TRABALHISTA_AGENT_NAME)
    .limit(1);

  if (error) {
    console.warn(
      `[triageSpecialistAgentsConfig] organizationHasTriageSpecialistAgentsConfig(${organizationId}): ${error.message}`,
    );
    return false;
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Lê `instrucoes` em `triage_specialist_agents_config` para a org e o nome do
 * agente (ex.: `triage_trabalhista`). Retorna `null` se não houver linha,
 * erro de I/O ou conteúdo vazio após formatação.
 *
 * A coluna é JSONB: array de `{ data, texto }` vira lista numerada para o prompt;
 * string simples (legado) é repassada em trim.
 *
 * A tabela já existe no projeto (FK `organization_id` → `organizations`, etc.);
 * usamos `limit(1)` + `atualizado_em` desc para não depender de unique composto.
 */
export async function getTriageSpecialistInstrucoes(
  organizationId: string,
  nome: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("triage_specialist_agents_config")
    .select("instrucoes")
    .eq("organization_id", organizationId)
    .eq("nome", nome)
    .order("atualizado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.warn(
      `[triageSpecialistAgentsConfig] Falha ao buscar instruções (${organizationId}, ${nome}): ${error.message}`,
    );
    return null;
  }

  const row = data?.[0];
  const raw = row?.instrucoes;
  return formatTriageSpecialistInstrucoesForPrompt(raw);
}

/**
 * Mesmo contrato de {@link getTriageSpecialistInstrucoes}, com cache em
 * memória por par org + nome (TTL {@link TTL_MS}).
 */
export async function getTriageSpecialistInstrucoesCached(
  organizationId: string,
  nome: string,
  env?: EnvConfig,
): Promise<string | null> {
  const key = cacheKey(organizationId, nome);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < TTL_MS) {
    return hit.value;
  }
  const value = await getTriageSpecialistInstrucoes(organizationId, nome, env);
  cache.set(key, { value, timestamp: Date.now() });
  return value;
}

/** Remove cache de uma org (opcional: após edição no back-office). */
export function invalidateTriageSpecialistAgentsConfigCache(
  organizationId: string,
  nome?: string,
): void {
  if (nome !== undefined) {
    cache.delete(cacheKey(organizationId, nome));
    return;
  }
  const prefix = `${organizationId}::`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/** Uso restrito a testes. */
export function __resetTriageSpecialistAgentsConfigCacheForTests(): void {
  cache.clear();
}
