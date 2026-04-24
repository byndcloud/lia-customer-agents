import type { ChatbotAiConfig } from "../../db/chatbotAiConfig.js";

/**
 * Cache do **corpo** estático de instruções do agente `process_info` (sem
 * `RECOMMENDED_PROMPT_PREFIX` e sem o bloco de data atual — esse bloco é
 * acrescentado em toda montagem final).
 *
 * Espelha o comportamento de `_shared/chatbot/instructionsCache.ts` da edge
 * function `chat-messages`, com uma correção: o hash inclui `hasCalendar`
 * (boolean) para invalidar a string quando o calendário da organização
 * ligar/desligar. O bloco de transbordo é idêntico independente do ID da
 * conexão, então a chave booleana basta.
 *
 * Escopo: processo Node (instância Cloud Run). Map de módulo, sem TTL de
 * eviction por tamanho — só expira por TTL ou por mudança de hash.
 */
interface CachedInstructions {
  /** Corpo estático (base + estilo + transbordo); sem prefixo nem temporal. */
  instructions: string;
  configHash: string;
  timestamp: number;
}

const instructionsCache = new Map<string, CachedInstructions>();
const INSTRUCTIONS_TTL_MS = 10 * 60 * 1000;

function generateHash(
  config: ChatbotAiConfig | null,
  hasCalendar: boolean,
): string {
  if (!config) return `default:${hasCalendar ? "cal" : "nocal"}`;

  return JSON.stringify({
    tom_voz: config.tom_voz,
    vocabulario: config.vocabulario,
    tipo_atualizacao: config.tipo_atualizacao,
    palavras_chave: [...config.palavras_chave_filtro].sort().join(","),
    hasCalendar,
  });
}

/**
 * Busca a string de instruções cacheada para a organização.
 *
 * Retorna `null` em três situações (sempre removendo a entrada stale, para
 * forçar rebuild no próximo `set`):
 *  1. não existe entrada;
 *  2. TTL estourado;
 *  3. hash atual diferente do hash cacheado (config ou `hasCalendar` mudou).
 */
export function getCachedInstructions(
  organizationId: string,
  config: ChatbotAiConfig | null,
  hasCalendar: boolean,
): string | null {
  const cached = instructionsCache.get(organizationId);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > INSTRUCTIONS_TTL_MS) {
    instructionsCache.delete(organizationId);
    return null;
  }

  const currentHash = generateHash(config, hasCalendar);
  if (cached.configHash !== currentHash) {
    instructionsCache.delete(organizationId);
    return null;
  }

  console.log(
    `[instructions-cache] Pega instruções cacheadas — organizacaoId=${organizationId}`,
  );
  return cached.instructions;
}

/** Persiste a string composta no cache. */
export function setCachedInstructions(
  organizationId: string,
  instructions: string,
  config: ChatbotAiConfig | null,
  hasCalendar: boolean,
): void {
  instructionsCache.set(organizationId, {
    instructions,
    configHash: generateHash(config, hasCalendar),
    timestamp: Date.now(),
  });
}

/** Invalida o cache de uma org específica. */
export function invalidateInstructionsCache(organizationId: string): void {
  instructionsCache.delete(organizationId);
}

/** Limpa todo o cache. Uso restrito a testes. */
export function __resetInstructionsCacheForTests(): void {
  instructionsCache.clear();
}
