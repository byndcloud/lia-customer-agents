import { Agent, handoff } from "@openai/agents";
import {
  RECOMMENDED_PROMPT_PREFIX,
  removeAllTools,
} from "@openai/agents-core/extensions";
import type { EnvConfig } from "../config/env.js";
import type { ActiveTriageSpecialistRow } from "../db/triageSpecialistAgentsConfig.js";
import { buildLegisMcpTool } from "../mcp/legis-mcp.js";
import type { AgentRunContext } from "../types.js";
import {
  appendChatbotTomVocabToInstructions,
  pickOptionalFetchChatbotOptions,
  type FetchChatbotAiConfigFn,
} from "./chatbot-instructions-appendix.js";
import { buildAgentTemporalContextSection } from "./agent-temporal-context.js";
import { buildTriageSpecialistAgent } from "./triage-specialist.agent.js";
import {
  TRIAGE_AGENT_HANDOFF_DESCRIPTION,
  TRIAGE_AGENT_HANDOFF_DESCRIPTION_SIMPLES,
  TRIAGE_AGENT_NAME,
  TRIAGE_AGENT_SIMPLE_INSTRUCTIONS,
  buildTriageAgentInstructions,
} from "./instructions/triage.instructions.js";

export interface BuildTriageAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
  /**
   * Quando `false`, não registra handoffs para triagens especialistas e o corpo do prompt
   * é **TRIAGE_AGENT_SIMPLE_INSTRUCTIONS** — inclusive se `activeTriageSpecialists` vier
   * populado (ex.: `runAgents` com não cliente e `triage_enabled=false`).
   * Com `true`, handoffs e texto dinâmico exigem lista não vazia.
   */
  readonly specialistHandoffs?: boolean;
  /**
   * Especialistas ativos (`ativo=true`) para esta org, vindos do banco.
   * Omitir ou passar `[]`: nenhum handoff de especialista (mesmo com `specialistHandoffs` true).
   */
  readonly activeTriageSpecialists?: readonly ActiveTriageSpecialistRow[];
  /** Ver `BuildOrchestratorAgentParams.fetchChatbotAiConfig`. */
  readonly fetchChatbotAiConfig?: FetchChatbotAiConfigFn;
}

/** Lista efetiva de especialistas (nunca `undefined`). */
function activeSpecialistsList(
  rows: readonly ActiveTriageSpecialistRow[] | undefined,
): readonly ActiveTriageSpecialistRow[] {
  return rows ?? [];
}

/**
 * Indica se a triagem central pode registrar handoffs para agentes especialistas por área.
 * Exige política explícita (`specialistHandoffs !== false`) e ao menos uma linha ativa.
 */
function mayRegisterSpecialistHandoffs(
  specialistHandoffsPolicy: boolean | undefined,
  specialists: readonly ActiveTriageSpecialistRow[],
): boolean {
  return specialistHandoffsPolicy !== false && specialists.length > 0;
}

/** Corpo markdown da triagem (sem prefixo temporal nem bloco de tom). */
function triageInstructionBodyMarkdown(
  specialistHandoffsActive: boolean,
  specialists: readonly ActiveTriageSpecialistRow[],
): string {
  if (!specialistHandoffsActive) {
    return TRIAGE_AGENT_SIMPLE_INSTRUCTIONS;
  }
  return buildTriageAgentInstructions(true, specialists);
}

function triageAgentHandoffDescription(specialistHandoffsActive: boolean): string {
  return specialistHandoffsActive
    ? TRIAGE_AGENT_HANDOFF_DESCRIPTION
    : TRIAGE_AGENT_HANDOFF_DESCRIPTION_SIMPLES;
}

function composeTriageInstructionsPrefix(instructionBodyMarkdown: string): string {
  return `${RECOMMENDED_PROMPT_PREFIX}\n\n${buildAgentTemporalContextSection()}\n\n${instructionBodyMarkdown}`;
}

function buildSpecialistAgentsForHandoffs(
  specialistHandoffsActive: boolean,
  specialists: readonly ActiveTriageSpecialistRow[],
  env: EnvConfig,
  context: AgentRunContext,
  chatbotOptions: { fetchChatbotAiConfig?: FetchChatbotAiConfigFn },
): Agent<AgentRunContext>[] {
  if (!specialistHandoffsActive) {
    return [];
  }
  return specialists.map((row) =>
    buildTriageSpecialistAgent({
      areaSlug: row.areaSlug,
      env,
      context,
      ...chatbotOptions,
    }),
  );
}

function wrapSpecialistHandoffs(agents: Agent<AgentRunContext>[]) {
  return agents.map((agent) =>
    handoff(agent, {
      inputFilter: removeAllTools,
    }),
  );
}

type TriageInstructionsRunContext = { context?: AgentRunContext };

/**
 * Callback de `instructions` do SDK: o prefixo (recomendado + temporal + corpo) é fixo
 * no build do agente; tom/vocabulário vêm de `appendChatbotTomVocabToInstructions`, que
 * usa `organizationId` do **turno** (`runContext.context`).
 */
function createTriageInstructionsResolver(
  instructionsPrefix: string,
  env: EnvConfig,
  chatbotOptions: { fetchChatbotAiConfig?: FetchChatbotAiConfigFn },
): (runContext: TriageInstructionsRunContext) => Promise<string> {
  return async (runContext: TriageInstructionsRunContext): Promise<string> => {
    const organizationId = runContext.context?.organizationId;
    return appendChatbotTomVocabToInstructions(instructionsPrefix, {
      organizationId,
      env,
      ...chatbotOptions,
    });
  };
}

/**
 * Constrói o agente de Triagem Simples/Central.
 * - **TRIAGE_AGENT_SIMPLE_INSTRUCTIONS** quando não há handoffs permitidos (lista vazia,
 *   `specialistHandoffs` falso, ou política de `runAgents`: não cliente sem `triage_enabled`).
 * - Texto com `buildTriageAgentInstructionsWithSpecialists` só quando há handoffs ativos
 *   e lista de especialistas não vazia.
 */
export function buildTriageAgent(params: BuildTriageAgentParams): Agent<AgentRunContext> {
  const specialists = activeSpecialistsList(params.activeTriageSpecialists);
  const specialistHandoffsActive = mayRegisterSpecialistHandoffs(
    params.specialistHandoffs,
    specialists,
  );
  const chatbotOptions = pickOptionalFetchChatbotOptions(params.fetchChatbotAiConfig);

  const instructionBodyMarkdown = triageInstructionBodyMarkdown(
    specialistHandoffsActive,
    specialists,
  );
  const instructionsPrefix = composeTriageInstructionsPrefix(instructionBodyMarkdown);

  const specialistAgents = buildSpecialistAgentsForHandoffs(
    specialistHandoffsActive,
    specialists,
    params.env,
    params.context,
    chatbotOptions,
  );

  const legisMcp = buildLegisMcpTool({
    env: params.env,
    context: params.context,
    allowedTools: ["concluir_triagem"],
  });

  const resolveInstructions = createTriageInstructionsResolver(
    instructionsPrefix,
    params.env,
    chatbotOptions,
  );

  return new Agent<AgentRunContext>({
    name: TRIAGE_AGENT_NAME,
    handoffDescription: triageAgentHandoffDescription(specialistHandoffsActive),
    instructions: resolveInstructions,
    model: params.env.aiModel,
    handoffs: wrapSpecialistHandoffs(specialistAgents),
    tools: [legisMcp],
  });
}
