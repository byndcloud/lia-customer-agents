import { loadEnv, type EnvConfig } from "../config/env.js";
import { getOpenAIClient } from "../config/openai-client.js";
import { getSupabaseClient } from "../db/client.js";
import { resolveAtendimentoIdForPersistedMessage } from "../db/atendimentos.js";
import {
  getConversationMessages,
  saveChatbotMessage,
  type WhatsappMensagem,
} from "../db/messages.js";
import {
  closeConversation,
  getConversationStatus,
  setConversationAguardandoAtendimentoFollowupTriagem,
  setConversationInactiveSince,
} from "../db/conversations.js";
import {
  finalizarAtendimentosAtivosPorConversa,
  finalizarAtendimentosTransferidosFilaPorFollowup24hTriagem,
  getOpenAtendimentoAgenteResponsavelRaw,
} from "../db/atendimentos.js";
import { isPersistedTriageSpecialistAgentId } from "../agents/instructions/triage-specialist.instructions.js";
import { sendEvolutionMessage } from "./evolutionApi.js";
import { resolveWhatsAppInstance } from "./whatsappInstanceResolver.js";

/**
 * Implementação dos dois followups (30min de inatividade e encerramento 24h).
 * São disparados externamente (pg_cron / Cloud Scheduler) via POST nas rotas
 * `/followup-30min` e `/followup-24h`.
 *
 * Diferenças vs. a edge function original:
 *  - Tudo é Node (clientes obtidos via factories cacheadas).
 *  - Não dependemos mais de `Deno.env`; configuração vem de `loadEnv()`.
 */

interface ConversaInativa30min {
  id: string;
  organization_id: string;
  numero_whatsapp: string;
  status: string;
  ultima_mensagem_at: string | null;
  ultima_mensagem_id: string | null;
  ultima_mensagem_conteudo: string | null;
  ultima_mensagem_remetente: string | null;
  ultimo_response_id: string | null;
}

interface ConversaInativa24h {
  id: string;
  organization_id: string;
  numero_whatsapp: string;
  status: string;
  inactive_since: string;
  ultima_mensagem_id: string | null;
  ultima_mensagem_conteudo: string | null;
  ultima_mensagem_remetente: string | null;
  ultimo_response_id: string | null;
}

/**
 * GATE PROVISÓRIO DE FOLLOW-UP POR ORGANIZAÇÃO
 * --------------------------------------------
 * Mantém as rotas de follow-up ativas apenas para orgs com:
 * - módulo `legis_atende`
 * - `settings.feature_flags.triagem_inteligente === true`
 *
 * Para remover no futuro, basta:
 * 1) definir a constante abaixo como `false`, ou
 * 2) apagar este bloco e os `if` de skip nos loops de follow-up.
 */
const FOLLOWUP_TRIAGEM_INTELIGENTE_GATE_ENABLED = true;
const FOLLOWUP_MODULE_IDENTIFIER = "legis_atende";

type OrganizationModuleRowDirect = {
  organization_id: string | null;
  settings: unknown;
  identifier?: string | null;
};

type OrganizationModuleRowJoined = {
  organization_id: string | null;
  settings: unknown;
  modules?: { identifier?: string | null } | Array<{ identifier?: string | null }> | null;
};

function hasTriagemInteligenteFlag(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const featureFlags = (settings as { feature_flags?: unknown }).feature_flags;
  if (!featureFlags || typeof featureFlags !== "object") return false;
  return (
    (featureFlags as { triagem_inteligente?: unknown }).triagem_inteligente ===
    true
  );
}

async function getFollowupEligibleOrganizationIds(
  cfg: EnvConfig,
): Promise<Set<string>> {
  if (!FOLLOWUP_TRIAGEM_INTELIGENTE_GATE_ENABLED) {
    return new Set<string>();
  }

  const supabase = getSupabaseClient(cfg);

  // Tentativa 1: `identifier` direto em `organization_modules`.
  const direct = await supabase
    .from("organization_modules")
    .select("organization_id, settings, identifier")
    .eq("identifier", FOLLOWUP_MODULE_IDENTIFIER);

  if (!direct.error) {
    const rows = (direct.data as OrganizationModuleRowDirect[] | null) ?? [];
    return new Set(
      rows
        .filter(
          (row) =>
            typeof row.organization_id === "string" &&
            row.organization_id.length > 0 &&
            hasTriagemInteligenteFlag(row.settings),
        )
        .map((row) => row.organization_id as string),
    );
  }

  // Tentativa 2: join com `modules.identifier`.
  const joined = await supabase
    .from("organization_modules")
    .select("organization_id, settings, modules!inner(identifier)")
    .eq("modules.identifier", FOLLOWUP_MODULE_IDENTIFIER);

  if (joined.error) {
    console.warn(
      "⚠️ [followup] Não foi possível resolver gate provisório por organization_modules:",
      joined.error.message,
    );
    // Fail-closed: sem conseguir validar a flag, não processa follow-up.
    return new Set<string>();
  }

  const rows = (joined.data as OrganizationModuleRowJoined[] | null) ?? [];
  return new Set(
    rows
      .filter((row) => {
        if (
          typeof row.organization_id !== "string" ||
          row.organization_id.length === 0
        ) {
          return false;
        }
        const moduleRef = Array.isArray(row.modules)
          ? row.modules[0]
          : row.modules;
        return (
          moduleRef?.identifier === FOLLOWUP_MODULE_IDENTIFIER &&
          hasTriagemInteligenteFlag(row.settings)
        );
      })
      .map((row) => row.organization_id as string),
  );
}

