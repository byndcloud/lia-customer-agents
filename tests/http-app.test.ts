import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app.js";
import type { EnvConfig } from "../src/config/env.js";
import type { RunInput, RunOutput } from "../src/types.js";

const ANON_KEY = "anon-key-test-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVICE_ROLE_KEY =
  "service-role-key-test-value-bbbbbbbbbbbbbbbbbbb";

const env: EnvConfig = {
  aiModel: "gpt-test",
  openaiApiKey: "sk-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "mcp-key",
  supabaseUrl: "https://proj.supabase.co",
  supabaseAnonKey: ANON_KEY,
  supabaseServiceRoleKey: SERVICE_ROLE_KEY,
  evolutionApiUrl: "https://evo.example.com",
  evolutionApiKey: "evo-key",
  googleServiceAccountKey: undefined,
  googleCloudTasksLocation: "us-central1",
  chatbotQueueName: "lia",
  selfPublicBaseUrl: "https://self.example.com",
  chatbotQueueDelaySeconds: 22,
  whatsappStorageBucket: "whatsapp-files",
  followup30minSeconds: 1800,
  followup24hSeconds: 86400,
  port: 0,
};

const validBody: RunInput = {
  userMessage: "Oi, tudo bem?",
  conversationId: "conv-1",
  organizationId: "org-1",
  clientId: "cli-1",
};

function authHeadersAnon() {
  return { Authorization: `Bearer ${ANON_KEY}` };
}

function authHeadersServiceRole() {
  return { Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
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

describe("Authorization: Bearer = Supabase anon ou service_role", () => {
  it("returns 401 when Authorization is missing on /run", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app).post("/run").send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 401 when Bearer token does not match any configured key", async () => {
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

  it("returns 500 when neither Supabase key is configured", async () => {
    const app = buildApp({
      env: {
        ...env,
        supabaseAnonKey: undefined,
        supabaseServiceRoleKey: undefined,
      },
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app)
      .get("/health")
      .set(authHeadersAnon());

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("server_misconfigured");
  });
});

describe("POST /run", () => {
  it("returns 200 when Bearer is anon key and body is valid", async () => {
    const runAgentsImpl = buildFakeRunAgents();
    const app = buildApp({ env, runAgentsImpl: runAgentsImpl as never });

    const res = await request(app)
      .post("/run")
      .set(authHeadersAnon())
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

  it("returns 200 when Bearer is service_role key", async () => {
    const runAgentsImpl = buildFakeRunAgents();
    const app = buildApp({ env, runAgentsImpl: runAgentsImpl as never });

    const res = await request(app)
      .post("/run")
      .set(authHeadersServiceRole())
      .send(validBody);

    expect(res.status).toBe(200);
  });

  it("returns 400 when body fails Zod validation", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app)
      .post("/run")
      .set(authHeadersAnon())
      .send({ ...validBody, userMessage: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("GET /health", () => {
  it("returns 200 when Bearer matches a configured Supabase key", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: buildFakeRunAgents() as never,
    });

    const res = await request(app).get("/health").set(authHeadersAnon());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
