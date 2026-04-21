/**
 * Helpers de manipulação de números brasileiros vindos do WhatsApp.
 * Mantém compatibilidade exata com o formato esperado pela `findConversaByPhoneNumber`
 * (que considera o "9 extra" entre o DDD e o número).
 */

/**
 * Decompõe um número brasileiro (com ou sem `+`) em três partes:
 *  - `phoneNumber` — número completo prefixado com `+`
 *  - `firstFive`   — `+55XX` (DDI + DDD)
 *  - `lastEight`   — últimos 8 dígitos (sem o "9 extra" da posição 6)
 *
 * Para números fora do formato brasileiro (13 ou 14 caracteres com `+`),
 * retorna `null`.
 */
export function handlePhoneNumber(
  whatsappPhoneNumber: string,
): { phoneNumber: string; firstFive: string; lastEight: string } | null {
  const phoneNumber = whatsappPhoneNumber.startsWith("+")
    ? whatsappPhoneNumber
    : `+${whatsappPhoneNumber}`;

  const firstFive = phoneNumber.slice(0, 5);

  let lastEight: string;
  if (phoneNumber.length === 14) {
    lastEight = phoneNumber.slice(6, 14);
  } else if (phoneNumber.length === 13) {
    lastEight = phoneNumber.slice(5, 13);
  } else {
    console.warn(
      `⚠️ Invalid phone number format (non-Brazilian): ${phoneNumber}`,
    );
    return null;
  }

  return { phoneNumber, firstFive, lastEight };
}
