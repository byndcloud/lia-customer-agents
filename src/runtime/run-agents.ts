import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from "@openai/agents-core";
import {
  OpenAIConversationsSession,
  Runner,
  type AgentInputItem,
} from "@openai/agents";
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
  readonly openAiConversationId: string | undefined;
  readonly runInput: string | AgentInputItem[];
}): void {
  const { conversationId, error, openAiConversationId, runInput } = params;
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
  if (openAiConversationId) {
    warnAgentLine(
      conversationId,
      `OpenAI conversationId (conv_...) retomado: ${openAiConversationId}`,
    );
  } else {
    warnAgentLine(
      conversationId,
      "OpenAI conversationId: (ausente — nova session sem thread prévio)",
    );
  }
  if (suspectedStaleToolChain) {
    warnAgentLine(
      conversationId,
      `Interpretação: a API esperava o output da tool para call_id=${missingCallId ?? "(não extraído do texto)"}, mas esse item não existe no estado da conversa encadeada.`,
    );
    warnAgentLine(
      conversationId,
      "Possíveis causas: turno anterior interrompido antes de concluir tools; falha ao persistir a sessão OpenAI no atendimento; conversationId apontando para thread inconsistente; ou concorrência entre dois workers no mesmo atendimento.",
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
      openAiConversationIdPresent: Boolean(openAiConversationId),
      openAiConversationId: openAiConversationId ?? null,
      missingFunctionCallId: missingCallId ?? null,
      suspectedStaleResponsesToolChain: suspectedStaleToolChain,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: message,
      runInputSummary: summarizeRunInputForDiagnostics(runInput),
    }),
  );
}

/**
 * Registra entrada do run, contexto do SDK e parâmetros de ambiente relevantes
 * para agentes/MCP (sem valor de segredos).
 */
function logRunAgentsDebug(params: {
  readonly conversationId: string;
  readonly input: RunInput;
  readonly context: AgentRunContext;
  readonly env: EnvConfig;
  readonly runInput: string | AgentInputItem[];
}): void {
  const { conversationId, input, context, env, runInput } = params;
  logAgentLine(conversationId, "--- Debug runAgents (entrada + ambiente) ---");
  logAgentLine(conversationId, `modelo (OPENAI / aiModel): ${env.aiModel}`);
  logAgentLine(
    conversationId,
    `MCP_SERVER_URL: ${env.mcpServerUrl ?? "(ausente — run vai falhar ao montar tool)"}`,
  );
  logAgentLine(
    conversationId,
    `MCP_SERVER_API_KEY: ${env.mcpServerApiKey ? "definida" : "ausente"}`,
  );
  logAgentLine(conversationId, `organizacaoId: ${input.organizationId}`);
  logAgentLine(
    conversationId,
    `clientId: ${input.clientId ?? "(ausente — sem X-Client-Id no MCP)"}`,
  );
  logAgentLine(
    conversationId,
    `calendarConnectionId: ${input.calendarConnectionId ?? "(ausente)"}`,
  );
  logAgentLine(
    conversationId,
    `openaiConversationId (conv_...): ${input.conversationId ?? "(ausente — session nova)"}`,
  );
  logAgentLine(
    conversationId,
    `context.continuesOpenAiAgentChain: ${String(context.continuesOpenAiAgentChain)}`,
  );
  logAgentLine(
    conversationId,
    `extra: ${input.extra ? JSON.stringify(input.extra) : "(nenhum)"}`,
  );

  if (typeof runInput === "string") {
    logAgentTextBlock(
      conversationId,
      "Mensagem(ns) de usuário enviada(s) ao runner (string única):",
      runInput,
    );
  } else {
    logAgentLine(
      conversationId,
      `Mensagem(ns) de usuário enviada(s) ao runner (${runInput.length} item(ns) no array):`,
    );
    runInput.forEach((item, i) => {
      const content =
        typeof item === "object" &&
        item !== null &&
        "content" in item &&
        typeof (item as { content: unknown }).content === "string"
          ? (item as { content: string }).content
          : JSON.stringify(item);
      logAgentTextBlock(conversationId, `  [${i}] conteúdo:`, content);
    });
  }
  logAgentLine(conversationId, "--- Fim debug runAgents entrada ---");
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
 * contexto (`clientId`, `continuesOpenAiAgentChain`).
 *
 * Responsabilidades desta função:
 *  1. Validar o input via Zod.
 *  2. Montar `AgentRunContext` para uso em ferramentas (MCP, etc).
 *  3. Instanciar o orquestrador com handoffs para triage/process_info.
 *  4. Chamar `run()` do SDK com `OpenAIConversationsSession` por turno.
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
    continuesOpenAiAgentChain: Boolean(input.conversationId),
  };

  // O SDK aceita `string | AgentInputItem[]`. Quando o chamador (rota
  // `generate-ai-response`) já agregou múltiplas mensagens, repassamos como
  // array para preservar a separação semântica de cada mensagem do batch.
  const runInput: string | AgentInputItem[] = input.inputs
    ? (input.inputs as unknown as AgentInputItem[])
    : (input.userMessage as string);

  const runner = new Runner();
  const conversationId = input.conversaId;
  const inputsCount = Array.isArray(input.inputs) ? input.inputs.length : 1;
  const clientNote = input.clientId
    ? "cliente já vinculado ao cadastro"
    : "cliente ainda não vinculado ao cadastro";
  const chainNote = context.continuesOpenAiAgentChain
    ? "retomando a sessão OpenAI existente"
    : "iniciando nova sessão OpenAI";

  logRunAgentsDebug({
    conversationId,
    input,
    context,
    env,
    runInput,
  });

  const orchestrator = buildOrchestratorAgent({ env, context });

  console.log("");
  logAgentLine(
    conversationId,
    `Início do atendimento — começando pela ${agentLabel(orchestrator.name)} (${clientNote}; ${chainNote}; ${pluralize(inputsCount, "mensagem recebida", "mensagens recebidas")}).`,
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

  const session = new OpenAIConversationsSession({
    ...(env.openaiApiKey ? { apiKey: env.openaiApiKey } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });

  const runOpts = {
    context,
    session,
    ...(Array.isArray(runInput)
      ? {
          // Para batch de mensagens (inputs[]), fixamos explicitamente o merge
          // history + newItems para evitar ambiguidades em mudanças futuras.
          sessionInputCallback: (history: AgentInputItem[], newItems: AgentInputItem[]) => [
            ...history,
            ...newItems,
          ],
        }
      : {}),
  };

  logAgentLine(
    conversationId,
    `Chamando runner.run — session OpenAI retomada: ${Boolean(input.conversationId)}; resumo runInput: ${JSON.stringify(summarizeRunInputForDiagnostics(runInput))}`,
  );

  let result;
  try {
    result = await runner.run(orchestrator, runInput, runOpts);
  } catch (error) {
    logRunAgentsFailure({
      conversationId,
      error,
      openAiConversationId: input.conversationId,
      runInput,
    });
    throw error;
  }

  const openaiConversationId = await session.getSessionId();

  const rawLogDir = resolveAgentRunRawLogPath();
  if (rawLogDir) {
    const rawRecord = buildAgentRunRawLogRecord({
      conversaId: input.conversaId,
      organizationId: input.organizationId,
      clientId: input.clientId,
      openaiConversationId,
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
    openaiConversationId,
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
