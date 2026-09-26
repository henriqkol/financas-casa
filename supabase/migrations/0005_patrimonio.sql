-- =====================================================================
-- Patrimônio: investimentos (com caixinhas definidas pelo usuário) e dívidas.
-- =====================================================================

-- ---------- Caixinhas (agrupamentos criados no app) -------------------------
create table if not exists caixinhas (
  id         serial primary key,
  nome       text not null unique,
  cor        text not null default '#2e9e5b',
  meta       numeric(14,2),
  ordem      int not null default 100,
  criado_em  timestamptz not null default now()
);
comment on table caixinhas is 'Caixinhas do Nubank (ou outros objetivos) criadas no app. O Open Finance não informa o nome da caixinha: cada aplicação é associada a uma caixinha pelo usuário.';

-- ---------- Investimentos (cada aplicação vinda do Open Finance) ------------
create table if not exists investimentos (
  id               text primary key,             -- id do investimento na Pluggy
  item_id          text references pluggy_itens(id) on delete set null,
  nome             text,
  tipo             text,                          -- FIXED_INCOME, MUTUAL_FUND, ...
  subtipo          text,                          -- CDB, LCI, TREASURY, ...
  emissor          text,
  taxa             numeric(10,4),                 -- ex.: 100 (% do CDI)
  indexador        text,                          -- CDI, IPCA, SELIC...
  taxa_anual_fixa  numeric(10,4),
  data_aplicacao   date,
  vencimento       date,
  status           text,                          -- ACTIVE | PENDING | TOTAL_WITHDRAWAL
  valor_aplicado   numeric(14,2),
  saldo_bruto      numeric(14,2),
  saldo_liquido    numeric(14,2),
  saldo_resgatavel numeric(14,2),
  caixinha_id      int references caixinhas(id) on delete set null,
  apelido          text,
  primeiro_visto   timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  raw              jsonb
);
create index if not exists investimentos_caixinha_idx on investimentos (caixinha_id);
comment on table investimentos is 'Cada aplicação financeira (no Nubank, cada depósito em caixinha vira um CDB separado). saldo_liquido = já descontados impostos.';

create table if not exists investimento_saldos (
  investimento_id  text not null references investimentos(id) on delete cascade,
  dia              date not null,
  saldo_bruto      numeric(14,2),
  saldo_liquido    numeric(14,2),
  valor_aplicado   numeric(14,2),
  registrado_em    timestamptz not null default now(),
  primary key (investimento_id, dia)
);
comment on table investimento_saldos is 'Fotografia diária do saldo de cada aplicação, gravada a cada sincronização (a última do dia vale).';

-- ---------- Dívidas ----------------------------------------------------------
create table if not exists dividas (
  id                 bigserial primary key,
  nome               text not null,
  credor             text,
  tipo               text not null default 'outro'
                     check (tipo in ('emprestimo','financiamento','cartao','cheque_especial','pessoa','outro')),
  origem             text not null default 'manual' check (origem in ('manual','open_finance')),
  pluggy_id          text unique,
  valor_original     numeric(14,2),
  saldo_devedor      numeric(14,2),
  taxa_juros_mensal  numeric(8,4),                -- % ao mês (ex.: 1.99)
  cet_anual          numeric(8,4),
  parcela_valor      numeric(14,2),
  parcelas_total     int,
  parcelas_pagas     int not null default 0,
  parcelas_pagas_antes int not null default 0,     -- parcelas já pagas antes de cadastrar no app
  dia_vencimento     int check (dia_vencimento between 1 and 31),
  data_inicio        date,
  padrao_pagamento   text,                         -- texto do extrato que identifica o pagamento (MAIÚSCULAS, sem acento)
  observacao         text,
  ativa              boolean not null default true,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now(),
  raw                jsonb
);
comment on table dividas is 'Dívidas: cadastradas no app (manual) ou empréstimos vindos do Open Finance. padrao_pagamento faz o app reconhecer os pagamentos no extrato.';

create table if not exists divida_pagamentos (
  id            bigserial primary key,
  divida_id     bigint not null references dividas(id) on delete cascade,
  data          date not null,
  valor         numeric(14,2) not null,
  transacao_id  text unique references transacoes(id) on delete set null,
  observacao    text,
  criado_em     timestamptz not null default now()
);
comment on table divida_pagamentos is 'Pagamentos de cada dívida; quando vieram do extrato, transacao_id aponta para o lançamento.';

