-- No máximo um atendimento "aberto" (finalizado_em nulo) por conversa.
-- Evita duas inserções em webhooks paralelos; o app trata 23505 refazendo o SELECT.
--
-- Se falhar por já existirem duas linhas ativas para a mesma conversa, deduplicar
-- manualmente (finalizar uma delas) e reexecutar.

CREATE UNIQUE INDEX whatsapp_atendimentos_one_open_per_conversa
  ON public.whatsapp_atendimentos (conversa_id)
  WHERE (finalizado_em IS NULL);
