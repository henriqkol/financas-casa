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
  const regras: any[] = [];
  const re = /\('(item|transacao)', '((?:[^']|'')*)', '([^']+)', (\d+)\)/g;
  let m, id = 1;
  while ((m = re.exec(sql))) {
    if (!nomes.includes(m[3])) nomes.push(m[3]);
    regras.push({ id: id++, alvo: m[1], tipo: "regex", padrao: m[2].replace(/''/g, "'"), categoria_id: nomes.indexOf(m[3]) + 1, prioridade: Number(m[4]) });
  }
  return { regras: compilarRegras(regras), nomes, porNome: Object.fromEntries(nomes.map((n, i) => [n, i + 1])) };
}

test("regras: todas as expressões compilam", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0002_regras.sql", import.meta.url), "utf8");
  const n = (sql.match(/\('(item|transacao)', '/g) ?? []).length;
  assert.equal(regrasDoSql().regras.length, n);
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
  assert.equal(cat({ descricao: "TED RECEBIDA EMPRESA X", sentido: "entrada", conta_tipo: "BANK" }), "Receitas");

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
