// Função "api" — backend do app Finanças da Casa (Supabase Edge Function / Deno).
//
// Rotas (POST com JSON, exceto onde indicado):
//   GET  /saude                       → teste simples
//   POST /nfce            {texto}     → lê o QR da nota, consulta a SEFAZ, categoriza e tenta vincular
//   POST /nfce/reconsultar {nota_id}
//   POST /candidatos      {nota_id}   → gastos que podem ser esta nota
//   POST /vincular        {nota_id, transacao_id}
//   POST /desvincular     {nota_id, transacao_id}
//   POST /ignorar-nota    {nota_id, ignorar}
//   POST /categorizar-item       {item_id, categoria_id, aprender}
//   POST /categorizar-transacao  {transacao_id, categoria_id, aprender}
//   POST /recategorizar   {}          → reaplica as regras (após mudar regras)
//   POST /sync            {}          → busca contas e lançamentos no Open Finance
//   GET  /config  · POST /config {pluggy_client_id, pluggy_client_secret, anthropic_key}
//   POST /itens   {id, acao: "adicionar"|"remover"} · POST /descobrir-itens

import { createClient } from "npm:@supabase/supabase-js@2";
import { chaveAprendizado, dataBrasilia, normalizar } from "./lib/texto.ts";
import { decodificarHtml, extrairDoPortal, infoDaChave, lerQr, urlsDeConsulta } from "./lib/nfce.ts";
import {
  aplicarRegras, categoriaDominante, categorizarTransacao, compilarRegras,
  type RegraCompilada,
} from "./lib/categorizar.ts";
import { candidatos, escolhaAutomatica, JANELA, type TxCandidata } from "./lib/vinculo.ts";
import {
  autenticar, listarContas, listarItens, listarTransacoes, normalizarTransacao, obterItem,
  type LinhaTransacao,
} from "./lib/pluggy.ts";
import { categorizarComIA } from "./lib/ia.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class HttpErro extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function ok<T>(r: { data: T; error: any }): T {
  if (r.error) throw new HttpErro(500, r.error.message ?? String(r.error));
  return r.data;
}

/** Busca todas as linhas de uma consulta paginando de 1000 em 1000. */
async function todos<T = any>(consulta: (de: number, ate: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const lote = ok<T[]>(await consulta(de, de + 999));
    out.push(...lote);
    if (lote.length < 1000) break;
  }
  return out;
}

