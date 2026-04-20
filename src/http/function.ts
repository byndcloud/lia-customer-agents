import type { Request, Response } from "express";
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
 * A instância Express é criada uma única vez por container, reaproveitada
 * entre invocações (warm start).
 */
const app = buildApp();

http("runAgentsHttp", (req: Request, res: Response) => {
  app(req, res);
});
