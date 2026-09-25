-- =====================================================================
-- Finanças da Casa — estrutura do banco
-- Todos os valores em R$. Datas no fuso America/Sao_Paulo.
-- =====================================================================

-- ---------- Acesso: quem pode ver os dados --------------------------------
create table if not exists membros (
  email      text primary key,
  nome       text,
  criado_em  timestamptz not null default now()
);
comment on table membros is 'E-mails autorizados a usar o app (o casal). Quem não estiver aqui não vê nada.';

create or replace function eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from membros where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- ---------- Configuração e segredos (só o servidor lê) --------------------
create table if not exists app_config (
  chave       text primary key,
  valor       text,
  atualizado_em timestamptz not null default now()
);
comment on table app_config is 'Configurações e segredos (credenciais Pluggy, chave Anthropic, segredo do agendamento). Sem acesso pelo app: só as funções do servidor leem.';

insert into app_config (chave, valor)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (chave) do nothing;

-- ---------- Categorias ------------------------------------------------------
create table if not exists categorias (
  id                serial primary key,
  nome              text not null unique,
  grupo             text not null default 'Outros',
  cor               text not null default '#8a8f98',
  conta_como_gasto  boolean not null default true,
  ordem             int not null default 100,
  ativa             boolean not null default true
);
comment on table categorias is 'Categorias de gasto. conta_como_gasto=false para movimentos que não são consumo (pagamento de fatura, transferência entre contas próprias, investimentos, receitas).';

insert into categorias (nome, grupo, cor, conta_como_gasto, ordem) values
  ('Mercado',                 'Alimentação', '#2e9e5b', true, 10),
  ('Hortifruti',              'Alimentação', '#58b847', true, 11),
  ('Carnes e frios',          'Alimentação', '#c0463a', true, 12),
  ('Padaria',                 'Alimentação', '#d19a3c', true, 13),
  ('Bebidas',                 'Alimentação', '#3a8fc0', true, 14),
  ('Bebidas alcoólicas',      'Alimentação', '#7d4bb3', true, 15),
  ('Doces e snacks',          'Alimentação', '#e0739b', true, 16),
  ('Restaurante e delivery',  'Alimentação', '#e5813b', true, 17),
  ('Limpeza',                 'Casa',        '#37a3a3', true, 20),
  ('Higiene e beleza',        'Pessoal',     '#b35bb0', true, 21),
  ('Farmácia e saúde',        'Saúde',       '#d64545', true, 22),
  ('Pet',                     'Casa',        '#9a7b4f', true, 23),
  ('Casa e utilidades',       'Casa',        '#6f7fa8', true, 24),
  ('Contas da casa',          'Casa',        '#4b6cb7', true, 25),
  ('Combustível',             'Transporte',  '#556270', true, 30),
  ('Transporte',              'Transporte',  '#7a8591', true, 31),
  ('Vestuário',               'Pessoal',     '#c96f9d', true, 40),
  ('Eletrônicos',             'Pessoal',     '#4f5d75', true, 41),
  ('Lazer',                   'Pessoal',     '#f2a33a', true, 42),
  ('Educação',                'Pessoal',     '#3b7dd8', true, 43),
  ('Assinaturas',             'Pessoal',     '#8e6fd8', true, 44),
  ('Presentes',               'Pessoal',     '#e56b6f', true, 45),
  ('Tarifas e juros',         'Financeiro',  '#9b2226', true, 50),
  ('Impostos',                'Financeiro',  '#6d597a', true, 51),
  ('Repasse família',         'Família',     '#ff8fab', true, 60),
  ('Outros',                  'Outros',      '#8a8f98', true, 90),
  ('Pagamento de fatura',     'Não é gasto', '#b0b4ba', false, 95),
  ('Transferência entre contas','Não é gasto','#b0b4ba', false, 96),
  ('Investimentos',           'Não é gasto', '#b0b4ba', false, 97),
  ('Receitas',                'Entradas',    '#2a9d8f', false, 98)
on conflict (nome) do nothing;

-- ---------- Open Finance (Pluggy) ------------------------------------------
create table if not exists pluggy_itens (
  id            text primary key,
  nome          text,
  conector      text,
  status        text,
  ultimo_sync   timestamptz,
  ultimo_erro   text,
  criado_em     timestamptz not null default now()
);
comment on table pluggy_itens is 'Conexões (Items) da Pluggy. Cada banco conectado no Meu Pluggy e vinculado à aplicação vira um Item.';

create table if not exists contas (
  id            text primary key,          -- id da conta na Pluggy
  item_id       text references pluggy_itens(id) on delete cascade,
  tipo          text not null,             -- BANK | CREDIT
  subtipo       text,                      -- CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD
  nome          text,
  apelido       text,
  numero        text,
  saldo         numeric(14,2),
  ativa         boolean not null default true,
  atualizado_em timestamptz not null default now()
);
comment on table contas is 'Contas correntes e cartões de crédito vindos do Open Finance. apelido é o nome amigável dado no app (ex.: "Itaú", "Nubank cartão").';

