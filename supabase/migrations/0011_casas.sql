-- =====================================================================
-- Várias casas no mesmo app e no mesmo banco
--
-- • Cada pessoa que entra pela primeira vez ganha a própria casa, já com as
--   categorias e regras padrão — a não ser que tenha sido convidada: aí entra
--   direto na casa de quem convidou.
-- • Convite = colocar o e-mail em "membros" da sua casa (Mais → Quem tem acesso).
--   Quem pertence a mais de uma casa escolhe qual abrir (tabela usuarios).
-- • Todas as tabelas de dados ganham casa_id, preenchido sozinho com a casa
--   aberta, e as regras de segurança passam a mostrar só a casa aberta.
-- • As chaves da Pluggy (e da Anthropic) ficam em casa_config, uma por casa,
--   visível só para o servidor.
-- Os dados que já existiam formam a casa 1.
-- =====================================================================

-- ---------- Casas e usuários --------------------------------------------------------
create table if not exists casas (
  id serial primary key,
  nome text not null,
  criado_por text,
  criado_em timestamptz not null default now()
);
comment on table casas is 'Cada casa (família) tem seus próprios dados. Os dados antigos são a casa 1.';
insert into casas (id, nome, criado_por) values (1, 'Casa Limberger', 'rique.limberger@gmail.com') on conflict (id) do nothing;
select setval('casas_id_seq', greatest((select max(id) from casas), 1));

create table if not exists usuarios (
  email text primary key check (email = lower(email)),
  casa_id int not null references casas(id) on delete cascade,
  atualizado_em timestamptz not null default now()
);
comment on table usuarios is 'Qual casa cada pessoa está com aberta no app (quem participa de mais de uma casa pode trocar).';

-- ---------- Membros passam a ser por casa --------------------------------------------
alter table membros add column if not exists casa_id int references casas(id) on delete cascade;
alter table membros add column if not exists aceito_em timestamptz;
update membros set casa_id = 1 where casa_id is null;
update membros set email = lower(email), aceito_em = coalesce(aceito_em, now());
alter table membros alter column casa_id set not null;
alter table membros drop constraint if exists membros_pkey;
alter table membros add primary key (casa_id, email);
alter table membros drop constraint if exists membros_email_minusculo;
alter table membros add constraint membros_email_minusculo check (email = lower(email));
comment on table membros is 'Quem tem acesso a cada casa. Inserir um e-mail aqui é o convite; aceito_em fica vazio até a pessoa abrir o app.';

insert into usuarios (email, casa_id) select email, 1 from membros where casa_id = 1 on conflict (email) do nothing;

-- Casa aberta por quem está logado (null = sem casa)
create or replace function casa_atual() returns int
language sql stable security definer set search_path = public as $$
  select u.casa_id from usuarios u
  join membros m on m.casa_id = u.casa_id and m.email = u.email
  where u.email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
comment on function casa_atual() is 'Casa aberta pela pessoa logada; base de todas as regras de segurança.';

create or replace function eh_membro() returns boolean
language sql stable security definer set search_path = public as $$ select casa_atual() is not null $$;

-- ---------- casa_id em todas as tabelas de dados --------------------------------------
do $$
declare t text;
begin
  foreach t in array array['caixinhas','categorias','contas','divida_pagamentos','divida_saldos','dividas',
    'investimento_saldos','investimentos','nota_itens','nota_transacao','notas','objetivos','orcamento_grupos',
    'orcamento_itens','pluggy_itens','preferencias','regras_categoria','sync_log','transacoes'] loop
    execute format('alter table %I add column if not exists casa_id int references casas(id) on delete cascade', t);
    execute format('update %I set casa_id = 1 where casa_id is null', t);
    execute format('alter table %I alter column casa_id set not null', t);
    execute format('alter table %I alter column casa_id set default casa_atual()', t);
    execute format('create index if not exists %I on %I (casa_id)', t || '_casa_idx', t);
    execute format('drop policy if exists membros_tudo on %I', t);
    execute format('drop policy if exists casa_tudo on %I', t);
    execute format('create policy casa_tudo on %I for all to authenticated using (casa_id = (select casa_atual())) with check (casa_id = (select casa_atual()))', t);
  end loop;
end $$;

