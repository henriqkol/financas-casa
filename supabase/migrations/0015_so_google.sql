-- Login só pelo Google (04/10/2026).
-- O provedor de e-mail continua ligado no Supabase porque os robôs de cada casa (robo-casa-N@financas-casa.app)
-- entram com senha para a sincronização agendada. Para pessoas, estas travas no banco fecham o caminho:
--   1. ninguém novo se cadastra por e-mail/senha ou link mágico (só Google);
--   2. ninguém (além dos robôs) consegue definir senha (bloqueia "esqueci a senha" e troca de senha);
--   3. entrar por senha, código ou link mágico falha para quem não é robô;
--   4. a senha antiga de quem já tinha é apagada.

create or replace function public.e_robo(e text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(e, '') ~ '^robo-casa-[0-9]+@financas-casa\.app$'
$$;

create or replace function public.trava_cadastro_sem_google() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.e_robo(new.email) then return new; end if;
  if tg_op = 'INSERT' and coalesce(new.raw_app_meta_data->>'provider', '') = 'email' then
    raise exception 'Cadastro só pelo Google';
  end if;
  if coalesce(new.encrypted_password, '') <> '' and new.encrypted_password is distinct from (case when tg_op = 'UPDATE' then old.encrypted_password end) then
    raise exception 'Este app não usa senha: entre com o Google';
  end if;
  return new;
end $$;

drop trigger if exists trava_cadastro_sem_google on auth.users;
create trigger trava_cadastro_sem_google before insert or update of encrypted_password, raw_app_meta_data on auth.users
  for each row execute function public.trava_cadastro_sem_google();

create or replace function public.trava_login_sem_google() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if new.authentication_method in ('password', 'otp', 'magiclink', 'email/signup', 'email_change', 'recovery', 'invite', 'anonymous') then
    select u.email into v_email from auth.sessions s join auth.users u on u.id = s.user_id where s.id = new.session_id;
    if not public.e_robo(v_email) then
      raise exception 'Entre com o Google';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trava_login_sem_google on auth.mfa_amr_claims;
create trigger trava_login_sem_google before insert or update on auth.mfa_amr_claims
  for each row execute function public.trava_login_sem_google();

revoke execute on function public.trava_cadastro_sem_google() from public, anon, authenticated;
revoke execute on function public.trava_login_sem_google() from public, anon, authenticated;

-- Senhas antigas de pessoas (o trigger acima permite apagar, só não permite definir)
update auth.users set encrypted_password = null where not public.e_robo(email) and coalesce(encrypted_password, '') <> '';