function addDias(dia: string, n: number): string {
  const d = new Date(dia + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ config

async function lerConfig(chaves: string[]): Promise<Record<string, string>> {
  const linhas = ok(await db.from("app_config").select("chave, valor").in("chave", chaves)) as any[];
  return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
}

async function gravarConfig(chave: string, valor: string | null) {
  if (valor == null || valor === "") {
    ok(await db.from("app_config").delete().eq("chave", chave));
  } else {
    ok(await db.from("app_config").upsert({ chave, valor, atualizado_em: new Date().toISOString() }));
  }
}

let cacheCategorias: { porNome: Record<string, number>; porId: Record<number, any>; nomes: string[] } | null = null;
async function categorias() {
  if (!cacheCategorias) {
    const lista = ok(await db.from("categorias").select("id, nome, conta_como_gasto, ativa")) as any[];
    cacheCategorias = {
      porNome: Object.fromEntries(lista.map((c) => [c.nome, c.id])),
      porId: Object.fromEntries(lista.map((c) => [c.id, c])),
      nomes: lista.filter((c) => c.ativa && c.conta_como_gasto).map((c) => c.nome),
    };
  }
  return cacheCategorias;
}

async function regras(): Promise<RegraCompilada[]> {
  const lista = await todos((de, ate) =>
    db.from("regras_categoria").select("id, alvo, tipo, padrao, categoria_id, prioridade").range(de, ate)
  );
  return compilarRegras(lista as any);
}

function textoTx(t: { descricao: string; recebedor_nome?: string | null }) {
  return [t.descricao, t.recebedor_nome].filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ auth

async function autorizar(req: Request, rota: string): Promise<{ email: string | null; cron: boolean }> {
  const segredo = req.headers.get("x-cron-secret");
  if (segredo) {
    const c = await lerConfig(["cron_secret"]);
    if (c.cron_secret && segredo === c.cron_secret && rota === "/sync") return { email: null, cron: true };
    throw new HttpErro(401, "Segredo inválido");
  }
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpErro(401, "Faça login no app");
  const { data, error } = await db.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new HttpErro(401, "Sessão expirada, faça login de novo");
  const m = ok(await db.from("membros").select("email").eq("email", email).maybeSingle());
  if (!m) throw new HttpErro(403, `O e-mail ${email} não está autorizado neste app`);
  return { email, cron: false };
}

// ------------------------------------------------------------------ categorização de itens

async function categorizarItens(
  itens: { descricao: string; valor_total: number }[],
  loja: string | null,
): Promise<{ categoria_id: number | null; categoria_origem: string | null }[]> {
  const rg = await regras();
  const cats = await categorias();
  const res = itens.map((i) => {
    const r = aplicarRegras(i.descricao, rg, "item");
    return r ? { categoria_id: r.categoria_id, categoria_origem: r.origem } : { categoria_id: null as number | null, categoria_origem: null as string | null };
  });

  const faltando = res.map((r, i) => (r.categoria_id ? -1 : i)).filter((i) => i >= 0);
  if (faltando.length) {
    const cfg = await lerConfig(["anthropic_key"]);
    if (cfg.anthropic_key) {
      try {
        const nomes = await categorizarComIA(cfg.anthropic_key, faltando.map((i) => itens[i].descricao), cats.nomes, loja);
        const novasRegras: any[] = [];
        faltando.forEach((idx, k) => {
          const nome = nomes[k];
          if (nome && cats.porNome[nome]) {
            res[idx] = { categoria_id: cats.porNome[nome], categoria_origem: "ia" };
            novasRegras.push({
              alvo: "item", tipo: "exato", padrao: normalizar(itens[idx].descricao),
              categoria_id: cats.porNome[nome], prioridade: 5, origem: "ia",
            });
          }
        });
        if (novasRegras.length) {
          await db.from("regras_categoria").upsert(novasRegras, { onConflict: "alvo,tipo,padrao", ignoreDuplicates: true });
        }
      } catch (e) {
        console.warn("IA falhou:", e);
      }
    }
  }

  // O que sobrou: usa o tipo de loja (ex.: supermercado → Mercado), senão "Outros".
  const pelaLoja = loja ? aplicarRegras(loja, rg, "transacao") : null;
  const lojaServe = pelaLoja && cats.porId[pelaLoja.categoria_id]?.conta_como_gasto;
  return res.map((r) =>
    r.categoria_id ? r
      : lojaServe ? { categoria_id: pelaLoja!.categoria_id, categoria_origem: "loja" }
      : { categoria_id: cats.porNome["Outros"] ?? null, categoria_origem: "padrao" }
  );
}

// ------------------------------------------------------------------ notas

const CABECALHOS_SEFAZ = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

async function consultarSefaz(notaId: string) {
  const nota = ok(await db.from("notas").select("*").eq("id", notaId).single()) as any;
  const qr = lerQr(nota.url ?? nota.chave);
  const urls = urlsDeConsulta(qr);
  let extr: ReturnType<typeof extrairDoPortal> | null = null;
  let erro = urls.length ? "" : "Este estado ainda não é suportado automaticamente (sem endereço de consulta).";
  let htmlBruto: string | null = null;

  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: CABECALHOS_SEFAZ, redirect: "follow", signal: AbortSignal.timeout(25000) });
      const html = decodificarHtml(await r.arrayBuffer(), r.headers.get("content-type"));
      const ex = extrairDoPortal(html);
      if (ex.itens.length) { extr = ex; break; }
      htmlBruto = html.slice(0, 60000);
      erro = `A SEFAZ respondeu (${r.status}) mas não encontrei os itens na página.`;
    } catch (e) {
      erro = `Não consegui falar com a SEFAZ: ${e instanceof Error ? e.message : e}`;
    }
  }

  if (!extr) {
    ok(await db.from("notas").update({
      consulta_status: "erro", consulta_erro: erro, html_bruto: htmlBruto, atualizado_em: new Date().toISOString(),
    }).eq("id", notaId));
    return;
  }

  ok(await db.from("notas").update({
    nome_emitente: extr.nome_emitente ?? nota.nome_emitente,
    cnpj_emitente: extr.cnpj_emitente ?? nota.cnpj_emitente,
    endereco: extr.endereco,
    numero: extr.numero ?? nota.numero,
    serie: extr.serie ?? nota.serie,
    emissao: extr.emissao ?? nota.emissao,
    valor_total: extr.valor_total,
    desconto: extr.desconto,
    valor_pago: extr.valor_pago ?? nota.valor_pago,
    forma_pagamento: extr.forma_pagamento,
    qtd_itens: extr.qtd_itens,
    consulta_status: "ok",
    consulta_erro: null,
    html_bruto: null,
    atualizado_em: new Date().toISOString(),
  }).eq("id", notaId));

  const cats = await categorizarItens(extr.itens, extr.nome_emitente);
  ok(await db.from("nota_itens").delete().eq("nota_id", notaId));
  ok(await db.from("nota_itens").insert(extr.itens.map((i, k) => ({
    nota_id: notaId,
    ordem: i.ordem,
    codigo: i.codigo,
    descricao: i.descricao,
    descricao_norm: normalizar(i.descricao),
    quantidade: i.quantidade,
    unidade: i.unidade,
    valor_unitario: i.valor_unitario,
    valor_total: i.valor_total,
    categoria_id: cats[k].categoria_id,
    categoria_origem: cats[k].categoria_origem,
  }))));
}