export interface FollowupResult {
  conversas_encontradas: number;
  processadas: number;
  erros: number;
  detalhes: Array<{
    conversa_id: string;
    status: string;
    erro?: string;
  }>;
}

const FOLLOWUP_30MIN_DEVELOPER_MSG = `
O usuário está inativo há mais de 30 minutos. 
Inicie o fluxo de encerramento, gere uma mensagem curta e amigável para validar se sua ajuda foi suficiente. O foco deve ser na sua utilidade como assistente.
Diretrizes de Conteúdo: Varie a abordagem, mas sempre pergunte se você (Lia) conseguiu resolver o que o cliente precisava ou se ainda pode ajudar com algo mais. Use uma linguagem extremamente simples e clara (foco em público leigo), evitando termos como "pendência" ou "interação".
Se a dúvida parecer resolvida, incentive uma confirmação simples (ex: "é só me avisar") para facilitar o fechamento.
Exemplo de Tom: "Consegui resolver o que você precisava ou posso te ajudar com mais alguma coisa? 😊

Siga essas regras de forma determinística.
`;

const FOLLOWUP_30MIN_DEVELOPER_MSG_TRIAGE = `
O usuário está inativo há mais de 30 minutos e estava no meio de uma triagem. 
Inicie o fluxo de encerramento, gere uma mensagem curta e amigável para validar se existe mais alguma informação que o usuário queira compartilhar. O foco deve ser na sua utilidade como assistente.

Siga essas regras de forma determinística.
`;

const FOLLOWUP_24H_DEVELOPER_MSG = `O usuário está inativo há mais de 24 horas e a conversa será encerrada. Envie uma mensagem como essa "Como a nossa conversa parou por aqui, vou encerrar o atendimento. Se precisar de algo novo, é só me chamar! 😊"`;

/** Notas internas para a fila humana: alinhado ao “RESUMO FINAL” da triagem trabalhista. */
const FOLLOWUP_24H_TRIAGEM_NOTAS_DEVELOPER = `Você redige notas INTERNAS para o time humano (campo de finalização no CRM), em português.

Contexto operacional (sempre verdadeiro neste caso):
- A conversa estava em triagem automática com a assistente Lia.
- Passaram mais de 24 horas sem nova mensagem do cliente.
- O sistema vai colocar a conversa em fila de atendimento humano (não é encerramento com despedida ao cliente).

Tarefa:
1) Primeira linha EXATAMENTE assim (uma linha só):
Transferência automática — follow-up 24h (triagem inativa, sem resposta do cliente).

2) Linha em branco.

3) Em seguida, um resumo da situação no MESMO ESPÍRITO do “RESUMO FINAL” da triagem trabalhista (preencha com base só no histórico abaixo; use “não informado” quando algo não aparecer):
Nome: …
Empresa: …
Situação atual: …
Tema principal: …

Resumo do caso:
(2 a 5 linhas objetivas com os fatos centrais)

Provas mencionadas:
…

Leitura inicial para o advogado:
- Viabilidade: …
- Complexidade: …
- Potencial de ganho: …
- Urgência jurídica: …
- Prioridade de atendimento: …

Regras:
- Não invente fatos; só deduza o que for razoavelmente implícito no histórico.
- Não escreva mensagem ao cliente.
- Seja conciso; evite repetir o histórico inteiro.`;

const TRANSCRIPT_MAX_CHARS = 48_000;
const TRANSCRIPT_MSG_SLICE = 2_800;

/**
 * Monta transcrição cronológica para o modelo (últimas mensagens da conversa).
 */
