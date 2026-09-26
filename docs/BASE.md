# Base de dados — Finanças da Casa

Guia para consultar a base (Supabase/Postgres), inclusive pelo Claude via conector Supabase.
Valores em R$. Datas no fuso de Brasília. Todo o dinheiro sai das contas do Rique (Itaú e Nubank);
Pix para a esposa são "repasses" que depois são explicados por notas fiscais.

## Como os dados se ligam

```
contas ──< transacoes >──< nota_transacao >──< notas ──< nota_itens
                │                                         │
            categorias <──────────────────────────────────┘
```

- **transacoes**: lançamentos do Open Finance. `valor` é sempre positivo; `sentido` = `saida` | `entrada`.
  `removida = true` → o banco reapresentou o lançamento com outro id; **ignore nas análises**.
- **notas / nota_itens**: notas fiscais escaneadas (NFC-e) e seus produtos, cada item com categoria.
- **nota_transacao**: qual nota explica qual gasto (uma nota pode cobrir várias parcelas; um Pix pode cobrir várias notas).
- **categorias**: `conta_como_gasto = false` para Pagamento de fatura, Transferência entre contas, Investimentos e Receitas
  (evita contar a fatura do cartão duas vezes).

## Visões prontas (use estas primeiro)

| Visão | Para quê |
|---|---|
| `v_gastos` | Uma linha por gasto × categoria. Gastos com nota são **divididos pelas categorias dos itens**. Filtre `conta_como_gasto = true` para somar gasto real. Colunas: transacao_id, data, mes (AAAA-MM), descricao, conta, conta_tipo, valor, categoria, grupo, via_nota |
| `v_resumo_mensal` | Total por mês e categoria (só o que é gasto) |
| `v_itens_comprados` | Todos os produtos comprados: data, loja, descrição, quantidade, preço unitário, total, categoria. Bom para comparar preços e consumo |
| `v_pendencias` | Notas sem gasto ligado e gastos sem categoria |

## Consultas úteis

```sql
-- Gasto por mês
select mes, sum(valor) from v_gastos where conta_como_gasto group by 1 order by 1;

-- Categorias do mês, com variação para o mês anterior
select categoria,
       sum(valor) filter (where mes = '2026-09') as setembro,
       sum(valor) filter (where mes = '2026-08') as agosto
from v_gastos where conta_como_gasto group by 1 order by 2 desc nulls last;

-- Preço médio de um produto por loja
select loja, round(avg(valor_unitario),2) preco_medio, count(*) compras
from v_itens_comprados where descricao_norm like '%LEITE%' group by 1 order by 2;

-- Quanto dos gastos tem nota fiscal
select mes, round(100 * sum(valor) filter (where via_nota) / sum(valor)) as pct_com_nota
from v_gastos where conta_como_gasto group by 1 order by 1;

-- Maiores gastos sem nota do mês
select data, descricao, conta, valor from v_gastos
where conta_como_gasto and not via_nota and mes = '2026-09' order by valor desc limit 20;
```

## Patrimônio (investimentos e dívidas)

| Visão / tabela | Para quê |
|---|---|
| `v_investimentos` | Cada aplicação hoje: caixinha, saldo líquido, valor aplicado, rendimento, vencimento, taxa (ex.: 100% CDI) |
| `v_caixinhas_historico` | Saldo diário por caixinha (soma das aplicações). Começa na 1ª sincronização com investimentos (26/09/2026) |
| `v_investimentos_historico` | Saldo diário do total investido |
| `investimento_saldos` | Fotografia diária de cada aplicação (a última sincronização do dia vale) |
| `caixinhas` | Caixinhas criadas no app (o Open Finance não informa o nome: cada depósito numa caixinha do Nubank vira um CDB separado, associado à caixinha pelo usuário) |
| `v_dividas` | Tudo o que se deve hoje: dívidas cadastradas, empréstimos do Open Finance, fatura atual e parcelas futuras do cartão |
| `v_cartao_parcelas_futuras` | Compras parceladas com parcelas ainda por vir |
| `dividas`, `divida_pagamentos`, `divida_saldos` | Cadastro, pagamentos (ligados ao extrato quando possível) e histórico do saldo devedor |

```sql
-- Evolução de cada caixinha
select dia, caixinha, saldo_liquido from v_caixinhas_historico order by dia, caixinha;

-- Patrimônio líquido hoje
select (select coalesce(sum(saldo_liquido),0) from investimentos where status <> 'TOTAL_WITHDRAWAL')
     - (select coalesce(sum(saldo_devedor),0) from v_dividas) as patrimonio_liquido;
```

## Outras tabelas

- `regras_categoria`: regras de categorização (regex em MAIÚSCULAS sem acento, ou `exato` = aprendida no app).
- `sync_log`: histórico da sincronização com o Open Finance (roda 06:15 e 18:15).
- `pluggy_itens`, `contas`: conexões e contas do Open Finance.
- `membros`: e-mails com acesso ao app.
- `app_config`: segredos (credenciais Pluggy etc.). **Nunca exibir o conteúdo.**