async function processarQr(texto: string, email: string | null) {
  const qr = lerQr(texto);
  const info = infoDaChave(qr.chave);
  if (!info) throw new HttpErro(400, "Este QR code não parece ser de uma nota fiscal (não achei a chave de 44 dígitos).");
  if (info.modelo !== "65") {
    // 55 = NF-e (nota "grande"); a consulta pública dela exige captcha.
    throw new HttpErro(400, "Esta é uma NF-e (modelo 55), não uma NFC-e. Por enquanto só notas de consumidor (NFC-e) são lidas.");
  }

  const existente = ok(await db.from("notas").select("id").eq("chave", info.chave).maybeSingle()) as any;
  if (existente) return { ...(await detalheNota(existente.id)), duplicada: true };

  let emissaoAprox: string | null = null;
  if (qr.diaNoQr) emissaoAprox = `${info.anoMes}-${qr.diaNoQr}T12:00:00-03:00`;
  const nova = ok(await db.from("notas").insert({
    chave: info.chave,
    url: qr.urlOriginal,
    uf: info.uf,
    cnpj_emitente: info.cnpj,
    numero: info.numero,
    serie: info.serie,
    valor_pago: qr.valorNoQr,
    emissao: emissaoAprox,
    escaneada_por: email,
  }).select("id").single()) as any;

  await consultarSefaz(nova.id);
  await vincularNota(nova.id);
  return { ...(await detalheNota(nova.id)), duplicada: false };
}

async function detalheNota(notaId: string) {
  const nota = ok(await db.from("notas").select("*, nota_itens(*), nota_transacao(transacao_id, origem)").eq("id", notaId).single()) as any;
  delete nota.html_bruto;
  const cands = nota.vinculo_status === "vinculada" ? [] : await candidatosDetalhados(notaId);
  return { nota, candidatos: cands };
}

async function txsNaJanela(dia: string) {
  const linhas = ok(await db.from("transacoes")
    .select("id, valor, data, descricao, recebedor_doc, recebedor_nome, parcela_numero, parcelas_total, conta_id, contas(tipo, apelido, nome), nota_transacao(nota_id)")
    .eq("sentido", "saida").eq("removida", false)
    .gte("data", addDias(dia, -JANELA.antes)).lte("data", addDias(dia, JANELA.depois + 5))
    .limit(2000)) as any[];
  return linhas;
}

function paraCandidata(t: any, notaId: string): TxCandidata {
  return {
    id: t.id, valor: Number(t.valor), data: t.data, descricao: t.descricao,
    recebedor_doc: t.recebedor_doc, recebedor_nome: t.recebedor_nome,
    parcela_numero: t.parcela_numero, parcelas_total: t.parcelas_total,
    conta_tipo: t.contas?.tipo,
    ja_vinculada: (t.nota_transacao ?? []).some((v: any) => v.nota_id !== notaId),
  };
}

async function candidatosDetalhados(notaId: string) {
  const nota = ok(await db.from("notas").select("id, valor_pago, emissao, cnpj_emitente, nome_emitente").eq("id", notaId).single()) as any;
  if (!nota.emissao) return [];
  const dia = dataBrasilia(nota.emissao);
  const txs = await txsNaJanela(dia);
  const porId = Object.fromEntries(txs.map((t) => [t.id, t]));
  const fortes = nota.valor_pago != null
    ? candidatos({ id: nota.id, valor: Number(nota.valor_pago), emissao: nota.emissao, cnpj: nota.cnpj_emitente, nome: nota.nome_emitente },
        txs.map((t) => paraCandidata(t, notaId)))
    : [];
  const ids = new Set(fortes.map((c) => c.transacao_id));
  // "Parecidos": para casos como um Pix que cobre mais de uma nota
  const valor = Number(nota.valor_pago ?? 0);
  const parecidos = txs
    .filter((t) => !ids.has(t.id) && valor > 0)
    .map((t) => ({ t, dif: Math.abs(Number(t.valor) - valor) }))
    .filter((x) => x.dif <= Math.max(5, valor * 0.5))
    .sort((a, b) => a.dif - b.dif)
    .slice(0, 8);
  const fmt = (t: any, extra: any) => ({
    transacao_id: t.id, data: t.data, descricao: t.descricao, valor: Number(t.valor),
    conta: t.contas?.apelido || t.contas?.nome, ...extra,
  });
  return [
    ...fortes.map((c) => fmt(porId[c.transacao_id], { forte: true, pontos: c.pontos, motivos: c.motivos })),
    ...parecidos.map((x) => fmt(x.t, { forte: false, motivos: [`diferença de R$ ${x.dif.toFixed(2).replace(".", ",")}`] })),
  ];
}

