import "dotenv/config";

import { serve } from "@hono/node-server";
import { loadEnv } from "../config/env.js";
import { buildApp } from "./app.js";

/**
 * Entrypoint para Cloud Run (e execução local). Sobe o servidor HTTP (Hono)
 * na porta definida por `PORT` (default 3333; Cloud Run injeta `PORT`).
 */
function main(): void {
  const env = loadEnv();
  const app = buildApp({ env });

  const server = serve(
    {
      fetch: app.fetch,
      port: env.port,
    },
    (info) => {
      console.log(
        JSON.stringify({
          level: "info",
          event: "server_started",
          port: info.port,
          model: env.aiModel,
        }),
      );
    },
  );

  const shutdown = (signal: string) => {
    console.log(
      JSON.stringify({ level: "info", event: "shutdown_signal", signal }),
    );
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
