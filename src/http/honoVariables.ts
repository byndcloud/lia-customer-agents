import type { EnvConfig } from "../config/env.js";

/**
 * Variáveis por request no app Hono (`c.set` / `c.var`).
 */
export type LiaHttpVariables = {
  readonly env: EnvConfig;
  /** Corpo JSON parseado (middleware global); omitido em GET/HEAD ou sem `application/json`. */
  readonly jsonBody?: unknown;
};
