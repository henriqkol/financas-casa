-- =====================================================================
-- Receitas categorizadas, classes de despesa (essencial/estilo de vida),
-- preferências do planejamento e visões de fluxo mensal.
-- =====================================================================

-- ---------- Natureza e classe das categorias -------------------------------
alter table categorias add column if not exists natureza text not null default 'despesa';
alter table categorias drop constraint if exists categorias_natureza_check;
alter table categorias add constraint categorias_natureza_check check (natureza in ('despesa','receita','neutro'));
alter table categorias add column if not exists classe text;
alter table categorias drop constraint if exists categorias_classe_check;
alter table categorias add constraint categorias_classe_check check (classe in ('essencial','estilo_vida'));
comment on column categorias.natureza is 'despesa (consumo), receita (renda) ou neutro (movimento entre contas, fatura, investimento, crédito contratado).';
comment on column categorias.classe is 'Para despesas: essencial ou estilo_vida (base do plano 50/30/20).';

update categorias set nome = 'Outras receitas' where nome = 'Receitas'
  and not exists (select 1 from categorias where nome = 'Outras receitas');

insert into categorias (nome, grupo, cor, conta_como_gasto, ordem, natureza) values
  ('Salário',                        'Receitas', '#2a9d8f', false, 1, 'receita'),
  ('Renda extra',                    'Receitas', '#43aa8b', false, 2, 'receita'),
  ('Pix e transferências recebidas', 'Receitas', '#577590', false, 3, 'receita'),
  ('Reembolsos e estornos',          'Receitas', '#90be6d', false, 4, 'receita'),
  ('Rendimentos',                    'Receitas', '#4d908e', false, 5, 'receita'),
  ('Crédito contratado',             'Não é gasto', '#b0b4ba', false, 94, 'neutro')
on conflict (nome) do nothing;

update categorias set natureza = 'receita', grupo = 'Receitas', ordem = 6, conta_como_gasto = false where nome = 'Outras receitas';
update categorias set natureza = 'neutro', conta_como_gasto = false
  where nome in ('Pagamento de fatura', 'Transferência entre contas', 'Investimentos', 'Crédito contratado', 'Pagamento de dívida');
-- Pagar dívida não é consumo: o que foi comprado já contou como gasto; juros e tarifas contam em "Tarifas e juros".
update categorias set grupo = 'Não é gasto' where nome = 'Pagamento de dívida';

update categorias set classe = 'essencial' where natureza = 'despesa' and nome in (
  'Mercado','Hortifruti','Carnes e frios','Padaria','Limpeza','Higiene e beleza','Farmácia e saúde','Pet',
  'Casa e utilidades','Contas da casa','Combustível','Transporte','Educação','Impostos','Tarifas e juros','Repasse família');
update categorias set classe = 'estilo_vida' where natureza = 'despesa' and classe is null;

-- ---------- Regras com sentido (entrada/saída) --------------------------------
alter table regras_categoria add column if not exists sentido text;
alter table regras_categoria drop constraint if exists regras_categoria_sentido_check;
alter table regras_categoria add constraint regras_categoria_sentido_check check (sentido in ('saida','entrada'));
comment on column regras_categoria.sentido is 'Se preenchido, a regra só vale para lançamentos deste sentido.';

-- A antiga regra "Receitas" vira Salário, só para entradas
update regras_categoria set categoria_id = (select id from categorias where nome = 'Salário'), sentido = 'entrada', prioridade = 7,
  padrao = '(SALARIO|PROVENTOS|\bFOLHA\b|PAGTO SALARIO|PGTO SALARIO|REMUNERACAO MENSAL|\bFGTS\b)'
where padrao like '(SALARIO|PROVENTOS%' and alvo = 'transacao';

insert into regras_categoria (alvo, tipo, padrao, categoria_id, prioridade, origem, sentido)
select 'transacao', 'regex', r.padrao, c.id, r.prioridade, 'sistema', r.sentido
from (values
  ('(ESTORNO|REEMBOLSO|DEVOLUCAO|CASHBACK|RESSARCIMENTO|RESTITUICAO|RECEITA FEDERAL|SECR DA RECEITA)', 'Reembolsos e estornos', 5, 'entrada'),
  ('(RENDIMENTO|DIVIDENDO|\bJCP\b|REND PAGO|REMUNERACAO BASICA)', 'Rendimentos', 6, 'entrada'),
  ('(RENEGOCIACAO|SALDO DEVEDOR|RECLASSIF|PROVISAO JUROS|CREDITO CONTRATADO|EMPRESTIMO LIBERADO|LIBERACAO DE CREDITO)', 'Crédito contratado', 4, 'entrada'),
  ('(VALOR ADICIONADO NA CONTA|PIX NO CREDITO)', 'Transferência entre contas', 4, null),
  ('(PIX RECEBIDO|TRANSFERENCIA RECEBIDA|TRANSF RECEBIDA|RECEBIMENTO PIX|TED RECEBIDA|DOC RECEBIDO)', 'Pix e transferências recebidas', 9, 'entrada'),
  ('(FINANCIAM FAT|PARCELAMEN FATURA|PARCELAMENTO FATURA|PARCELAMENTO DE FATURA|CREDIARIO|LUIZA CRED|PGTO MIN|PAGAMENTO MINIMO)', 'Pagamento de dívida', 8, 'saida'),
  ('(JUROS|ENCARGOS|\bIOF\b|MULTA ATRASO|MORA)', 'Tarifas e juros', 9, 'saida')
) as r(padrao, categoria, prioridade, sentido)
join categorias c on c.nome = r.categoria
on conflict (alvo, tipo, padrao) do nothing;

