import { inspect } from "node:util";
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from "@openai/agents-core";
import { Runner, type AgentInputItem } from "@openai/agents";
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

const AGENT_RUN_PIPELINE_LOG_MAX = 48;

/** Subconjunto do `RunResult` usado só para logging (evita genéricos do SDK). */
interface AgentRunLogSnapshot {
  readonly finalOutput: unknown;
  readonly lastAgent?: { readonly name: string } | undefined;
  readonly lastResponseId: string | undefined;
  readonly newItems: ReadonlyArray<unknown>;
  readonly rawResponses: ReadonlyArray<unknown>;
  readonly interruptions: ReadonlyArray<unknown>;
}

/**
 * Resume o `RunResult` do SDK em JSON enxuto: pipeline de itens (por agente),
 * handoffs, tools e aviso explícito de `output_text` vazio — sem dump do
 * objeto inteiro.
 */
function logAgentRunSummary(
  conversationId: string,
  result: AgentRunLogSnapshot,
): void {
  const finalRaw = result.finalOutput;
  const finalStr =
    typeof finalRaw === "string" ? finalRaw : String(finalRaw ?? "");

  const items = result.newItems;
  const truncated = items.length > AGENT_RUN_PIPELINE_LOG_MAX;
  const slice = truncated
    ? items.slice(0, AGENT_RUN_PIPELINE_LOG_MAX)
    : items;

  const pipeline = slice.map((item, index) =>
    summarizeRunItemForLog(item, index),
  );

  console.log(
    JSON.stringify({
      level: "info",
      event: "agent_run_summary",
      conversationId,
      lastAgent: result.lastAgent?.name ?? null,
      lastResponseIdPresent: Boolean(result.lastResponseId),
      finalOutputChars: finalStr.length,
      finalOutputTrimmedEmpty: finalStr.trim().length === 0,
      newItemsCount: items.length,
      pipelineTruncated: truncated,
      pipeline,
      rawResponsesCount: result.rawResponses.length,
      interruptionCount: result.interruptions.length,
    }),
  );

  for (const step of pipeline) {
    if (
      step.kind === "message_output" &&
      step.outputTextTrimmedEmpty === true
    ) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "agent_run_empty_assistant_message",
          conversationId,
          agent: step.agent,
          messageStatus: step.messageStatus,
          contentTypes: step.contentTypes,
          hint: "Mensagem assistant com output_text vazio; comum no orquestrador ao só handoff, ou bug/limitação do modelo.",
        }),
      );
    }
  }
}

function summarizeRunItemForLog(
  item: unknown,
  index: number,
): Record<string, unknown> {
  if (item instanceof RunMessageOutputItem) {
    const raw = item.rawItem as {
      status?: string;
      content?: Array<{
        type: string;
        text?: string;
        refusal?: string;
      }>;
    };
    const content = Array.isArray(raw.content) ? raw.content : [];
    const outputBlocks = content.filter((c) => c.type === "output_text");
    const combinedText = outputBlocks
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
    return {
      index,
      kind: "message_output",
      agent: item.agent.name,
      messageStatus: raw.status ?? null,
      contentTypes: content.map((c) => c.type),
      outputTextBlockCount: outputBlocks.length,
      outputTextTotalChars: combinedText.length,
      outputTextTrimmedEmpty: combinedText.trim().length === 0,
    };
  }

  if (item instanceof RunHandoffCallItem) {
    const raw = item.rawItem as {
      name?: string;
      arguments?: string;
      type?: string;
    };
    const args = raw.arguments;
    return {
      index,
      kind: "handoff_call",
      agent: item.agent.name,
      callName: raw.name ?? raw.type ?? null,
      argumentsChars: typeof args === "string" ? args.length : 0,
      argumentsPreview:
        typeof args === "string" ? args.slice(0, 160) : null,
    };
  }

  if (item instanceof RunHandoffOutputItem) {
    return {
      index,
      kind: "handoff_output",
      fromAgent: item.sourceAgent.name,
      toAgent: item.targetAgent.name,
    };
  }

  if (item instanceof RunToolCallItem) {
    const raw = item.rawItem as { type?: string; name?: string };
    return {
      index,
      kind: "tool_call",
      agent: item.agent.name,
      toolName: raw.name ?? raw.type ?? "unknown",
    };
  }

  if (item instanceof RunToolCallOutputItem) {
    const raw = item.rawItem as { type?: string; name?: string };
    return {
      index,
      kind: "tool_call_output",
      toolName: raw.name ?? raw.type ?? null,
    };
  }

  if (item instanceof RunReasoningItem) {
    return {
      index,
      kind: "reasoning_item",
      agent: item.agent.name,
    };
  }

  const kind =
    item !== null &&
    typeof item === "object" &&
    "type" in item &&
    typeof (item as { type: unknown }).type === "string"
      ? (item as { type: string }).type
      : "unknown";
  return { index, kind };
}

/**
 * Ponto de entrada da biblioteca. Executa o **orquestrador** (LLM) que decide
 * o handoff para triagem ou consulta processual, com sinais objetivos no
 * contexto (`clientId`, `continuesOpenAiAgentChain`).
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
    continuesOpenAiAgentChain: Boolean(input.previousResponseId),
  };

  const orchestrator = buildOrchestratorAgent({ env, context });

  // O SDK aceita `string | AgentInputItem[]`. Quando o chamador (rota
  // `generate-ai-response`) já agregou múltiplas mensagens, repassamos como
  // array para preservar a separação semântica de cada mensagem do batch.
  const runInput: string | AgentInputItem[] = input.inputs
    ? (input.inputs as unknown as AgentInputItem[])
    : (input.userMessage as string);

  const runner = new Runner();
  const logBase = `[agents] conversa=${input.conversationId} org=${input.organizationId} clientIdVinculado=${input.clientId ? "sim" : "não"}`;

  console.log(
    JSON.stringify({
      level: "info",
      event: "agent_run_orchestrator",
      conversationId: input.conversationId,
      hasClientId: Boolean(input.clientId),
      continuesOpenAiAgentChain: context.continuesOpenAiAgentChain,
    }),
  );

  runner.on("agent_start", (_runCtx, agent) => {
    console.log(`${logBase} → agent_start: ${agent.name}`);
  });

  runner.on("agent_handoff", (_runCtx, fromAgent, toAgent) => {
    console.log(
      `${logBase} → handoff: ${fromAgent.name} → ${toAgent.name}`,
    );
  });

  runner.on("agent_end", (_runCtx, agent, output) => {
    const size =
      typeof output === "string"
        ? `${output.length} caracteres`
        : `não-string (${inspect(output, { depth: 3, maxStringLength: 500 })})`;
    console.log(`${logBase} → agent_end: ${agent.name} (resposta ${size})`);
  });

  const result = await runner.run(orchestrator, runInput, {
    context,
    ...(input.previousResponseId
      ? { previousResponseId: input.previousResponseId }
      : {}),
  });

  logAgentRunSummary(input.conversationId, result);

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
 * Quando o nome não bate com um agente conhecido, assume-se `triage`.
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