/** Tenta vincular automaticamente; senão marca como "confirmar" (há candidatos) ou "pendente". */
async function vincularNota(notaId: string): Promise<"vinculada" | "confirmar" | "pendente" | "ignorada"> {
  const nota = ok(await db.from("notas")
    .select("id, valor_pago, emissao, cnpj_emitente, nome_emitente, vinculo_status, nota_transacao(transacao_id)")
    .eq("id", notaId).single()) as any;
  if (nota.vinculo_status === "ignorada") return "ignorada";
  if ((nota.nota_transacao ?? []).length) {
    if (nota.vinculo_status !== "vinculada") ok(await db.from("notas").update({ vinculo_status: "vinculada" }).eq("id", notaId));
    return "vinculada";
  }
  if (!nota.emissao || nota.valor_pago == null) return "pendente";

  const txs = await txsNaJanela(dataBrasilia(nota.emissao));
  const cs = candidatos(
    { id: nota.id, valor: Number(nota.valor_pago), emissao: nota.emissao, cnpj: nota.cnpj_emitente, nome: nota.nome_emitente },
    txs.map((t) => paraCandidata(t, notaId)),
  );
  const auto = escolhaAutomatica(cs);
  let status: "vinculada" | "confirmar" | "pendente";
  if (auto) {
    ok(await db.from("nota_transacao").insert({ nota_id: notaId, transacao_id: auto.transacao_id, origem: "auto" }));
    await atualizarCategoriaPelaNota(auto.transacao_id);
    await propagarParcelas();
    status = "vinculada";
  } else {
    status = cs.length ? "confirmar" : "pendente";
  }
  ok(await db.from("notas").update({ vinculo_status: status, atualizado_em: new Date().toISOString() }).eq("id", notaId));
  return status;
}

async function atualizarCategoriaPelaNota(transacaoId: string) {
  const tx = ok(await db.from("transacoes").select("categoria_origem").eq("id", transacaoId).single()) as any;
  if (tx.categoria_origem === "manual") return;
  const links = ok(await db.from("nota_transacao").select("nota_id").eq("transacao_id", transacaoId)) as any[];
  if (!links.length) return;
  const itens = ok(await db.from("nota_itens").select("categoria_id, valor_total").in("nota_id", links.map((l) => l.nota_id))) as any[];
  const dom = categoriaDominante(itens);
  if (dom) ok(await db.from("transacoes").update({ categoria_id: dom, categoria_origem: "nota" }).eq("id", transacaoId));
}

/** Compras parceladas: se a 1ª parcela tem nota, as demais parcelas recebem a mesma nota. */
async function propagarParcelas(): Promise<number> {
  const linhas = await todos((de, ate) => db.from("transacoes")
    .select("id, conta_id, descricao, valor, parcelas_total, nota_transacao(nota_id)")
    .gt("parcelas_total", 1).eq("removida", false).eq("sentido", "saida").range(de, ate)) as any[];
  const grupos = new Map<string, any[]>();
  for (const t of linhas) {
    const k = `${t.conta_id}|${chaveAprendizado(t.descricao)}|${t.parcelas_total}|${Math.round(Number(t.valor) * 10)}`;
    grupos.set(k, [...(grupos.get(k) ?? []), t]);
  }
  const novos: any[] = [];
  for (const g of grupos.values()) {
    const notas = new Set(g.flatMap((t) => (t.nota_transacao ?? []).map((v: any) => v.nota_id)));
    if (notas.size !== 1) continue;
    const notaId = [...notas][0];
    for (const t of g) if (!(t.nota_transacao ?? []).length) novos.push({ nota_id: notaId, transacao_id: t.id, origem: "parcela" });
  }
  if (novos.length) {
    ok(await db.from("nota_transacao").upsert(novos, { onConflict: "nota_id,transacao_id", ignoreDuplicates: true }));
    for (const n of novos) await atualizarCategoriaPelaNota(n.transacao_id);
  }
  return novos.length;
}

