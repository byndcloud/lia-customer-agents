# lia-customer-agents

Serviço HTTP (Cloud Run / GCF 2ª gen, Node 20) que concentra **todo o fluxo
de conversa do WhatsApp da Lia**: agentes jurídicos (orquestrador + triagem +
consulta processual) usando o [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/),
**mais** as rotas migradas da edge function `chat-messages` (webhook
Evolution, geração de resposta, entrega, follow-ups).

## Arquitetura

```
Evolution API --webhook--> POST /webhook-evolution  (Cloud Run)
                                |
                                +--> persiste em whatsapp_mensagens
                                +--> upload de mídia em Supabase Storage
                                +--> enfileira no Cloud Tasks (~22s)
                                            |
                                            v
                            POST /generate-ai-response (Cloud Run)
                                |
                                +--> RPC claim_pending_chatbot_messages
                                +--> transcreve áudios via Whisper
                                +--> runAgents() -> OrchestratorAgent
                                                       |
                                                       +--> TriageAgent
                                                       +--> ProcessInfoAgent --> legis-mcp
                                +--> POST sendText (Evolution)

pg_cron --POST /followup-30min--> processFollowup30min  (Cloud Run)
pg_cron --POST /followup-24h----> processFollowup24h    (Cloud Run)

Frontend (futuro) --POST /deliver-response--> envia mensagem do atendente
```

- O serviço **lê e grava no Supabase** (mensagens, conversas, atendimentos,
  `response_id` para encadeamento). Use `SUPABASE_SERVICE_ROLE_KEY`.
- **Toda** requisição (inclusive `/health` e `/webhook-evolution`) exige
  `Authorization: Bearer <SUPABASE_ANON_KEY | SUPABASE_SERVICE_ROLE_KEY>`: o
  token após `Bearer` deve ser **igual** a uma das chaves configuradas no env
  (comparação time-safe). Em produção costuma-se usar a **service role** no
  servidor e na Evolution / Cloud Tasks.
- A edge function `chat-messages` **continua existindo** apenas para as
  rotas administrativas da Evolution (`/instance`, `/connection-state`,
  `/set-webhook`, `/deactivate-number`).

## Instalação (dev)

```bash
npm install
```

## Scripts

| Script | O que faz |
| --- | --- |
| `npm run dev` | Sobe o servidor Express com `tsx watch` (hot reload). |
| `npm run start` | Executa `node dist/http/server.js` (usado em Cloud Run). |
| `npm run start:function` | Sobe via `functions-framework` (simula GCF 2ª gen local). |
| `npm run typecheck` | Verifica tipos. |
| `npm run build` | Gera `dist/`. |
| `npm test` | Roda os testes com Vitest + Supertest. |

## Rotas HTTP

> Todas as rotas exigem `Authorization: Bearer` com a anon key ou a service role key do Supabase (mesmo valor que está no env).

| Rota | Quem chama | O que faz |
| --- | --- | --- |
| `GET /health` | Cloud Run probe | Liveness. Retorna `{ "status": "ok" }`. |
| `POST /run` | Uso interno / testes | Executa os agentes diretamente para uma `RunInput`. |
| `POST /webhook-evolution` | Evolution API | Recebe mensagens/eventos do WhatsApp, persiste, sobe mídia, enfileira no Cloud Tasks. |
| `POST /generate-ai-response` | Cloud Tasks | Faz claim do batch agregado, transcreve áudios e chama `runAgents()`. |
| `POST /deliver-response` | Frontend / atendente | Envia uma mensagem (texto/áudio/mídia) via Evolution e persiste em `whatsapp_mensagens`. |
| `POST /followup-30min` | `pg_cron` | Gera mensagem de "ainda precisa de ajuda?" para conversas ~30 min inativas. |
| `POST /followup-24h` | `pg_cron` | Encerra conversas inativas há 24h com mensagem de despedida. |

### `GET /health`
Retorna `{ "status": "ok" }`. Configure o healthcheck (Cloud Run / load balancer) para enviar o mesmo header.

### `POST /run`
Executa os agentes. Útil para testes ou integrações externas.

Body com `RunInput`:

```json
{
  "userMessage": "Oi, queria saber como está o andamento do meu processo",
  "conversationId": "conv-123",
  "organizationId": "org-456",
  "clientId": "cli-789",
  "calendarConnectionId": "cal-abc",
  "previousResponseId": "resp_abc123",
  "extra": { "clientName": "Maria" }
}
```

Resposta:

```json
{
  "output": "Olá! Sou a Lia...",
  "agentUsed": "triage",
  "responseId": "resp_xyz789",
  "usage": {
    "requests": 2,
    "inputTokens": 812,
    "outputTokens": 140,
    "totalTokens": 952
  }
}
```

Códigos de erro:

| Status | Quando |
| --- | --- |
| 400 | Body inválido (falha de Zod) — detalhes em `details`. |
| 401 | `Authorization` ausente, sem `Bearer`, ou token após `Bearer` diferente das chaves Supabase configuradas. |
| 500 | Nenhuma de `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` configurada (`server_misconfigured`) ou erro interno. |

