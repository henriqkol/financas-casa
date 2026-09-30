-- =====================================================================
-- Sistema de metas, a partir do plano financeiro de 28/09/2026:
--   orçamento mensal (grupos + contas/envelopes), acordos de dívida com calendário,
--   objetivos (colchão, déficit zero, antecipação do Itaú, casa própria) e tarefas.
-- =====================================================================

-- ---------- Ajustes de apoio -----------------------------------------------------
alter table dividas drop constraint if exists dividas_tipo_check;
alter table dividas add constraint dividas_tipo_check
  check (tipo in ('emprestimo','financiamento','cartao','cheque_especial','pessoa','acordo','outro'));
alter table dividas add column if not exists vencimentos date[];
comment on column dividas.vencimentos is 'Calendário de vencimentos das parcelas (acordos). A n-ésima data é a parcela n.';

alter table contas add column if not exists negativo_em_acordo boolean not null default false;
comment on column contas.negativo_em_acordo is 'Saldo negativo já renegociado em acordo: não é tratado como cheque especial em uso.';
update contas set negativo_em_acordo = true
where tipo = 'BANK' and (lower(coalesce(apelido, '')) like '%ita%' or lower(nome) like '%ita%');

insert into categorias (nome, grupo, cor, conta_como_gasto, ordem, natureza, classe)
values ('Aluguel', 'Casa', '#8d6e63', true, 39, 'despesa', 'essencial_fixo')
on conflict (nome) do nothing;

-- Regras do dia a dia (confirmadas no extrato)
insert into regras_categoria (alvo, tipo, padrao, categoria_id, prioridade, origem, sentido)
select 'transacao', 'regex', r.padrao, c.id, r.prioridade, r.origem, 'saida'
from (values
  ('GIOVANA PINHATTI', 'Aluguel', 2, 'usuario'),
  ('(DISTRIBUICAO DE ENERGIA|COMPANHIA ESTADUAL DE DISTRIBUICAO|\bCEEE\b|RGE SUL)', 'Contas da casa', 2, 'sistema'),
  ('(WS-NET|WS NET|WSNET)', 'Contas da casa', 2, 'usuario'),
  ('PETLOVE', 'Plano de saúde pet', 12, 'usuario'),
  ('PICPAY', 'Assinaturas', 20, 'usuario')
) as r(padrao, categoria, prioridade, origem)
join categorias c on c.nome = r.categoria
on conflict (alvo, tipo, padrao) do nothing;

-- Pix para a Laynara: estavam em "Outros" por regra aprendida → "Pix para esposa (sem nota)"
update regras_categoria set categoria_id = (select id from categorias where nome = 'Pix para esposa (sem nota)')
where alvo = 'transacao' and tipo = 'exato' and padrao like '%LAYNARA DOS SANTOS LIMBERGER%'
  and categoria_id = (select id from categorias where nome = 'Outros');
update transacoes set categoria_id = (select id from categorias where nome = 'Pix para esposa (sem nota)')
where categoria_origem = 'aprendida' and sentido = 'saida'
  and upper(descricao) like '%LAYNARA DOS SANTOS LIMBERGER%'
  and categoria_id = (select id from categorias where nome = 'Outros');

-- Renda do plano (só o salário base, líquido)
insert into preferencias (chave, valor) values ('renda_mensal', '7983.89')
on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();

-- ---------- Orçamento ---------------------------------------------------------------
create table if not exists orcamento_grupos (
  id          serial primary key,
  nome        text not null unique,
  ordem       int not null default 50,
  categorias  int[] not null default '{}',     -- categorias cujo gasto conta neste grupo
  observacao  text
);
comment on table orcamento_grupos is 'Grupos do orçamento mensal (Moradia, Alimentação, Carro…). A meta do grupo é a soma dos seus itens.';

create table if not exists orcamento_itens (
  id                  serial primary key,
  grupo_id            int not null references orcamento_grupos(id) on delete cascade,
  nome                text not null,
  valor               numeric(12,2) not null default 0,   -- valor por ocorrência
  periodicidade_meses smallint not null default 1 check (periodicidade_meses in (1,2,3,6,12)),
  tipo                text not null default 'envelope' check (tipo in ('conta','envelope')),
  dia_vencimento      smallint check (dia_vencimento between 1 and 31),
  forma_pagamento     text,
  padrao              text,           -- regex (MAIÚSCULAS, sem acento) para achar o pagamento no extrato
  observacao          text,
  ordem               int not null default 50,
  ativo               boolean not null default true,
  unique (grupo_id, nome)
);
comment on table orcamento_itens is 'Itens do orçamento. tipo conta = boleto/transferência fixa (vira checklist do mês); envelope = valor a separar (mercado, combustível). Meta mensal = valor ÷ periodicidade.';

