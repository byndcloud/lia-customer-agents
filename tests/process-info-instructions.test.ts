import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { ChatbotAiConfig } from "../src/db/chatbotAiConfig.js";
import { buildAgentTemporalContextSection } from "../src/agents/agent-temporal-context.js";
import {
  PROCESS_INFO_BASE_INSTRUCTIONS,
  PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS,
} from "../src/agents/instructions/process-info.instructions.js";
import { __resetInstructionsCacheForTests } from "../src/agents/instructions/process-info.instructionsCache.js";
import { buildProcessInfoInstructions } from "../src/agents/instructions/process-info.personalization.js";

beforeEach(() => {
  __resetInstructionsCacheForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-22T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const TRANSHIPMENT_HEADING = "### REGRA ESPECIAL: Transbordo com Opção de Agendamento";

const PROCESS_INFO_CLIENT_UNLINKED_SECTION = `## Sinal do sistema: cliente ainda não vinculado (sem clientId)
Não há **pessoa vinculada** ao atendimento neste run. Se o cliente pedir "meu processo" sem ter informado CPF/CNPJ confiável na conversa, você pode precisar de \`cpf_cnpj\` em **getLatelyProcess** após tentar \`{}\` se a tool/documentação indicar insuficiência — peça **só** o documento, uma pergunta curta, sem exigir tribunal/vara.`;

function makeConfig(overrides: Partial<ChatbotAiConfig> = {}): ChatbotAiConfig {
  return {
    tom_voz: "profissional",
    vocabulario: "leigo",
    tipo_atualizacao: "publicacao",
    palavras_chave_filtro: [],
    ...overrides,
  };
}

describe("buildProcessInfoInstructions — sem config", () => {
  it("retorna PREFIX + temporal + BASE + DEFAULT_STYLE quando config é null e não há calendário", () => {
    const result = buildProcessInfoInstructions({
      config: null,
      calendarConnectionId: undefined,
    });

    expect(result).toContain(PROCESS_INFO_BASE_INSTRUCTIONS);
    expect(result).toContain(PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS);
    expect(result).not.toContain(TRANSHIPMENT_HEADING);
    expect(result.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(result).toContain("## Contexto temporal (âncora do atendimento)");
    const temporal = buildAgentTemporalContextSection();
    expect(result).toBe(
      `${RECOMMENDED_PROMPT_PREFIX}\n\n${temporal}\n\n${PROCESS_INFO_CLIENT_UNLINKED_SECTION}\n\n` +
        PROCESS_INFO_BASE_INSTRUCTIONS +
        PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS,
    );
  });

  it("com clientLinked: instrui a não pedir CPF antes de getLatelyProcess", () => {
    const result = buildProcessInfoInstructions({
      config: null,
      calendarConnectionId: undefined,
      clientLinked: true,
    });

    expect(result).toContain("## Sinal do sistema: cliente já vinculado (clientId)");
    expect(result).toContain("**É proibido** pedir CPF, CNPJ");
    expect(result).toContain("getLatelyProcess");
  });

  it("anexa bloco de transbordo quando calendarConnectionId está presente", () => {
    const result = buildProcessInfoInstructions({
      config: null,
      calendarConnectionId: "cal-1",
    });

    expect(result).toContain(PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS);
    expect(result).toContain(TRANSHIPMENT_HEADING);
  });
});

describe("buildProcessInfoInstructions — tom_voz", () => {
  it("inclui bloco profissional e exclui demais", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({ tom_voz: "profissional" }),
    });

    expect(result).toContain(
      "Tom: Formal, objetivo e claro. Use linguagem simples",
    );
    expect(result).toContain("Seja direto e profissional");
    expect(result).not.toContain("Acolhedor, empático");
    expect(result).not.toContain("Enérgico, confiante e proativo");
  });

  it("inclui bloco empatico e exclui demais", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({ tom_voz: "empatico" }),
    });

    expect(result).toContain("Acolhedor, empático e compreensivo");
    expect(result).not.toContain("Seja direto e profissional");
    expect(result).not.toContain("Enérgico, confiante e proativo");
  });

  it("inclui bloco energico e exclui demais", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({ tom_voz: "energico" }),
    });

    expect(result).toContain("Enérgico, confiante e proativo");
    expect(result).not.toContain("Acolhedor, empático");
    expect(result).not.toContain("Seja direto e profissional");
  });
});

