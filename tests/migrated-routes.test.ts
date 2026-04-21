import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app.js";
import type { EnvConfig } from "../src/config/env.js";

const env: EnvConfig = {
  aiModel: "gpt-test",
  openaiApiKey: "sk-test",
  mcpServerUrl: "https://mcp.example.com",
  mcpServerApiKey: "mcp-key",
  supabaseUrl: "https://proj.supabase.co",
  supabaseAnonKey: "anon-key-test",
  supabaseServiceRoleKey: "service-role-key-test",
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

const fakeRunAgents = vi.fn(async () => ({
  output: "ok",
  agentUsed: "triage" as const,
  responseId: "resp_test",
  usage: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
}));

function authHeaders() {
  return { Authorization: `Bearer ${env.supabaseServiceRoleKey}` };
}

describe("Migrated chat-messages routes — auth", () => {
  const routes: Array<{ method: "post"; path: string }> = [
    { method: "post", path: "/webhook-evolution" },
    { method: "post", path: "/generate-ai-response" },
    { method: "post", path: "/deliver-response" },
    { method: "post", path: "/followup-30min" },
    { method: "post", path: "/followup-24h" },
  ];

  for (const route of routes) {
    it(`returns 401 on ${route.method.toUpperCase()} ${route.path} without Authorization`, async () => {
      const app = buildApp({
        env,
        runAgentsImpl: fakeRunAgents as never,
      });
      const res = await request(app)[route.method](route.path).send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });
  }
});

describe("POST /webhook-evolution — payload validation", () => {
  it("returns 400 when payload is missing required structure", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: fakeRunAgents as never,
    });
    const res = await request(app)
      .post("/webhook-evolution")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid payload structure");
  });

  it("returns 200 and ignores events other than messages.upsert", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: fakeRunAgents as never,
    });
    const res = await request(app)
      .post("/webhook-evolution")
      .set(authHeaders())
      .send({
        event: "presence.update",
        instance: "irrelevant",
        data: {
          key: { remoteJid: "5511999999999@s.whatsapp.net" },
          message: { conversation: "x" },
          messageType: "conversation",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Event ignored");
  });
});

describe("POST /deliver-response — payload validation", () => {
  it("returns 400 when 'number' is missing", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: fakeRunAgents as never,
    });
    const res = await request(app)
      .post("/deliver-response")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required field: number");
  });

  it("returns 400 when 'number' is present but neither conversa_id nor organization_id is provided", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: fakeRunAgents as never,
    });
    const res = await request(app)
      .post("/deliver-response")
      .set(authHeaders())
      .send({ number: "5511999999999", text: "Olá" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("organization_id or conversa_id");
  });
});

describe("POST /generate-ai-response — payload validation", () => {
  it("returns 400 when conversaId is missing", async () => {
    const app = buildApp({
      env,
      runAgentsImpl: fakeRunAgents as never,
    });
    const res = await request(app)
      .post("/generate-ai-response")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("conversaId é obrigatório");
  });
});
