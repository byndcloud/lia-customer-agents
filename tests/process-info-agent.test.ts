import { RunContext } from "@openai/agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetInstructionsCacheForTests } from "../src/agents/instructions/process-info.instructionsCache.js";
import { buildProcessInfoAgent } from "../src/agents/process-info.agent.js";
import type { EnvConfig } from "../src/config/env.js";
import type { ChatbotAiConfig } from "../src/db/chatbotAiConfig.js";
import type { AgentRunContext } from "../src/types.js";

beforeEach(() => {
  __resetInstructionsCacheForTests();
});

const env = {
  aiModel: "gpt-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "secret",
} as unknown as EnvConfig;

const baseContext: AgentRunContext = {
  conversationId: "conv-1",
  organizationId: "org-1",
  clientId: "cli-1",
  calendarConnectionId: undefined,
  extra: undefined,
  continuesOpenAiAgentChain: false,
};

const fullConfig: ChatbotAiConfig = {
  tom_voz: "empatico",
  vocabulario: "intermediario",
  tipo_atualizacao: "todas",
  palavras_chave_filtro: ["sigilo", "menor"],
};

describe("buildProcessInfoAgent — instructions dinâmicas", () => {
  it("chama o resolver com a organizationId do contexto e devolve instruções compostas", async () => {
    const fetcher = vi.fn(async () => fullConfig);

    const agent = buildProcessInfoAgent({
      env,
      context: baseContext,
      fetchChatbotAiConfig: fetcher,
    });

    const runContext = new RunContext<AgentRunContext>(baseContext);

    const instructions = await (
      agent.instructions as (
        ctx: RunContext<AgentRunContext>,
        agent: unknown,
      ) => Promise<string>
    )(runContext, agent);

    expect(fetcher).toHaveBeenCalledWith("org-1", env);
    expect(instructions).toContain("Acolhedor, empático");
    expect(instructions).toContain("Você pode usar termos técnicos");
    expect(instructions).toContain("TODAS as movimentações");
    expect(instructions).toContain("(sigilo, menor)");
    expect(instructions).not.toContain(
      "### REGRA ESPECIAL: Transbordo com Opção de Agendamento",
    );
  });

  it("anexa transbordo quando há calendarConnectionId no contexto", async () => {
    const fetcher = vi.fn(async () => null);
    const ctx: AgentRunContext = {
      ...baseContext,
      calendarConnectionId: "cal-1",
    };

    const agent = buildProcessInfoAgent({
      env,
      context: ctx,
      fetchChatbotAiConfig: fetcher,
    });

    const instructions = await (
      agent.instructions as (
        ctx: RunContext<AgentRunContext>,
        agent: unknown,
      ) => Promise<string>
    )(new RunContext<AgentRunContext>(ctx), agent);

    expect(instructions).toContain(
      "### REGRA ESPECIAL: Transbordo com Opção de Agendamento",
    );
  });

  it("usa defaults quando o resolver devolve null", async () => {
    const fetcher = vi.fn(async () => null);

    const agent = buildProcessInfoAgent({
      env,
      context: baseContext,
      fetchChatbotAiConfig: fetcher,
    });

    const instructions = await (
      agent.instructions as (
        ctx: RunContext<AgentRunContext>,
        agent: unknown,
      ) => Promise<string>
    )(new RunContext<AgentRunContext>(baseContext), agent);

    expect(fetcher).toHaveBeenCalledWith("org-1", env);
    expect(instructions).toContain(
      "Informe apenas sobre publicações oficiais no Diário de Justiça",
    );
    expect(instructions).not.toContain("Acolhedor, empático");
  });

  it("não chama o resolver quando organizationId está ausente", async () => {
    const fetcher = vi.fn(async () => fullConfig);
    const ctx = {
      ...baseContext,
      organizationId: "" as unknown as string,
    };

    const agent = buildProcessInfoAgent({
      env,
      context: ctx,
      fetchChatbotAiConfig: fetcher,
    });

    const instructions = await (
      agent.instructions as (
        ctx: RunContext<AgentRunContext>,
        agent: unknown,
      ) => Promise<string>
    )(new RunContext<AgentRunContext>(ctx), agent);

    expect(fetcher).not.toHaveBeenCalled();
    expect(instructions).toContain(
      "Informe apenas sobre publicações oficiais no Diário de Justiça",
    );
  });
});
