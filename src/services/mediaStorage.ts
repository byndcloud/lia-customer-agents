import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { EnvConfig } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { getSupabaseClient } from "../db/client.js";

/**
 * Upload de mídia (áudio/imagem/vídeo/documento) recebida via Evolution para o
 * Supabase Storage. Retorna a URL pública para persistir em `whatsapp_mensagens`.
 */

interface UploadParams {
  /** Conteúdo em base64 vindo do webhook Evolution. */
  base64: string;
  mimeType: string;
  sender: "cliente" | "atendente";
  /** Nome original do arquivo, quando disponível (documentos). */
  originalFileName?: string | undefined;
}

function buildSanitizedFileName(params: {
  sender: string;
  mimeType: string;
  originalFileName?: string | undefined;
}): string {
  const fileType = params.mimeType.split("/")?.[0] || "application";
  const mimeExt = params.mimeType.split("/")?.[1] || "bin";

  const original = (params.originalFileName ?? "").trim();
  if (!original) {
    return `${params.sender}-${fileType}-${randomUUID()}.${mimeExt}`;
  }

  const normalized = original
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!normalized) {
    return `${params.sender}-${fileType}-${randomUUID()}.${mimeExt}`;
  }

  const lastDot = normalized.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot < normalized.length - 1;
  const base = (hasExt ? normalized.slice(0, lastDot) : normalized).slice(
    0,
    120,
  );
  const ext =
    (hasExt ? normalized.slice(lastDot + 1) : mimeExt).slice(0, 12) || mimeExt;
  return `${base}_${Date.now()}.${ext}`;
}

/**
 * Faz upload e retorna a URL pública do arquivo no bucket `whatsapp-files`
 * (configurável via env `STORAGE_BUCKET_WHATSAPP_FILES`).
 *
 * Lança se o upload falhar — o chamador decide se segue com fallback.
 */
export async function uploadMediaToStorage(
  params: UploadParams,
  env?: EnvConfig,
): Promise<string> {
  const cfg = env ?? loadEnv();
  const supabase = getSupabaseClient(cfg);
  const fileName = buildSanitizedFileName({
    sender: params.sender,
    mimeType: params.mimeType,
    originalFileName: params.originalFileName,
  });

  const fileBuffer = Buffer.from(params.base64, "base64");

  const { error: uploadError } = await supabase.storage
    .from(cfg.whatsappStorageBucket)
    .upload(fileName, fileBuffer, {
      contentType: params.mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrlData } = supabase.storage
    .from(cfg.whatsappStorageBucket)
    .getPublicUrl(fileName);

  if (!publicUrlData?.publicUrl) {
    throw new Error("Failed to get public URL after upload");
  }

  return publicUrlData.publicUrl;
}

/**
 * Validação rápida de tamanho a partir do comprimento do base64 (overhead ~33%).
 * Útil para rejeitar mídias maiores que o limite ANTES de fazer o upload.
 */
export function validateMediaSize(
  base64: string,
  maxSizeMB: number = 10,
): { valid: boolean; sizeMB: number } {
  const sizeBytes = (base64.length * 3) / 4;
  const sizeMB = sizeBytes / (1024 * 1024);
  return {
    valid: sizeMB <= maxSizeMB,
    sizeMB: parseFloat(sizeMB.toFixed(2)),
  };
}
