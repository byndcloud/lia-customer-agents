import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from "@openai/agents-core";
import { Runner, type AgentInputItem } from "@openai/agents";
import {
  buildOrchestratorAgent,
  ORCHESTRATOR_AGENT_NAME,
} from "../agents/orchestrator.agent.js";
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
import {
  buildAgentRunRawLogRecord,
  resolveAgentRunRawLogPath,
  writeAgentRunRawLogFile,
} from "./agent-run-raw-log.js";
import {
  logAgentLine,
  logAgentTextBlock,
  warnAgentLine,
} from "./atendimento-log.js";

export interface RunAgentsOptions {
  /** Configuração de ambiente. Quando omitida, é carregada via `loadEnv()`. */
  readonly env?: EnvConfig;
}

interface PipelineCounts {
  readonly messageOutputs: number;
  readonly handoffs: number;
  readonly toolCalls: number;
  readonly reasoning: number;
}

/** Nomes técnicos dos agentes traduzidos para apelidos lidos nos logs. */
const AGENT_LABEL: Record<string, string> = {
  [ORCHESTRATOR_AGENT_NAME]: "recepção",
  [TRIAGE_AGENT_NAME]: "triagem",
  [PROCESS_INFO_AGENT_NAME]: "consulta processual",
};

function agentLabel(name: string | undefined | null): string {
  if (!name) return "desconhecido";
  return AGENT_LABEL[name] ?? name;
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * O bridge Responses (`@openai/agents-openai`) trata itens `message` com
 * `content` como **array** de partes (`getMessageItem` usa `content.map`).
 * Nosso app envia texto simples em `content` (histórico WhatsApp); convertemos
 * para o formato esperado pela API.
 *
 * - `user` / `system` / `developer`: partes `input_text`
 * - `assistant` (histórico reenviado): `output_text` (reprodução de saída do modelo)
 */
function normalizeRunInputForOpenAiResponsesModel(
  runInput: string | AgentInputItem[],
): string | AgentInputItem[] {
  if (typeof runInput === "string") {
    return runInput;
  }

  return runInput.map((item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }
    const o = item as Record<string, unknown>;
    if (Array.isArray(o.content)) {
      return item;
    }
    const role = typeof o.role === "string" ? o.role : "user";
    const rawContent = o.content;
    if (typeof rawContent !== "string" || rawContent.length === 0) {
      return item;
    }
    const partType = role === "assistant" ? "output_text" : "input_text";
    return {
      ...o,
      type: typeof o.type === "string" ? o.type : "message",
      role,
      content: [{ type: partType, text: rawContent }],
    } as AgentInputItem;
  });
}

/**
 * Gatilhos textuais que indicam "promessa sem ação" — frases em que o agente
 * anuncia que vai consultar/verificar algo em vez de chamar a tool no mesmo
 * turno. Comparação é feita em lowercase, então variações de caixa caem na
 * mesma regra.
 */
const PROMISE_TRIGGERS: ReadonlyArray<string> = [
  "vou consultar",
  "vou verificar",
  "vou buscar",
  "vou checar",
  "vou puxar",
  "vou dar uma olhada",
  "vou conferir",
  "aguarde um momento",
  "aguarde um instante",
  "aguarde, por favor",
  "já vou",
  "um instante",
  "um momento, por favor",
  "já te retorno",
  "estou checando",
  "estou verificando",
  "deixa eu dar uma olhada",
];

function findPromiseTrigger(text: string): string | undefined {
  const lower = text.toLowerCase();
  return PROMISE_TRIGGERS.find((trigger) => lower.includes(trigger));
}

/**
 * Extrai o id da function_call citado em erros da API Responses do tipo
 * "400 No tool output found for function call call_XXX".
 */
function extractMissingFunctionCallId(message: string): string | undefined {
  const m = message.match(
    /function call\s+(call_[A-Za-z0-9_-]+)/i,
  );
  return m?.[1];
}

/**
 * Resumo do que entra no `Runner` (para correlacionar com erros 400 da
 * Responses API). Não inclui texto longo de mensagens — só prefixo curto.
 */
