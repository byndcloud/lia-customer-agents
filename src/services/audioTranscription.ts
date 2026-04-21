import { Buffer } from "node:buffer";
import { toFile } from "openai";
import type { EnvConfig } from "../config/env.js";
import { getOpenAIClient } from "../config/openai-client.js";

/**
 * Transcrição de áudio via Whisper (OpenAI). Usado pelo `generate-ai-response`
 * antes de montar o input para o agente.
 */

export interface AudioTranscriptionResult {
  success: boolean;
  transcription?: string;
  error?: string;
}

const SUPPORTED_FORMATS = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/m4a",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
]);

type AudioExt = "mp3" | "wav" | "ogg" | "webm" | "m4a";

const MIME_TO_EXT: Record<string, AudioExt> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/aac": "m4a",
  "audio/x-m4a": "m4a",
};

function baseMime(mimetype: string): string {
  const head = mimetype.split(";")[0] ?? mimetype;
  return head.trim().toLowerCase();
}

function getAudioFormat(mimetype: string): AudioExt {
  return MIME_TO_EXT[baseMime(mimetype)] ?? "ogg";
}

export function isSupportedAudioFormat(mimetype: string): boolean {
  return SUPPORTED_FORMATS.has(baseMime(mimetype));
}

/**
 * Baixa o áudio do Supabase Storage (URL pública) e transcreve via Whisper.
 *
 * Erros são capturados e devolvidos como `{ success: false, error }` para o
 * chamador decidir se segue com placeholder.
 */
export async function transcribeAudioFromStorage(
  storageUrl: string,
  mimetype: string,
  env?: EnvConfig,
): Promise<AudioTranscriptionResult> {
  try {
    const response = await fetch(storageUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch audio from storage: ${response.status}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const format = getAudioFormat(mimetype);
    const file = await toFile(Buffer.from(arrayBuffer), `audio.${format}`, {
      type: mimetype,
    });

    const openai = getOpenAIClient(env);
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
      response_format: "text",
    });

    return {
      success: true,
      transcription: transcription as unknown as string,
    };
  } catch (error) {
    console.error("❌ [AudioTranscription] Erro na transcrição:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Erro desconhecido na transcrição",
    };
  }
}

/**
 * Transcrição direta a partir de base64 (ainda usado quando o áudio não foi
 * subido para storage ou para testes locais).
 */
export async function transcribeAudioWithWhisper(
  audioBase64: string,
  mimetype: string,
  env?: EnvConfig,
): Promise<AudioTranscriptionResult> {
  try {
    const buffer = Buffer.from(audioBase64, "base64");
    const format = getAudioFormat(mimetype);
    const file = await toFile(buffer, `audio.${format}`, { type: mimetype });

    const openai = getOpenAIClient(env);
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
      response_format: "text",
    });

    return {
      success: true,
      transcription: transcription as unknown as string,
    };
  } catch (error) {
    console.error("❌ [AudioTranscription] Erro na transcrição:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Erro desconhecido na transcrição",
    };
  }
}
