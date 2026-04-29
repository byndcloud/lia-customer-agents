import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { describe, expect, it } from "vitest";
import { buildTriageAgent } from "../src/agents/triage.agent.js";
import { buildTriageTrabalhistaAgent } from "../src/agents/triage-trabalhista.agent.js";
import {
  TRIAGE_AGENT_INSTRUCTIONS,
  TRIAGE_AGENT_SIMPLE_INSTRUCTIONS,
  buildTriageAgentInstructions,
} from "../src/agents/instructions/triage.instructions.js";
import {
  TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS,
  buildTriageTrabalhistaInstructionsWithExtras,
  formatTriageSpecialistInstrucoesForPrompt,
} from "../src/agents/instructions/triage-trabalhista.instructions.js";
import type { EnvConfig } from "../src/config/env.js";
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

describe("TRIAGE_AGENT_INSTRUCTIONS — modo especialista (com handoffs)", () => {
  it("posiciona orquestração para especialista antes das regras centrais", () => {
    const orchIdx = TRIAGE_AGENT_INSTRUCTIONS.indexOf(
      "REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA",
    );
    const centralRulesIdx = TRIAGE_AGENT_INSTRUCTIONS.indexOf("REGRAS CENTRAIS");

    expect(orchIdx).toBeGreaterThan(0);
    expect(centralRulesIdx).toBeGreaterThan(orchIdx);
  });

  it("lista aberturas proibidas explícitas no modo simples (texto completo)", () => {
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Sou a Lia"');
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Em que posso te ajudar?"');
    expect(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS).toContain('"Olá!"');
  });

  it("orquestra handoff para especialista trabalhista e remove checklist detalhista", () => {
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain("transfer_to_triage_trabalhista");
    expect(TRIAGE_AGENT_INSTRUCTIONS).not.toContain("PERGUNTAS-REFERÊNCIA POR TEMA");
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

describe("buildTriageAgent", () => {
  it("prepara as instruções com RECOMMENDED_PROMPT_PREFIX e mantém o corpo da triagem", () => {
    const agent = buildTriageAgent({ env, context });

    expect(typeof agent.instructions).toBe("string");
    const text = agent.instructions as string;
    expect(text.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(text).toContain("## Contexto temporal (âncora do atendimento)");
    expect(text).toContain(TRIAGE_AGENT_INSTRUCTIONS);
    expect(agent.handoffs.length).toBe(1);
    expect(agent.tools.length).toBe(1);
  });

  it("modo sem handoffs usa TRIAGE_AGENT_SIMPLE_INSTRUCTIONS", () => {
    const agent = buildTriageAgent({
      env,
      context,
      specialistHandoffs: false,
    });
    const text = agent.instructions as string;
    expect(text).toContain(TRIAGE_AGENT_SIMPLE_INSTRUCTIONS);
    expect(text).not.toContain("REGRA CRÍTICA: ORQUESTRAÇÃO PARA ESPECIALISTA");
    expect(agent.handoffs.length).toBe(0);
  });
});

describe("triage trabalhista especialista", () => {
  it("mantém o escopo trabalhista detalhado", () => {
    expect(TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS).toContain(
      "PERGUNTAS-REFERÊNCIA POR TEMA",
    );
    expect(TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS).toContain(
      "O escritório atende apenas Direito do Trabalho.",
    );
  });

  it("insere Instruções extras antes da regra de continuidade quando há texto", () => {
    const withExtras = buildTriageTrabalhistaInstructionsWithExtras(
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
    const withExtras = buildTriageTrabalhistaInstructionsWithExtras(formatted);
    expect(withExtras).toContain("1 - Perguntar sempre o nome completo do cliente.");
    expect(withExtras).toContain("3 - Incluir o link ao perguntar o endereço.");
  });

  it("aceita string JSON com array (como serializado) e texto legado sem JSON", () => {
    const json = JSON.stringify([{ data: "2026-01-01T00:00:00.000Z", texto: "Só uma regra." }]);
    expect(formatTriageSpecialistInstrucoesForPrompt(json)).toBe("1 - Só uma regra.");
    expect(formatTriageSpecialistInstrucoesForPrompt("  texto puro antigo  ")).toBe("texto puro antigo");
  });

  it("constrói agente com prefixo recomendado e tool MCP", async () => {
    const agent = buildTriageTrabalhistaAgent({
      env,
      context,
      fetchTriageSpecialistInstrucoes: async () => null,
    });
    expect(typeof agent.instructions).toBe("function");
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(text).toContain(TRIAGE_TRABALHISTA_AGENT_INSTRUCTIONS);
    expect(agent.tools.length).toBe(1);
  });

  it("hidrata Instruções extras quando o fetch retorna texto", async () => {
    const agent = buildTriageTrabalhistaAgent({
      env,
      context,
      fetchTriageSpecialistInstrucoes: async () => "  peça CPF  ",
    });
    const text = await (agent.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("## Instruções extras (definidas pelo escritório)");
    expect(text).toContain("peça CPF");
  });
});
