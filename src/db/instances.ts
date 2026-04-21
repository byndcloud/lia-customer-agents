import type { EnvConfig } from "../config/env.js";
import { getSupabaseClient } from "./client.js";

/**
 * Helpers sobre `whatsapp_numeros` (instância Evolution -> organização).
 */

export interface OrganizationByInstance {
  organization_id: string;
  instance_name: string;
  triage_enabled: boolean;
}

/**
 * Resolve organização (e flag de triagem) a partir do nome da instância
 * Evolution. Retorna `null` quando o webhook chega para uma instância sem
 * registro ativo (caso típico: instância recém-deletada).
 */
export async function getOrganizationByInstanceName(
  instanceName: string,
  env?: EnvConfig,
): Promise<OrganizationByInstance | null> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase
    .from("whatsapp_numeros")
    .select("organization_id, instance_name, triage_enabled")
    .eq("instance_name", instanceName)
    .eq("is_active", true)
    .single<OrganizationByInstance>();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }

  return data;
}

/**
 * Retorna o `instance_name` da instância ativa de uma organização. Usado
 * pelos followups para escolher a instância para o envio.
 */
export async function getActiveWhatsAppInstance(
  organizationId: string,
  env?: EnvConfig,
): Promise<string | null> {
  const supabase = getSupabaseClient(env);

  const { data, error } = await supabase
    .from("whatsapp_numeros")
    .select("instance_name")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .single<{ instance_name: string }>();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }

  return data?.instance_name ?? null;
}
