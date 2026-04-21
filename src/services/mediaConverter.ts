import { Buffer } from "node:buffer";

/**
 * Converte uma URL de arquivo público para base64. Usado pelo `deliverResponse`
 * antes de enviar mídia para a Evolution (a API espera base64, não URL).
 *
 * Limita o tamanho a 10 MB e usa um timeout para não travar o request.
 */
export async function convertUrlToBase64(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch file: ${response.status} ${response.statusText}`,
      );
    }

    const contentLength = response.headers.get("content-length");
    const maxBytes = 10 * 1024 * 1024;
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error("File too large");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error("File too large");
    }
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (error) {
    throw new Error(
      `Failed to convert URL to base64: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Verifica se uma string é uma URL HTTP(S) válida. */
export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
