-- Aplicada na criação do projeto: endereço das funções, primeiro membro e permissões.
insert into app_config (chave, valor) values ('functions_url', 'https://hisraarbwhuhovommgqo.supabase.co/functions/v1')
on conflict (chave) do update set valor = excluded.valor;
insert into membros (email) values ('rique.limberger@gmail.com') on conflict do nothing;
revoke execute on function public.eh_membro() from anon, public;
grant execute on function public.eh_membro() to authenticated;
