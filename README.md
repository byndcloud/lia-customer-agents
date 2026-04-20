# lia-customer-agents

Cloud function HTTP que expõe os agentes jurídicos (orquestrador + triagem + consulta processual) usando o [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/). Foi desenhada para rodar em **Google Cloud Functions (2ª gen)** ou **Cloud Run**, sendo chamada pela edge function existente da Lia via HTTP.

## Arquitetura

```
edgeFunction (Supabase) --HTTP--> Cloud Function (Node 20)
                                    |
                                    +--> runAgents() -> OrchestratorAgent
                                                           |
                                                           +--> TriageAgent (Direito do Trabalho)
                                                           +--> ProcessInfoAgent --> legis-mcp
```

- A cloud function é **stateless**. Não grava em Supabase — o chamador é responsável por persistir mensagens, `response_id`, etc.
- **Toda** requisição (inclusive `/health`) exige `Authorization: Bearer <API_SECRET_TOKEN>`. Só o token **após** `Bearer` é comparado com a env `API_SECRET_TOKEN` (time-safe).
- Headers de contexto (`X-Conversation-Id`, etc.) viajam dentro do **body** (`RunInput`); a edge function repassa para o MCP quando monta os headers internos do `legis-mcp`.

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

### `GET /health`
Requer `Authorization: Bearer <API_SECRET_TOKEN>`. Retorna `{ "status": "ok" }`. Configure o healthcheck (Cloud Run / load balancer) para enviar o mesmo header.

### `POST /run`
Header obrigatório: `Authorization: Bearer <API_SECRET_TOKEN>` (o valor após `Bearer` deve ser exatamente o definido em `API_SECRET_TOKEN` no servidor).

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
| 401 | `Authorization` ausente, sem `Bearer`, ou token após `Bearer` diferente de `API_SECRET_TOKEN`. |
| 500 | `API_SECRET_TOKEN` não configurado no servidor (`server_misconfigured`) ou erro interno. |

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `OPENAI_API_KEY` | sim | Usada pelo SDK da OpenAI. |
| `SUPABASE_URL` | recomendado | URL do projeto Supabase (`https://<ref>.supabase.co`). Carregada para futuras integrações/observabilidade. |
| `SUPABASE_ANON_KEY` | não* | Chave anon do projeto (útil se você usar o client Supabase neste serviço no futuro; **não** é o Bearer HTTP). |
| `SUPABASE_SERVICE_ROLE_KEY` | não* | Service role (idem). |
| `API_SECRET_TOKEN` | **sim** | Segredo enviado como `Authorization: Bearer <valor>` em **todas** as rotas. Gere algo aleatório e longo (ex.: `openssl rand -hex 32`). |
| `MCP_SERVER_URL` | sim (para consulta processual) | URL do servidor MCP `legis-mcp`. |
| `MCP_SERVER_API_KEY` | não | Quando presente, é enviado como `Authorization: Bearer ...` para o MCP. |
| `AI_MODEL` | não | Default: `gpt-5-mini`. |
| `PORT` | não | Default local: `3333` (evita conflito com 8080/3000). Em Cloud Run, a plataforma define `PORT`. |

\* Opcional para este serviço enquanto ele não chama o Supabase diretamente; a edge function continua sendo quem persiste dados.

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
     --set-secrets="OPENAI_API_KEY=openai-api-key:latest,SUPABASE_URL=supabase-url:latest,API_SECRET_TOKEN=lia-api-secret-token:latest,MCP_SERVER_URL=mcp-url:latest,MCP_SERVER_API_KEY=mcp-key:latest"
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
     --set-secrets="OPENAI_API_KEY=openai-api-key:latest,SUPABASE_URL=supabase-url:latest,API_SECRET_TOKEN=lia-api-secret-token:latest,MCP_SERVER_URL=mcp-url:latest,MCP_SERVER_API_KEY=mcp-key:latest"
   ```

## Uso pela edge function

Supabase Edge Function (Deno), exemplo simplificado:

```ts
const resp = await fetch(`${CLOUD_FUNCTION_URL}/run`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${Deno.env.get("LIA_API_SECRET_TOKEN")!}`,
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

A cloud function **não** lê conversa anterior. O chamador guarda o `responseId` retornado e envia como `previousResponseId` na próxima chamada. O SDK da OpenAI cuida de montar o histórico a partir disso.

## Contrato (`RunInput`)

| Campo | Tipo | Obrigatório | Observações |
| --- | --- | --- | --- |
| `userMessage` | `string` | sim | Mensagem da rodada. |
| `conversationId` | `string` | sim | Vira `X-Conversation-Id` no MCP. |
| `organizationId` | `string` | sim | Vira `X-Organization-Id` no MCP. |
| `clientId` | `string` | sim | Vira `X-Client-Id` no MCP. |
| `calendarConnectionId` | `string` | não | Vira `X-Calendar-Connection-Id`. |
| `previousResponseId` | `string` | não | `response_id` anterior. |
| `extra` | `Record<string, unknown>` | não | Contexto adicional do chamador. |

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
├── config/env.ts                     # loadEnv()
├── mcp/legis-mcp.ts                  # headers + hostedMcpTool
├── runtime/run-agents.ts             # função runAgents()
├── agents/
│   ├── orchestrator.agent.ts
│   ├── triage.agent.ts
│   ├── process-info.agent.ts
│   └── instructions/...
└── http/
    ├── app.ts                        # Express app + rotas
    ├── auth.ts                       # Bearer token = API_SECRET_TOKEN
    ├── server.ts                     # entrypoint Cloud Run
    └── function.ts                   # entrypoint Cloud Functions (GCF 2ª gen)
```
