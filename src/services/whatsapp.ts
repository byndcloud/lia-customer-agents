import type { EnvConfig } from "../config/env.js";
import {
  findConversaByPhoneNumber,
  type WhatsappConversa,
} from "../db/conversations.js";
import { handlePhoneNumber } from "./phone.js";

/**
 * Façade voltada à rota `webhookEvolution`: recebe o número cru vindo do
 * webhook e devolve a conversa do escritório que o atende. Devolve `null`
 * quando o número não é brasileiro (formato inválido) ou inexistente.
 */
export async function getConversaByPhoneNumber(
  number: string,
  organizationId: string,
  env?: EnvConfig,
): Promise<WhatsappConversa | null> {
  const dataPhoneNumber = handlePhoneNumber(number);
  if (!dataPhoneNumber) return null;
  return findConversaByPhoneNumber(
    { ...dataPhoneNumber, organizationId },
    env,
  );
}
