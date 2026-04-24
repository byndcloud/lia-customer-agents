-- Liga cada mensagem ao ciclo de atendimento (novas linhas preenchem a partir do app).
ALTER TABLE whatsapp_mensagens
  ADD COLUMN IF NOT EXISTS atendimento_id uuid
  REFERENCES whatsapp_atendimentos (id)
  ON DELETE SET NULL;

COMMENT ON COLUMN whatsapp_mensagens.atendimento_id IS
  'whatsapp_atendimentos.id — escopo do histórico do atendimento; legado permanece NULL.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_mensagens_atendimento_created
  ON whatsapp_mensagens (atendimento_id, created_at)
  WHERE atendimento_id IS NOT NULL;
