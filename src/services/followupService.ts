import { loadEnv, type EnvConfig } from "../config/env.js";
import { getOpenAIClient } from "../config/openai-client.js";
import { getSupabaseClient } from "../db/client.js";
import { resolveAtendimentoIdForPersistedMessage } from "../db/atendimentos.js";
import { saveChatbotMessage } from "../db/messages.js";
import { insertWhatsappConversationResponse } from "../db/responses.js";
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

Regras de comportamento após a resposta do usuário:

1. Se o usuário confirmar que o problema foi resolvido:
   - Chamar a tool "finalizar_atendimento".

2. Se o usuário indicar que o problema NÃO foi resolvido, e não fornecer o problema/contexto do que não foi resolvido. Deve-se perguntar para o usuário qual foi o problema que não foi resolvido. Por exemplo: "Com o que posso te ajudar?"

3. Se após resposta do usuário explicando seu problema, for identificado que a solicitação está fora do escopo ou das capacidades das tools disponíveis 
   (getLatelyProcess, getLastMovimentation, getMovimentationHistory, getPerson, etc.):
   - Chamar a tool "unresolvedProblem". Não deve-se chamar a tool de transbordo nesse fluxo de encerramento ("transhipment"), deve-se chamar a tool "unresolvedProblem".

4. Caso o usuário responda com uma nova dúvida ou continuação dentro do escopo suportado:
   - Prosseguir normalmente com o atendimento, sem chamar nenhuma das tools acima.

Siga essas regras de forma determinística.
`;

const FOLLOWUP_30MIN_DEVELOPER_MSG_TRIAGE = `
O usuário está inativo há mais de 30 minutos e estava no meio de uma triagem. 
Inicie o fluxo de encerramento, gere uma mensagem curta e amigável para validar se existe mais alguma informação que o usuário queira compartilhar. O foco deve ser na sua utilidade como assistente.

Siga essas regras de forma determinística.
`;

const FOLLOWUP_24H_DEVELOPER_MSG = `O usuário está inativo há mais de 24 horas e a conversa será encerrada. Envie uma mensagem como essa "Como a nossa conversa parou por aqui, vou encerrar o atendimento. Se precisar de algo novo, é só me chamar! 😊"`;

/**
 * Gera mensagem de followup chamando direto a Responses API (encadeada com o
 * sem encadear `previous_response_id` (histórico vem do canal / banco).
 *
 * NOTE: usamos a Responses API e não o Agents SDK aqui porque o followup é
 * sempre uma instrução fixa do "developer" e não deve disparar handoffs/tools.
 */
async function gerarMensagemComResponsesApi(
  developerMessage: string,
  env: EnvConfig,
): Promise<{
  responseContent: string;
  responseId: string;
  tokensUsed?: number | undefined;
}> {
  const openai = getOpenAIClient(env);

  const requestBody: Record<string, unknown> = {
    model: env.aiModel,
    input: [{ role: "developer", content: developerMessage }],
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

/**
 * Processa conversas inativas há ~30 min: gera mensagem de "ainda precisa de
 * ajuda?" e marca `inactive_since` para evitar duplicação.
 * Com `agente_responsavel` `triage` ou `triage_trabalhista`, usa
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
  const result: FollowupResult = {
    conversas_encontradas: lista.length,
    processadas: 0,
    erros: 0,
    detalhes: [],
  };

  for (const conversa of lista) {
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
        agenteRaw === "triage" || agenteRaw === "triage_trabalhista";
      const developerMsg30 = emTriagem
        ? FOLLOWUP_30MIN_DEVELOPER_MSG_TRIAGE
        : FOLLOWUP_30MIN_DEVELOPER_MSG;

      const { responseContent, responseId, tokensUsed } =
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

      const mensagemData = await saveChatbotMessage(
        conversa.id,
        responseContent,
        "texto",
        undefined,
        cfg,
        atendimentoId,
      );

      await insertWhatsappConversationResponse(
        {
          responseId,
          whatsappMensagemId: mensagemData.id,
          modelUsed: cfg.aiModel,
          tokensUsed,
        },
        cfg,
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
 * `triage_trabalhista`, não encerra: finaliza o atendimento como transferido
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
  const result: FollowupResult = {
    conversas_encontradas: lista.length,
    processadas: 0,
    erros: 0,
    detalhes: [],
  };

  for (const conversa of lista) {
    try {
      const agenteRaw = await getOpenAtendimentoAgenteResponsavelRaw(
        conversa.id,
        cfg,
      );
      const encaminharParaFilaTriagem =
        agenteRaw === "triage" || agenteRaw === "triage_trabalhista";

      if (encaminharParaFilaTriagem) {
        try {
          await finalizarAtendimentosTransferidosFilaPorFollowup24hTriagem(
            conversa.id,
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

        const mensagemData = await saveChatbotMessage(
          conversa.id,
          responseContent,
          "texto",
          undefined,
          cfg,
          atendimentoId24,
        );

        await insertWhatsappConversationResponse(
          {
            responseId: generated.responseId,
            whatsappMensagemId: mensagemData.id,
            modelUsed: cfg.aiModel,
            tokensUsed: generated.tokensUsed,
          },
          cfg,
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