-- ---------- Preferências do planejamento ---------------------------------------
create table if not exists preferencias (
  chave         text primary key,
  valor         text,
  atualizado_em timestamptz not null default now()
);
comment on table preferencias is 'Preferências do casal para o planejamento: renda_mensal (se vazio, o app estima pelas receitas), meta_poupanca_pct, reserva_meses, nomes_proprios.';
alter table preferencias enable row level security;
drop policy if exists membros_tudo on preferencias;
create policy membros_tudo on preferencias for all to authenticated using (eh_membro()) with check (eh_membro());
insert into preferencias (chave, valor) values ('meta_poupanca_pct', '20'), ('reserva_meses', '6')
on conflict (chave) do nothing;

-- ---------- Visões --------------------------------------------------------------
create or replace view v_receitas with (security_invoker = true) as
select t.id as transacao_id, t.data, to_char(t.data, 'YYYY-MM') as mes, t.descricao,
       coalesce(c.apelido, c.nome) as conta, t.valor, t.categoria_id,
       coalesce(cat.nome, 'Sem categoria') as categoria
from transacoes t
join contas c on c.id = t.conta_id
left join categorias cat on cat.id = t.categoria_id
where not t.removida and t.sentido = 'entrada' and coalesce(cat.natureza, 'receita') = 'receita';
comment on view v_receitas is 'Receitas (entradas que são renda: salário, pix recebidos, reembolsos, rendimentos...). Movimentos entre contas próprias, resgates e pagamentos de fatura ficam de fora.';

create or replace view v_fluxo_mensal with (security_invoker = true) as
with g as (select mes, sum(valor) as despesas from v_gastos where conta_como_gasto group by 1),
     r as (select mes, sum(valor) as receitas from v_receitas group by 1),
     d as (select to_char(t.data, 'YYYY-MM') as mes, sum(t.valor) as pagamento_dividas
           from transacoes t join categorias c on c.id = t.categoria_id
           where not t.removida and t.sentido = 'saida' and c.nome = 'Pagamento de dívida' group by 1)
select coalesce(g.mes, r.mes, d.mes) as mes, coalesce(r.receitas, 0) as receitas, coalesce(g.despesas, 0) as despesas,
       coalesce(d.pagamento_dividas, 0) as pagamento_dividas,
       coalesce(r.receitas, 0) - coalesce(g.despesas, 0) - coalesce(d.pagamento_dividas, 0) as sobra
from g full join r on r.mes = g.mes full join d on d.mes = coalesce(g.mes, r.mes);
comment on view v_fluxo_mensal is 'Por mês: receitas, despesas (consumo), pagamentos de dívidas e o que sobrou.';

-- Saldo negativo em conta corrente é dívida (cheque especial)
create or replace view v_dividas with (security_invoker = true) as
select 'divida' as fonte, d.id::text as id, d.nome, d.tipo, d.credor, d.saldo_devedor, d.parcela_valor,
       d.parcelas_total, d.parcelas_pagas, d.dia_vencimento, d.origem
from dividas d where d.ativa
union all
select 'cheque_especial', c.id, 'Cheque especial · ' || coalesce(c.apelido, c.nome), 'cheque_especial', null, abs(c.saldo), null, null, null, null, 'open_finance'
from contas c where c.tipo = 'BANK' and c.saldo < 0
union all
select 'fatura', c.id, 'Fatura atual · ' || coalesce(c.apelido, c.nome), 'cartao', null, abs(c.saldo), null, null, null, null, 'open_finance'
from contas c where c.tipo = 'CREDIT' and coalesce(abs(c.saldo), 0) > 0
union all
select 'parcelas', p.conta_id, 'Parcelas futuras · ' || coalesce(c.apelido, c.nome), 'cartao', null, sum(p.valor_restante), null, null, null, null, 'open_finance'
from v_cartao_parcelas_futuras p join contas c on c.id = p.conta_id
group by p.conta_id, c.apelido, c.nome;
comment on view v_dividas is 'Tudo o que se deve hoje: dívidas cadastradas, empréstimos do Open Finance, cheque especial (saldo negativo em conta), fatura atual e parcelas futuras do cartão.';

create or replace view v_pendencias with (security_invoker = true) as
select 'nota_sem_gasto' as tipo, n.id::text as id, (n.emissao at time zone 'America/Sao_Paulo')::date as data,
       n.nome_emitente as descricao, n.valor_pago as valor
from notas n where n.vinculo_status in ('pendente','confirmar')
union all
select 'gasto_sem_categoria', t.id, t.data, t.descricao, t.valor
from transacoes t
where not t.removida and t.categoria_id is null;
comment on view v_pendencias is 'O que precisa de atenção: notas ainda sem gasto vinculado e lançamentos (despesas ou receitas) sem categoria.';
