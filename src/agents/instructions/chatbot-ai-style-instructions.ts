import type {
  ChatbotAiConfig,
  ChatbotTom,
  ChatbotVocabulario,
} from "../../db/chatbotAiConfig.js";

/**
 * Fragmentos de prompt derivados de `chatbot_ai_config` (`tom_voz`,
 * `vocabulario`). Consumidos por qualquer agente (process_info, orquestrador,
 * triagens, etc.).
 */

/**
 * Tom + vocabulário padrão quando não há config válida ou `config` é `null`
 * (equivalente formal / leigo).
 */
export const CHATBOT_DEFAULT_TOM_VOCAB_INSTRUCTIONS = `
### ESTILO E FLUXO
-   Tom: Formal, objetivo e claro. Use linguagem simples, sem "juridiquês".
-   Apresentação de Opções: Antes de listar opções numeradas, sempre introduza a lista com uma frase de transição humanizada.

### NÍVEL DE LINGUAGEM
-   Use linguagem simples e acessível, sem termos técnicos jurídicos.
`;

const STYLE_INSTRUCTIONS: Record<ChatbotTom, string> = {
  profissional: `
### ESTILO E FLUXO
-   Tom: Formal, objetivo e claro. Use linguagem simples, sem "juridiquês".
-   Seja direto e profissional, evitando excessos de cordialidade.
-   Apresentação de Opções: Antes de listar opções numeradas, sempre introduza a lista com uma frase de transição humanizada. Evite chamadas robóticas como "Escolha uma das opções:". Em vez disso, pergunte algo como "Com o que mais posso te ajudar?" ou "Posso ajudar com mais alguma informação?" e então apresente a lista.
`,
  empatico: `
### ESTILO E FLUXO
-   Tom: Acolhedor, empático e compreensivo. Demonstre cuidado genuíno.
-   Use frases que transmitam empatia.
-   Seja paciente e detalhista nas explicações.
-   Apresentação de Opções: Sempre introduza listas com frases calorosas como.
`,
  energico: `
### ESTILO E FLUXO
-   Tom: Enérgico, confiante e proativo. Transmita dinamismo e eficiência.
-   Use frases assertivas e diretas.
-   Seja objetivo mas entusiasmado.
-   Apresentação de Opções: Introduza listas com energia.
`,
};

const VOCABULARY_INSTRUCTIONS: Record<ChatbotVocabulario, string> = {
  leigo: `
### NÍVEL DE LINGUAGEM
-   Use SEMPRE linguagem simples e acessível, sem termos técnicos jurídicos.
-   Evite palavras como "petição inicial", "contestação", "réu", "autor".
-   Prefira: "documento inicial", "resposta", "parte contrária", "cliente".
-   Explique qualquer termo técnico que precise usar de forma clara e didática.
`,
  intermediario: `
### NÍVEL DE LINGUAGEM
-   Você pode usar termos técnicos essenciais, mas mantenha a clareza.
-   Termos como "petição", "audiência", "sentença" são aceitáveis.
-   Evite juridiquês excessivo ou termos muito técnicos.
-   Equilibre profissionalismo com compreensibilidade.
`,
};

/** Bloco de estilo/fluxo conforme `tom_voz` da config. */
export function buildStyleInstructions(tom: ChatbotTom): string {
  return STYLE_INSTRUCTIONS[tom];
}

/** Bloco de nível de linguagem conforme `vocabulario` da config. */
export function buildVocabularyInstructions(
  vocabulario: ChatbotVocabulario,
): string {
  return VOCABULARY_INSTRUCTIONS[vocabulario];
}

/**
 * Tom + vocabulário a partir de `chatbot_ai_config`. Com `config === null`,
 * usa {@link CHATBOT_DEFAULT_TOM_VOCAB_INSTRUCTIONS}.
 */
export function buildTomAndVocabularyStyleAppendix(
  config: ChatbotAiConfig | null,
): string {
  if (!config) {
    return CHATBOT_DEFAULT_TOM_VOCAB_INSTRUCTIONS;
  }
  return (
    buildStyleInstructions(config.tom_voz) +
    buildVocabularyInstructions(config.vocabulario)
  );
}
