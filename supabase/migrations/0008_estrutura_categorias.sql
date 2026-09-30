-- =====================================================================
-- Nova estrutura de categorias (definida pelo casal em 30/09/2026):
--   essencial_variavel · essencial_fixo · emergencial · estilo_vida
-- + metas por categoria (valor e periodicidade, para contas anuais)
-- + correção: Pix para a esposa NÃO é "Repasse família" (que é a ajuda às mães)
-- =====================================================================

-- ---------- Classes e metas ------------------------------------------------------
alter table categorias drop constraint if exists categorias_classe_check;
update categorias set classe = 'essencial_variavel' where classe = 'essencial';
alter table categorias add constraint categorias_classe_check
  check (classe in ('essencial_variavel','essencial_fixo','emergencial','estilo_vida'));
comment on column categorias.classe is
  'essencial_variavel (valor variável, meta fixa) · essencial_fixo (valor fixo, meta fixa) · emergencial (imprevistos, sem meta: formam a meta da reserva) · estilo_vida (variável, meta fixa). Receitas não têm classe; "Pagamento de dívida" é neutro mas aparece como compromisso fixo.';

alter table categorias add column if not exists meta_valor numeric(12,2);
alter table categorias add column if not exists periodicidade_meses smallint not null default 1;
alter table categorias drop constraint if exists categorias_periodicidade_check;
alter table categorias add constraint categorias_periodicidade_check check (periodicidade_meses in (1,2,3,6,12));
comment on column categorias.meta_valor is 'Meta de gasto por período (ex.: seguro anual de R$ 2.400 → meta_valor 2400, periodicidade 12). Vazio = sem meta.';
comment on column categorias.periodicidade_meses is 'De quantos em quantos meses a despesa acontece: 1 mensal, 12 anual… A meta mensal equivalente é meta_valor / periodicidade_meses.';

-- ---------- Renomeações ------------------------------------------------------------
update categorias set nome = 'Cursos' where nome = 'Educação' and not exists (select 1 from categorias where nome = 'Cursos');

-- ---------- Novas categorias -------------------------------------------------------
insert into categorias (nome, grupo, cor, conta_como_gasto, ordem, natureza, classe) values
  ('Material escolar',            'Educação',    '#6d8fc7', true, 34, 'despesa', 'essencial_variavel'),
  ('Pix para esposa (sem nota)',  'Família',     '#9b8ec4', true, 38, 'despesa', 'essencial_variavel'),
  ('Seguro veículo',              'Transporte',  '#5c7a99', true, 47, 'despesa', 'essencial_fixo'),
  ('Plano de saúde',              'Saúde',       '#d0556a', true, 48, 'despesa', 'essencial_fixo'),
  ('Plano de saúde pet',          'Saúde',       '#c77b8f', true, 49, 'despesa', 'essencial_fixo'),
  ('Mecânica e pneus',            'Transporte',  '#8a6d52', true, 60, 'despesa', 'emergencial'),
  ('Acionamento de seguro',       'Transporte',  '#8a7d6b', true, 61, 'despesa', 'emergencial'),
  ('Hospedagem imprevista',       'Transporte',  '#9a8a70', true, 62, 'despesa', 'emergencial'),
  ('Coparticipação do plano',     'Saúde',       '#b8606f', true, 63, 'despesa', 'emergencial'),
  ('Remédios não planejados',     'Saúde',       '#c46f6f', true, 64, 'despesa', 'emergencial'),
  ('Repasses extras',             'Doação',      '#a07cc0', true, 65, 'despesa', 'emergencial'),
  ('Viagem para visitar',         'Viagens',     '#3f9fb5', true, 82, 'despesa', 'estilo_vida'),
  ('Turismo',                     'Viagens',     '#2f86a6', true, 83, 'despesa', 'estilo_vida')
on conflict (nome) do nothing;

-- ---------- Classe, grupo e ordem de cada categoria --------------------------------
update categorias c set classe = v.classe, grupo = v.grupo, ordem = v.ordem
from (values
  -- Essenciais variáveis
  ('Mercado','essencial_variavel','Alimentação',10), ('Hortifruti','essencial_variavel','Alimentação',11),
  ('Carnes e frios','essencial_variavel','Alimentação',12), ('Padaria','essencial_variavel','Alimentação',13),
  ('Limpeza','essencial_variavel','Casa',20), ('Pet','essencial_variavel','Casa',21), ('Casa e utilidades','essencial_variavel','Casa',22),
  ('Higiene e beleza','essencial_variavel','Saúde',25), ('Farmácia e saúde','essencial_variavel','Saúde',26),
  ('Cursos','essencial_variavel','Educação',33), ('Material escolar','essencial_variavel','Educação',34),
  ('Combustível','essencial_variavel','Transporte',35), ('Transporte','essencial_variavel','Transporte',36),
  ('Pix para esposa (sem nota)','essencial_variavel','Família',38),
  -- Essenciais fixas
  ('Contas da casa','essencial_fixo','Casa',40),
  ('Tarifas e juros','essencial_fixo','Financeiro',41), ('Impostos','essencial_fixo','Financeiro',42),
  ('Repasse família','essencial_fixo','Família',44),
  ('Seguro veículo','essencial_fixo','Transporte',47),
  ('Plano de saúde','essencial_fixo','Saúde',48), ('Plano de saúde pet','essencial_fixo','Saúde',49),
  ('Assinaturas','essencial_fixo','Assinaturas',50),
  -- Estilo de vida
  ('Bebidas','estilo_vida','Alimentação',70), ('Bebidas alcoólicas','estilo_vida','Alimentação',71),
  ('Doces e snacks','estilo_vida','Alimentação',72), ('Restaurante e delivery','estilo_vida','Alimentação',73),
  ('Vestuário','estilo_vida','Pessoal',76), ('Eletrônicos','estilo_vida','Pessoal',77),
  ('Lazer','estilo_vida','Pessoal',78), ('Presentes','estilo_vida','Pessoal',79),
  ('Outros','estilo_vida','Outros',90)
) as v(nome, classe, grupo, ordem)
where c.nome = v.nome;

