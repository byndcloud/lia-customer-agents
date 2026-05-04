import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { buildAgentTemporalContextSection } from "../agent-temporal-context.js";
import type { ChatbotAiConfig } from "../../db/chatbotAiConfig.js";
import {
  getCachedInstructions,
  setCachedInstructions,
} from "./process-info.instructionsCache.js";
import {
  buildStyleInstructions,
  buildVocabularyInstructions,
} from "./chatbot-ai-style-instructions.js";
import {
  PROCESS_INFO_BASE_INSTRUCTIONS,
  PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS,
  buildUpdateInstructions,
  getTranshipmentMenuInstructions,
} from "./process-info.instructions.js";

export interface BuildProcessInfoInstructionsParams {
  /** Config da org (`chatbot_ai_config`) ou `null` quando ausente/ inválida. */
  readonly config: ChatbotAiConfig | null;
  /** Quando presente, anexa o bloco de transbordo com agendamento. */
  readonly calendarConnectionId?: string | undefined;
  /**
   * `true` quando `AgentRunContext.clientId` está definido (pessoa já vinculada
   * no atendimento). Afeta o bloco de identificação fora do cache.
   */
  readonly clientLinked?: boolean | undefined;
  /**
   * Quando presente, ativa o cache em memória da string final (TTL 10 min).
   * Sem org o build é executado toda vez — útil em testes e chamadas
   * sintéticas.
   */
  readonly organizationId?: string | undefined;
}

/**
 * Compõe as instruções finais do agente `process_info`.
 *
 * Estrutura final:
 *  1. `PROCESS_INFO_BASE_INSTRUCTIONS` (sempre).
 *  2. Estilo + vocabulário (`chatbot-ai-style-instructions.ts`) + comunicação
 *     de atualizações:
 *     - sem config → `PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS`
 *     - com config → `buildStyleInstructions` / `buildVocabularyInstructions` +
 *       `tipo_atualizacao` + `palavras_chave_filtro`.
 *  3. Bloco de transbordo (`getTranshipmentMenuInstructions()`) quando há
 *     `calendarConnectionId`.
 *
 * O bloco de **data atual** (`buildAgentTemporalContextSection`) é montado a
 * cada chamada e não entra no cache (TTL), para referências relativas do
 * cliente permanecerem corretas.
 *
 * Quando `organizationId` é passado, o **corpo** estático (sem prefixo
 * recomendado, sem bloco temporal e sem bloco de vínculo do cliente) é
 * cacheado por até 10 min, invalidando automaticamente se a config ou a
 * presença do calendário mudar.
 */
export function buildProcessInfoInstructions(
  params: BuildProcessInfoInstructionsParams,
): string {
  const { config, calendarConnectionId, organizationId, clientLinked } =
    params;
  const hasCalendar = Boolean(calendarConnectionId);
  const linked = Boolean(clientLinked);

  if (organizationId) {
    const cachedBody = getCachedInstructions(organizationId, config, hasCalendar);
    if (cachedBody) {
      return finalizeProcessInfoInstructions(cachedBody, linked);
    }
  }

  const body = composeProcessInfoInstructionBody(config, hasCalendar);

  if (organizationId) {
    setCachedInstructions(organizationId, body, config, hasCalendar);
  }

  return finalizeProcessInfoInstructions(body, linked);
}

/**
 * Bloco fora do cache: o modelo deve obedecer ao vínculo real do run, não só
 * ao texto genérico da base.
 */
function buildProcessInfoClientLinkSection(clientLinked: boolean): string {
  if (clientLinked) {
    return `## Sinal do sistema: cliente já vinculado (clientId)
O atendimento já tem **pessoa identificada no cadastro** do escritório (headers / contexto técnico). Para pedidos de andamento, "como está **meu** processo", situação ou listagem de processos **desse** cliente:
- Chame **getLatelyProcess** no **mesmo turno**, em geral com argumentos \`{}\` (vazio) — o backend resolve pelo vínculo.
- **É proibido** pedir CPF, CNPJ ou "confirmar documento" **antes** dessa chamada nem como substituto dela.
- Só peça CPF/CNPJ se, **depois** do retorno da tool, houver indicação explícita de que a identificação falhou ou se for necessário desambiguar entre **várias pessoas** (caso raro com clientId já definido).`;
  }

  return `## Sinal do sistema: cliente ainda não vinculado (sem clientId)
Não há **pessoa vinculada** ao atendimento neste run. Se o cliente pedir "meu processo" sem ter informado CPF/CNPJ confiável na conversa, você pode precisar de \`cpf_cnpj\` em **getLatelyProcess** após tentar \`{}\` se a tool/documentação indicar insuficiência — peça **só** o documento, uma pergunta curta, sem exigir tribunal/vara.`;
}

function finalizeProcessInfoInstructions(
  body: string,
  clientLinked: boolean,
): string {
  const temporal = buildAgentTemporalContextSection();
  const clientSection = buildProcessInfoClientLinkSection(clientLinked);
  return `${RECOMMENDED_PROMPT_PREFIX}\n\n${temporal}\n\n${clientSection}\n\n${body}`;
}

function composeProcessInfoInstructionBody(
  config: ChatbotAiConfig | null,
  hasCalendar: boolean,
): string {
  const transhipment = hasCalendar ? getTranshipmentMenuInstructions() : "";

  if (!config) {
    return (
      PROCESS_INFO_BASE_INSTRUCTIONS +
      PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS +
      transhipment
    );
  }

  return (
    PROCESS_INFO_BASE_INSTRUCTIONS +
    buildStyleInstructions(config.tom_voz) +
    buildVocabularyInstructions(config.vocabulario) +
    buildUpdateInstructions(
      config.tipo_atualizacao,
      config.palavras_chave_filtro,
    ) +
    transhipment
  );
}
