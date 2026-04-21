import { run, type AgentInputItem } from "@openai/agents";
import { buildOrchestratorAgent } from "../agents/orchestrator.agent.js";
import { PROCESS_INFO_AGENT_NAME } from "../agents/instructions/process-info.instructions.js";
import { TRIAGE_AGENT_NAME } from "../agents/instructions/triage.instructions.js";
import { loadEnv, type EnvConfig } from "../config/env.js";
import {
  RunInputSchema,
  type AgentId,
  type AgentRunContext,
  type RunInput,
  type RunOutput,
  type RunUsage,
} from "../types.js";

export interface RunAgentsOptions {
  /** Configuração de ambiente. Quando omitida, é carregada via `loadEnv()`. */
  readonly env?: EnvConfig;
}

/**
 * Ponto de entrada da biblioteca. Executa o orquestrador com a mensagem do
 * usuário e retorna a resposta final junto com metadados mínimos.
 *
 * Responsabilidades desta função:
 *  1. Validar o input via Zod.
 *  2. Montar `AgentRunContext` para uso em ferramentas (MCP, etc).
 *  3. Instanciar o orquestrador com handoffs para triage/process_info.
 *  4. Chamar `run()` do SDK passando `previousResponseId` quando disponível.
 *  5. Normalizar a saída para o contrato `RunOutput`.
 *
 * Erros do SDK são propagados diretamente — quem chama (edge function) decide
 * o tratamento e o que persistir.
 */
export async function runAgents(
  rawInput: RunInput,
  options: RunAgentsOptions = {},
): Promise<RunOutput> {
  const input = RunInputSchema.parse(rawInput);
  const env = options.env ?? loadEnv();

  const context: AgentRunContext = {
    conversationId: input.conversationId,
    organizationId: input.organizationId,
    clientId: input.clientId,
    calendarConnectionId: input.calendarConnectionId,
    extra: input.extra,
  };

  const orchestrator = buildOrchestratorAgent({ env, context });

  // O SDK aceita `string | AgentInputItem[]`. Quando o chamador (rota
  // `generate-ai-response`) já agregou múltiplas mensagens, repassamos como
  // array para preservar a separação semântica de cada mensagem do batch.
  const runInput: string | AgentInputItem[] = input.inputs
    ? (input.inputs as unknown as AgentInputItem[])
    : (input.userMessage as string);

  const result = await run(orchestrator, runInput, {
    context,
    ...(input.previousResponseId
      ? { previousResponseId: input.previousResponseId }
      : {}),
  });

  const output =
    typeof result.finalOutput === "string"
      ? result.finalOutput
      : String(result.finalOutput ?? "");

  return {
    output,
    agentUsed: resolveAgentUsed(result.lastAgent?.name),
    responseId: result.lastResponseId,
    usage: extractUsage(result),
  };
}

/**
 * Resolve o nome do último agente para o enum público `AgentId`.
 *
 * Se o orquestrador responder sem handoff (caso extremo), consideramos como
 * `triage` — é o caminho mais seguro para um primeiro contato.
 */
function resolveAgentUsed(lastAgentName: string | undefined): AgentId {
  if (lastAgentName === PROCESS_INFO_AGENT_NAME) {
    return "process_info";
  }

  if (lastAgentName === TRIAGE_AGENT_NAME) {
    return "triage";
  }

  return "triage";
}

interface RunResultLike {
  runContext?: { usage?: Partial<RunUsage> };
}

function extractUsage(result: RunResultLike): RunUsage {
  const usage = result.runContext?.usage;
  return {
    requests: usage?.requests ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}