alter table orcamento_grupos enable row level security;
alter table orcamento_itens enable row level security;
drop policy if exists membros_tudo on orcamento_grupos;
drop policy if exists membros_tudo on orcamento_itens;
create policy membros_tudo on orcamento_grupos for all to authenticated using (eh_membro()) with check (eh_membro());
create policy membros_tudo on orcamento_itens for all to authenticated using (eh_membro()) with check (eh_membro());

insert into orcamento_grupos (nome, ordem, categorias, observacao)
select g.nome, g.ordem, array(select id from categorias where nome = any(g.cats) order by ordem), g.obs
from (values
  ('Moradia',     10, array['Aluguel','Contas da casa'], 'Água de poço (sem custo).'),
  ('Alimentação', 20, array['Mercado','Hortifruti','Carnes e frios','Padaria','Restaurante e delivery','Bebidas','Bebidas alcoólicas','Doces e snacks'], 'Meta em teste no dia a dia (antes R$ 3.000).'),
  ('Carro',       30, array['Combustível','Seguro veículo','Impostos','Transporte'], '62 km por trecho até a FAVET/UFRGS; nas férias o combustível cai para ~R$ 104.'),
  ('Cachorros',   40, array['Pet','Plano de saúde pet'], null),
  ('Assinaturas', 50, array['Assinaturas'], 'Netflix e Spotify pausados. Petlove e Anthropic são a reserva de ajuste.'),
  ('Medicação',   60, array['Farmácia e saúde'], 'A psicóloga é coberta pelo plano de saúde.'),
  ('Doação e família', 70, array['Repasse família','Repasses extras'], 'Suspensa até sair do vermelho.')
) as g(nome, ordem, cats, obs)
on conflict (nome) do nothing;

insert into orcamento_itens (grupo_id, nome, valor, periodicidade_meses, tipo, dia_vencimento, forma_pagamento, padrao, ordem, observacao)
select g.id, i.nome, i.valor, i.per, i.tipo, i.dia, i.forma, i.padrao, i.ordem, i.obs
from (values
  ('Moradia', 'Aluguel', 1500.00, 1, 'conta', 5, 'Transferência manual para a dona da casa', 'GIOVANA PINHATTI', 1, null),
  ('Moradia', 'Energia', 250.00, 1, 'conta', null, 'Manual (sem débito/Pix automático)', '(DISTRIBUICAO DE ENERGIA|CEEE|RGE)', 2, 'Vencimento a descobrir.'),
  ('Moradia', 'Internet', 129.90, 1, 'conta', null, 'Pix automático', '(WS-NET|WS NET|WSNET)', 3, null),
  ('Moradia', 'Celular', 80.00, 1, 'conta', null, 'Pix automático', '(TELEFONICA|\bVIVO\b)', 4, null),
  ('Moradia', 'Gás', 110.00, 3, 'envelope', null, 'Pix na compra', null, 5, 'A cada 3 meses.'),
  ('Alimentação', 'Mercado + delivery', 1600.00, 1, 'envelope', null, 'Na hora', null, 1, null),
  ('Carro', 'Combustível', 1013.95, 1, 'envelope', null, 'Na hora', null, 1, '161,2 l a R$ 6,29 (15 km/l).'),
  ('Carro', 'Seguro do carro', 273.69, 1, 'conta', null, 'Manual (sem Pix automático)', 'CAIXA SEGURADORA', 2, 'Vencimento a descobrir.'),
  ('Carro', 'Licenciamento', 90.00, 12, 'envelope', null, 'Pix no pagamento', null, 3, 'Uma vez por ano.'),
  ('Cachorros', 'Ração', 456.08, 1, 'envelope', null, 'Pix na compra', null, 1, 'Varia: pacotes de 20, 30 e 45 dias.'),
  ('Cachorros', 'Petlove', 367.14, 1, 'conta', null, 'Manual (sem Pix automático)', 'PETLOVE', 2, 'Vencimento a descobrir.'),
  ('Assinaturas', 'PicPay (Anthropic + Google One)', 316.99, 1, 'conta', 5, 'Transferência para o PicPay', 'PICPAY', 1, 'Anthropic R$ 220 · Google One R$ 96,99.'),
  ('Medicação', 'Remédios Henrique', 135.00, 1, 'envelope', null, 'Pix na compra', null, 1, null),
  ('Medicação', 'Remédios Laynara', 500.00, 2, 'envelope', null, 'Pix na compra', null, 2, 'A cada 2 meses.'),
  ('Doação e família', 'Doação', 0, 1, 'envelope', null, null, null, 1, 'Suspensa até sair do vermelho.')
) as i(grupo, nome, valor, per, tipo, dia, forma, padrao, ordem, obs)
join orcamento_grupos g on g.nome = i.grupo
on conflict (grupo_id, nome) do nothing;

