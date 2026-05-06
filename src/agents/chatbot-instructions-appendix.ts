import type { EnvConfig } from "../config/env.js";
import type { ChatbotAiConfig } from "../db/chatbotAiConfig.js";
import { getChatbotAiConfig } from "../db/chatbotAiConfig.js";
import { buildTomAndVocabularyStyleAppendix } from "./instructions/chatbot-ai-style-instructions.js";

const CHATBOT_TOM_VOCAB_SECTION_HEADER = `## Personalização (tom de voz e vocabulário)

As instruções abaixo espelham a tabela \`chatbot_ai_config\` (\`tom_voz\`, \`vocabulario\`) e alinham este agente ao tom do agente de consulta processual. **Em conflito pontual** com bullets genéricos de estilo neste prompt, **mantenha** as regras operacionais (handoff, tools, escopo, proibições) e **ajuste** cordialidade e vocabulário conforme esta seção.

`;

export type FetchChatbotAiConfigFn = (
  organizationId: string,
  env: EnvConfig,
) => Promise<ChatbotAiConfig | null>;

/** Repassa `fetchChatbotAiConfig` injetado em testes, ou omite para usar o default do módulo. */
export function pickOptionalFetchChatbotOptions(
  fetchChatbotAiConfig: FetchChatbotAiConfigFn | undefined,
): { fetchChatbotAiConfig?: FetchChatbotAiConfigFn } {
  if (fetchChatbotAiConfig === undefined) {
    return {};
  }
  return { fetchChatbotAiConfig };
}

/**
 * Resolve `chatbot_ai_config` e anexa o bloco de tom + vocabulário ao final
 * das instruções (orquestrador, triagem).
 */
export async function appendChatbotTomVocabToInstructions(
  baseInstructions: string,
  options: {
    readonly organizationId: string | undefined;
    readonly env: EnvConfig;
    readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
  },
): Promise<string> {
  const fetchFn = options.fetchChatbotAiConfig ?? getChatbotAiConfig;
  const orgId = options.organizationId;
  const config =
    orgId !== undefined && orgId !== ""
      ? await fetchFn(orgId, options.env)
      : null;
  const appendix = buildTomAndVocabularyStyleAppendix(config);
  return `${baseInstructions}\n\n${CHATBOT_TOM_VOCAB_SECTION_HEADER}${appendix}`;
}