-- Únicos passam a valer dentro de cada casa
alter table categorias drop constraint if exists categorias_nome_key;
alter table categorias add constraint categorias_nome_key unique (casa_id, nome);
alter table regras_categoria drop constraint if exists regras_categoria_alvo_tipo_padrao_key;
alter table regras_categoria add constraint regras_categoria_alvo_tipo_padrao_key unique (casa_id, alvo, tipo, padrao);
alter table notas drop constraint if exists notas_chave_key;
alter table notas add constraint notas_chave_key unique (casa_id, chave);
alter table caixinhas drop constraint if exists caixinhas_nome_key;
alter table caixinhas add constraint caixinhas_nome_key unique (casa_id, nome);
alter table orcamento_grupos drop constraint if exists orcamento_grupos_nome_key;
alter table orcamento_grupos add constraint orcamento_grupos_nome_key unique (casa_id, nome);
alter table objetivos drop constraint if exists objetivos_titulo_key;
alter table objetivos add constraint objetivos_titulo_key unique (casa_id, titulo);
alter table preferencias drop constraint if exists preferencias_pkey;
alter table preferencias add primary key (casa_id, chave);

-- ---------- Segurança das tabelas novas e de membros ---------------------------------
alter table casas enable row level security;
alter table usuarios enable row level security;
drop policy if exists casa_ver on casas;
drop policy if exists casa_renomear on casas;
create policy casa_ver on casas for select to authenticated using (id = (select casa_atual()));
create policy casa_renomear on casas for update to authenticated using (id = (select casa_atual())) with check (id = (select casa_atual()));
drop policy if exists usuario_proprio on usuarios;
create policy usuario_proprio on usuarios for select to authenticated using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
revoke insert, update, delete on usuarios from anon, authenticated;
revoke insert, update, delete on casas from anon, authenticated;

drop policy if exists membros_tudo on membros;
drop policy if exists membros_ver on membros;
drop policy if exists membros_convidar on membros;
drop policy if exists membros_remover on membros;
alter table membros alter column casa_id set default casa_atual();
create policy membros_ver on membros for select to authenticated using (casa_id = (select casa_atual()));
create policy membros_convidar on membros for insert to authenticated with check (casa_id = (select casa_atual()) and aceito_em is null);
create policy membros_remover on membros for delete to authenticated
  using (casa_id = (select casa_atual()) and email <> lower(coalesce(auth.jwt() ->> 'email', '')));
revoke update on membros from anon, authenticated;

-- ---------- Chaves de cada casa (só o servidor lê) ------------------------------------
create table if not exists casa_config (
  casa_id int not null references casas(id) on delete cascade,
  chave text not null,
  valor text,
  atualizado_em timestamptz not null default now(),
  primary key (casa_id, chave)
);
alter table casa_config enable row level security;
revoke all on casa_config from anon, authenticated;
comment on table casa_config is 'Chaves privadas de cada casa (Pluggy, Anthropic, login do robô de sincronização). Sem acesso pelo app; só a função api (service role).';
insert into casa_config (casa_id, chave, valor)
select 1, chave, valor from app_config where chave in ('pluggy_client_id', 'pluggy_client_secret', 'anthropic_key')
on conflict (casa_id, chave) do update set valor = excluded.valor;
delete from app_config where chave in ('pluggy_client_id', 'pluggy_client_secret', 'anthropic_key');
revoke all on app_config from anon, authenticated;

-- ---------- Modelo de casa nova (categorias e regras padrão) ------------------------
create table if not exists modelo_categorias (
  nome text primary key, grupo text, cor text, conta_como_gasto boolean, ordem int, natureza text, classe text
);
create table if not exists modelo_regras (
  alvo text, tipo text, padrao text, categoria text, prioridade int, sentido text,
  primary key (alvo, tipo, padrao)
);
alter table modelo_categorias enable row level security;
alter table modelo_regras enable row level security;
revoke all on modelo_categorias, modelo_regras from anon, authenticated;
comment on table modelo_categorias is 'Categorias que toda casa nova recebe (cópia das padrão da casa 1, sem as pessoais).';
comment on table modelo_regras is 'Regras do sistema que toda casa nova recebe.';

insert into modelo_categorias (nome, grupo, cor, conta_como_gasto, ordem, natureza, classe)
select nome, grupo, cor, conta_como_gasto, ordem, natureza, classe from categorias
where casa_id = 1 and ativa and nome not in ('Pix para esposa (sem nota)')
on conflict (nome) do nothing;
insert into modelo_regras (alvo, tipo, padrao, categoria, prioridade, sentido)
select r.alvo, r.tipo, r.padrao, c.nome, r.prioridade, r.sentido
from regras_categoria r join categorias c on c.id = r.categoria_id
where r.casa_id = 1 and r.origem = 'sistema' and c.nome in (select nome from modelo_categorias)
on conflict do nothing;

