-- Verificação rápida a cada 30 minutos (aplicado via SQL em 01/10/2026): a função api/verificar
-- pergunta à Pluggy se alguma conexão foi atualizada e só então sincroniza. Os horários fogem
-- dos minutos da sincronização completa (06:15 e 18:15 de Brasília).
select cron.schedule('verificar-pluggy', '7,37 * * * *', $$select net.http_post(
  url := (select valor from app_config where chave='functions_url') || '/api/verificar',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select valor from app_config where chave='cron_secret')),
  body := '{}'::jsonb, timeout_milliseconds := 150000)$$);
