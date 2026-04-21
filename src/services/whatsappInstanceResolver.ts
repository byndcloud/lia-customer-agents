import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "../db/client.js";
import { getActiveWhatsAppInstance } from "../db/instances.js";

interface ResolveInstanceParams {
  instancia?: string | undefined;
  conversaId: string;
}

interface ResolveInstanceResult {
  instancia: string;
  error?: string | undefined;
}

/**
 * Decide qual instância Evolution usar para responder a uma conversa.
 * Se o chamador já passar `instancia`, devolve direto. Caso contrário busca a
 * instância ativa da organização da conversa.
 */
export async function resolveWhatsAppInstance(
  { instancia, conversaId }: ResolveInstanceParams,
  env?: EnvConfig,
): Promise<ResolveInstanceResult> {
  if (instancia) {
    return { instancia };
  }

  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("whatsapp_conversas")
    .select("organization_id")
    .eq("id", conversaId)
    .single<{ organization_id: string }>();

  if (
    !data ||
    (error as { code?: string } | null)?.code === "PGRST116"
  ) {
    return { instancia: "", error: "Conversation not found" };
  }

  const active = await getActiveWhatsAppInstance(data.organization_id, env);
  if (!active) {
    return {
      instancia: "",
      error: "No active WhatsApp instance configured for this organization",
    };
  }

  return { instancia: active };
}
