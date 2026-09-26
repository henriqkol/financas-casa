// Testes da lógica pura do backend. Rodar: node --experimental-strip-types --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chaveAprendizado, numeroBR, normalizar, textoDeHtml, dataBrasilia, diasEntre } from "../supabase/functions/api/lib/texto.ts";
import { extrairDoPortal, infoDaChave, lerQr, urlsDeConsulta, hostPermitido } from "../supabase/functions/api/lib/nfce.ts";
import { aplicarRegras, categorizarTransacao, compilarRegras, categoriaDominante } from "../supabase/functions/api/lib/categorizar.ts";
import { candidatos, escolhaAutomatica, pontuar } from "../supabase/functions/api/lib/vinculo.ts";
import { normalizarTransacao, dataDoLancamento } from "../supabase/functions/api/lib/pluggy.ts";

const CHAVE = "43260904784082000163652040001781671145519190";

test("texto: números BR e normalização", () => {
  assert.equal(numeroBR("1.234,56"), 1234.56);
  assert.equal(numeroBR("54,9"), 54.9);
  assert.equal(numeroBR("0,124"), 0.124);
  assert.equal(numeroBR("12"), 12);
  assert.equal(numeroBR(""), null);
  assert.equal(normalizar("  Pão   de Açúcar "), "PAO DE ACUCAR");
  assert.equal(chaveAprendizado("PIX TRANSF MARIA S 25/09"), "PIX TRANSF MARIA S");
  assert.equal(textoDeHtml("<strong>Qtde.:</strong>&nbsp;1,5"), "Qtde.: 1,5");
  assert.equal(dataBrasilia("2026-09-25T02:30:00Z"), "2026-09-24");
  assert.equal(diasEntre("2026-09-25", "2026-09-27"), 2);
});

test("nfce: chave e QR (online, offline, v1)", () => {
  const info = infoDaChave(CHAVE)!;
  assert.equal(info.uf, "RS");
  assert.equal(info.anoMes, "2026-09");
  assert.equal(info.cnpj, "04784082000163");
  assert.equal(info.modelo, "65");
  assert.equal(info.serie, "204");

  const online = lerQr(`https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${CHAVE}|2|1|1|A274DF310A01C053663AF39A5A94F59CBF44B5A7`);
  assert.equal(online.chave, CHAVE);
  assert.equal(online.valorNoQr, null);
  const urls = urlsDeConsulta(online);
  assert.equal(urls[0], `https://dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce?p=${CHAVE}|2|1|1|A274DF310A01C053663AF39A5A94F59CBF44B5A7`);
  assert.equal(urls.length, 2);

  const offline = lerQr(`https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${CHAVE}|2|1|18|81.74|6a4f|1|ABCDEF`);
  assert.equal(offline.valorNoQr, 81.74);
  assert.equal(offline.diaNoQr, "18");

  const soChave = lerQr(CHAVE);
  assert.equal(soChave.chave, CHAVE);
  assert.equal(urlsDeConsulta(soChave).length, 0);

  assert.equal(hostPermitido("https://evil.com/?x=.gov.br"), false);
  assert.equal(hostPermitido("https://www.nfce.fazenda.sp.gov.br/qrcode?p=1"), true);
});

