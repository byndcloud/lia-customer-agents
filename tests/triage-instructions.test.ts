import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { describe, expect, it } from "vitest";
import { buildTriageAgent } from "../src/agents/triage.agent.js";
import { buildTriageSpecialistAgent } from "../src/agents/triage-specialist.agent.js";
import {
  TRIAGE_AGENT_INSTRUCTIONS,
  TRIAGE_AGENT_SIMPLE_INSTRUCTIONS,
  buildTriageAgentInstructions,
  type TriageActiveSpecialistForInstructions,
} from "../src/agents/instructions/triage.instructions.js";
import {
  TRIAGE_SPECIALIST_INSTRUCTIONS_NO_DB,
  buildTriageSpecialistInstructionsWithExtras,
  formatConhecimentoForPrompt,
  formatTriageSpecialistInstrucoesForPrompt,
} from "../src/agents/instructions/triage-specialist.instructions.js";
import type { EnvConfig } from "../src/config/env.js";
import type { ActiveTriageSpecialistRow } from "../src/db/triageSpecialistAgentsConfig.js";
import type { AgentRunContext } from "../src/types.js";

const env: EnvConfig = {
  aiModel: "gpt-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "secret",
};

const context: AgentRunContext = {
  conversaId: "conv-1",
  organizationId: "org-1",
  clientId: undefined,
  calendarConnectionId: undefined,
  extra: undefined,
  agenteResponsavelAtendimento: undefined,
};

describe("Triagem central — corpo de instruções (lista de especialistas vs. export sem default)", () => {
  it("posiciona orquestração para especialista antes das regras centrais quando há lista ativa", () => {
    const sample: TriageActiveSpecialistForInstructions[] = [
      { areaSlug: "trabalhista", agentName: "trabalhista" },
    ];
    const body = buildTriageAgentInstructions(true, sample);
    const orchIdx = body.indexOf("REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA");
    const afterOrchIdx = body.indexOf("ESCOPO");

    expect(orchIdx).toBeGreaterThan(0);
    expect(afterOrchIdx).toBeGreaterThan(orchIdx);
  });

  it("lista aberturas proibidas explícitas no modo simples (texto completo)", () => {
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Sou a Lia"');
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Em que posso te ajudar?"');
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Olá!"');
  });

  it("com especialistas na lista, inclui transfer_to_<slug> e remove checklist detalhista", () => {
    const sample: TriageActiveSpecialistForInstructions[] = [
      { areaSlug: "trabalhista", agentName: "trabalhista" },
    ];
    const body = buildTriageAgentInstructions(true, sample);
    expect(body).toContain("transfer_to_trabalhista");
    expect(body).not.toContain("PERGUNTAS-REFERÊNCIA POR TEMA");
  });

  it("TRIAGE_AGENT_INSTRUCTIONS exportada não assume slug de exemplo nem handoff", () => {
    expect(TRIAGE_AGENT_INSTRUCTIONS).not.toContain("transfer_to_trabalhista");
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain("não há");
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain("triagens especialistas por área ativas");
  });
});

describe("TRIAGE_AGENT_SIMPLE_INSTRUCTIONS — modo simples (sem handoffs)", () => {
  it("buildTriageAgentInstructions aponta para a constante correta", () => {
    expect(buildTriageAgentInstructions(false)).toBe(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS);
    expect(buildTriageAgentInstructions(true)).toBe(TRIAGE_AGENT_INSTRUCTIONS);
  });

  it("não inclui bloco de orquestração para especialista nem checklist de handoff", () => {
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).not.toContain(
      "REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA",
    );
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).not.toContain(
      "Se havia especialista aplicável, fiz handoff sem texto antes?",
    );
  });

  it("define condução única no agente e proíbe transferência interna", () => {
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain("Sua função nesta configuração:");
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain("é proibido");
  });
});

const noChatbotAiConfig = async () => null;

