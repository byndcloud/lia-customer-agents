import { describe, expect, it } from "vitest";
import {
  buildLegisMcpHeaders,
  buildLegisMcpTool,
  LEGIS_MCP_SERVER_LABEL,
} from "../src/mcp/legis-mcp.js";
import type { EnvConfig } from "../src/config/env.js";
import type { AgentRunContext } from "../src/types.js";

const baseContext: AgentRunContext = {
  conversationId: "conv-1",
  organizationId: "org-1",
  clientId: "cli-1",
  calendarConnectionId: undefined,
  extra: undefined,
  continuesOpenAiAgentChain: false,
};

const envWithoutAuth: EnvConfig = {
  aiModel: "gpt-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: undefined,
};

const envWithAuth: EnvConfig = {
  ...envWithoutAuth,
  mcpServerApiKey: "secret-key",
};

describe("buildLegisMcpHeaders", () => {
  it("includes conversation/org/client headers and omits optional ones", () => {
    const headers = buildLegisMcpHeaders({
      env: envWithoutAuth,
      context: baseContext,
    });
    expect(headers).toEqual({
      "X-Conversation-Id": "conv-1",
      "X-Organization-Id": "org-1",
      "X-Client-Id": "cli-1",
    });
  });

  it("omits X-Client-Id when clientId is undefined", () => {
    const headers = buildLegisMcpHeaders({
      env: envWithoutAuth,
      context: { ...baseContext, clientId: undefined },
    });
    expect(headers["X-Client-Id"]).toBeUndefined();
    expect(headers["X-Conversation-Id"]).toBe("conv-1");
    expect(headers["X-Organization-Id"]).toBe("org-1");
  });

  it("adds X-Calendar-Connection-Id when available", () => {
    const headers = buildLegisMcpHeaders({
      env: envWithoutAuth,
      context: { ...baseContext, calendarConnectionId: "cal-1" },
    });
    expect(headers["X-Calendar-Connection-Id"]).toBe("cal-1");
  });

  it("adds Authorization only when MCP_SERVER_API_KEY is set", () => {
    const without = buildLegisMcpHeaders({
      env: envWithoutAuth,
      context: baseContext,
    });
    expect(without.Authorization).toBeUndefined();

    const withAuth = buildLegisMcpHeaders({
      env: envWithAuth,
      context: baseContext,
    });
    expect(withAuth.Authorization).toBe("Bearer secret-key");
  });
});

describe("buildLegisMcpTool", () => {
  it("throws when MCP_SERVER_URL is missing", () => {
    expect(() =>
      buildLegisMcpTool({
        env: { ...envWithoutAuth, mcpServerUrl: undefined },
        context: baseContext,
      }),
    ).toThrow(/MCP_SERVER_URL/);
  });

  it("creates a hosted MCP tool with legis-mcp label", () => {
    const tool = buildLegisMcpTool({
      env: envWithAuth,
      context: baseContext,
    });
    expect(tool.name).toBe("hosted_mcp");
    expect(tool.providerData).toBeTruthy();
    const providerData = tool.providerData as Record<string, unknown>;
    expect(providerData.server_label).toBe(LEGIS_MCP_SERVER_LABEL);
    expect(providerData.server_url).toBe("https://mcp.example.com");
    expect(providerData.headers).toMatchObject({
      "X-Conversation-Id": "conv-1",
      Authorization: "Bearer secret-key",
    });
  });
});
