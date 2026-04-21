/**
 * Subconjunto do payload da Evolution API consumido pelo webhook.
 *
 * A Evolution envia muito mais campos, mas só precisamos destes para o
 * roteamento de mensagens. Mantemos `instance` opcional como `string` para
 * acomodar a forma `{ instance: { instanceName: ... } }` em versões antigas
 * (caso surja, basta normalizar ao entrar no handler).
 */
export interface EvolutionWebhookData {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string;
      remoteJidAlt?: string;
      fromMe: boolean;
      id: string;
    };
    pushName: string;
    message: {
      conversation?: string;
      base64?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { mimetype: string; caption?: string };
      stickerMessage?: { mimetype: string; caption?: string };
      audioMessage?: { mimetype: string; caption?: string };
      videoMessage?: { mimetype: string; caption?: string };
      documentMessage?: {
        mimetype: string;
        caption?: string;
        fileName?: string;
        title?: string;
      };
      [key: string]: unknown;
    };
    messageType: string;
    messageTimestamp: number;
    instanceId: string;
    source: string;
  };
  destination: string;
  date_time: string;
  sender: string;
  server_url: string;
  apikey: string;
}
