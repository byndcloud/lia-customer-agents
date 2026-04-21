/**
 * Interceptor de fluxo (mantido por compatibilidade com a edge function).
 *
 * O sistema de avaliação foi migrado para o MCP, então este interceptor
 * devolve sempre `{ shouldIntercept: false }`. Mantemos a função para que
 * a rota `generateAiResponse` continue com o mesmo formato e fique fácil de
 * voltar a interceptar mensagens no futuro, se necessário.
 */

export interface InterceptionResult {
  shouldIntercept: boolean;
  reason?: string;
  action?: "finalize_and_restart" | "continue_flow";
}

export async function shouldInterceptMessage(
  _conversaId: string,
  _userMessage: string,
): Promise<InterceptionResult> {
  return { shouldIntercept: false, action: "continue_flow" };
}

export async function finalizeAndRestart(conversaId: string): Promise<void> {
  console.log(
    `ℹ️ finalizeAndRestart chamado para ${conversaId} - sistema de avaliação desabilitado`,
  );
}