describe("buildProcessInfoInstructions — vocabulario", () => {
  it("inclui bloco leigo e exclui intermediario", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({ vocabulario: "leigo" }),
    });

    expect(result).toContain('Evite palavras como "petição inicial"');
    expect(result).not.toContain(
      "Você pode usar termos técnicos essenciais",
    );
  });

  it("inclui bloco intermediario e exclui leigo", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({ vocabulario: "intermediario" }),
    });

    expect(result).toContain("Você pode usar termos técnicos essenciais");
    expect(result).not.toContain('Evite palavras como "petição inicial"');
  });
});

describe("buildProcessInfoInstructions — tipo_atualizacao", () => {
  it("inclui bloco publicacao com palavras-chave interpoladas", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({
        tipo_atualizacao: "publicacao",
        palavras_chave_filtro: ["sigilo", "menor", "valor"],
      }),
    });

    expect(result).toContain(
      "Informe APENAS sobre publicações oficiais no Diário de Justiça",
    );
    expect(result).toContain("(sigilo, menor, valor)");
    expect(result).not.toContain("Informe sobre TODAS as movimentações");
  });

  it("inclui bloco todas com palavras-chave interpoladas", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({
        tipo_atualizacao: "todas",
        palavras_chave_filtro: ["sigilo"],
      }),
    });

    expect(result).toContain("Informe sobre TODAS as movimentações");
    expect(result).toContain("(sigilo)");
    expect(result).not.toContain("Informe APENAS sobre publicações oficiais");
  });

  it("interpola lista vazia como `()` quando não há palavras-chave", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({
        tipo_atualizacao: "publicacao",
        palavras_chave_filtro: [],
      }),
    });

    expect(result).toContain("termos sensíveis ()");
  });
});

describe("PROCESS_INFO_BASE_INSTRUCTIONS — blocos críticos", () => {
  it("contém o bloco 'ENTRADA VIA HANDOFF (CONTINUIDADE)' e regra determinística getLatelyProcess", () => {
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain(
      "ENTRADA VIA HANDOFF (CONTINUIDADE)",
    );
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain("REGRA DETERMINÍSTICA");
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain("getLatelyProcess");
  });

  it("contém o bloco 'AGIR ANTES DE FALAR' com 'Frases banidas de promessa'", () => {
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain("AGIR ANTES DE FALAR");
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain(
      "Frases banidas de promessa",
    );
  });

  it("proíbe pedir tribunal/vara/cidade como pré-requisito antes das tools", () => {
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain(
      "Dados que as tools aceitam",
    );
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain("tribunal");
    expect(PROCESS_INFO_BASE_INSTRUCTIONS).toContain("getLatelyProcess");
  });
});

describe("buildProcessInfoInstructions — composição completa", () => {
  it("compõe BASE + estilo + vocab + updates + transbordo na ordem correta", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig({
        tom_voz: "empatico",
        vocabulario: "intermediario",
        tipo_atualizacao: "todas",
        palavras_chave_filtro: ["urgência"],
      }),
      calendarConnectionId: "cal-1",
    });

    const baseIdx = result.indexOf("# Persona");
    const estiloIdx = result.indexOf("Acolhedor, empático");
    const vocabIdx = result.indexOf("Você pode usar termos técnicos");
    const updatesIdx = result.indexOf("TODAS as movimentações");
    const transbordoIdx = result.indexOf(TRANSHIPMENT_HEADING);

    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(estiloIdx).toBeGreaterThan(baseIdx);
    expect(vocabIdx).toBeGreaterThan(estiloIdx);
    expect(updatesIdx).toBeGreaterThan(vocabIdx);
    expect(transbordoIdx).toBeGreaterThan(updatesIdx);
  });

  it("não substitui o bloco default ao receber config (sem default + com config)", () => {
    const result = buildProcessInfoInstructions({
      config: makeConfig(),
    });

    expect(result).not.toContain(PROCESS_INFO_DEFAULT_STYLE_INSTRUCTIONS);
  });
});