create table if not exists divida_saldos (
  divida_id      bigint not null references dividas(id) on delete cascade,
  dia            date not null,
  saldo_devedor  numeric(14,2),
  primary key (divida_id, dia)
);
comment on table divida_saldos is 'Histórico do saldo devedor de cada dívida.';

insert into categorias (nome, grupo, cor, conta_como_gasto, ordem)
values ('Pagamento de dívida', 'Financeiro', '#b5651d', true, 52)
on conflict (nome) do nothing;

-- ---------- Recalcula o saldo de uma dívida manual ---------------------------
-- Com juros e parcela fixa (tabela Price): saldo = valor presente das parcelas restantes.
-- Sem juros: parcela × restantes. Sem parcelas definidas: valor original − pagamentos.
create or replace function recalcular_divida(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  d dividas%rowtype;
  pagas int;
  soma numeric;
  restantes int;
  i numeric;
  novo numeric;
begin
  select * into d from dividas where id = p_id;
  if not found or d.origem <> 'manual' then return; end if;
  select count(*) + d.parcelas_pagas_antes, coalesce(sum(valor), 0) into pagas, soma from divida_pagamentos where divida_id = p_id;
  if d.parcelas_total is not null and d.parcela_valor is not null then
    restantes := greatest(d.parcelas_total - pagas, 0);
    i := coalesce(d.taxa_juros_mensal, 0) / 100.0;
    if i > 0 then
      novo := round(d.parcela_valor * (1 - power(1 + i, -restantes)) / i, 2);
    else
      novo := d.parcela_valor * restantes;
    end if;
  elsif d.valor_original is not null then
    novo := greatest(d.valor_original - soma, 0);
  else
    novo := d.saldo_devedor;
  end if;
  update dividas set parcelas_pagas = pagas, saldo_devedor = novo,
    ativa = case when novo is not null and novo <= 0 then false else ativa end,
    atualizado_em = now()
  where id = p_id;
  insert into divida_saldos (divida_id, dia, saldo_devedor)
  values (p_id, (now() at time zone 'America/Sao_Paulo')::date, novo)
  on conflict (divida_id, dia) do update set saldo_devedor = excluded.saldo_devedor;
end $$;

create or replace function trg_divida_pagamento() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform recalcular_divida(coalesce(new.divida_id, old.divida_id));
  return null;
end $$;
drop trigger if exists divida_pagamento_recalc on divida_pagamentos;
create trigger divida_pagamento_recalc after insert or update or delete on divida_pagamentos
for each row execute function trg_divida_pagamento();

create or replace function trg_divida_editada() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.origem = 'manual' and (
       new.parcela_valor is distinct from old.parcela_valor or new.parcelas_total is distinct from old.parcelas_total
    or new.taxa_juros_mensal is distinct from old.taxa_juros_mensal or new.valor_original is distinct from old.valor_original
    or new.parcelas_pagas_antes is distinct from old.parcelas_pagas_antes) then
    perform recalcular_divida(new.id);
  end if;
  return null;
end $$;
drop trigger if exists divida_editada_recalc on dividas;
create trigger divida_editada_recalc after update on dividas
for each row when (pg_trigger_depth() = 0) execute function trg_divida_editada();

create or replace function trg_divida_nova() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.origem = 'manual' then perform recalcular_divida(new.id); end if;
  return null;
end $$;
drop trigger if exists divida_nova_recalc on dividas;
create trigger divida_nova_recalc after insert on dividas
for each row execute function trg_divida_nova();

revoke all on function recalcular_divida(bigint) from public, anon;
grant execute on function recalcular_divida(bigint) to authenticated;
revoke all on function trg_divida_pagamento() from public, anon, authenticated;
revoke all on function trg_divida_editada() from public, anon, authenticated;
revoke all on function trg_divida_nova() from public, anon, authenticated;

-- ---------- Segurança ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['caixinhas','investimentos','investimento_saldos','dividas','divida_pagamentos','divida_saldos']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists membros_tudo on %I', t);
    execute format('create policy membros_tudo on %I for all to authenticated using (eh_membro()) with check (eh_membro())', t);
  end loop;
end $$;

-- ---------- Visões ----------------------------------------------------------------
create or replace view v_investimentos with (security_invoker = true) as
select i.id, coalesce(c.nome, 'Sem caixinha') as caixinha, i.caixinha_id,
       coalesce(i.apelido, trim(coalesce(i.subtipo, i.tipo, 'Investimento') || ' ' || coalesce(rtrim(to_char(i.taxa, 'FM999990.##'), '.') || '% ', '') || coalesce(i.indexador, ''))) as nome,
       i.tipo, i.subtipo, i.emissor, i.taxa, i.indexador, i.data_aplicacao, i.vencimento, i.status,
       i.valor_aplicado, i.saldo_bruto, i.saldo_liquido, i.saldo_resgatavel,
       i.saldo_liquido - i.valor_aplicado as rendimento_liquido,
       i.atualizado_em
from investimentos i left join caixinhas c on c.id = i.caixinha_id;
comment on view v_investimentos is 'Situação atual de cada aplicação, com a caixinha a que pertence.';

create or replace view v_caixinhas_historico with (security_invoker = true) as
select s.dia, coalesce(c.nome, 'Sem caixinha') as caixinha, i.caixinha_id,
       sum(s.saldo_liquido) as saldo_liquido, sum(s.saldo_bruto) as saldo_bruto, sum(s.valor_aplicado) as valor_aplicado
from investimento_saldos s
join investimentos i on i.id = s.investimento_id
left join caixinhas c on c.id = i.caixinha_id
group by 1, 2, 3;
comment on view v_caixinhas_historico is 'Evolução diária do saldo por caixinha (soma das aplicações de cada caixinha). Começa na primeira sincronização com investimentos.';

create or replace view v_investimentos_historico with (security_invoker = true) as
select dia, sum(saldo_liquido) as saldo_liquido, sum(saldo_bruto) as saldo_bruto, sum(valor_aplicado) as valor_aplicado
from investimento_saldos group by dia;
comment on view v_investimentos_historico is 'Evolução diária do total investido.';

-- Parcelas do cartão ainda por vir: para cada compra parcelada, o que falta depois da última parcela conhecida.
create or replace view v_cartao_parcelas_futuras with (security_invoker = true) as
with compras as (
  select t.conta_id,
         trim(regexp_replace(regexp_replace(upper(t.descricao), '[^A-Z ]', ' ', 'g'), '\s+', ' ', 'g')) as chave,
         t.parcelas_total, round(t.valor, 1) as valor_aprox,
         max(t.parcela_numero) as ultima_parcela, max(t.valor) as valor_parcela,
         max(t.descricao) as descricao, max(t.data) as ultima_data
  from transacoes t join contas c on c.id = t.conta_id
  where c.tipo = 'CREDIT' and not t.removida and t.sentido = 'saida' and t.parcelas_total > 1
  group by 1, 2, 3, 4
)
select conta_id, descricao, parcelas_total, ultima_parcela, valor_parcela, ultima_data,
       (parcelas_total - ultima_parcela) as parcelas_restantes,
       (parcelas_total - ultima_parcela) * valor_parcela as valor_restante
from compras where ultima_parcela < parcelas_total;
comment on view v_cartao_parcelas_futuras is 'Compras parceladas no cartão com parcelas que ainda vão aparecer nas próximas faturas.';

create or replace view v_dividas with (security_invoker = true) as
select 'divida' as fonte, d.id::text as id, d.nome, d.tipo, d.credor, d.saldo_devedor, d.parcela_valor,
       d.parcelas_total, d.parcelas_pagas, d.dia_vencimento, d.origem
from dividas d where d.ativa
union all
select 'fatura', c.id, 'Fatura atual · ' || coalesce(c.apelido, c.nome), 'cartao', null, abs(c.saldo), null, null, null, null, 'open_finance'
from contas c where c.tipo = 'CREDIT' and coalesce(abs(c.saldo), 0) > 0
union all
select 'parcelas', p.conta_id, 'Parcelas futuras · ' || coalesce(c.apelido, c.nome), 'cartao', null, sum(p.valor_restante), null, null, null, null, 'open_finance'
from v_cartao_parcelas_futuras p join contas c on c.id = p.conta_id
group by p.conta_id, c.apelido, c.nome;
comment on view v_dividas is 'Tudo o que se deve hoje: dívidas cadastradas e empréstimos do Open Finance, fatura atual do cartão e parcelas futuras.';