async function vincularPendentes(): Promise<number> {
  const desde = new Date(Date.now() - 75 * 86400000).toISOString();
  const notas = ok(await db.from("notas").select("id")
    .in("vinculo_status", ["pendente", "confirmar"]).eq("consulta_status", "ok").gte("emissao", desde)) as any[];
  let n = 0;
  for (const nt of notas) if ((await vincularNota(nt.id)) === "vinculada") n++;
  n += await propagarParcelas();
  return n;
}

// ------------------------------------------------------------------ Open Finance

async function sincronizar(origem: string) {
  const log = ok(await db.from("sync_log").insert({ origem }).select("id").single()) as any;
  const resumo = { novas: 0, atualizadas: 0, removidas: 0, vinculadas: 0, contas: 0, avisos: [] as string[] };
  try {
    const cfg = await lerConfig(["pluggy_client_id", "pluggy_client_secret"]);
    if (!cfg.pluggy_client_id || !cfg.pluggy_client_secret) {
      throw new HttpErro(400, "Configure o Client ID e o Client Secret da Pluggy em Mais → Open Finance.");
    }
    const apiKey = await autenticar(cfg.pluggy_client_id, cfg.pluggy_client_secret);

    // Descobre conexões novas (se a Pluggy liberar a listagem) e junta com as cadastradas
    try {
      const descobertos = await listarItens(apiKey);
      if (descobertos.length) {
        await db.from("pluggy_itens").upsert(descobertos.map((i) => ({ id: i.id, conector: i.connector?.name, status: i.status })), { onConflict: "id", ignoreDuplicates: true });
      }
    } catch { /* listagem é opcional */ }

    const itens = ok(await db.from("pluggy_itens").select("id")) as any[];
    if (!itens.length) throw new HttpErro(400, "Nenhuma conexão cadastrada. Adicione o ID da conexão (Item) em Mais → Open Finance.");

    const rg = await regras();
    const cats = await categorias();

    for (const it of itens) {
      try {
        const item = await obterItem(apiKey, it.id);
        ok(await db.from("pluggy_itens").update({
          conector: item.connector?.name ?? null, status: item.status ?? null,
          ultimo_sync: new Date().toISOString(), ultimo_erro: item.error?.message ?? null,
        }).eq("id", it.id));

        const contas = await listarContas(apiKey, it.id);
        if (contas.length) {
          ok(await db.from("contas").upsert(contas.map((c) => ({
            id: c.id, item_id: it.id, tipo: c.type, subtipo: c.subtype,
            nome: c.marketingName || c.name, numero: c.number,
            saldo: c.type === "CREDIT" ? -(c.balance ?? 0) : c.balance,
            atualizado_em: new Date().toISOString(),
          })), { onConflict: "id" }));
        }
        resumo.contas += contas.length;

        for (const c of contas) {
          const r = await sincronizarConta(apiKey, c, rg, cats.porNome);
          resumo.novas += r.novas; resumo.atualizadas += r.atualizadas; resumo.removidas += r.removidas;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resumo.avisos.push(`Conexão ${it.id.slice(0, 8)}…: ${msg}`);
        await db.from("pluggy_itens").update({ ultimo_erro: msg }).eq("id", it.id);
      }
    }

    resumo.vinculadas = await vincularPendentes();
    ok(await db.from("sync_log").update({
      fim: new Date().toISOString(), ok: resumo.avisos.length === 0,
      mensagem: resumo.avisos.join(" | ") || `${resumo.contas} contas`,
      novas: resumo.novas, atualizadas: resumo.atualizadas, removidas: resumo.removidas, vinculadas: resumo.vinculadas,
    }).eq("id", log.id));
    return resumo;
  } catch (e) {
    await db.from("sync_log").update({ fim: new Date().toISOString(), ok: false, mensagem: e instanceof Error ? e.message : String(e) }).eq("id", log.id);
    throw e;
  }
}

async function sincronizarConta(apiKey: string, conta: any, rg: RegraCompilada[], cat: Record<string, number>) {
  const { count } = await db.from("transacoes").select("id", { count: "exact", head: true }).eq("conta_id", conta.id);
  const diasAtras = (count ?? 0) === 0 ? 365 : 75;
  const desde = new Date(Date.now() - diasAtras * 86400000);
  const desdeDia = desde.toISOString().slice(0, 10);

  const brutas = await listarTransacoes(apiKey, conta.id, desde);
  const linhas: LinhaTransacao[] = brutas.map((t) => normalizarTransacao(t, conta.type));

  const existentes = await todos((de, ate) => db.from("transacoes")
    .select("id, data, valor, descricao, recebedor_nome, provider_id, categoria_id, categoria_origem, observacao, removida, nota_transacao(nota_id)")
    .eq("conta_id", conta.id).gte("data", desdeDia).range(de, ate)) as any[];
  const porId = new Map(existentes.map((e) => [e.id, e]));

  const comCategoria: any[] = [];
  const semMexerCategoria: any[] = [];
  for (const l of linhas) {
    const ex = porId.get(l.id);
    if (ex && ex.categoria_id != null) {
      semMexerCategoria.push(l);
    } else {
      const r = categorizarTransacao({ ...l, conta_tipo: conta.type }, rg, cat);
      comCategoria.push({ ...l, categoria_id: r?.categoria_id ?? null, categoria_origem: r?.origem ?? null });
    }
  }
  for (let i = 0; i < comCategoria.length; i += 500) {
    ok(await db.from("transacoes").upsert(comCategoria.slice(i, i + 500), { onConflict: "id" }));
  }
  for (let i = 0; i < semMexerCategoria.length; i += 500) {
    ok(await db.from("transacoes").upsert(semMexerCategoria.slice(i, i + 500), { onConflict: "id" }));
  }

  // Lançamentos que sumiram (o banco reapresentou com outro id): marca como removidos
  // e transfere vínculo de nota / categoria manual para o substituto.
  const idsAgora = new Set(linhas.map((l) => l.id));
  const sumiram = existentes.filter((e) => !idsAgora.has(e.id) && !e.removida);
  const usados = new Set<string>();
  for (const s of sumiram) {
    ok(await db.from("transacoes").update({ removida: true }).eq("id", s.id));
    const temAlgo = (s.nota_transacao ?? []).length || s.categoria_origem === "manual" || s.observacao;
    if (!temAlgo) continue;
    const subst = linhas.find((l) => !usados.has(l.id) && !porId.has(l.id) && (
      (s.provider_id && l.provider_id === s.provider_id) ||
      (Math.abs(l.valor - Number(s.valor)) <= 0.01 && chaveAprendizado(l.descricao) === chaveAprendizado(s.descricao) &&
        Math.abs(Date.parse(l.data) - Date.parse(s.data)) <= 45 * 86400000)
    ));
    if (!subst) continue;
    usados.add(subst.id);
    for (const v of s.nota_transacao ?? []) {
      await db.from("nota_transacao").upsert({ nota_id: v.nota_id, transacao_id: subst.id, origem: "auto" }, { onConflict: "nota_id,transacao_id", ignoreDuplicates: true });
    }
    await db.from("nota_transacao").delete().eq("transacao_id", s.id);
    const upd: any = {};
    if (s.categoria_origem === "manual" || s.categoria_origem === "nota") { upd.categoria_id = s.categoria_id; upd.categoria_origem = s.categoria_origem; }
    if (s.observacao) upd.observacao = s.observacao;
    if (Object.keys(upd).length) await db.from("transacoes").update(upd).eq("id", subst.id);
  }

  return {
    novas: linhas.filter((l) => !porId.has(l.id)).length,
    atualizadas: linhas.filter((l) => porId.has(l.id)).length,
    removidas: sumiram.length,
  };
}

// ------------------------------------------------------------------ recategorizar

async function recategorizar() {
  cacheCategorias = null;
  const rg = await regras();
  const cats = await categorias();

  const itens = await todos((de, ate) => db.from("nota_itens")
    .select("id, descricao, categoria_id, categoria_origem, notas(nome_emitente)")
    .or("categoria_origem.is.null,categoria_origem.neq.manual").range(de, ate)) as any[];
  let mudouItens = 0;
  for (const i of itens) {
    const r = aplicarRegras(i.descricao, rg, "item");
    if (r && r.categoria_id !== i.categoria_id) {
      ok(await db.from("nota_itens").update({ categoria_id: r.categoria_id, categoria_origem: r.origem }).eq("id", i.id));
      mudouItens++;
    }
  }

  const txs = await todos((de, ate) => db.from("transacoes")
    .select("id, descricao, recebedor_nome, sentido, tipo_operacao, pagador_doc, recebedor_doc, categoria_id, categoria_origem, contas(tipo)")
    .eq("removida", false).range(de, ate)) as any[];
  let mudouTx = 0;
  for (const t of txs) {
    if (t.categoria_origem === "manual" || t.categoria_origem === "nota") continue;
    const r = categorizarTransacao({ ...t, conta_tipo: t.contas?.tipo }, rg, cats.porNome);
    const nova = r?.categoria_id ?? null;
    if (nova !== t.categoria_id) {
      ok(await db.from("transacoes").update({ categoria_id: nova, categoria_origem: r?.origem ?? null }).eq("id", t.id));
      mudouTx++;
    }
  }
  // Gastos com nota seguem a categoria dos itens
  const vinculados = await todos((de, ate) => db.from("nota_transacao").select("transacao_id").range(de, ate)) as any[];
  for (const id of new Set(vinculados.map((v) => v.transacao_id))) await atualizarCategoriaPelaNota(id);
  return { itens_alterados: mudouItens, gastos_alterados: mudouTx };
}

// ------------------------------------------------------------------ servidor

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
  try {
    if (rota === "/saude") return json({ ok: true, hora: new Date().toISOString() });

    const quem = await autorizar(req, rota);
    const corpo: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    switch (rota) {
      case "/nfce":
        return json(await processarQr(String(corpo.texto ?? corpo.url ?? ""), quem.email));

      case "/nfce/reconsultar": {
        await consultarSefaz(corpo.nota_id);
        await vincularNota(corpo.nota_id);
        return json(await detalheNota(corpo.nota_id));
      }

      case "/nota":
        return json(await detalheNota(corpo.nota_id));

      case "/candidatos":
        return json({ candidatos: await candidatosDetalhados(corpo.nota_id) });

      case "/vincular": {
        ok(await db.from("nota_transacao").upsert(
          { nota_id: corpo.nota_id, transacao_id: corpo.transacao_id, origem: "manual" },
          { onConflict: "nota_id,transacao_id" },
        ));
        ok(await db.from("notas").update({ vinculo_status: "vinculada" }).eq("id", corpo.nota_id));
        await atualizarCategoriaPelaNota(corpo.transacao_id);
        await propagarParcelas();
        return json({ ok: true });
      }

      case "/desvincular": {
        ok(await db.from("nota_transacao").delete().eq("nota_id", corpo.nota_id).eq("transacao_id", corpo.transacao_id));
        const resta = ok(await db.from("nota_transacao").select("transacao_id").eq("nota_id", corpo.nota_id)) as any[];
        if (!resta.length) ok(await db.from("notas").update({ vinculo_status: "confirmar" }).eq("id", corpo.nota_id));
        // Volta a categoria do gasto para as regras
        const tx = ok(await db.from("transacoes").select("*, contas(tipo)").eq("id", corpo.transacao_id).single()) as any;
        if (tx.categoria_origem === "nota") {
          const r = categorizarTransacao({ ...tx, conta_tipo: tx.contas?.tipo }, await regras(), (await categorias()).porNome);
          ok(await db.from("transacoes").update({ categoria_id: r?.categoria_id ?? null, categoria_origem: r?.origem ?? null }).eq("id", tx.id));
        }
        await atualizarCategoriaPelaNota(corpo.transacao_id);
        return json({ ok: true });
      }

      case "/ignorar-nota": {
        const status = corpo.ignorar ? "ignorada" : "pendente";
        ok(await db.from("notas").update({ vinculo_status: status }).eq("id", corpo.nota_id));
        if (!corpo.ignorar) await vincularNota(corpo.nota_id);
        return json({ ok: true });
      }

      case "/categorizar-item": {
        const item = ok(await db.from("nota_itens").select("id, descricao, descricao_norm, nota_id").eq("id", corpo.item_id).single()) as any;
        ok(await db.from("nota_itens").update({ categoria_id: corpo.categoria_id, categoria_origem: "manual" }).eq("id", item.id));
        const afetadas = new Set<string>([item.nota_id]);
        if (corpo.aprender !== false) {
          ok(await db.from("regras_categoria").upsert({
            alvo: "item", tipo: "exato", padrao: item.descricao_norm, categoria_id: corpo.categoria_id, prioridade: 1, origem: "aprendida",
          }, { onConflict: "alvo,tipo,padrao" }));
          const iguais = ok(await db.from("nota_itens").update({ categoria_id: corpo.categoria_id, categoria_origem: "aprendida" })
            .eq("descricao_norm", item.descricao_norm).or("categoria_origem.is.null,categoria_origem.neq.manual").select("nota_id")) as any[];
          iguais.forEach((i) => afetadas.add(i.nota_id));
        }
        const links = ok(await db.from("nota_transacao").select("transacao_id").in("nota_id", [...afetadas])) as any[];
        for (const l of links) await atualizarCategoriaPelaNota(l.transacao_id);
        return json({ ok: true, notas_afetadas: afetadas.size });
      }

      case "/categorizar-transacao": {
        const tx = ok(await db.from("transacoes").select("id, descricao, recebedor_nome").eq("id", corpo.transacao_id).single()) as any;
        ok(await db.from("transacoes").update({ categoria_id: corpo.categoria_id, categoria_origem: "manual" }).eq("id", tx.id));
        let outros = 0;
        if (corpo.aprender) {
          const chave = chaveAprendizado(textoTx(tx));
          ok(await db.from("regras_categoria").upsert({
            alvo: "transacao", tipo: "exato", padrao: chave, categoria_id: corpo.categoria_id, prioridade: 1, origem: "aprendida",
          }, { onConflict: "alvo,tipo,padrao" }));
          const candidatos = await todos((de, ate) => db.from("transacoes").select("id, descricao, recebedor_nome")
            .eq("removida", false).or("categoria_origem.is.null,categoria_origem.not.in.(manual,nota)").range(de, ate)) as any[];
          const alvo = candidatos.filter((t) => t.id !== tx.id && chaveAprendizado(textoTx(t)) === chave).map((t) => t.id);
          for (let i = 0; i < alvo.length; i += 200) {
            ok(await db.from("transacoes").update({ categoria_id: corpo.categoria_id, categoria_origem: "aprendida" }).in("id", alvo.slice(i, i + 200)));
          }
          outros = alvo.length;
        }
        return json({ ok: true, outros_atualizados: outros });
      }

      case "/recategorizar":
        return json(await recategorizar());

      case "/sync":
        return json(await sincronizar(quem.cron ? "agendado" : `app (${quem.email})`));

      case "/config": {
        if (req.method === "POST") {
          if ("pluggy_client_id" in corpo) await gravarConfig("pluggy_client_id", String(corpo.pluggy_client_id ?? "").trim());
          if ("pluggy_client_secret" in corpo) await gravarConfig("pluggy_client_secret", String(corpo.pluggy_client_secret ?? "").trim());
          if ("anthropic_key" in corpo) await gravarConfig("anthropic_key", String(corpo.anthropic_key ?? "").trim());
        }
        const c = await lerConfig(["pluggy_client_id", "pluggy_client_secret", "anthropic_key"]);
        let pluggyOk: boolean | null = null, pluggyErro: string | null = null;
        if (req.method === "POST" && c.pluggy_client_id && c.pluggy_client_secret) {
          try { await autenticar(c.pluggy_client_id, c.pluggy_client_secret); pluggyOk = true; }
          catch (e) { pluggyOk = false; pluggyErro = e instanceof Error ? e.message : String(e); }
        }
        return json({
          pluggy_configurado: !!(c.pluggy_client_id && c.pluggy_client_secret),
          pluggy_client_id_fim: c.pluggy_client_id ? c.pluggy_client_id.slice(-4) : null,
          pluggy_teste: pluggyOk, pluggy_erro: pluggyErro,
          anthropic_configurado: !!c.anthropic_key,
        });
      }

      case "/itens": {
        const id = String(corpo.id ?? "").trim();
        if (!id) throw new HttpErro(400, "Informe o ID da conexão");
        if (corpo.acao === "remover") {
          ok(await db.from("pluggy_itens").delete().eq("id", id));
          return json({ ok: true });
        }
        const cfg = await lerConfig(["pluggy_client_id", "pluggy_client_secret"]);
        if (!cfg.pluggy_client_id) throw new HttpErro(400, "Configure primeiro as credenciais da Pluggy");
        const apiKey = await autenticar(cfg.pluggy_client_id, cfg.pluggy_client_secret);
        const item = await obterItem(apiKey, id).catch(() => {
          throw new HttpErro(400, "A Pluggy não encontrou essa conexão. Confira o ID (formato xxxxxxxx-xxxx-…).");
        });
        ok(await db.from("pluggy_itens").upsert({ id, conector: item.connector?.name, status: item.status }, { onConflict: "id" }));
        return json({ ok: true, conector: item.connector?.name, status: item.status });
      }

      case "/descobrir-itens": {
        const cfg = await lerConfig(["pluggy_client_id", "pluggy_client_secret"]);
        const apiKey = await autenticar(cfg.pluggy_client_id, cfg.pluggy_client_secret);
        try {
          const itens = await listarItens(apiKey);
          if (itens.length) {
            ok(await db.from("pluggy_itens").upsert(itens.map((i) => ({ id: i.id, conector: i.connector?.name, status: i.status })), { onConflict: "id" }));
          }
          return json({ encontrados: itens.length });
        } catch {
          return json({ encontrados: 0, aviso: "A Pluggy não liberou a listagem automática; informe o ID manualmente." });
        }
      }

      default:
        throw new HttpErro(404, `Rota desconhecida: ${rota}`);
    }
  } catch (e) {
    const status = e instanceof HttpErro ? e.status : 500;
    const msg = e instanceof Error ? e.message : String(e);
    if (status >= 500) console.error(rota, e);
    return json({ erro: msg }, status);
  }
});
