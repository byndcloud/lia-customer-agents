import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { describe, expect, it } from "vitest";
import { buildTriageAgent } from "../src/agents/triage.agent.js";
import { TRIAGE_AGENT_INSTRUCTIONS } from "../src/agents/instructions/triage.instructions.js";
import type { EnvConfig } from "../src/config/env.js";

const env: EnvConfig = {
  aiModel: "gpt-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "secret",
};

describe("TRIAGE_AGENT_INSTRUCTIONS — pós-handoff", () => {
  it("posiciona a regra de continuidade no topo, antes das demais regras", () => {
    const continuityIdx = TRIAGE_AGENT_INSTRUCTIONS.indexOf(
      "ENTRADA VIA HANDOFF (CONTINUIDADE)",
    );
    const centralRulesIdx = TRIAGE_AGENT_INSTRUCTIONS.indexOf("REGRAS CENTRAIS");

    expect(continuityIdx).toBeGreaterThan(0);
    expect(centralRulesIdx).toBeGreaterThan(continuityIdx);
  });

  it("lista aberturas proibidas explícitas", () => {
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain('"Sou a Lia"');
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain('"Em que posso te ajudar?"');
    expect(TRIAGE_AGENT_INSTRUCTIONS).toContain('"Olá!"');
  });
});

describe("buildTriageAgent", () => {
  it("prepara as instruções com RECOMMENDED_PROMPT_PREFIX e mantém o corpo da triagem", () => {
    const agent = buildTriageAgent({ env });

    expect(typeof agent.instructions).toBe("string");
    const text = agent.instructions as string;
    expect(text.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
    expect(text).toContain("## Contexto temporal (âncora do atendimento)");
    expect(text).toContain(TRIAGE_AGENT_INSTRUCTIONS);
  });
});
