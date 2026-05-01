-- Uma conversa por (organization_id, numero_whatsapp).
-- Impede duas linhas na corrida de webhooks paralelos; o app trata 23505 refazendo o SELECT.
--
-- Se este ALTER falhar por duplicatas existentes, deduplicar whatsapp_conversas antes
-- (mesmo org + mesmo numero_whatsapp) e reexecutar.

ALTER TABLE public.whatsapp_conversas
  ADD CONSTRAINT whatsapp_conversas_org_numero_unique
  UNIQUE (organization_id, numero_whatsapp);
