export { runAgents } from "./runtime/run-agents.js";
export type { RunAgentsOptions } from "./runtime/run-agents.js";

export {
  AgentIdSchema,
  AgentInputItemSchema,
  RunInputSchema,
  type AgentId,
  type AgentInputItem,
  type AgentRunContext,
  type RunInput,
  type RunOutput,
  type RunUsage,
} from "./types.js";

export { loadEnv, type EnvConfig } from "./config/env.js";

export {
  buildLegisMcpHeaders,
  buildLegisMcpTool,
  LEGIS_MCP_SERVER_DESCRIPTION,
  LEGIS_MCP_SERVER_LABEL,
  type BuildLegisMcpToolParams,
} from "./mcp/legis-mcp.js";

export { buildOrchestratorAgent } from "./agents/orchestrator.agent.js";
export { buildTriageAgent } from "./agents/triage.agent.js";
export { buildProcessInfoAgent } from "./agents/process-info.agent.js";

export { buildApp, type BuildAppParams } from "./http/app.js";
export {
  AuthConfigError,
  UnauthorizedError,
  extractBearerToken,
  verifySupabaseKey,
  type AuthResult,
  type SupabaseAuthRole,
  type VerifySupabaseKeyParams,
} from "./http/auth.js";
