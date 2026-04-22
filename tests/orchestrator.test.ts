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
  conversationId: "conv-1",
  organizationId: "org-1",
  clientId: "cli-1",
  calendarConnectionId: undefined,
  extra: undefined,
  continuesOpenAiAgentChain: false,
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

  it("propagates the configured model to the orchestrator agent", () => {
    const orchestrator = buildOrchestratorAgent({ env, context });
    expect(orchestrator.model).toBe("gpt-test");
  });
});

describe("buildOrchestratorInstructions", () => {
  it("injeta sinais de clientId e encadeamento OpenAI no texto", () => {
    const noClientNoChain = buildOrchestratorInstructions({
      conversationId: "c1",
      organizationId: "o1",
      clientId: undefined,
      calendarConnectionId: undefined,
      extra: undefined,
      continuesOpenAiAgentChain: false,
    });
    expect(noClientNoChain).toContain("clientId / pessoa identificada): não");
    expect(noClientNoChain).toContain("Encadeamento desta execução");
    expect(noClientNoChain).toMatch(/OpenAI[^\n]+: não/);

    const linkedWithChain = buildOrchestratorInstructions({
      conversationId: "c1",
      organizationId: "o1",
      clientId: "p1",
      calendarConnectionId: undefined,
      extra: undefined,
      continuesOpenAiAgentChain: true,
    });
    expect(linkedWithChain).toContain("clientId / pessoa identificada): sim");
    expect(linkedWithChain).toMatch(/OpenAI[^\n]+: sim/);
  });
});