-- ---------- Funções chamadas pelo app -----------------------------------------------
create or replace function criar_casa(p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare c int; apelido text := split_part(split_part(lower(p_email), '@', 1), '.', 1);
begin
  insert into casas (nome, criado_por) values ('Casa de ' || initcap(regexp_replace(apelido, '[^a-z]', '', 'g')), lower(p_email)) returning id into c;
  insert into membros (casa_id, email, aceito_em) values (c, lower(p_email), now());
  insert into categorias (casa_id, nome, grupo, cor, conta_como_gasto, ordem, natureza, classe)
    select c, nome, grupo, cor, conta_como_gasto, ordem, natureza, classe from modelo_categorias;
  insert into regras_categoria (casa_id, alvo, tipo, padrao, categoria_id, prioridade, origem, sentido)
    select c, r.alvo, r.tipo, r.padrao, k.id, r.prioridade, 'sistema', r.sentido
    from modelo_regras r join categorias k on k.casa_id = c and k.nome = r.categoria;
  insert into preferencias (casa_id, chave, valor) values (c, 'meta_poupanca_pct', '20'), (c, 'reserva_meses', '6');
  return c;
end $$;

create or replace function minhas_casas() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', c.id, 'nome', c.nome,
           'membros', (select count(*) from membros x where x.casa_id = c.id and x.email not like 'robo-casa-%'))
         order by c.id), '[]')
  from casas c join membros m on m.casa_id = c.id
  where m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- Chamada ao abrir o app: garante uma casa para quem entrou.
-- Convite novo tem prioridade (a pessoa passa a ver a casa de quem convidou);
-- sem convite e sem casa, cria uma casa nova.
create or replace function entrar() returns json
language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce(auth.jwt() ->> 'email', '')); c int; convite int;
begin
  if e = '' then raise exception 'Faça login'; end if;
  select casa_id into convite from membros where email = e and aceito_em is null order by criado_em desc limit 1;
  if convite is not null then
    update membros set aceito_em = now() where email = e and aceito_em is null;
    c := convite;
  else
    select u.casa_id into c from usuarios u join membros m on m.casa_id = u.casa_id and m.email = u.email where u.email = e;
    if c is null then
      select casa_id into c from membros where email = e order by criado_em limit 1;
    end if;
    if c is null then c := criar_casa(e); end if;
  end if;
  insert into usuarios (email, casa_id) values (e, c)
    on conflict (email) do update set casa_id = excluded.casa_id, atualizado_em = now();
  return json_build_object('casa_id', c, 'nome', (select nome from casas where id = c),
                           'casas', minhas_casas(), 'convite_aceito', convite is not null);
end $$;

create or replace function trocar_casa(p_casa int) returns json
language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not exists (select 1 from membros where casa_id = p_casa and email = e) then
    raise exception 'Você não tem acesso a essa casa';
  end if;
  update membros set aceito_em = coalesce(aceito_em, now()) where casa_id = p_casa and email = e;
  insert into usuarios (email, casa_id) values (e, p_casa)
    on conflict (email) do update set casa_id = excluded.casa_id, atualizado_em = now();
  return json_build_object('casa_id', p_casa, 'nome', (select nome from casas where id = p_casa), 'casas', minhas_casas());
end $$;

-- Sair de uma casa (quem foi convidado); volta para outra casa ou ganha uma nova
create or replace function sair_da_casa(p_casa int) returns json
language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if (select count(*) from membros where casa_id = p_casa and email not like 'robo-casa-%') <= 1 then
    raise exception 'Você é a única pessoa desta casa; não dá para sair dela';
  end if;
  delete from membros where casa_id = p_casa and email = e;
  delete from usuarios where email = e and casa_id = p_casa;
  return entrar();
end $$;

revoke execute on function criar_casa(text) from public, anon, authenticated;
revoke execute on function casa_atual(), eh_membro(), minhas_casas(), entrar(), trocar_casa(int), sair_da_casa(int) from public, anon;
grant execute on function casa_atual(), eh_membro(), minhas_casas(), entrar(), trocar_casa(int), sair_da_casa(int) to authenticated;
grant select on casas, usuarios to authenticated;
grant update (nome) on casas to authenticated;
