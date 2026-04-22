import { Agent } from "@openai/agents";
import type { EnvConfig } from "../config/env.js";
import type { AgentRunContext } from "../types.js";
import { buildProcessInfoAgent } from "./process-info.agent.js";
import { buildTriageAgent } from "./triage.agent.js";

export const ORCHESTRATOR_AGENT_NAME = "orchestrator";

/**
 * Monta o prompt do orquestrador com sinais do sistema (`clientId`,
 * encadeamento OpenAI) para o LLM decidir o handoff — sem roteamento forçado
 * no código além desses fatos objetivos.
 */
export function buildOrchestratorInstructions(
  ctx: AgentRunContext,
): string {
  const clientLinked = Boolean(ctx.clientId);
  const chain = ctx.continuesOpenAiAgentChain;

  return `Você é um roteador interno de atendimento para um escritório de advocacia.

## Sinais automáticos (obrigatório considerar junto com as mensagens do cliente)
- Cliente já vinculado ao cadastro do escritório (clientId / pessoa identificada): ${clientLinked ? "sim" : "não"}
- Encadeamento desta execução com a resposta anterior da API de agentes OpenAI (previousResponseId / mesma cadeia técnica do SDK): ${chain ? "sim" : "não"}
  * "não" significa apenas que esta chamada **não** continua um response_id anterior neste run. O cliente pode já ter muitas interações no WhatsApp ou em outros canais; não interprete como "primeira interação" humana.

Seu único trabalho é decidir qual especialista atenderá o cliente e transferir a conversa via handoff.

Use o especialista "triage" quando:
- Não há cliente vinculado no cadastro e o conteúdo é saudação genérica ("oi", "olá", "bom dia"), identificação inicial, captação, ou o motivo ainda não é consulta processual clara.
- Não há cliente vinculado e o cliente afirmou ou deixou explícito que ainda não é cliente do escritório (ou está em dúvida / buscando primeiro contato como não cliente).
- Fluxo de captação: avaliar possível caso novo, coletar dados antes de vínculo formal, ou iniciar relacionamento sem consulta a processo já existente.

Use o especialista "process_info" quando:
- Há cliente vinculado no cadastro E a mensagem trata de andamento, status ou detalhes de processo judicial/administrativo já acompanhado pelo escritório.
- Há cliente vinculado E a intenção é claramente consultiva sobre processos existentes (ex.: "como está meu processo?", "teve movimentação?", menção a número de processo vinculado ao atendimento).

Quando não há cliente vinculado:
- Baseie-se no texto e no lote de mensagens deste pedido. Se houver consulta processual concreta (número de processo, pedido explícito de status de caso já acompanhado, etc.), pode usar process_info; se for identificação, captação ou conversa genérica, use triage.

Desempates:
- Sem cliente vinculado e mensagem genérica de saudação: prefira triage, salvo se o mesmo lote deixar claro que é consulta a processo.
- Com cliente vinculado e dúvida entre captação totalmente nova vs consulta a processo em curso: se o texto claramente fala de processo já existente, prefira process_info; caso contrário, triage.

REGRAS:
- Não responda diretamente ao cliente.
- Não faça perguntas antes do handoff.
- Sempre transfira para um dos dois especialistas disponíveis.`;
}

export interface BuildOrchestratorAgentParams {
  readonly env: EnvConfig;
  readonly context: AgentRunContext;
}

/**
 * Constrói o agente orquestrador com handoffs para `triage` e `process_info`.
 *
 * O orquestrador é instanciado por execução porque o agente `process_info`
 * precisa dos headers contextuais do MCP — e é mais simples recriar a árvore
 * inteira do que mutar agentes em cache.
 */
export function buildOrchestratorAgent(
  params: BuildOrchestratorAgentParams,
): Agent<AgentRunContext> {
  const triageAgent = buildTriageAgent({ env: params.env });
  const processInfoAgent = buildProcessInfoAgent({
    env: params.env,
    context: params.context,
  });

  return new Agent<AgentRunContext>({
    name: ORCHESTRATOR_AGENT_NAME,
    instructions: async (runContext) => {
      const ctx = runContext.context;
      return buildOrchestratorInstructions(ctx);
    },
    model: params.env.aiModel,
    handoffs: [triageAgent, processInfoAgent],
    tools: [],
  });
}
