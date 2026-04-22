import { z } from "zod";

/**
 * Identificadores dos agentes do fluxo principal (triagem e consulta processual).
 *
 * `triage` — Lia de primeiro atendimento (triagem de casos)
 * `process_info` — Lia de consulta a processos já existentes
 */
export const AgentIdSchema = z.enum(["triage", "process_info"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * Schema mínimo aceito como item de input dos agentes.
 *
 * O SDK aceita uma variedade muito maior de itens (ferramentas, imagens,
 * arquivos, etc.), mas para o nosso fluxo (chat WhatsApp) só precisamos do
 * `UserMessageItem` simples — texto de usuário. Validamos só o suficiente
 * para garantir que `run()` aceite.
 */
export const AgentInputItemSchema = z
  .object({
    role: z.literal("user"),
    content: z.string().min(1),
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
 * `organizationId` e `conversationId` são obrigatórios. `clientId` é opcional
 * (pessoa ainda não vinculada no cadastro). O **orquestrador LLM** combina
 * `clientId`, `previousResponseId` e o texto do usuário para decidir o handoff
 * entre triagem e consulta processual.
 */
export const RunInputSchema = z
  .object({
    userMessage: z.string().min(1).optional(),
    inputs: z.array(AgentInputItemSchema).min(1).optional(),

    /** Identificador da conversa do canal (ex.: WhatsApp). */
    conversationId: z.string().min(1),

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
     * `response_id` retornado pela OpenAI na rodada anterior. Quando presente,
     * é usado para encadear a conversa via `previousResponseId` do SDK.
     */
    previousResponseId: z.string().min(1).optional(),

    /**
     * Extras passados pelo chamador (ex.: nome do cliente). Não interferem no
     * contrato do SDK; podem ser utilizados pelos agentes via instruções.
     */
    extra: z.record(z.string(), z.unknown()).optional(),
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

  /** `response_id` retornado pela OpenAI (deve ser persistido pela edge function). */
  responseId: string | undefined;

  /** Métricas agregadas do run. */
  usage: RunUsage;
}

/**
 * Contexto compartilhado entre agentes e ferramentas durante um `run`.
 * Não é exposto na API pública, mas é injetado no `RunContext` do SDK para
 * permitir que ferramentas acessem identificadores do tenant.
 */
export interface AgentRunContext {
  conversationId: string;
  organizationId: string;
  /** Definido quando a conversa já tem `pessoa_id` no banco. */
  clientId: string | undefined;
  calendarConnectionId: string | undefined;
  extra: Record<string, unknown> | undefined;
  /**
   * `true` quando este run encadeia `previousResponseId` da OpenAI (continua
   * a mesma cadeia técnica de respostas do SDK). `false` só indica que **não**
   * há esse encadeamento nesta chamada — não significa primeira mensagem do
   * cliente nem ausência de histórico no canal.
   */
  continuesOpenAiAgentChain: boolean;
}