create table if not exists transacoes (
  id               text primary key,        -- id da transação na Pluggy
  conta_id         text not null references contas(id) on delete cascade,
  data             date not null,            -- data do lançamento (fuso de Brasília)
  descricao        text not null,
  descricao_raw    text,
  valor            numeric(14,2) not null,   -- sempre positivo
  sentido          text not null check (sentido in ('saida','entrada')),
  valor_original   numeric(14,2),            -- como veio da Pluggy (com sinal)
  status           text,                     -- POSTED | PENDING
  tipo_operacao    text,                     -- PIX, BOLETO, CARTAO, PAGAMENTO_FATURA...
  provider_id      text,
  parcela_numero   int,
  parcelas_total   int,
  data_compra      date,
  pagador_doc      text,
  recebedor_doc    text,
  recebedor_nome   text,
  categoria_id     int references categorias(id),
  categoria_origem text,                     -- regra | nota | manual | padrao | aprendida
  observacao       text,
  removida         boolean not null default false,
  raw              jsonb,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
create index if not exists transacoes_data_idx on transacoes (data);
create index if not exists transacoes_valor_idx on transacoes (valor);
create index if not exists transacoes_conta_idx on transacoes (conta_id, data);
create index if not exists transacoes_provider_idx on transacoes (provider_id);
comment on table transacoes is 'Lançamentos das contas e cartões. valor é sempre positivo; sentido diz se é saída (gasto) ou entrada. removida=true quando o banco reapresentou o lançamento com outro id (ignorar nas análises).';

-- ---------- Notas fiscais (NFC-e) ------------------------------------------
create table if not exists notas (
  id              uuid primary key default gen_random_uuid(),
  chave           text unique,                -- chave de acesso de 44 dígitos
  url             text,
  uf              text,
  cnpj_emitente   text,
  nome_emitente   text,
  endereco        text,
  numero          text,
  serie           text,
  emissao         timestamptz,
  valor_total     numeric(14,2),              -- soma dos itens (antes de descontos)
  desconto        numeric(14,2) default 0,
  valor_pago      numeric(14,2),              -- valor a pagar (o que sai da conta)
  forma_pagamento text,
  qtd_itens       int,
  consulta_status text not null default 'pendente' check (consulta_status in ('ok','erro','pendente')),
  consulta_erro   text,
  vinculo_status  text not null default 'pendente' check (vinculo_status in ('vinculada','confirmar','pendente','ignorada')),
  escaneada_por   text,
  observacao      text,
  html_bruto      text,                       -- página da SEFAZ guardada só quando a leitura falha (para ajustar o leitor)
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists notas_emissao_idx on notas (emissao);
comment on table notas is 'Notas fiscais escaneadas pelo QR code. vinculo_status: vinculada (ligada a um gasto), confirmar (há candidatos, falta confirmar no app), pendente (gasto ainda não apareceu no banco), ignorada.';

create table if not exists nota_itens (
  id               bigserial primary key,
  nota_id          uuid not null references notas(id) on delete cascade,
  ordem            int not null,
  codigo           text,
  descricao        text not null,
  descricao_norm   text not null,
  quantidade       numeric(14,4),
  unidade          text,
  valor_unitario   numeric(14,4),
  valor_total      numeric(14,2) not null,
  categoria_id     int references categorias(id),
  categoria_origem text
);
create index if not exists nota_itens_nota_idx on nota_itens (nota_id);
create index if not exists nota_itens_desc_idx on nota_itens (descricao_norm);
comment on table nota_itens is 'Itens de cada nota fiscal, com categoria por item. descricao_norm é a descrição em maiúsculas e sem acentos.';

create table if not exists nota_transacao (
  nota_id       uuid not null references notas(id) on delete cascade,
  transacao_id  text not null references transacoes(id) on delete cascade,
  origem        text not null default 'auto',   -- auto | manual | parcela
  criado_em     timestamptz not null default now(),
  primary key (nota_id, transacao_id)
);
create index if not exists nota_transacao_tx_idx on nota_transacao (transacao_id);
comment on table nota_transacao is 'Vínculo entre nota fiscal e gasto. Uma nota pode ligar várias parcelas; um gasto (ex.: um Pix) pode cobrir várias notas.';

-- ---------- Regras de categorização ----------------------------------------
create table if not exists regras_categoria (
  id            serial primary key,
  alvo          text not null check (alvo in ('item','transacao')),
  tipo          text not null default 'regex' check (tipo in ('regex','exato')),
  padrao        text not null,
  categoria_id  int not null references categorias(id) on delete cascade,
  prioridade    int not null default 100,     -- menor vence
  origem        text not null default 'sistema', -- sistema | aprendida | usuario | ia
  criado_em     timestamptz not null default now(),
  unique (alvo, tipo, padrao)
);
comment on table regras_categoria is 'Regras que categorizam itens de nota e lançamentos. Padrões em MAIÚSCULAS e sem acento. Regras aprendidas vêm das correções feitas no app.';

-- ---------- Log de sincronização --------------------------------------------
create table if not exists sync_log (
  id          bigserial primary key,
  inicio      timestamptz not null default now(),
  fim         timestamptz,
  origem      text,
  ok          boolean,
  mensagem    text,
  novas       int default 0,
  atualizadas int default 0,
  removidas   int default 0,
  vinculadas  int default 0
);

-- ---------- Segurança (RLS) --------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['membros','categorias','pluggy_itens','contas','transacoes','notas','nota_itens','nota_transacao','regras_categoria','sync_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists membros_tudo on %I', t);
    execute format('create policy membros_tudo on %I for all to authenticated using (eh_membro()) with check (eh_membro())', t);
  end loop;
end $$;
alter table app_config enable row level security;  -- sem políticas: só o servidor

-- ---------- Visões para o app e para análises -------------------------------

-- Gastos alocados por categoria. Quando o gasto tem nota, o valor é dividido
-- entre as categorias dos itens (proporcional ao valor de cada item).
create or replace view v_gastos with (security_invoker = true) as
with tx as (
  select t.*, c.apelido, c.nome as conta_nome, c.tipo as conta_tipo
  from transacoes t join contas c on c.id = t.conta_id
  where not t.removida and t.sentido = 'saida'
),
itens_por_tx as (
  select nt.transacao_id, i.categoria_id, sum(i.valor_total) as soma
  from nota_transacao nt join nota_itens i on i.nota_id = nt.nota_id
  group by 1, 2
),
tot_por_tx as (
  select transacao_id, sum(soma) as total from itens_por_tx group by 1
),
alocado as (
  select tx.id as transacao_id, ipt.categoria_id,
         round(tx.valor * ipt.soma / nullif(tpt.total, 0), 2) as valor, true as via_nota
  from tx
  join tot_por_tx tpt on tpt.transacao_id = tx.id and tpt.total > 0
  join itens_por_tx ipt on ipt.transacao_id = tx.id
  -- se o próprio gasto foi marcado como "não é gasto", respeita a marcação
  where coalesce((select conta_como_gasto from categorias where id = tx.categoria_id), true)
  union all
  select tx.id, tx.categoria_id, tx.valor, false
  from tx
  where not exists (select 1 from tot_por_tx tpt where tpt.transacao_id = tx.id and tpt.total > 0)
     or not coalesce((select conta_como_gasto from categorias where id = tx.categoria_id), true)
)
select
  tx.id as transacao_id,
  tx.data,
  to_char(tx.data, 'YYYY-MM') as mes,
  tx.descricao,
  coalesce(tx.apelido, tx.conta_nome) as conta,
  tx.conta_tipo,
  a.valor,
  a.categoria_id,
  coalesce(cat.nome, 'Sem categoria') as categoria,
  coalesce(cat.grupo, 'Outros') as grupo,
  coalesce(cat.conta_como_gasto, true) as conta_como_gasto,
  a.via_nota
from alocado a
join tx on tx.id = a.transacao_id
left join categorias cat on cat.id = a.categoria_id;
comment on view v_gastos is 'Uma linha por gasto × categoria. Gastos com nota fiscal são divididos pelas categorias dos itens. Para somar o que realmente foi gasto, filtre conta_como_gasto = true.';

create or replace view v_resumo_mensal with (security_invoker = true) as
select mes, categoria, grupo, sum(valor) as total, count(distinct transacao_id) as lancamentos
from v_gastos
where conta_como_gasto
group by 1, 2, 3;
comment on view v_resumo_mensal is 'Total gasto por mês e categoria (só o que conta como gasto).';

create or replace view v_itens_comprados with (security_invoker = true) as
select n.emissao::date as data, to_char(n.emissao, 'YYYY-MM') as mes,
       n.nome_emitente as loja, n.cnpj_emitente,
       i.descricao, i.descricao_norm, i.quantidade, i.unidade, i.valor_unitario, i.valor_total,
       coalesce(c.nome, 'Sem categoria') as categoria, n.id as nota_id
from nota_itens i
join notas n on n.id = i.nota_id
left join categorias c on c.id = i.categoria_id;
comment on view v_itens_comprados is 'Todos os produtos comprados (das notas fiscais). Útil para comparar preços entre lojas e acompanhar consumo de produtos.';

create or replace view v_pendencias with (security_invoker = true) as
select 'nota_sem_gasto' as tipo, n.id::text as id, n.emissao::date as data,
       n.nome_emitente as descricao, n.valor_pago as valor
from notas n where n.vinculo_status in ('pendente','confirmar')
union all
select 'gasto_sem_categoria', t.id, t.data, t.descricao, t.valor
from transacoes t
where not t.removida and t.sentido = 'saida' and t.categoria_id is null;
comment on view v_pendencias is 'O que precisa de atenção: notas ainda sem gasto vinculado e gastos sem categoria.';
