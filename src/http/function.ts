import { getRequestListener } from "@hono/node-server";
import { http } from "@google-cloud/functions-framework";
import { buildApp } from "./app.js";

/**
 * Entrypoint para Google Cloud Functions (2ª geração) via
 * `functions-framework`. Registra o handler HTTP com o nome `runAgentsHttp`.
 *
 * Deploy:
 *   gcloud functions deploy lia-agents \
 *     --gen2 --runtime=nodejs20 --region=us-central1 \
 *     --source=. --entry-point=runAgentsHttp --trigger-http
 *
 * O app Hono é criado uma única vez por container, reaproveitado entre
 * invocações (warm start).
 */
const app = buildApp();
const listener = getRequestListener(app.fetch);

http("runAgentsHttp", listener);