function buildTranscriptForTriagemNotas(
  messages: readonly WhatsappMensagem[],
): string {
  const chronological = [...messages].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const parts: string[] = [];
  for (const m of chronological) {
    const label =
      m.remetente === "cliente"
        ? "CLIENTE"
        : m.remetente === "chatbot"
          ? "LIA"
          : "ATENDENTE";
    const raw = (m.conteudo ?? "").trim();
    if (!raw) {
      parts.push(`[${label}] (${m.tipo_mensagem}, sem texto)`);
      continue;
    }
    const slice =
      raw.length > TRANSCRIPT_MSG_SLICE
        ? `${raw.slice(0, TRANSCRIPT_MSG_SLICE)}…`
        : raw;
    parts.push(`[${label}] ${slice}`);
  }
  let joined = parts.join("\n\n");
  if (joined.length > TRANSCRIPT_MAX_CHARS) {
    joined =
      "…(trecho inicial omitido por limite)\n\n" +
      joined.slice(joined.length - TRANSCRIPT_MAX_CHARS);
  }
  return joined;
}

type ResponsesInputRole = "developer" | "user";

/**
 * Gera texto via Responses API (sem encadear previous_response_id).
 *
 * NOTE: usamos a Responses API e não o Agents SDK aqui porque o followup é
 * instrução controlada e não deve disparar handoffs/tools.
 */
async function gerarTextoComResponsesApi(
  input: ReadonlyArray<{ role: ResponsesInputRole; content: string }>,
  env: EnvConfig,
): Promise<{
  responseContent: string;
  responseId: string;
  tokensUsed?: number | undefined;
}> {
  const openai = getOpenAIClient(env);

  const requestBody: Record<string, unknown> = {
    model: env.aiModel,
    input: [...input],
  };

  const response = (await openai.responses.create(
    requestBody as unknown as Parameters<typeof openai.responses.create>[0],
  )) as unknown as {
    id: string;
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    usage?: { total_tokens?: number };
  };

  const responseContent =
    response.output?.[0]?.content?.[0]?.text || response.output_text || "";

  return {
    responseContent,
    responseId: response.id,
    tokensUsed: response.usage?.total_tokens,
  };
}

async function gerarMensagemComResponsesApi(
  developerMessage: string,
  env: EnvConfig,
): Promise<{
  responseContent: string;
  responseId: string;
  tokensUsed?: number | undefined;
}> {
  return gerarTextoComResponsesApi(
    [{ role: "developer", content: developerMessage }],
    env,
  );
}

const FOLLOWUP_24H_TRIAGEM_NOTAS_FALLBACK =
  "Transferência automática — follow-up 24h (triagem inativa, sem resposta do cliente).\n\n" +
  "Resumo não gerado automaticamente; consultar histórico da conversa no painel.";