function summarizeRunInputForDiagnostics(
  runInput: string | AgentInputItem[],
): Record<string, unknown> {
  if (typeof runInput === "string") {
    return {
      shape: "single_string",
      charLength: runInput.length,
      previewPrefix: runInput.slice(0, 120),
    };
  }

  const items = runInput.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      return { index, kind: "unknown" };
    }
    const o = item as Record<string, unknown>;
    const t = typeof o.type === "string" ? o.type : undefined;
    if (t === "function_call" || t === "function_call_result") {
      return {
        index,
        kind: t,
        name: typeof o.name === "string" ? o.name : undefined,
        callId:
          typeof o.callId === "string"
            ? `${o.callId.slice(0, 12)}…`
            : undefined,
      };
    }
    const role = typeof o.role === "string" ? o.role : undefined;
    let contentChars = 0;
    let previewPrefix: string | undefined;
    if (typeof o.content === "string") {
      contentChars = o.content.length;
      previewPrefix = o.content.slice(0, 80);
    } else if (Array.isArray(o.content)) {
      contentChars = o.content.length;
      previewPrefix = `[content parts: ${o.content.length}]`;
    }
    return { index, kind: "message", role, contentChars, previewPrefix };
  });

  return { shape: "agent_input_item[]", length: runInput.length, items };
}

/**
 * Log detalhado quando `runner.run` falha — em especial 400
 * "No tool output found for function call …" (cadeia Responses inconsistente).
 */
function logRunAgentsFailure(params: {
  readonly conversationId: string;
  readonly error: unknown;
  readonly runInput: string | AgentInputItem[];
}): void {
  const { conversationId, error, runInput } = params;
  const message = error instanceof Error ? error.message : String(error);
  const missingCallId = extractMissingFunctionCallId(message);
  const suspectedStaleToolChain =
    /no tool output found/i.test(message) ||
    /tool output.*not found/i.test(message);

  warnAgentLine(
    conversationId,
    "--- runAgents falhou (detalhe para diagnóstico / OpenAI Responses) ---",
  );
  warnAgentLine(
    conversationId,
    `Exceção: ${message.length > 600 ? `${message.slice(0, 600)}…` : message}`,
  );
  if (suspectedStaleToolChain) {
    warnAgentLine(
      conversationId,
      `Interpretação: a API esperava o output da tool para call_id=${missingCallId ?? "(não extraído do texto)"}, mas esse item não existe no estado da conversa encadeada.`,
    );
    warnAgentLine(
      conversationId,
      "Possíveis causas: turno anterior interrompido antes de concluir tools; histórico de mensagens inconsistente; ou concorrência entre dois workers no mesmo atendimento.",
    );
  }
  warnAgentLine(
    conversationId,
    `Resumo runInput (JSON): ${JSON.stringify(summarizeRunInputForDiagnostics(runInput))}`,
  );
  warnAgentLine(conversationId, "--- fim diagnóstico runAgents ---");

  console.warn(
    JSON.stringify({
      level: "warn",
      event: "run_agents_failed",
      conversationId,
      missingFunctionCallId: missingCallId ?? null,
      suspectedStaleResponsesToolChain: suspectedStaleToolChain,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: message,
      runInputSummary: summarizeRunInputForDiagnostics(runInput),
    }),
  );
}

/**
 * Percorre `newItems` do `RunResult`, avisa sobre respostas vazias de cada
 * agente e devolve contadores agregados da execução.
 */
