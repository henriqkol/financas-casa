-- =====================================================================
-- Sincronização automática com o Open Finance (2x por dia).
-- 09:15 e 21:15 UTC = 06:15 e 18:15 em Brasília.
-- A URL das funções fica em app_config('functions_url'),
-- ex.: https://<projeto>.supabase.co/functions/v1
-- =====================================================================
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function disparar_sync() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  base text := (select valor from app_config where chave = 'functions_url');
  segredo text := (select valor from app_config where chave = 'cron_secret');
begin
  if base is null then
    raise notice 'functions_url não configurada';
    return;
  end if;
  perform net.http_post(
    url := base || '/api/sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := '{"origem":"agendado"}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;
revoke all on function disparar_sync() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('sync-open-finance')
  where exists (select 1 from cron.job where jobname = 'sync-open-finance');
  perform cron.schedule('sync-open-finance', '15 9,21 * * *', 'select public.disparar_sync()');
end $$;