/** Gera notas_finalizacao para finalização por follow-up 24h em triagem. */
async function gerarNotasFinalizacaoTriagemFollowup24h(
  conversaId: string,
  env: EnvConfig,
): Promise<string> {
  const recent = await getConversationMessages(conversaId, 100, env);
  const transcript = buildTranscriptForTriagemNotas(recent);
  if (!transcript.trim()) {
    return FOLLOWUP_24H_TRIAGEM_NOTAS_FALLBACK;
  }
  try {
    const { responseContent } = await gerarTextoComResponsesApi(
      [
        { role: "developer", content: FOLLOWUP_24H_TRIAGEM_NOTAS_DEVELOPER },
        {
          role: "user",
          content: `Histórico da conversa (mais antigo primeiro):\n\n${transcript}`,
        },
      ],
      env,
    );
    const trimmed = responseContent.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch (err) {
    console.warn(
      `⚠️ [followup-24h] Falha ao gerar notas de triagem (${conversaId}):`,
      err,
    );
  }
  return FOLLOWUP_24H_TRIAGEM_NOTAS_FALLBACK;
}

/**
 * Processa conversas inativas há ~30 min: gera mensagem de "ainda precisa de
 * ajuda?" e marca `inactive_since` para evitar duplicação.
 * Com `agente_responsavel` `triage` ou identificador de triagem especialista (`criminal`, `trabalhista`, etc.), usa
 * `FOLLOWUP_30MIN_DEVELOPER_MSG_TRIAGE` em vez do prompt padrão.
 */
export async function processFollowup30min(
  env?: EnvConfig,
): Promise<FollowupResult> {
  const cfg = env ?? loadEnv();
  const supabase = getSupabaseClient(cfg);

  const { data, error } = await supabase.rpc("buscar_conversas_inativas_30min", {
    p_intervalo_segundos: cfg.followup30minSeconds,
  });

  if (error) throw error;

  const lista = (data as ConversaInativa30min[]) ?? [];
  const eligibleOrgIds = await getFollowupEligibleOrganizationIds(cfg);
  const result: FollowupResult = {
    conversas_encontradas: lista.length,
    processadas: 0,
    erros: 0,
    detalhes: [],
  };

  for (const conversa of lista) {
    if (
      FOLLOWUP_TRIAGEM_INTELIGENTE_GATE_ENABLED &&
      !eligibleOrgIds.has(conversa.organization_id)
    ) {
      result.detalhes.push({
        conversa_id: conversa.id,
        status: "pulado_feature_flag_triagem_inteligente",
      });
      continue;
    }

    let inactiveSinceUpdated = false;

    const marcarInactiveSince = async () => {
      try {
        await setConversationInactiveSince(
          conversa.id,
          new Date().toISOString(),
          cfg,
        );
        inactiveSinceUpdated = true;
      } catch (err) {
        console.error(
          `❌ [followup-30min] Erro ao atualizar inactive_since (${conversa.id}):`,
          err,
        );
      }
    };

    try {
      if (conversa.status !== "em_atendimento_chatbot") {
        const isWhatsapp = conversa.status === "em_atendimento_whatsapp";
        await marcarInactiveSince();

        if (isWhatsapp) {
          result.processadas++;
          result.detalhes.push({
            conversa_id: conversa.id,
            status: "pulado_whatsapp",
          });
        } else {
          result.detalhes.push({
            conversa_id: conversa.id,
            status: "status_invalido",
            erro: `Status da conversa é "${conversa.status}" (esperado: "em_atendimento_chatbot")`,
          });
        }
        continue;
      }

      const agenteRaw = await getOpenAtendimentoAgenteResponsavelRaw(
        conversa.id,
        cfg,
      );
      const emTriagem =
        agenteRaw === "triage" || isPersistedTriageSpecialistAgentId(agenteRaw);
      const developerMsg30 = emTriagem
        ? FOLLOWUP_30MIN_DEVELOPER_MSG_TRIAGE
        : FOLLOWUP_30MIN_DEVELOPER_MSG;

      const { responseContent } =
        await gerarMensagemComResponsesApi(developerMsg30, cfg);

      const atendimentoId = await resolveAtendimentoIdForPersistedMessage(
        {
          id: conversa.id,
          status: conversa.status,
          chatbot_ativo: true,
        },
        conversa.organization_id,
        "chatbot",
        cfg,
      );

      await saveChatbotMessage(
        conversa.id,
        responseContent,
        "texto",
        undefined,
        cfg,
        atendimentoId,
      );

      const { instancia, error: instanceError } =
        await resolveWhatsAppInstance({ conversaId: conversa.id }, cfg);

      if (instanceError) {
        result.detalhes.push({
          conversa_id: conversa.id,
          status: "sem_instancia",
          erro: instanceError,
        });
        result.erros++;
        await marcarInactiveSince();
        continue;
      }

      await marcarInactiveSince();

      try {
        await sendEvolutionMessage(
          instancia,
          conversa.numero_whatsapp,
          responseContent,
          cfg,
          {
            conversaId: conversa.id,
            source: "followup_30min",
          },
        );
      } catch (evolutionError) {
        console.warn(
          `⚠️ [followup-30min] Erro ao enviar para Evolution:`,
          evolutionError,
        );
      }

      result.processadas++;
      result.detalhes.push({ conversa_id: conversa.id, status: "enviado" });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`❌ [followup-30min] Erro na conversa ${conversa.id}:`, err);
      result.erros++;
      result.detalhes.push({
        conversa_id: conversa.id,
        status: "erro",
        erro: errorMsg,
      });
    } finally {
      if (!inactiveSinceUpdated) {
        await marcarInactiveSince();
      }
    }
  }

  return result;
}

/**
 * Processa conversas inativas há ~24 h: encerra a conversa e finaliza
 * atendimentos ativos. Quando o status já é `em_atendimento_whatsapp`,
 * finaliza sem gerar nova mensagem (atendente humano assumiu).
 *
 * Se o atendimento aberto tiver `agente_responsavel` `triage` ou
 * identificador de triagem especialista (`criminal`, `trabalhista`, etc.), não encerra: finaliza o atendimento como transferido
 * e define a conversa como `aguardando_atendimento` (fila humana).
 */