export function summarizeAgentRunPipeline(
  conversationId: string,
  items: ReadonlyArray<unknown>,
): PipelineCounts {
  let messageOutputs = 0;
  let handoffs = 0;
  let toolCalls = 0;
  let reasoning = 0;
  const emptyAgents: string[] = [];
  /**
   * Quantas tool calls cada agente emitiu no run. Usado para detectar
   * "promessa sem ação": o agente disse "vou consultar" mas não chamou
   * nenhuma tool no mesmo run.
   */
  const toolCallsByAgent = new Map<string, number>();
  /**
   * Mensagens com gatilho de promessa que cada agente produziu. Avaliadas
   * só depois da iteração para conhecer a contagem total de tool calls
   * daquele agente no run.
   */
  const promisesByAgent = new Map<
    string,
    Array<{ readonly trigger: string; readonly text: string }>
  >();

  for (const item of items) {
    if (item instanceof RunMessageOutputItem) {
      messageOutputs += 1;
      const raw = item.rawItem as {
        status?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      const content = Array.isArray(raw.content) ? raw.content : [];
      const combinedText = content
        .filter((c) => c.type === "output_text")
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      if (combinedText.trim().length === 0) {
        emptyAgents.push(item.agent.name);
      } else {
        const trigger = findPromiseTrigger(combinedText);
        if (trigger) {
          const list = promisesByAgent.get(item.agent.name) ?? [];
          list.push({ trigger, text: combinedText });
          promisesByAgent.set(item.agent.name, list);
        }
      }
      continue;
    }
    if (item instanceof RunHandoffCallItem) {
      continue;
    }
    if (item instanceof RunHandoffOutputItem) {
      handoffs += 1;
      continue;
    }
    if (item instanceof RunToolCallItem) {
      toolCalls += 1;
      const name = item.agent.name;
      toolCallsByAgent.set(name, (toolCallsByAgent.get(name) ?? 0) + 1);
      continue;
    }
    if (item instanceof RunToolCallOutputItem) {
      continue;
    }
    if (item instanceof RunReasoningItem) {
      reasoning += 1;
      continue;
    }
  }

  for (const agent of emptyAgents) {
    warnAgentLine(
      conversationId,
      `Atenção: o agente de ${agentLabel(agent)} produziu uma resposta vazia.`,
    );
  }

  for (const [agentName, promises] of promisesByAgent) {
    if ((toolCallsByAgent.get(agentName) ?? 0) > 0) {
      // Houve tool call no mesmo run — a "promessa" foi cumprida ou o texto
      // veio depois do retorno da tool. Não avisamos.
      continue;
    }
    for (const { trigger } of promises) {
      warnAgentLine(
        conversationId,
        `Possível promessa sem ação detectada no agente de ${agentLabel(
          agentName,
        )} (gatilho: "${trigger}"). O agente não chamou nenhuma tool neste run.`,
      );
    }
  }

  return { messageOutputs, handoffs, toolCalls, reasoning };
}

/**
 * Ponto de entrada da biblioteca. Executa o **orquestrador** (LLM) que decide
 * o handoff para triagem ou consulta processual, com sinais objetivos no
 * contexto (`clientId`, `agenteResponsavelAtendimento`).
 *
 * Responsabilidades desta função:
 *  1. Validar o input via Zod.
 *  2. Montar `AgentRunContext` para uso em ferramentas (MCP, etc).
 *  3. Instanciar o orquestrador com handoffs para triage/process_info.
 *  4. Chamar `run()` do SDK com o histórico completo já presente em `inputs`.
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
    conversaId: input.conversaId,
    organizationId: input.organizationId,
    clientId: input.clientId,
    calendarConnectionId: input.calendarConnectionId,
    extra: input.extra,
    agenteResponsavelAtendimento: input.agenteResponsavelAtendimento,
  };

  // O SDK aceita `string | AgentInputItem[]`. Quando o chamador (rota
  // `generate-ai-response`) já agregou múltiplas mensagens, repassamos como
  // array para preservar a separação semântica de cada mensagem do batch.
  const runInputRaw: string | AgentInputItem[] = input.inputs
    ? (input.inputs as unknown as AgentInputItem[])
    : (input.userMessage as string);
  const runInput = normalizeRunInputForOpenAiResponsesModel(runInputRaw);

  const runner = new Runner();
  const conversationId = input.conversaId;
  const inputsCount = Array.isArray(input.inputs) ? input.inputs.length : 1;
  const clientNote = input.clientId
    ? "cliente já vinculado ao cadastro"
    : "cliente ainda não vinculado ao cadastro";
  const agenteNote = context.agenteResponsavelAtendimento
    ? `agente responsável no atendimento (persistido): ${context.agenteResponsavelAtendimento}`
    : "sem agente responsável persistido no contexto";

  const orchestrator = buildOrchestratorAgent({ env, context });

  console.log("");
  logAgentLine(
    conversationId,
    `Início do atendimento — começando pela ${agentLabel(orchestrator.name)} (${clientNote}; ${agenteNote}; ${pluralize(inputsCount, "mensagem recebida", "mensagens recebidas")}).`,
  );

  runner.on("agent_start", (_runCtx, agent) => {
    logAgentLine(
      conversationId,
      `Passou pelo agente de ${agentLabel(agent.name)}.`,
    );
  });

  runner.on("agent_handoff", (_runCtx, fromAgent, toAgent) => {
    logAgentLine(
      conversationId,
      `Transferência: ${agentLabel(fromAgent.name)} → ${agentLabel(toAgent.name)}.`,
    );
  });

  runner.on("agent_end", (_runCtx, agent, output) => {
    const isString = typeof output === "string";
    const chars = isString ? (output as string).length : -1;
    const empty = isString && (output as string).trim().length === 0;
    if (!isString) {
      logAgentLine(
        conversationId,
        `Agente de ${agentLabel(agent.name)} finalizou sem resposta em texto.`,
      );
      let serialized: string;
      try {
        serialized = JSON.stringify(output);
      } catch {
        serialized = String(output);
      }
      logAgentTextBlock(
        conversationId,
        `Saída estruturada (${agentLabel(agent.name)}):`,
        serialized,
      );
      return;
    }
    if (empty) {
      logAgentLine(
        conversationId,
        `Agente de ${agentLabel(agent.name)} finalizou com resposta vazia.`,
      );
      logAgentLine(conversationId, "  (texto vazio)");
      return;
    }
    const text = output as string;
    logAgentLine(
      conversationId,
      `Agente de ${agentLabel(agent.name)} gerou resposta (${pluralize(chars, "caractere", "caracteres")}).`,
    );
    logAgentTextBlock(
      conversationId,
      `Texto gerado (${agentLabel(agent.name)}):`,
      text,
    );
  });

  const runOpts = { context };

  logAgentLine(
    conversationId,
    `Chamando runner.run — histórico stateless (sem OpenAI session); resumo runInput: ${JSON.stringify(summarizeRunInputForDiagnostics(runInput))}`,
  );

  let result;
  try {
    result = await runner.run(orchestrator, runInput, runOpts);
  } catch (error) {
    logRunAgentsFailure({
      conversationId,
      error,
      runInput,
    });
    throw error;
  }

  const rawLogDir = resolveAgentRunRawLogPath();
  if (rawLogDir) {
    const rawRecord = buildAgentRunRawLogRecord({
      conversaId: input.conversaId,
      organizationId: input.organizationId,
      clientId: input.clientId,
      openaiConversationId: undefined,
      model: env.aiModel,
      result,
    });
    await writeAgentRunRawLogFile(rawLogDir, rawRecord, input.conversaId);
  }

  const counts = summarizeAgentRunPipeline(conversationId, result.newItems);
  const output =
    typeof result.finalOutput === "string"
      ? result.finalOutput
      : String(result.finalOutput ?? "");

  const lastAgentNote = agentLabel(result.lastAgent?.name);
  const finalNote = output.trim().length === 0
    ? "resposta final vazia"
    : `resposta final com ${pluralize(output.length, "caractere", "caracteres")}`;
  const stepsNote = [
    pluralize(counts.messageOutputs, "mensagem", "mensagens"),
    pluralize(counts.handoffs, "transferência", "transferências"),
    pluralize(counts.toolCalls, "ferramenta usada", "ferramentas usadas"),
    pluralize(counts.reasoning, "bloco de raciocínio", "blocos de raciocínio"),
  ].join(", ");

  logAgentLine(
    conversationId,
    `Fim do atendimento — última fala por ${lastAgentNote}; ${finalNote}. Etapas: ${stepsNote}.`,
  );
  console.log("");

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
 * Quando o nome não bate com um agente conhecido, assume-se `orchestrator`.
 */
function resolveAgentUsed(lastAgentName: string | undefined): AgentId {
  if (lastAgentName === PROCESS_INFO_AGENT_NAME) {
    return "process_info";
  }

  if (lastAgentName === TRIAGE_AGENT_NAME) {
    return "triage";
  }

  if (lastAgentName === ORCHESTRATOR_AGENT_NAME) {
    return "orchestrator";
  }

  return "orchestrator";
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