-- Pagamento de dívida: continua fora da soma de gastos (a compra já contou), mas é compromisso fixo do mês
update categorias set classe = 'essencial_fixo', grupo = 'Financeiro', ordem = 43 where nome = 'Pagamento de dívida';

-- ---------- Regras -----------------------------------------------------------------
-- Pix para a esposa: vira "Pix para esposa (sem nota)" (as notas escaneadas detalham o que foi comprado)
update regras_categoria set categoria_id = (select id from categorias where nome = 'Pix para esposa (sem nota)')
where padrao = 'LAYNARA DOS SANTOS LIMBERGER' and alvo = 'transacao';
update transacoes set categoria_id = (select id from categorias where nome = 'Pix para esposa (sem nota)')
where categoria_id = (select id from categorias where nome = 'Repasse família')
  and coalesce(categoria_origem, '') <> 'manual'
  and upper(descricao) like '%LAYNARA%';

-- Oficina/pneus saem de Transporte e viram imprevisto do carro
update regras_categoria set padrao = '(ESTACIONAMENTO|PEDAGIO|SEM PARAR|CONECTCAR|VELOE)'
where padrao = '(PNEU|AUTO ?PECAS|OFICINA|MECANICA|ESTACIONAMENTO|PEDAGIO|SEM PARAR|CONECTCAR|VELOE)' and alvo = 'transacao';
-- Seguros: plano de saúde tem prioridade; o resto é seguro do veículo
update regras_categoria set categoria_id = (select id from categorias where nome = 'Seguro veículo')
where padrao = '(SEGURADORA|SEGUROS|PORTO SEGURO|\bSEGURO\b)' and alvo = 'transacao';

insert into regras_categoria (alvo, tipo, padrao, categoria_id, prioridade, origem, sentido)
select 'transacao', 'regex', r.padrao, c.id, r.prioridade, 'sistema', 'saida'
from (values
  ('(PNEU|AUTO ?PECAS|OFICINA|MECANICA|FUNILARIA|BORRACHARIA|AUTO ?CENTER|RETIFICA|GUINCHO)', 'Mecânica e pneus', 21),
  ('(FRANQUIA)', 'Acionamento de seguro', 15),
  ('(COPARTICIPA|CO-PARTICIPA|CO PARTICIPA)', 'Coparticipação do plano', 14),
  ('(PETLOVE SAUDE|PLANO PET|PET ?SAUDE|HEALTH ?FOR ?PET|PETPLAN|PLANO DE SAUDE PET)', 'Plano de saúde pet', 15),
  ('(UNIMED|\bAMIL\b|HAPVIDA|NOTRE ?DAME|SULAMERICA SAUDE|SUL AMERICA SAUDE|BRADESCO SAUDE|PORTO SAUDE|IPE SAUDE|\bCASSI\b|\bGEAP\b|PLANO DE SAUDE)', 'Plano de saúde', 16),
  ('(PAPELARIA|LIVRARIA|KALUNGA|MATERIAL ESCOLAR)', 'Material escolar', 22),
  ('(AIRBNB|BOOKING|HOTEL|POUSADA|LATAM|GOL LINHAS|AZUL LINHAS|AZUL LINHAS AEREAS|DECOLAR|123 ?MILHAS|MAXMILHAS|HURB)', 'Turismo', 22)
) as r(padrao, categoria, prioridade)
join categorias c on c.nome = r.categoria
on conflict (alvo, tipo, padrao) do nothing;

-- ---------- Visão de metas ----------------------------------------------------------
create or replace view v_metas with (security_invoker = true) as
select c.id as categoria_id, c.nome as categoria, c.grupo, c.classe, c.meta_valor, c.periodicidade_meses,
       round(c.meta_valor / c.periodicidade_meses, 2) as meta_mensal,
       coalesce((select sum(g.valor) from v_gastos g
                 where g.categoria_id = c.id and g.mes = to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM')), 0) as gasto_mes_atual
from categorias c
where c.meta_valor is not null and c.ativa;
comment on view v_metas is 'Categorias com meta: meta mensal equivalente (meta_valor ÷ periodicidade) e quanto já foi gasto no mês atual.';
