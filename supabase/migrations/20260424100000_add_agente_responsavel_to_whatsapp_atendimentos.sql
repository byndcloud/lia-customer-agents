-- Agent responsible for the active chatbot turn (orchestrator | triage | process_info).
-- History is loaded from whatsapp_mensagens by atendimento window, not OpenAI session.
ALTER TABLE whatsapp_atendimentos
ADD COLUMN IF NOT EXISTS agente_responsavel TEXT;

COMMENT ON COLUMN whatsapp_atendimentos.agente_responsavel IS
  'IA agent responsible for this atendimento: orchestrator, triage, or process_info.';

-- Backfill active chatbot rows so reads never see NULL for in-flight bot atendimentos.
UPDATE whatsapp_atendimentos
SET agente_responsavel = 'orchestrator'
WHERE agente_responsavel IS NULL
  AND finalizado_em IS NULL
  AND tipo_responsavel = 'chatbot';

CREATE INDEX IF NOT EXISTS idx_whatsapp_atendimentos_active_agente
  ON whatsapp_atendimentos (conversa_id, agente_responsavel)
  WHERE finalizado_em IS NULL;