test("nfce: extrai página do portal (layout SVRS)", () => {
  const html = readFileSync(new URL("./fixtures/nfce-rs.html", import.meta.url), "utf8");
  const n = extrairDoPortal(html);
  assert.equal(n.nome_emitente, "MERCEARIA J O L I LTDA");
  assert.equal(n.cnpj_emitente, "04784082000163");
  assert.match(n.endereco!, /PORTO ALEGRE/);
  assert.equal(n.itens.length, 4);
  assert.deepEqual(n.itens[0], {
    ordem: 1, codigo: "32798", descricao: "ENERGETICO BALY 473ML ABACAXI/ HORTELA",
    quantidade: 1, unidade: "UN", valor_unitario: 8.99, valor_total: 8.99,
  });
  assert.equal(n.itens[1].quantidade, 0.124);
  assert.equal(n.itens[1].unidade, "KG");
  assert.equal(n.itens[1].codigo, "105");
  assert.equal(n.itens[3].descricao, "DETERG LIQ YPE NEUTRO 500ML");
  assert.equal(n.valor_total, 42.29);
  assert.equal(n.desconto, 1.5);
  assert.equal(n.valor_pago, 40.79);
  assert.equal(n.qtd_itens, 4);
  assert.equal(n.forma_pagamento, "Cartão de Crédito");
  assert.equal(n.numero, "178167");
  assert.equal(n.serie, "204");
  assert.equal(n.emissao, "2026-09-18T18:24:51-03:00");
  assert.equal(n.chave, CHAVE);
});

test("nfce: layout desconhecido não quebra", () => {
  const n = extrairDoPortal("<html><body>Erro na consulta</body></html>");
  assert.equal(n.itens.length, 0);
  assert.equal(n.valor_pago, null);
});

