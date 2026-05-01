import { describe, expect, it } from "vitest";
import {
  collectDiagnosticText,
  flattenErrorCauses,
  inferLikelyUpstreams,
  integrationHintForPath,
  resolvePathForIntegrationHints,
} from "../src/http/internalErrorLog.js";

describe("inferLikelyUpstreams", () => {
  it("detects Evolution failures", () => {
    expect(
      inferLikelyUpstreams("Evolution API returned 503: timeout"),
    ).toContain("evolution_api");
  });

  it("detects OpenAI stack frames", () => {
    const text = "Error at foo\n    at bar (/node_modules/@openai/agents-core/dist/run.mjs:1:1)";
    expect(inferLikelyUpstreams(text)).toContain("openai_agents_sdk");
  });

  it("detects Cloudflare / cloudflared tunnel errors", () => {
    const text =
      "502 Bad Gateway\nUnable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared\n";
    expect(inferLikelyUpstreams(text)).toContain("cloudflare_tunnel_or_edge");
  });

  it("detects Supabase client in stack", () => {
    const text = "fetch failed\n    at /app/node_modules/@supabase/supabase-js/dist/module/lib/fetch.js:40";
    expect(inferLikelyUpstreams(text)).toContain("supabase_client");
  });
});

describe("integrationHintForPath", () => {
  it("returns hints for known routes", () => {
    expect(integrationHintForPath("/run")).toContain("/run");
    expect(integrationHintForPath("/generate-ai-response")).toContain(
      "generate-ai-response",
    );
  });
});

describe("resolvePathForIntegrationHints", () => {
  it("prefers originalUrl so route mounts do not collapse to '/'", () => {
    const key = resolvePathForIntegrationHints({
      originalUrl: "/generate-ai-response",
      baseUrl: "",
      path: "/",
    });
    expect(integrationHintForPath(key)).toContain("Supabase");
  });
});

describe("flattenErrorCauses", () => {
  it("collects nested causes without duplicating root", () => {
    const inner = new Error("inner");
    const root = new Error("root");
    root.cause = inner;
    const slices = flattenErrorCauses(root);
    expect(slices.map((s) => s.message)).toEqual(["inner"]);
  });
});

describe("collectDiagnosticText", () => {
  it("includes root stack and nested cause messages", () => {
    const inner = new Error("inner fail");
    const root = new Error("root fail");
    root.cause = inner;
    const blob = collectDiagnosticText(root);
    expect(blob).toContain("root fail");
    expect(blob).toContain("inner fail");
  });
});
