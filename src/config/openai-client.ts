import OpenAI from "openai";
import { loadEnv, type EnvConfig } from "./env.js";

let cached: OpenAI | null = null;
let cachedKey: string | null = null;

/**
 * Retorna o cliente OpenAI compartilhado (Whisper / Responses API auxiliar).
 *
 * O Agents SDK tem seu próprio cliente interno; este aqui é só para chamadas
 * diretas (transcrição de áudio e geração de mensagens de followup).
 */
export function getOpenAIClient(env?: EnvConfig): OpenAI {
  const cfg = env ?? loadEnv();

  if (!cfg.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  if (cached && cachedKey === cfg.openaiApiKey) {
    return cached;
  }

  cached = new OpenAI({ apiKey: cfg.openaiApiKey });
  cachedKey = cfg.openaiApiKey;
  return cached;
}

/** Reseta o cache (uso em testes). */
export function resetOpenAIClient(): void {
  cached = null;
  cachedKey = null;
}