-- ---------- Acordos (dívidas renegociadas em 28/09/2026) --------------------------------
insert into dividas (nome, credor, tipo, origem, parcela_valor, parcelas_total, parcelas_pagas_antes, dia_vencimento, data_inicio, padrao_pagamento, observacao, vencimentos)
select v.nome, v.credor, 'acordo', 'manual', v.parcela, v.total, v.antes, v.dia, v.inicio, v.padrao, v.obs, v.venc
from (values
  ('Acordo Itaú', 'Itaú', 1273.96, 60, 0, 5, date '2026-09-28', 'ITAU UNIBANCO',
   'Pacote Passaí, empréstimo, cheque especial e Magalu (Henrique). 1ª parcela paga em 28/09. Vence no dia 5, o mesmo dia do salário: pagar logo que o salário cair. Antecipar de trás para frente (a 60ª sai por ~R$ 326).',
   array[date '2026-09-28'] || array(select (date '2026-11-05' + make_interval(months => n))::date from generate_series(0, 58) n)),
  ('Acordo Nubank Henrique', 'Nubank', 374.59, 24, 0, 21, date '2026-09-29', 'PAGAMENTO DE FATURA',
   'Entrada de R$ 166,59 paga em 28/09. Agendar no app Nubank para o dia 21.',
   array(select (date '2026-10-21' + make_interval(months => n))::date from generate_series(0, 23) n)),
  ('Acordo Nubank Laynara', 'Nubank', 119.08, 25, 1, 6, date '2026-09-29', 'NU PAGAMENTOS',
   'Via acerto.com.br. 1ª parcela (R$ 48,45) paga em 28/09. Boleto; vencimento entre os dias 6 e 11. Não há parcela em outubro/2026.',
   array[date '2026-09-28', '2026-11-06','2026-12-07','2027-01-06','2027-02-11','2027-03-08','2027-04-06','2027-05-06','2027-06-07','2027-07-06',
         '2027-08-06','2027-09-06','2027-10-06','2027-11-08','2027-12-06','2028-01-06','2028-02-07','2028-03-06','2028-04-06','2028-05-08',
         '2028-06-06','2028-07-06','2028-08-07','2028-09-06','2028-10-06']::date[])
) as v(nome, credor, parcela, total, antes, dia, inicio, padrao, obs, venc)
where not exists (select 1 from dividas d where d.nome = v.nome);
select recalcular_divida(id) from dividas where tipo = 'acordo';

