import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app.js";
import type { EnvConfig } from "../src/config/env.js";
import type { RunInput, RunOutput } from "../src/types.js";

const API_SECRET = "shared-secret-token-cccccccccccccccccccccccccccccccc";

const env: EnvConfig = {
  aiModel: "gpt-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "mcp-key",
  supabaseUrl: "https://proj.supabase.co",
  supabaseAnonKey: "anon-key-test-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  supabaseServiceRoleKey:
    "service-role-key-test-value-bbbbbbbbbbbbbbbbbbb",
  apiSecretToken: API_SECRET,
  port: 0,
};

const validBody: RunInput = {
  userMessage: "Oi, tudo bem?",
  conversationId: "conv-1",
  organizationId: "org-1",
  clientId: "cli-1",
};

function authHeaders() {
  return { Authorization: `Bearer ${API_SECRET}` };
}

function buildFakeRunAgents(output?: Partial<RunOutput>) {
  const defaultOutput: RunOutput = {
    output: "Olá! Sou a Lia.",
    agentUsed: "triage",
    responseId: "resp_test_1",
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    },
  };
  return vi.fn(async () => ({ ...defaultOutput, ...output }));
}

describe("Authorization: Bearer + API_SECRET_TOKEN", () => {
  it("returns 401 when Authorization is missing on /run", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app).post("/run").send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 401 when Bearer token does not match API_SECRET_TOKEN", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app)
      .post("/run")
      .set("Authorization", "Bearer wrong-token")
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it("returns 401 on /health when Authorization is missing", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(401);
  });

  it("returns 500 when API_SECRET_TOKEN is not configured", async () => {
    const app = buildApp({
      env: { ...env, apiSecretToken: undefined },
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app)
      .get("/health")
      .set(authHeaders());

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("server_misconfigured");
  });
});

describe("POST /run", () => {
  it("returns 200 when Bearer matches API_SECRET_TOKEN and body is valid", async () => {
    const runAgentsImpl = buildFakeRunAgents();
    const app = buildApp({ env, runAgentsImpl: runAgentsImpl as never });

    const res = await request(app)
      .post("/run")
      .set(authHeaders())
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.output).toBe("Olá! Sou a Lia.");
    expect(res.body.agentUsed).toBe("triage");
    expect(res.body.responseId).toBe("resp_test_1");
    expect(runAgentsImpl).toHaveBeenCalledTimes(1);
    expect(runAgentsImpl).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" }),
      expect.objectContaining({ env }),
    );
  });

  it("returns 400 when body fails Zod validation", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app)
      .post("/run")
      .set(authHeaders())
      .send({ ...validBody, userMessage: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("GET /health", () => {
  it("returns 200 when Bearer matches API_SECRET_TOKEN", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app).get("/health").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
