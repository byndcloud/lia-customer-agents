import { Handoff } from "@openai/agents-core";
import {
  RECOMMENDED_PROMPT_PREFIX,
  removeAllTools,
} from "@openai/agents-core/extensions";
import { describe, expect, it } from "vitest";
import {
  buildOrchestratorAgent,
  buildOrchestratorInstructions,
} from "../src/agents/orchestrator.agent.js";
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
  clientId: "cli-1",
  calendarConnectionId: undefined,
  extra: undefined,
  agenteResponsavelAtendimento: undefined,
};

describe("buildOrchestratorAgent", () => {
  it("wires up handoffs for triage and process_info", () => {
    const orchestrator = buildOrchestratorAgent({ env, context });

    const handoffNames = orchestrator.handoffs
      .map((entry) => ("agent" in entry ? entry.agent.name : entry.name))
      .sort();

    expect(orchestrator.name).toBe("orchestrator");
    expect(handoffNames).toEqual(["process_info", "triage"]);
  });

  it("envolve cada handoff em `Handoff` com `removeAllTools` como inputFilter", () => {
    const orchestrator = buildOrchestratorAgent({ env, context });

    expect(orchestrator.handoffs.length).toBe(2);
    for (const entry of orchestrator.handoffs) {
      expect(entry).toBeInstanceOf(Handoff);
      const ho = entry as Handoff;
      expect(ho.inputFilter).toBe(removeAllTools);
    }
  });

  it("propagates the configured model to the orchestrator agent", () => {
    const orchestrator = buildOrchestratorAgent({ env, context });
    expect(orchestrator.model).toBe("gpt-test");
  });

  it("resolve instruções com bloco de tom/vocabulário a partir de chatbot_ai_config", async () => {
    const orchestrator = buildOrchestratorAgent({
      env,
      context,
      fetchChatbotAiConfig: async () => ({
        tom_voz: "energico",
        vocabulario: "intermediario",
        tipo_atualizacao: "publicacao",
        palavras_chave_filtro: [],
      }),
    });
    expect(typeof orchestrator.instructions).toBe("function");
    const text = await (orchestrator.instructions as (rc: {
      context: AgentRunContext;
    }) => Promise<string>)({ context });
    expect(text).toContain("## Personalização (tom de voz e vocabulário)");
    expect(text).toContain("Enérgico, confiante e proativo");
    expect(text).toContain("petição");
  });
});

describe("buildOrchestratorInstructions", () => {
  it("injeta sinais de clientId e agente responsável persistido no texto", () => {
    const noClientNoAgent = buildOrchestratorInstructions({
      conversaId: "c1",
      organizationId: "o1",
      clientId: undefined,
      calendarConnectionId: undefined,
      extra: undefined,
      agenteResponsavelAtendimento: undefined,
    });
    expect(noClientNoAgent).toContain("clientId / pessoa identificada): não");
    expect(noClientNoAgent).toContain(
      "Agente IA atualmente responsável por este atendimento",
    );
    expect(noClientNoAgent).toContain(
      "não informado — trate como recepção sem agente especialista persistido",
    );

    const linkedWithTriage = buildOrchestratorInstructions({
      conversaId: "c1",
      organizationId: "o1",
      clientId: "p1",
      calendarConnectionId: undefined,
      extra: undefined,
      agenteResponsavelAtendimento: "triage",
    });
    expect(linkedWithTriage).toContain("clientId / pessoa identificada): sim");
    expect(linkedWithTriage).toContain("`triage`");
  });

  it("começa com o RECOMMENDED_PROMPT_PREFIX da SDK", () => {
    const result = buildOrchestratorInstructions({
      conversaId: "c1",
      organizationId: "o1",
      clientId: undefined,
      calendarConnectionId: undefined,
      extra: undefined,
      agenteResponsavelAtendimento: undefined,
    });
    expect(result.startsWith(RECOMMENDED_PROMPT_PREFIX)).toBe(true);
  });

  it("deixa explícito que consulta de processo por CPF é handoff para process_info, não promessa na recepção", () => {
    const result = buildOrchestratorInstructions({
      conversaId: "c1",
      organizationId: "o1",
      clientId: "p1",
      calendarConnectionId: undefined,
      extra: undefined,
      agenteResponsavelAtendimento: undefined,
    });
    expect(result).toContain("getLatelyProcess");
    expect(result).toContain("transfer_to_process_info");
    expect(result).toContain("tribunal, vara, cidade");
  });
});
