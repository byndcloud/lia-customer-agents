import { describe, expect, it } from "vitest";
import { buildAgentTemporalContextSection } from "../src/agents/agent-temporal-context.js";

describe("buildAgentTemporalContextSection", () => {
  it("formata data no fuso America/Sao_Paulo e inclui regras de relativo vs relato", () => {
    const fixed = new Date("2026-04-23T15:00:00.000Z");
    const block = buildAgentTemporalContextSection(fixed, "America/Sao_Paulo");

    expect(block).toContain("## Contexto temporal (âncora do atendimento)");
    expect(block).toContain("America/Sao_Paulo");
    expect(block).toContain("`2026-04-23`");
    expect(block).toContain("ontem");
    expect(block).toContain("janeiro de 2021");
  });
});