// Regras reais, lidas da migração SQL
function regrasDoSql() {
  const sql = readFileSync(new URL("../supabase/migrations/0002_regras.sql", import.meta.url), "utf8");
  const base = readFileSync(new URL("../supabase/migrations/0001_base.sql", import.meta.url), "utf8");
  const nomes: string[] = [...base.matchAll(/^\s*\('([^']+)',\s*'[^']+',\s*'#/gm)].map((m) => m[1]);
  const m6 = readFileSync(new URL("../supabase/migrations/0006_receitas_planejamento.sql", import.meta.url), "utf8");
  for (const m of m6.matchAll(/^\s*\('([^']+)',\s*'[^']+',\s*'#/gm)) if (!nomes.includes(m[1])) nomes.push(m[1]);
  nomes[nomes.indexOf("Receitas")] = "Outras receitas";
  nomes.push("Pagamento de dívida"); // criada na 0005
  const regras: any[] = [];
  const re = /\('(item|transacao)', '((?:[^']|'')*)', '([^']+)', (\d+)\)/g;
  let m, id = 1;
  while ((m = re.exec(sql))) {
    if (!nomes.includes(m[3])) nomes.push(m[3]);
    regras.push({ id: id++, alvo: m[1], tipo: "regex", padrao: m[2].replace(/''/g, "'"), categoria_id: nomes.indexOf(m[3]) + 1, prioridade: Number(m[4]) });
  }
  // Regras da 0006 (com sentido) e a regra de salário reescrita
  const re6 = /\('((?:[^']|'')*)', '([^']+)', (\d+), (null|'entrada'|'saida')\)/g;
  let m2;
  while ((m2 = re6.exec(m6))) {
    regras.push({ id: id++, alvo: "transacao", tipo: "regex", padrao: m2[1], categoria_id: nomes.indexOf(m2[2]) + 1, prioridade: Number(m2[3]), sentido: m2[4] === "null" ? null : m2[4].replace(/'/g, "") });
  }
  const sal = regras.find((r) => r.padrao.startsWith("(SALARIO|PROVENTOS"));
  Object.assign(sal, { padrao: m6.match(/padrao = '([^']+)'/)![1], categoria_id: nomes.indexOf("Salário") + 1, prioridade: 7, sentido: "entrada" });
  return { regras: compilarRegras(regras), nomes, porNome: Object.fromEntries(nomes.map((n, i) => [n, i + 1])) };
}

test("regras: todas as expressões compilam", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0002_regras.sql", import.meta.url), "utf8");
  const n = (sql.match(/\('(item|transacao)', '/g) ?? []).length;
  assert.equal(regrasDoSql().regras.length, n + 7);
});

test("regras: itens de supermercado", () => {
  const { regras, nomes } = regrasDoSql();
  const cat = (d: string) => { const r = aplicarRegras(d, regras, "item"); return r ? nomes[r.categoria_id - 1] : null; };
  const casos: [string, string][] = [
    ["ARROZ TIO JOAO T1 5KG", "Mercado"],
    ["CERV SKOL LT 350ML", "Bebidas alcoólicas"],
    ["REFRIG COCA COLA PET 2L", "Bebidas"],
    ["AGUA SANITARIA QBOA 2L", "Limpeza"],
    ["AGUA MIN S/GAS 500ML", "Bebidas"],
    ["DETERG LIQ YPE NEUTRO 500ML", "Limpeza"],
    ["SABONETE DOVE 90G", "Higiene e beleza"],
    ["PAPEL HIG NEVE 12UN", "Higiene e beleza"],
    ["DIPIRONA 500MG C/10 CPR", "Farmácia e saúde"],
    ["RACAO PEDIGREE AD 1KG", "Pet"],
    ["BANANA CATURRA KG", "Hortifruti"],
    ["BATATA DOCE KG", "Hortifruti"],
    ["BATATA PALHA ELMA 120G", "Doces e snacks"],
    ["QUEIJO LANCHE STA HELENA KG", "Carnes e frios"],
    ["PAO DE QUEIJO FORNO DE MINAS", "Padaria"],
    ["PAO FRANCES KG", "Padaria"],
    ["MOLHO DE TOMATE POMAROLA", "Mercado"],
    ["LEITE COND MOCOCA 395G", "Mercado"],
    ["SUCO DEL VALLE LARANJA 1L", "Bebidas"],
    ["BISCOITO RECHEADO TRAKINAS", "Doces e snacks"],
    ["ACHOCOLATADO NESCAU 400G", "Mercado"],
    ["GASOLINA COMUM", "Combustível"],
    ["ERVA MATE BARAO 1KG", "Mercado"],
    ["FILE PEITO FRANGO SADIA 1KG", "Carnes e frios"],
  ];
  for (const [d, esperado] of casos) assert.equal(cat(d), esperado, d);
});

test("regras: lançamentos bancários", () => {
  const { regras, nomes, porNome } = regrasDoSql();
  const cat = (t: any) => { const r = categorizarTransacao({ sentido: "saida", ...t }, regras, porNome); return r ? nomes[r.categoria_id - 1] : null; };
  assert.equal(cat({ descricao: "UBER *TRIP HELP.UBER.COM" }), "Transporte");
  assert.equal(cat({ descricao: "IFD*IFOOD CLUB" }), "Restaurante e delivery");
  assert.equal(cat({ descricao: "ZAFFARI HIPICA" }), "Mercado");
  assert.equal(cat({ descricao: "PAG BOLETO NU PAGAMENTOS SA" }), "Pagamento de fatura");
  assert.equal(cat({ descricao: "Aplicação RDB" }), "Investimentos");
  assert.equal(cat({ descricao: "MERCADOLIVRE*LOJA" }), "Outros");
  assert.equal(cat({ descricao: "PANVEL FARMACIAS" }), "Farmácia e saúde");
  assert.equal(cat({ descricao: "NETFLIX.COM" }), "Assinaturas");
  assert.equal(cat({ descricao: "PIX TRANSF FULANA 25/09" }), null);
  assert.equal(cat({ descricao: "PIX TRANSF MEU NOME", pagador_doc: "123.456.789-00", recebedor_doc: "12345678900" }), "Transferência entre contas");
  assert.equal(cat({ descricao: "Pagamento recebido", sentido: "entrada", conta_tipo: "CREDIT" }), "Pagamento de fatura");
  assert.equal(cat({ descricao: "TED RECEBIDA EMPRESA X", sentido: "entrada", conta_tipo: "BANK" }), "Pix e transferências recebidas");

  // Regra aprendida (exata) vence as do sistema
  const aprendida = compilarRegras([...regras, { id: 999, alvo: "transacao", tipo: "exato", padrao: "PIX TRANSF FULANA", categoria_id: porNome["Repasse família"], prioridade: 1 }]);
  const r = categorizarTransacao({ sentido: "saida", descricao: "PIX TRANSF FULANA 02/10" }, aprendida, porNome);
  assert.equal(nomes[r!.categoria_id - 1], "Repasse família");
});

test("categoria dominante pelo valor", () => {
  assert.equal(categoriaDominante([
    { categoria_id: 1, valor_total: 10 }, { categoria_id: 2, valor_total: 15 }, { categoria_id: 1, valor_total: 6 }, { categoria_id: null, valor_total: 99 },
  ]), 1);
});

test("vínculo: Pix para a esposa dois dias depois", () => {
  const nota = { id: "n1", valor: 36.75, emissao: "2026-09-20T15:10:00-03:00", cnpj: "11222333000144", nome: "PADARIA PAO QUENTE LTDA" };
  const txs = [
    { id: "t1", valor: 36.75, data: "2026-09-22", descricao: "PIX TRANSF MARIA 22/09" },
    { id: "t2", valor: 36.70, data: "2026-09-20", descricao: "PADARIA PAO QUENTE" },
    { id: "t3", valor: 36.75, data: "2026-10-15", descricao: "OUTRA COISA" },
  ];
  const cs = candidatos(nota, txs);
  assert.equal(cs.length, 1);
  assert.equal(escolhaAutomatica(cs)?.transacao_id, "t1");
});

test("vínculo: nome do estabelecimento desempata; empate vira confirmação", () => {
  const nota = { id: "n1", valor: 25, emissao: "2026-09-20T12:00:00-03:00", nome: "COMERCIAL ZAFFARI LTDA" };
  const cs = candidatos(nota, [
    { id: "a", valor: 25, data: "2026-09-20", descricao: "ZAFFARI HIPICA", conta_tipo: "CREDIT" },
    { id: "b", valor: 25, data: "2026-09-21", descricao: "UBER TRIP" },
  ]);
  assert.equal(escolhaAutomatica(cs)?.transacao_id, "a");

  const empate = candidatos({ id: "n2", valor: 5, emissao: "2026-09-20T12:00:00-03:00", nome: "CAFE X" }, [
    { id: "a", valor: 5, data: "2026-09-20", descricao: "COMPRA 1" },
    { id: "b", valor: 5, data: "2026-09-20", descricao: "COMPRA 2" },
  ]);
  assert.equal(empate.length, 2);
  assert.equal(escolhaAutomatica(empate), null);
});

test("vínculo: parcelado e já vinculado", () => {
  const nota = { id: "n1", valor: 300, emissao: "2026-09-10T10:00:00-03:00" };
  const p = pontuar(nota, { id: "x", valor: 100, data: "2026-09-10", descricao: "LOJA X 1/3", parcelas_total: 3, parcela_numero: 1 });
  assert.ok(p && p.pontos >= 40);
  const cs = candidatos(nota, [{ id: "y", valor: 300, data: "2026-09-10", descricao: "LOJA", ja_vinculada: true }]);
  assert.equal(escolhaAutomatica(cs), null);
});

test("pluggy: normalização de lançamentos", () => {
  assert.equal(dataDoLancamento("2026-09-15T00:00:00.000Z"), "2026-09-15");
  assert.equal(dataDoLancamento("2026-09-15T01:30:00.000Z"), "2026-09-14");
  const conta = normalizarTransacao({
    id: "t", accountId: "c", description: "PIX TRANSF", amount: -36.75, date: "2026-09-22T00:00:00.000Z", type: "DEBIT",
    paymentData: { payer: { documentNumber: { value: "123.456.789-00" } }, receiver: { name: "Maria", documentNumber: { value: "987.654.321-00" } } },
  }, "BANK");
  assert.equal(conta.valor, 36.75);
  assert.equal(conta.sentido, "saida");
  assert.equal(conta.recebedor_doc, "98765432100");
  assert.equal(conta.recebedor_nome, "Maria");

  const cartao = normalizarTransacao({
    id: "t2", accountId: "c2", description: "ZAFFARI", amount: 120.5, date: "2026-09-22T00:00:00.000Z",
    creditCardMetadata: { installmentNumber: 1, totalInstallments: 3 },
  }, "CREDIT");
  assert.equal(cartao.sentido, "saida");
  assert.equal(cartao.parcelas_total, 3);
  const pagamento = normalizarTransacao({ id: "t3", accountId: "c2", description: "Pagamento recebido", amount: -500, date: "2026-09-22T00:00:00.000Z" }, "CREDIT");
  assert.equal(pagamento.sentido, "entrada");
});

// ------------------------------------------------------------------ patrimônio
import { normalizarInvestimento, normalizarEmprestimo, reconhecerPagamentos } from "../supabase/functions/api/lib/patrimonio.ts";

test("patrimônio: caixinha do Nubank vira aplicação com datas de Brasília", () => {
  const i = normalizarInvestimento({
    id: "x", name: "CDB - NU FINANCEIRA S.A.", type: "FIXED_INCOME", subtype: "CDB", rate: 100, rateType: "CDI",
    amount: 1.01, balance: 0.99, amountOriginal: 0.8441970000000001, amountWithdrawal: 0.99, status: "ACTIVE",
    issueDate: "2025-06-18T03:00:00.000Z", dueDate: "2027-06-18T03:00:00.000Z", issuer: "NU FINANCEIRA",
  }, "item1");
  assert.equal(i.data_aplicacao, "2025-06-18");
  assert.equal(i.vencimento, "2027-06-18");
  assert.equal(i.valor_aplicado, 0.84);
  assert.equal(i.saldo_liquido, 0.99);
  assert.equal(i.indexador, "CDI");
});

test("patrimônio: empréstimo do Open Finance", () => {
  const d = normalizarEmprestimo({ id: "l1", productName: "Crédito pessoal", kind: "LOAN", contractAmount: 10000,
    contractOutstandingBalance: 6000, totalNumberOfInstallments: 24, contractRemainingNumber: 12, CET: 45.1 });
  assert.equal(d.tipo, "emprestimo");
  assert.equal(d.parcelas_pagas, 12);
  assert.equal(d.parcela_valor, 500);
  assert.equal(d.ativa, true);
  assert.equal(normalizarEmprestimo({ id: "l2", kind: "FINANCING", contractOutstandingBalance: 0 }).ativa, false);
});

test("patrimônio: reconhece pagamentos pelo texto do extrato", () => {
  const usados = new Set(["t0"]);
  const r = reconhecerPagamentos(
    [{ id: 1, padrao_pagamento: "PIX TRANSF JOAO" }, { id: 2, padrao_pagamento: null }],
    [
      { id: "t0", data: "2026-09-01", valor: 300, descricao: "PIX TRANSF JOAO 01/09" },
      { id: "t1", data: "2026-10-01", valor: 300, descricao: "PIX TRANSF JOAO 01/10" },
      { id: "t2", data: "2026-10-02", valor: 50, descricao: "PIX TRANSF JOAOZINHO" },
    ], usados);
  assert.deepEqual(r, [{ divida_id: 1, transacao_id: "t1", data: "2026-10-01", valor: 300 }]);
});


// ------------------------------------------------------------------ receitas e sugestões
import { gerarDiagnostico, mesesAnteriores, taxaEstimada, tipoDeJuros } from "../supabase/functions/api/lib/sugestoes.ts";

test("receitas: categorização por tipo de operação e texto", () => {
  const { regras, nomes, porNome } = regrasDoSql();
  const cat = (t: any) => { const r = categorizarTransacao({ sentido: "entrada", conta_tipo: "BANK", ...t }, regras, porNome); return r ? nomes[r.categoria_id - 1] : null; };
  assert.equal(cat({ descricao: "Transferência Recebida", tipo_operacao: "PORTABILIDADE_SALARIO" }), "Salário");
  assert.equal(cat({ descricao: "Resgate RDB", tipo_operacao: "RESGATE_APLIC_FINANCEIRA" }), "Investimentos");
  assert.equal(cat({ descricao: "Transferência Recebida|IVAN KOLLING", tipo_operacao: "PIX" }), "Pix e transferências recebidas");
  assert.equal(cat({ descricao: "Reembolso recebido pelo Pix|PIX Marketplace" }), "Reembolsos e estornos");
  assert.equal(cat({ descricao: "ESTORNO JUROS DE FINANC", tipo_operacao: "ESTORNO" }), "Reembolsos e estornos");
  assert.equal(cat({ descricao: "Transferência Recebida|SECR. DA RECEITA FEDERAL" }), "Reembolsos e estornos");
  assert.equal(cat({ descricao: "RENEGOCIACAO CARTAO 1/1 R", conta_tipo: "CREDIT" }), "Crédito contratado");
  assert.equal(cat({ descricao: "Valor adicionado na conta por cartão de crédito" }), "Transferência entre contas");
  assert.equal(cat({ descricao: "Pagamento recebido", tipo_operacao: "PAGAMENTO_FATURA", conta_tipo: "CREDIT" }), "Pagamento de fatura");
  assert.equal(cat({ descricao: "DEPOSITO QUALQUER" }), "Outras receitas");
  // saídas não caem em regras de entrada
  const saida = (t: any) => { const r = categorizarTransacao({ sentido: "saida", ...t }, regras, porNome); return r ? nomes[r.categoria_id - 1] : null; };
  assert.equal(saida({ descricao: "FINANCIAM FAT 3/12" }), "Pagamento de dívida");
  assert.equal(saida({ descricao: "SAÍDA JUROS LIMITE DA CONTA", tipo_operacao: "ENCARGOS_JUROS_CHEQUE_ESPECIAL" }), "Tarifas e juros");
  assert.equal(saida({ descricao: "JUROS DE FINANCIAMENTO" }), "Tarifas e juros");
});

test("sugestões: meses de referência e juros", () => {
  assert.deepEqual(mesesAnteriores("2026-01-15", 3), ["2025-10", "2025-11", "2025-12"]);
  assert.equal(tipoDeJuros("SAÍDA JUROS LIMITE DA CONTA"), "cheque_especial");
  assert.equal(tipoDeJuros("JUROS ATRASO PARC 3"), "atraso");
  assert.equal(tipoDeJuros("JUROS DE FINANCIAMENTO"), "cartao");
  assert.equal(taxaEstimada("cheque_especial", null).taxa, 8);
  assert.equal(taxaEstimada("emprestimo", 2.5).estimada, false);
});

function dadosBase(extra: any = {}) {
  const meses = ["2026-06", "2026-07", "2026-08"];
  return {
    hoje: "2026-09-20",
    gastos: [
      ...meses.flatMap((mes) => [
        { mes, categoria: "Mercado", classe: "essencial", valor: 2000, n: 10 },
        { mes, categoria: "Contas da casa", classe: "essencial", valor: 1500, n: 4 },
        { mes, categoria: "Restaurante e delivery", classe: "estilo_vida", valor: 1200, n: 15 },
        { mes, categoria: "Lazer", classe: "estilo_vida", valor: 800, n: 3 },
        { mes, categoria: "Tarifas e juros", classe: "essencial", valor: 900, n: 6 },
      ]),
      { mes: "2026-09", categoria: "Mercado", classe: "essencial", valor: 2400, n: 9 },
    ],
    receitas: meses.map((mes) => ({ mes, categoria: "Salário", valor: 11300 })),
    pagamentosDivida: meses.map((mes) => ({ mes, valor: 2300 })),
    juros: meses.flatMap((mes) => [{ mes, tipo: "cheque_especial", valor: 600 }, { mes, tipo: "atraso", valor: 300 }]),
    recorrentes: [{ descricao: "TELEFONICA BRASIL", categoria: "Contas da casa", valor_medio: 108, meses: 3 }],
    contas: [{ nome: "Itaú", tipo: "BANK", saldo: -18141.64 }, { nome: "Nubank", tipo: "BANK", saldo: 9391.22 }],
    dividas: [{ nome: "Empréstimo", tipo: "emprestimo", saldo: 10000, taxa_mensal: 3.2, parcela: 500, origem: "manual" }],
    cartao: { fatura: 0, parcelas_futuras: 0 },
    investido: 2,
    repasse: { total: 3000, com_nota: 300 },
    prefs: { renda_mensal: null, meta_poupanca_pct: 20, reserva_meses: 6 },
    cdi_anual: 14.9,
    pendencias: { notas: 0, sem_categoria: 3 },
    ufs_notas: ["RS"],
    ...extra,
  };
}

test("sugestões: diagnóstico com cheque especial e dinheiro parado em outra conta", () => {
  const r = gerarDiagnostico(dadosBase());
  assert.equal(r.plano.renda, 11300);
  assert.equal(r.plano.despesas_media, 6400);
  assert.equal(r.plano.essencial.atual, 4400);
  assert.equal(r.plano.gasto_ideal, 9040);
  const ids = r.sugestoes.map((s: any) => s.id);
  assert.equal(r.sugestoes[0].id, "cheque-Itaú");
  const cheque = r.sugestoes[0];
  assert.match(cheque.texto, /transferir R\$ 9\.391,22/);
  assert.ok(cheque.economia_mensal > 250 && cheque.economia_mensal < 800, String(cheque.economia_mensal));
  assert.ok(ids.includes("juros"));
  assert.ok(ids.includes("ordem-dividas"));
  assert.ok(ids.includes("portabilidade"));
  assert.ok(ids.includes("delivery"));
  assert.ok(ids.includes("alta-Mercado"), "Mercado 2400 até dia 20 projeta 3600 > 2000*1,3");
  assert.ok(ids.includes("repasse"));
  assert.ok(ids.includes("nfg"));
  assert.ok(!ids.includes("saldo-parado"), "com cheque especial não sugere investir o saldo");
  const ordem = r.sugestoes.find((s: any) => s.id === "ordem-dividas").itens;
  assert.match(ordem[0].rotulo, /Cheque especial/);
  assert.ok(r.economia_potencial > 0);
});

test("sugestões: sem dívidas sugere reserva e investir saldo parado", () => {
  const r = gerarDiagnostico(dadosBase({
    contas: [{ nome: "Nubank", tipo: "BANK", saldo: 20000 }], dividas: [], juros: [],
    gastos: dadosBase().gastos.filter((g: any) => g.categoria !== "Tarifas e juros"),
    pagamentosDivida: [], repasse: { total: 0, com_nota: 0 },
  }));
  const ids = r.sugestoes.map((s: any) => s.id);
  assert.ok(ids.includes("saldo-parado"));
  assert.ok(ids.includes("reserva"));
  assert.ok(!ids.includes("ordem-dividas"));
  assert.ok(!ids.includes("deficit"));
  assert.equal(r.reserva.meta, 3500 * 6);
});

test("sugestões: renda informada tem prioridade e déficit vira alerta", () => {
  const r = gerarDiagnostico(dadosBase({ prefs: { renda_mensal: 7000, meta_poupanca_pct: 20, reserva_meses: 6 } }));
  assert.equal(r.plano.renda, 7000);
  assert.equal(r.plano.origem_renda, "informada");
  assert.ok(r.sugestoes.some((s: any) => s.id === "deficit"));
  assert.ok(r.sugestoes.some((s: any) => s.id === "comprometimento"));
});
