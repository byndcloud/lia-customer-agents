import {
  TRIAGE_SPECIALIST_AREA_SLUGS,
  formatConhecimentoForPrompt,
  formatTriageSpecialistInstrucoesForPrompt,
  isTriageSpecialistAreaSlug,
  triageSpecialistAgentTechnicalName,
  type TriageSpecialistAreaSlug,
} from "../agents/instructions/triage-specialist.instructions.js";
import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

interface CacheEntry {
  readonly value: ActiveTriageSpecialistRow[];
  readonly timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

const promptContentCache = new Map<string, CacheEntryPromptContent>();
interface CacheEntryPromptContent {
  readonly value: TriageSpecialistPromptContent;
  readonly timestamp: number;
}

/** Blocos de prompt carregados de `triage_specialist_agents_config` por org + `identificador`. */
export interface TriageSpecialistPromptContent {
  /** Coluna `conhecimento` → PERGUNTAS-REFERÊNCIA POR TEMA. */
  readonly conhecimento: string | null;
  /** Coluna `instrucoes` formatada → Instruções extras. */
  readonly instrucoesFormatadas: string | null;
}

function orgCacheKey(organizationId: string): string {
  return organizationId;
}

function promptContentCacheKey(organizationId: string, identificador: string): string {
  return `${organizationId}::${identificador}`;
}

export interface ActiveTriageSpecialistRow {
  /** Valor de `identificador` (slug, ex.: `trabalhista`). */
  readonly areaSlug: TriageSpecialistAreaSlug;
  /** Nome do agente no SDK (= `identificador`, ex.: `criminal`). */
  readonly agentName: string;
}

/**
 * Lista especialistas de triagem **ativos** para a organização (`ativo = true`),
 * com `identificador` em {@link TRIAGE_SPECIALIST_AREA_SLUGS}. Em duplicidade
 * por identificador, mantém a linha mais recente por `atualizado_em`.
 */
export async function getActiveTriageSpecialistsForOrganization(
  organizationId: string,
  env?: EnvConfig,
): Promise<ActiveTriageSpecialistRow[]> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("triage_specialist_agents_config")
    .select("identificador, atualizado_em")
    .eq("organization_id", organizationId)
    .eq("ativo", true)
    .in("identificador", [...TRIAGE_SPECIALIST_AREA_SLUGS])
    .order("atualizado_em", { ascending: false });

  if (error) {
    console.warn(
      `[triageSpecialistAgentsConfig] getActiveTriageSpecialistsForOrganization(${organizationId}): ${error.message}`,
    );
    return [];
  }

  const seen = new Set<string>();
  const rows: ActiveTriageSpecialistRow[] = [];
  for (const row of data ?? []) {
    const id =
      typeof row.identificador === "string" ? row.identificador.trim().toLowerCase() : "";
    if (!id || !isTriageSpecialistAreaSlug(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      areaSlug: id,
      agentName: triageSpecialistAgentTechnicalName(id),
    });
  }
  return rows;
}

/**
 * Indica se a org tem ao menos um especialista de triagem ativo configurado.
 */
export async function organizationHasActiveTriageSpecialistAgents(
  organizationId: string,
  env?: EnvConfig,
): Promise<boolean> {
  const list = await getActiveTriageSpecialistsForOrganizationCached(organizationId, env);
  return list.length > 0;
}

export async function getActiveTriageSpecialistsForOrganizationCached(
  organizationId: string,
  env?: EnvConfig,
): Promise<ActiveTriageSpecialistRow[]> {
  const key = orgCacheKey(organizationId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < TTL_MS) {
    return hit.value;
  }
  const value = await getActiveTriageSpecialistsForOrganization(organizationId, env);
  cache.set(key, { value, timestamp: Date.now() });
  return value;
}

/**
 * Lê `conhecimento` e `instrucoes` para a org e o `identificador` do especialista
 * (linha ativa mais recente). Campos vazios ou inválidos retornam `null` no slot correspondente.
 */
export async function getTriageSpecialistPromptContent(
  organizationId: string,
  identificador: string,
  env?: EnvConfig,
): Promise<TriageSpecialistPromptContent> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("triage_specialist_agents_config")
    .select("conhecimento, instrucoes")
    .eq("organization_id", organizationId)
    .eq("identificador", identificador)
    .eq("ativo", true)
    .order("atualizado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.warn(
      `[triageSpecialistAgentsConfig] Falha ao buscar conteúdo de prompt (${organizationId}, ${identificador}): ${error.message}`,
    );
    return { conhecimento: null, instrucoesFormatadas: null };
  }

  const row = data?.[0];
  return {
    conhecimento: formatConhecimentoForPrompt(row?.conhecimento),
    instrucoesFormatadas: formatTriageSpecialistInstrucoesForPrompt(row?.instrucoes),
  };
}

/**
 * Mesmo contrato de {@link getTriageSpecialistPromptContent}, com cache em
 * memória por par org + identificador (TTL {@link TTL_MS}).
 */
export async function getTriageSpecialistPromptContentCached(
  organizationId: string,
  identificador: string,
  env?: EnvConfig,
): Promise<TriageSpecialistPromptContent> {
  const key = promptContentCacheKey(organizationId, identificador);
  const hit = promptContentCache.get(key);
  if (hit && Date.now() - hit.timestamp < TTL_MS) {
    return hit.value;
  }
  const value = await getTriageSpecialistPromptContent(organizationId, identificador, env);
  promptContentCache.set(key, { value, timestamp: Date.now() });
  return value;
}

/** Remove cache de uma org (opcional: após edição no back-office). */
export function invalidateTriageSpecialistAgentsConfigCache(
  organizationId: string,
  identificador?: string,
): void {
  cache.delete(orgCacheKey(organizationId));
  if (identificador !== undefined) {
    promptContentCache.delete(promptContentCacheKey(organizationId, identificador));
    return;
  }
  const prefix = `${organizationId}::`;
  for (const k of promptContentCache.keys()) {
    if (k.startsWith(prefix)) promptContentCache.delete(k);
  }
}

/** Uso restrito a testes. */
export function __resetTriageSpecialistAgentsConfigCacheForTests(): void {
  cache.clear();
  promptContentCache.clear();
}