describe("buildTriageAgent", () => {
  it("prepara as instruções com RECOMMENDED_PROMPT_PREFIX e modo simples sem especialistas", async () => {
    const agent = buildTriageAgent({
      env,
      context,
      activeTriageSpecialists: [],
      fetchChatbotAiConfig: noChatbotAiConfig,
    });

    expect(typeof agent.instructions).toBe("function");
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(text).toContain("## Contexto temporal (âncora do atendimento)");
    expect(text).toContain(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS);
    expect(text).toContain("## Personalização (tom de voz e vocabulário)");
    expect(text).toContain("### ESTILO E FLUXO");
    expect(agent.handoffs.length).toBe(0);
    expect(agent.tools.length).toBe(1);
  });

  it("modo sem handoffs usa TRIAGE_AGENT_SIMPLE_INSTRUCTIONS", async () => {
    const agent = buildTriageAgent({
      env,
      context,
      specialistHandoffs: false,
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS);
    expect(text).not.toContain("REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA");
    expect(agent.handoffs.length).toBe(0);
  });

  it("sem handoffs permanece em TRIAGE_AGENT_SIMPLE mesmo com especialistas na lista (ex.: não cliente + triage_enabled=false no runAgents)", async () => {
    const agent = buildTriageAgent({
      env,
      context,
      specialistHandoffs: false,
      activeTriageSpecialists: [
        { areaSlug: "trabalhista", agentName: "trabalhista" },
        { areaSlug: "criminal", agentName: "criminal" },
      ],
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS);
    expect(text).not.toContain("REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA");
    expect(agent.handoffs.length).toBe(0);
  });

  it("com vários especialistas ativos, registra um handoff por área", () => {
    const multi: ActiveTriageSpecialistRow[] = [
      { areaSlug: "trabalhista", agentName: "trabalhista" },
      { areaSlug: "criminal", agentName: "criminal" },
    ];
    const agent = buildTriageAgent({
      env,
      context,
      specialistHandoffs: true,
      activeTriageSpecialists: multi,
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    expect(agent.handoffs.length).toBe(2);
  });

  it("anexa tom empático quando fetch de chatbot_ai_config retorna tom_voz empatico", async () => {
    const agent = buildTriageAgent({
      env,
      context,
      fetchChatbotAiConfig: async () => ({
        tom_voz: "empatico",
        vocabulario: "leigo",
        tipo_atualizacao: "publicacao",
        palavras_chave_filtro: [],
      }),
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("Acolhedor, empático e compreensivo");
  });
});

describe("triage especialista (base compartilhada por área)", () => {
  it("mantém o bloco PERGUNTAS-REFERÊNCIA quando configurado (ex.: vindo do banco)", () => {
    expect(TRIAGE_SPECIALIST_INSTRUCTIONS_NO_DB).toContain(
      "PERGUNTAS-REFERÊNCIA POR TEMA",
    );
    const comPerguntas = buildTriageSpecialistInstructionsWithExtras(
      "O escritório atende apenas Direito do Trabalho.",
      null,
    );
    expect(comPerguntas).toContain("O escritório atende apenas Direito do Trabalho.");
  });

  it("insere Instruções extras antes da regra de continuidade quando há texto", () => {
    const withExtras = buildTriageSpecialistInstructionsWithExtras(
      null,
      "sempre peça pro cliente seu nome completo",
    );
    expect(withExtras).toContain("## Instruções extras (definidas pelo escritório)");
    expect(withExtras).toContain("sempre peça pro cliente seu nome completo");
    const regraIdx = withExtras.indexOf("REGRA CRÍTICA: ENTRADA VIA HANDOFF (CONTINUIDADE)");
    const extrasIdx = withExtras.indexOf("## Instruções extras");
    expect(regraIdx).toBeGreaterThan(extrasIdx);
  });

  it("formata JSONB de instruções como lista numerada por ordem de data", () => {
    const formatted = formatTriageSpecialistInstrucoesForPrompt([
      { data: "2026-04-29T15:13:59.007Z", texto: "Incluir o link ao perguntar o endereço." },
      { data: "2026-04-29T14:39:07.220Z", texto: "Perguntar sempre o nome completo do cliente." },
      { data: "2026-04-29T14:39:07.220Z", texto: "Perguntar sempre o endereço do cliente." },
    ]);
    expect(formatted).toBe(
      [
        "1 - Perguntar sempre o nome completo do cliente.",
        "2 - Perguntar sempre o endereço do cliente.",
        "3 - Incluir o link ao perguntar o endereço.",
      ].join("\n"),
    );
    const withExtras = buildTriageSpecialistInstructionsWithExtras(null, formatted);
    expect(withExtras).toContain("1 - Perguntar sempre o nome completo do cliente.");
    expect(withExtras).toContain("3 - Incluir o link ao perguntar o endereço.");
  });

  it("formatConhecimentoForPrompt ignora vazio e não-string", () => {
    expect(formatConhecimentoForPrompt(null)).toBeNull();
    expect(formatConhecimentoForPrompt("   ")).toBeNull();
    expect(formatConhecimentoForPrompt("  tema X  ")).toBe("tema X");
  });

  it("aceita string JSON com array (como serializado) e texto legado sem JSON", () => {
    const json = JSON.stringify([{ data: "2026-01-01T00:00:00.000Z", texto: "Só uma regra." }]);
    expect(formatTriageSpecialistInstrucoesForPrompt(json)).toBe("1 - Só uma regra.");
    expect(formatTriageSpecialistInstrucoesForPrompt("  texto puro antigo  ")).toBe("texto puro antigo");
  });

  it("constrói agente com prefixo recomendado e tool MCP", async () => {
    const agent = buildTriageSpecialistAgent({
      areaSlug: "trabalhista",
      env,
      context,
      fetchTriageSpecialistPromptContent: async () => ({
        conhecimento: null,
        instrucoesFormatadas: null,
      }),
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    expect(typeof agent.instructions).toBe("function");
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(text).toContain(TRIAGE_SPECIALIST_INSTRUCTIONS_NO_DB);
    expect(agent.tools.length).toBe(1);
  });

  it("hidrata PERGUNTAS-REFERÊNCIA a partir de conhecimento no fetch", async () => {
    const agent = buildTriageSpecialistAgent({
      areaSlug: "trabalhista",
      env,
      context,
      fetchTriageSpecialistPromptContent: async () => ({
        conhecimento: "  peça CPF  ",
        instrucoesFormatadas: null,
      }),
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("PERGUNTAS-REFERÊNCIA POR TEMA");
    expect(text).toContain("peça CPF");
  });

  it("hidrata Instruções extras a partir de instrucoes formatadas no fetch", async () => {
    const agent = buildTriageSpecialistAgent({
      areaSlug: "trabalhista",
      env,
      context,
      fetchTriageSpecialistPromptContent: async () => ({
        conhecimento: null,
        instrucoesFormatadas: "1 - Confirmar disponibilidade de agenda.",
      }),
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("## Instruções extras (definidas pelo escritório)");
    expect(text).toContain("1 - Confirmar disponibilidade de agenda.");
  });

  it("anexa bloco de personalização tom/vocabulário ao final", async () => {
    const agent = buildTriageSpecialistAgent({
      areaSlug: "trabalhista",
      env,
      context,
      fetchTriageSpecialistPromptContent: async () => ({
        conhecimento: null,
        instrucoesFormatadas: null,
      }),
      fetchChatbotAiConfig: noChatbotAiConfig,
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("## Personalização (tom de voz e vocabulário)");
    expect(text).toContain("### NÍVEL DE LINGUAGEM");
  });
});