-- ---------- Objetivos e tarefas ----------------------------------------------------------
create table if not exists objetivos (
  id           serial primary key,
  grupo        text not null default 'Agora',          -- Agora · Casa própria · Tarefas
  titulo       text not null unique,
  descricao    text,
  tipo         text not null check (tipo in ('valor','habito','tarefa','monitor')),
  fonte        text,              -- de onde vem o progresso: colchao · acordos_em_dia · resultado_mensal · (vazio = informado à mão)
  valor_alvo   numeric(14,2),
  valor_atual  numeric(14,2),
  inverso      boolean not null default false,          -- monitor: bom enquanto o valor ficar ABAIXO do alvo
  data_alvo    date,
  concluido_em timestamptz,
  ordem        int not null default 50,
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table objetivos is 'Objetivos do plano financeiro (com progresso automático quando há fonte) e tarefas com data.';
alter table objetivos enable row level security;
drop policy if exists membros_tudo on objetivos;
create policy membros_tudo on objetivos for all to authenticated using (eh_membro()) with check (eh_membro());

insert into objetivos (grupo, titulo, descricao, tipo, fonte, valor_alvo, valor_atual, inverso, data_alvo, ordem) values
  ('Agora', 'Pagar todos os acordos em dia', 'Acordo quebrado devolve o nome ao cadastro de inadimplentes e o desconto costuma ser perdido. O relógio do crédito começou em 28/09/2026: com 6 a 12 meses em dia dá para tentar o financiamento.', 'habito', 'acordos_em_dia', 12, null, false, null, 1),
  ('Agora', 'Zerar o déficit mensal', 'Mês típico previsto a partir de novembro: −R$ 200,66. Cada R$ 100 acima da meta de alimentação aumenta o déficit na mesma medida.', 'habito', 'resultado_mensal', 3, null, false, null, 2),
  ('Agora', 'Colchão no fim de outubro', 'Saldo livre nas contas. Mínimo de segurança antes de cada dia 5: R$ 2.773,96 (parcela do Itaú + aluguel), para não atrasar o acordo se o salário atrasar.', 'valor', 'colchao', 2889.69, null, false, '2026-10-31', 3),
  ('Agora', 'Antecipar o acordo Itaú com o 13º', 'Pagar de trás para frente (as últimas parcelas têm o maior desconto). Efeito estimado: elimina ~20 parcelas e o total pago cai de ~R$ 76,4 mil para ~R$ 59,2 mil. Alternativa, se o caixa apertar: reduzir a parcela para ~R$ 1.000.', 'valor', null, 8400, 0, false, '2026-12-31', 4),
  ('Casa própria', 'FGTS para a entrada', 'Depósitos de ~R$ 906,44/mês + 3% a.a. Projeção: ~R$ 96 mil em jul/2027 e ~R$ 104 mil em jan/2028. Atualize com o saldo do app do FGTS.', 'valor', null, 96000, 84000, false, '2027-07-31', 10),
  ('Casa própria', 'Juntar para ITBI e cartório', '~3% a 5% do imóvel (R$ 11 a 18 mil para um imóvel de R$ 350 a 360 mil). Perguntar à Caixa se dá para incluir no financiamento.', 'valor', null, 15000, 0, false, '2027-12-31', 11),
  ('Casa própria', 'Renda bruta dentro da Faixa 4 do MCMV', 'Limite de R$ 13.000 de renda bruta familiar. Aumento de salário, horas extras ou bolsa da Laynara somam. Conferir antes de pedir o financiamento.', 'monitor', null, 13000, 11330.47, true, null, 12),
  ('Tarefas', 'Conferir Serasa e SPC (negativação saiu?)', null, 'tarefa', null, null, null, false, '2026-10-05', 20),
  ('Tarefas', 'Confirmar se a próxima parcela do Itaú é em 05/10 ou 05/11', 'O plano assume 05/11.', 'tarefa', null, null, null, false, '2026-10-05', 21),
  ('Tarefas', 'Descobrir os vencimentos de energia, seguro e Petlove', 'Para agendar tudo no próprio dia 5.', 'tarefa', null, null, null, false, '2026-10-05', 22),
  ('Tarefas', 'Confirmar se a 1ª parcela do Nubank do Henrique é em 21/10 ou 21/11', 'O plano assume 21/10.', 'tarefa', null, null, null, false, '2026-10-21', 23),
  ('Tarefas', 'Perguntar ao RH sobre a Laynara como dependente no IR', 'O líquido sobe ~R$ 53,13 por mês.', 'tarefa', null, null, null, false, '2026-10-31', 24),
  ('Tarefas', 'Consultar o Registrato (gov.br)', 'Ver como os acordos aparecem no SCR do Banco Central.', 'tarefa', null, null, null, false, '2026-12-01', 25),
  ('Tarefas', 'Pedir a isenção de IPVA 2027 da Laynara (TEA)', 'Laudo de médico e psicólogo do SUS, carro de até ~R$ 138 mil no nome dela. Portal da Receita Estadual a partir de 01/01/2027.', 'tarefa', null, null, null, false, '2027-01-02', 26),
  ('Tarefas', 'Anotar o valor do IPVA deste ano', 'Para medir a economia da isenção.', 'tarefa', null, null, null, false, null, 27),
  ('Tarefas', 'Ver com a Caixa: ITBI/cartório no financiamento e requisitos do FGTS', '3 anos de carteira somados, não ter imóvel na cidade, imóvel para moradia.', 'tarefa', null, null, null, false, '2027-06-30', 28)
on conflict (titulo) do nothing;

-- Dívidas: saldo negativo em acordo não é "cheque especial em uso"
create or replace view v_dividas with (security_invoker = true) as
select 'divida' as fonte, d.id::text as id, d.nome, d.tipo, d.credor, d.saldo_devedor, d.parcela_valor,
       d.parcelas_total, d.parcelas_pagas, d.dia_vencimento, d.origem
from dividas d where d.ativa
union all
select 'cheque_especial', c.id, 'Cheque especial · ' || coalesce(c.apelido, c.nome), 'cheque_especial', null, abs(c.saldo), null, null, null, null, 'open_finance'
from contas c where c.tipo = 'BANK' and c.saldo < 0 and not c.negativo_em_acordo
union all
select 'fatura', c.id, 'Fatura atual · ' || coalesce(c.apelido, c.nome), 'cartao', null, abs(c.saldo), null, null, null, null, 'open_finance'
from contas c where c.tipo = 'CREDIT' and coalesce(abs(c.saldo), 0) > 0
union all
select 'parcelas', p.conta_id, 'Parcelas futuras · ' || coalesce(c.apelido, c.nome), 'cartao', null, sum(p.valor_restante), null, null, null, null, 'open_finance'
from v_cartao_parcelas_futuras p join contas c on c.id = p.conta_id
group by p.conta_id, c.apelido, c.nome;

-- As metas agora vivem no orçamento (grupos e itens): as metas por categoria criadas na 0008 saem
drop view if exists v_metas;
alter table categorias drop column if exists meta_valor;
alter table categorias drop column if exists periodicidade_meses;