## Variáveis de ambiente

### Núcleo (agentes)

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `OPENAI_API_KEY` | **sim** | Usada pelo Agents SDK e pelo Whisper (transcrição de áudio). |
| `MCP_SERVER_URL` | sim (para consulta processual) | URL do servidor MCP `legis-mcp`. |
| `MCP_SERVER_API_KEY` | não | Quando presente, é enviado como `Authorization: Bearer ...` para o MCP. |
| `AI_MODEL` | não | Default: `gpt-5-mini`. |
| `PORT` | não | Default local: `3333`. Em Cloud Run, a plataforma define `PORT`. |

### Supabase (persistência + storage de mídia)

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `SUPABASE_URL` | **sim** | URL do projeto (`https://<ref>.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | **sim*** | Service role: DB, Storage e **Bearer HTTP** (recomendado para Evolution, Cloud Tasks, etc.). |
| `SUPABASE_ANON_KEY` | sim* | Anon key: também aceita no `Authorization: Bearer` se preferir. |

\* Pelo menos **uma** das duas chaves deve estar definida; o Bearer deve ser **idêntico** a uma delas.
| `STORAGE_BUCKET_WHATSAPP_FILES` | não | Default: `whatsapp-files`. |

### Evolution API (envio/recepção WhatsApp)

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `EVOLUTION_API_URL` | **sim** | URL base da Evolution (sem barra final). |
| `EVOLUTION_API_KEY` | **sim** | API key da Evolution (header `apikey`). |

### Cloud Tasks (agregação de mensagens, ~22s)

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | **sim** | JSON serializado da SA com permissão `roles/cloudtasks.enqueuer`. |
| `SELF_PUBLIC_BASE_URL` | **sim** | URL pública deste serviço (Cloud Run). Ex.: `https://lia-agents-XXXX-uc.a.run.app`. Usada como `targetUrl` da task. |
| `GOOGLE_CLOUD_TASKS_LOCATION` | não | Default: `us-central1`. |
| `CHATBOT_QUEUE_NAME` | não | Default: `lia`. |
| `CHATBOT_QUEUE_DELAY_SECONDS` | não | Default: `22`. |

### Follow-ups

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `FOLLOWUP_30MIN_SECONDS` | não | Default: `1800` (30 min). |
| `FOLLOWUP_24H_SECONDS` | não | Default: `86400` (24h). |

## Deploy

### Opção A — Google Cloud Functions (2ª geração)

1. `npm run build`
2. Deploy com `gcloud`:

   ```bash
   gcloud functions deploy lia-agents \
     --gen2 \
     --runtime=nodejs20 \
     --region=us-central1 \
     --source=. \
     --entry-point=runAgentsHttp \
     --trigger-http \
     --set-env-vars="AI_MODEL=gpt-5-mini" \
     --set-secrets="OPENAI_API_KEY=openai-api-key:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,SUPABASE_ANON_KEY=supabase-anon-key:latest,MCP_SERVER_URL=mcp-url:latest,MCP_SERVER_API_KEY=mcp-key:latest"
   ```

   O entrypoint `runAgentsHttp` está em `dist/http/function.js`.

### Opção B — Cloud Run (container)

1. Build da imagem (com o `Dockerfile` deste repo):

   ```bash
   gcloud builds submit --tag gcr.io/PROJECT_ID/lia-agents
   ```

2. Deploy:

   ```bash
   gcloud run deploy lia-agents \
     --image gcr.io/PROJECT_ID/lia-agents \
     --region us-central1 \
     --platform managed \
     --memory 512Mi \
     --set-secrets="OPENAI_API_KEY=openai-api-key:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,SUPABASE_ANON_KEY=supabase-anon-key:latest,MCP_SERVER_URL=mcp-url:latest,MCP_SERVER_API_KEY=mcp-key:latest"
   ```

## Uso pela edge function

Supabase Edge Function (Deno), exemplo simplificado:

```ts
const resp = await fetch(`${CLOUD_FUNCTION_URL}/run`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
  },
  body: JSON.stringify({
    userMessage,
    conversationId,
    organizationId,
    clientId,
    calendarConnectionId,
    previousResponseId,
  }),
});

if (!resp.ok) throw new Error(`agents_failed:${resp.status}`);

const data = await resp.json();
await saveToSupabase(data.output, data.responseId, data.usage);
```

## Encadeamento de conversa

A rota `/run` **não** lê conversa anterior; é responsabilidade do chamador
guardar o `responseId` retornado e enviar como `previousResponseId` na
próxima chamada.

A rota `/generate-ai-response` **lê** o último `response_id` da conversa
(via `whatsapp_conversation_responses`) e injeta automaticamente no
`runAgents()`. Persiste o novo `response_id` ao final.

## Contrato (`RunInput`)

A rota `/run` aceita uma das duas formas (mas não ambas):

| Campo | Tipo | Obrigatório | Observações |
| --- | --- | --- | --- |
| `userMessage` | `string` | um dos dois | Mensagem única (ex.: chamada direta). |
| `inputs` | `Array<{role:"user", content:string}>` | um dos dois | Lote agregado (usado por `/generate-ai-response` para preservar a separação semântica entre mensagens). |
| `conversationId` | `string` | sim | Vira `X-Conversation-Id` no MCP. |
| `organizationId` | `string` | sim | Vira `X-Organization-Id` no MCP. |
| `clientId` | `string` | não | `whatsapp_conversas.pessoa_id` quando já vinculado; se omitido, triagem trata cliente novo / número sem pessoa. `X-Client-Id` no MCP só é enviado quando existe. |
| `calendarConnectionId` | `string` | não | Vira `X-Calendar-Connection-Id`. |
| `previousResponseId` | `string` | não | `response_id` anterior. |
| `extra` | `Record<string, unknown>` | não | Contexto adicional do chamador. |

## Migração da edge function `chat-messages`

O fluxo de chat WhatsApp (webhook + IA + entrega + follow-ups) viveu
historicamente em `legis-prod/supabase/functions/chat-messages` (Deno + Hono)
e foi portado para este serviço (Node + Express). A edge function continua
hospedando apenas as **rotas administrativas da Evolution**:

- `POST /chat-messages/instance`
- `POST /chat-messages/connection-state`
- `POST /chat-messages/set-webhook`
- `POST /chat-messages/deactivate-number`

### Pontos a ajustar fora deste repo

1. **Webhook da Evolution**: ao registrar a instância (`/set-webhook`),
   apontar `url` para `${SELF_PUBLIC_BASE_URL}/webhook-evolution` em vez de
   `${supabaseUrl}/functions/v1/chat-messages/webhook-evolution`. O
   `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (ou anon, se preferir)
   precisa estar no header configurado no Evolution.
2. **`pg_cron`**: trocar a URL dos jobs `followup-30min`/`followup-24h`
   para o Cloud Run; manter o mesmo Bearer.
3. **Frontend (`legis-prod`)**: hooks como `useWhatsAppMensagens` chamam
   `supabase.functions.invoke('chat-messages/deliver-response', ...)`.
   Precisam ser migrados para chamar diretamente `POST /deliver-response`
   no Cloud Run — **não** exponha a `SUPABASE_SERVICE_ROLE_KEY` no browser;
   use uma RPC/edge function ou sessão autenticada no backend.

## Adicionando novos agentes

1. Criar o prompt em `src/agents/instructions/<novo>.instructions.ts`.
2. Criar a fábrica `buildXyzAgent` em `src/agents/<novo>.agent.ts`.
3. Registrar como handoff em `src/agents/orchestrator.agent.ts` e atualizar as regras de roteamento do prompt do orquestrador.
4. Se precisar de MCP, reutilize `buildLegisMcpTool` ou crie nova fábrica em `src/mcp/`.

## Estrutura

```
src/
├── index.ts                          # exports públicos
├── types.ts                          # RunInput/RunOutput (Zod)
├── types/evolution.ts                # tipos do payload do webhook
├── config/
│   ├── env.ts                        # loadEnv()
│   └── openai-client.ts              # client OpenAI cacheado (Whisper, Responses)
├── db/
│   ├── client.ts                     # client Supabase cacheado
│   ├── conversations.ts
│   ├── messages.ts
│   ├── instances.ts
│   ├── atendimentos.ts
│   └── responses.ts
├── services/
│   ├── audioTranscription.ts        # Whisper
│   ├── conversationContext.ts       # decide previousResponseId
│   ├── conversationFlowInterceptor.ts
│   ├── conversationRestarter.ts
│   ├── evolutionApi.ts              # cliente Evolution
│   ├── followupService.ts           # 30 min + 24h
│   ├── mediaConverter.ts
│   ├── mediaStorage.ts              # upload p/ Supabase Storage
│   ├── phone.ts
│   ├── queueService.ts              # Cloud Tasks
│   ├── whatsapp.ts
│   └── whatsappInstanceResolver.ts
├── mcp/legis-mcp.ts                  # headers + hostedMcpTool
├── runtime/run-agents.ts             # função runAgents()
├── agents/
│   ├── orchestrator.agent.ts
│   ├── triage.agent.ts
│   ├── process-info.agent.ts
│   └── instructions/...
└── http/
    ├── app.ts                        # Express app + rotas
    ├── auth.ts                       # Bearer = anon ou service_role (env)
    ├── server.ts                     # entrypoint Cloud Run
    ├── function.ts                   # entrypoint Cloud Functions (GCF 2ª gen)
    └── routes/
        ├── run.ts
        ├── webhookEvolution.ts
        ├── generateAiResponse.ts
        ├── deliverResponse.ts
        ├── followup30min.ts
        └── followup24h.ts
```