export async function processFollowup24h(
  env?: EnvConfig,
): Promise<FollowupResult> {
  const cfg = env ?? loadEnv();
  const supabase = getSupabaseClient(cfg);

  const { data, error } = await supabase.rpc("buscar_conversas_inativas_24h", {
    p_intervalo_segundos: cfg.followup24hSeconds,
  });

  if (error) throw error;

  const lista = (data as ConversaInativa24h[]) ?? [];
  const eligibleOrgIds = await getFollowupEligibleOrganizationIds(cfg);
  const result: FollowupResult = {
    conversas_encontradas: lista.length,
    processadas: 0,
    erros: 0,
    detalhes: [],
  };

  for (const conversa of lista) {
    if (
      FOLLOWUP_TRIAGEM_INTELIGENTE_GATE_ENABLED &&
      !eligibleOrgIds.has(conversa.organization_id)
    ) {
      result.detalhes.push({
        conversa_id: conversa.id,
        status: "pulado_feature_flag_triagem_inteligente",
      });
      continue;
    }

    try {
      const agenteRaw = await getOpenAtendimentoAgenteResponsavelRaw(
        conversa.id,
        cfg,
      );
      const encaminharParaFilaTriagem =
        agenteRaw === "triage" || isPersistedTriageSpecialistAgentId(agenteRaw);

      if (encaminharParaFilaTriagem) {
        try {
          const notasTriagem =
            await gerarNotasFinalizacaoTriagemFollowup24h(conversa.id, cfg);
          await finalizarAtendimentosTransferidosFilaPorFollowup24hTriagem(
            conversa.id,
            notasTriagem,
            cfg,
          );
        } catch (atendimentoError) {
          console.warn(
            `⚠️ [followup-24h] Erro ao finalizar atendimentos (fila triagem) (${conversa.id}):`,
            atendimentoError,
          );
        }
        await setConversationAguardandoAtendimentoFollowupTriagem(
          conversa.id,
          cfg,
        );
        result.processadas++;
        result.detalhes.push({
          conversa_id: conversa.id,
          status: "aguardando_atendimento",
        });
        continue;
      }

      const deveCriarMensagem =
        conversa.status !== "em_atendimento_whatsapp";

      let responseContent: string | null = null;

      if (deveCriarMensagem) {
        const generated = await gerarMensagemComResponsesApi(
          FOLLOWUP_24H_DEVELOPER_MSG,
          cfg,
        );
        responseContent = generated.responseContent;

        const atendimentoId24 = await resolveAtendimentoIdForPersistedMessage(
          {
            id: conversa.id,
            status: conversa.status,
            chatbot_ativo: true,
          },
          conversa.organization_id,
          "chatbot",
          cfg,
        );

        await saveChatbotMessage(
          conversa.id,
          responseContent,
          "texto",
          undefined,
          cfg,
          atendimentoId24,
        );

        const { instancia, error: instanceError } =
          await resolveWhatsAppInstance({ conversaId: conversa.id }, cfg);

        if (!instanceError && responseContent) {
          try {
            await sendEvolutionMessage(
              instancia,
              conversa.numero_whatsapp,
              responseContent,
              cfg,
              {
                conversaId: conversa.id,
                source: "followup_24h",
              },
            );
          } catch (evolutionError) {
            console.error(
              `❌ [followup-24h] Erro ao enviar para Evolution:`,
              evolutionError,
            );
          }
        }
      }

      const status = await getConversationStatus(conversa.id, cfg);
      const isWhatsapp = status === "em_atendimento_whatsapp";
      const resultado = isWhatsapp ? null : "abandonado";
      const notas = isWhatsapp
        ? "Robô encerra o atendimento via whatsapp como Nul"
        : "Lia encerrou o atendimento como abandonado por falta de interação em 24horas";

      try {
        await finalizarAtendimentosAtivosPorConversa(
          conversa.id,
          resultado,
          notas,
          cfg,
        );
      } catch (atendimentoError) {
        console.warn(
          `⚠️ [followup-24h] Erro ao finalizar atendimentos (${conversa.id}):`,
          atendimentoError,
        );
      }

      await closeConversation(conversa.id, cfg);

      result.processadas++;
      result.detalhes.push({ conversa_id: conversa.id, status: "encerrada" });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`❌ [followup-24h] Erro na conversa ${conversa.id}:`, err);
      result.erros++;
      result.detalhes.push({
        conversa_id: conversa.id,
        status: "erro",
        erro: errorMsg,
      });
    }
  }

  return result;
}

// Suprime warning "noUnusedLocals" - mantemos os tipos exportáveis no futuro se preciso.
export type { ConversaInativa30min, ConversaInativa24h };
