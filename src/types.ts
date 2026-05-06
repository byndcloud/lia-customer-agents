import { z } from "zod";
import { stripLegacyTriageSpecialistPrefix } from "./agents/instructions/triage-specialist.instructions.js";

/**
 * Identificadores dos agentes do fluxo principal.
 *
 * `orchestrator` — recepção / orquestrador (handoff para especialistas)
 * `triage` — triagem simples/central (fallback + roteamento)
 * Especialistas de triagem — valor de `identificador` em `triage_specialist_agents_config`
 * (ex.: `criminal`, `trabalhista`). Valores legados `triage_<slug>` são normalizados em leitura.
 * `process_info` — consulta a processos já existentes
 */
export const AgentIdSchema = z.enum([
  "orchestrator",
  "triage",
  "criminal",
  "digital",
  "previdenciario",
  "civil",
  "familia",
  "empresarial",
  "tributario",
  "trabalhista",
  "process_info",
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * Schema mínimo aceito como item de input dos agentes.
 *
 * O SDK aceita uma variedade muito maior de itens (ferramentas, imagens,
 * arquivos, etc.). Para o chat WhatsApp usamos mensagens simples com
 * `user` / `assistant` / `system`.
 */
export const AgentInputItemSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.union([
      z.string().min(1),
      z.array(z.record(z.string(), z.unknown())).min(1),
    ]),
    type: z.literal("message").optional(),
  })
  .passthrough();
export type AgentInputItem = z.infer<typeof AgentInputItemSchema>;

/**
 * Contrato de entrada para `runAgents`.
 *
 * Aceita ou `userMessage` (caminho histórico, usado pelo `POST /run`) ou
 * `inputs` (caminho novo, usado pelo `generate-ai-response` para preservar a
 * separação semântica das mensagens agregadas — texto + transcrições).
 *
 * `organizationId` e `conversaId` (plataforma/Supabase) são obrigatórios.
 * `clientId` é opcional (pessoa ainda não vinculada no cadastro).
 *
 */
export const RunInputSchema = z
  .object({
    userMessage: z.string().min(1).optional(),
    inputs: z.array(AgentInputItemSchema).min(1).optional(),

    /** Identificador da conversa do canal/plataforma (ex.: WhatsApp). */
    conversaId: z.string().min(1),

    /** Identificador da organização/escritório. */
    organizationId: z.string().min(1),

    /**
     * Identificador da pessoa (`whatsapp_conversas.pessoa_id`), quando já
     * vinculado. Omitir quando ainda não há cliente identificado.
     */
    clientId: z.preprocess(
      (v) => {
        if (v === undefined || v === null || v === "") return undefined;
        if (typeof v === "string" && !v.trim()) return undefined;
        return v;
      },
      z.string().min(1).optional(),
    ),

    /** Conexão de calendário do escritório, quando aplicável (agendamentos). */
    calendarConnectionId: z.string().min(1).optional(),

    /**
     * Extras passados pelo chamador (ex.: nome do cliente). Não interferem no
     * contrato do SDK; podem ser utilizados pelos agentes via instruções.
     */
    extra: z.record(z.string(), z.unknown()).optional(),

    /**
     * Agente IA atualmente responsável pelo atendimento ativo (persistido em
     * `whatsapp_atendimentos.agente_responsavel`), usado nas instruções do
     * orquestrador para preferir re-handoff.
     */
    agenteResponsavelAtendimento: z.preprocess(
      (v) => {
        if (v === undefined || v === null || v === "") return undefined;
        if (typeof v !== "string") return v;
        const t = v.trim();
        return stripLegacyTriageSpecialistPrefix(t);
      },
      AgentIdSchema.optional(),
    ),
  })
  .refine(
    (value) => Boolean(value.userMessage) || Boolean(value.inputs),
    {
      message: "either 'userMessage' or 'inputs' must be provided",
      path: ["userMessage"],
    },
  );
export type RunInput = z.infer<typeof RunInputSchema>;

/**
 * Métricas de uso agregadas do run.
 */
export interface RunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Contrato de saída de `runAgents`.
 */
export interface RunOutput {
  /** Texto final destinado ao usuário. */
  output: string;

  /** Agente que produziu a resposta final. */
  agentUsed: AgentId;

  /**
   * `response_id` da OpenAI neste turno (apenas auditoria / gravação em
   * `whatsapp_conversation_responses`). Não é usado para encadeamento.
   */
  responseId?: string | undefined;

  /** Métricas agregadas do run. */
  usage: RunUsage;
}

/**
 * Contexto compartilhado entre agentes e ferramentas durante um `run`.
 * Não é exposto na API pública, mas é injetado no `RunContext` do SDK para
 * permitir que ferramentas acessem identificadores do tenant.
 */
export interface AgentRunContext {
  conversaId: string;
  organizationId: string;
  /** Definido quando a conversa já tem `pessoa_id` no banco. */
  clientId: string | undefined;
  calendarConnectionId: string | undefined;
  extra: Record<string, unknown> | undefined;
  /**
   * Agente responsável persistido no atendimento ativo (antes deste run).
   * Ausente em chamadas que não passam pelo fluxo WhatsApp.
   */
  agenteResponsavelAtendimento: AgentId | undefined;
}
