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
//   POST /categorizar-lote       {transacao_ids, categoria_id, aprender}  → triagem de vários parecidos
//   POST /recategorizar   {}          → reaplica as regras (após mudar regras)
//   POST /sync            {}          → busca contas e lançamentos no Open Finance
//   POST /verificar       {}          → pergunta à Pluggy se há dados novos e só então sincroniza (agendado a cada 30 min e ao abrir o app)
//   POST /notificacoes    {acao: "chave"|"assinar"|"cancelar"|"estado"|"testar", ...} → notificações de lançamentos novos
//   GET  /config  · POST /config {pluggy_client_id, pluggy_client_secret, anthropic_key}
//   POST /itens   {id, acao: "adicionar"|"remover"} · POST /descobrir-itens
//   POST /pagar-divida {divida_id, transacao_id? | data+valor, aprender} · POST /sync-pagamentos

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";
import { chaveAprendizado, dataBrasilia, decodificarEntidades, normalizar } from "./lib/texto.ts";
import { enviarPush, gerarChavesVapid, type AssinaturaPush, type ChavesVapid } from "./lib/webpush.ts";
import { decodificarHtml, extrairDoPortal, infoDaChave, lerQr, urlsDeConsulta } from "./lib/nfce.ts";
import {
  aplicarRegras, categoriaDominante, categorizarTransacao, compilarRegras,
  type CarteiraDespesa, type RegraCompilada,
} from "./lib/categorizar.ts";
import { candidatos, escolhaAutomatica, JANELA, type TxCandidata } from "./lib/vinculo.ts";
import {
  autenticar, listarContas, listarEmprestimos, listarInvestimentos, listarItens, listarTransacoes,
  normalizarTransacao, obterItem, type LinhaTransacao,
} from "./lib/pluggy.ts";
import { normalizarEmprestimo, normalizarInvestimento, reconhecerPagamentos } from "./lib/patrimonio.ts";
import { categorizarComIA } from "./lib/ia.ts";
import { gerarDiagnostico, mesesAnteriores, tipoDeJuros, type DadosSugestoes } from "./lib/sugestoes.ts";
import { montarMetas } from "./lib/metas.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
/** Cliente administrativo (ignora as regras de segurança): só para config, robôs e login. */
const adm = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Cada requisição roda "dentro" de uma casa: o cliente usa o login de quem chamou (ou o robô
// da casa, no agendamento), então as regras de segurança do banco limitam tudo à casa aberta.
type Contexto = { db: SupabaseClient; casa: number };
const contexto = new AsyncLocalStorage<Contexto>();
const db: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_alvo, prop) {
    const c = contexto.getStore();
    if (!c) throw new Error("Consulta fora do contexto de uma casa");
    const v = (c.db as any)[prop];
    return typeof v === "function" ? v.bind(c.db) : v;
  },
});
function casaAtual(): number {
  const c = contexto.getStore();
  if (!c) throw new Error("Sem casa no contexto");
  return c.casa;
}
function clienteComToken(token?: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
}

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

/** Busca todas as linhas de uma consulta paginando de 1000 em 1000.
 *  Sem ORDER BY as páginas podem repetir ou pular linhas: ordena por `chave` (colunas separadas por vírgula) quando a consulta não tem ordem. */
async function todos<T = any>(consulta: (de: number, ate: number) => any, chave = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    let qb = consulta(de, de + 999);
    if (!String(qb.url ?? "").includes("order=")) for (const c of chave.split(",")) qb = qb.order(c.trim(), { ascending: true, nullsFirst: true });
    const lote = ok<T[]>(await qb);
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

/** Config global do app (segredo do agendamento, CDI…). */
async function lerConfigGlobal(chaves: string[]): Promise<Record<string, string>> {
  const linhas = ok(await adm.from("app_config").select("chave, valor").in("chave", chaves)) as any[];
  return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
}
async function gravarConfigGlobal(chave: string, valor: string) {
  ok(await adm.from("app_config").upsert({ chave, valor, atualizado_em: new Date().toISOString() }));
}

/** Chaves privadas de uma casa (Pluggy, Anthropic, senha do robô). */
async function lerConfigDe(casa: number, chaves: string[]): Promise<Record<string, string>> {
  const linhas = ok(await adm.from("casa_config").select("chave, valor").eq("casa_id", casa).in("chave", chaves)) as any[];
  return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
}
async function gravarConfigDe(casa: number, chave: string, valor: string | null) {
  if (valor == null || valor === "") {
    ok(await adm.from("casa_config").delete().eq("casa_id", casa).eq("chave", chave));
  } else {
    ok(await adm.from("casa_config").upsert({ casa_id: casa, chave, valor, atualizado_em: new Date().toISOString() }, { onConflict: "casa_id,chave" }));
  }
}
const lerConfig = (chaves: string[]) => lerConfigDe(casaAtual(), chaves);
const gravarConfig = (chave: string, valor: string | null) => gravarConfigDe(casaAtual(), chave, valor);

type CacheCategorias = { porNome: Record<string, number>; porId: Record<number, any>; nomes: string[] };
const cacheCategorias = new Map<number, CacheCategorias>();
async function categorias(): Promise<CacheCategorias> {
  const casa = casaAtual();
  let c = cacheCategorias.get(casa);
  if (!c) {
    const lista = ok(await db.from("categorias").select("id, nome, conta_como_gasto, ativa, natureza")) as any[];
    c = {
      porNome: Object.fromEntries(lista.map((c) => [c.nome, c.id])),
      porId: Object.fromEntries(lista.map((c) => [c.id, c])),
      nomes: lista.filter((c) => c.ativa && c.conta_como_gasto).map((c) => c.nome),
    };
    cacheCategorias.set(casa, c);
  }
  return c;
}

async function regras(): Promise<RegraCompilada[]> {
  const lista = await todos((de, ate) =>
    db.from("regras_categoria").select("id, alvo, tipo, padrao, categoria_id, prioridade, sentido").range(de, ate)
  );
  return compilarRegras(lista as any);
}

/** Contas próprias em outros bancos usadas para pagar despesas (preferência carteiras_despesa, JSON). */
async function carteiras(): Promise<CarteiraDespesa[]> {
  const c = await lerPreferencia("carteiras_despesa");
  try { return c ? JSON.parse(c) : []; } catch { return []; }
}
async function lerPreferencia(chave: string): Promise<string | null> {
  const r = await db.from("preferencias").select("valor").eq("chave", chave).maybeSingle();
  return (r.data as any)?.valor ?? null;
}

function textoTx(t: { descricao: string; recebedor_nome?: string | null }) {
  return [t.descricao, t.recebedor_nome].filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ auth

type Quem = { email: string | null; cron: boolean; db?: SupabaseClient; casa?: number };

async function autorizar(req: Request, rota: string): Promise<Quem> {
  const segredo = req.headers.get("x-cron-secret");
  if (segredo) {
    const c = await lerConfigGlobal(["cron_secret"]);
    if (c.cron_secret && segredo === c.cron_secret && ["/sync", "/verificar", "/recategorizar", "/sugestoes", "/metas"].includes(rota)) return { email: null, cron: true };
    throw new HttpErro(401, "Segredo inválido");
  }
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpErro(401, "Faça login no app");
  const { data, error } = await adm.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new HttpErro(401, "Sessão expirada, faça login de novo");
  const cli = clienteComToken(token);
  let casa = ok(await cli.rpc("casa_atual")) as number | null;
  if (!casa) casa = (ok(await cli.rpc("entrar")) as any).casa_id as number;
  return { email, cron: false, db: cli, casa };
}

// ------------------------------------------------------------------ robô de cada casa (agendamento)

const emailRobo = (casa: number) => `robo-casa-${casa}@financas-casa.app`;

/** Login do "robô" da casa: um usuário técnico, membro só dela, usado pela sincronização agendada. */
async function clienteRobo(casa: number): Promise<SupabaseClient> {
  const email = emailRobo(casa);
  let senha = (await lerConfigDe(casa, ["robo_senha"])).robo_senha;
  if (senha) {
    const c = clienteComToken();
    if (!(await c.auth.signInWithPassword({ email, password: senha })).error) return c;
  }
  senha = crypto.randomUUID() + crypto.randomUUID();
  const criado = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (criado.error) {
    // Já existe (ex.: senha perdida): procura e define uma senha nova
    let id: string | null = null;
    for (let page = 1; page <= 50 && !id; page++) {
      const { data } = await adm.auth.admin.listUsers({ page, perPage: 200 });
      id = data?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (!data?.users || data.users.length < 200) break;
    }
    if (!id) throw new HttpErro(500, `Não foi possível criar o robô da casa ${casa}: ${criado.error.message}`);
    ok(await adm.auth.admin.updateUserById(id, { password: senha }) as any);
  }
  await gravarConfigDe(casa, "robo_senha", senha);
  ok(await adm.from("membros").upsert({ casa_id: casa, email, aceito_em: new Date().toISOString() }, { onConflict: "casa_id,email", ignoreDuplicates: true }));
  ok(await adm.from("usuarios").upsert({ email, casa_id: casa, atualizado_em: new Date().toISOString() }, { onConflict: "email" }));
  const c = clienteComToken();
  const r = await c.auth.signInWithPassword({ email, password: senha });
  if (r.error) throw new HttpErro(500, `Login do robô da casa ${casa} falhou: ${r.error.message}`);
  return c;
}

const dormir = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// Sessão do robô reaproveitada enquanto vale (pedidos simultâneos usam o mesmo login)
const robos = new Map<number, Promise<{ cli: SupabaseClient; ate: number }>>();
async function obterRobo(casa: number): Promise<SupabaseClient> {
  const atual = robos.get(casa);
  if (atual) {
    try { const r = await atual; if (r.ate > Date.now() + 120000) return r.cli; } catch { /* refaz abaixo */ }
  }
  const novo = (async () => {
    const cli = await clienteRobo(casa);
    const sessao = (await cli.auth.getSession()).data.session;
    // Login recém-feito: o relógio do banco pode estar alguns instantes atrás do servidor de login
    await dormir(1500);
    return { cli, ate: (sessao?.expires_at ?? 0) * 1000 };
  })();
  robos.set(casa, novo);
  try { return (await novo).cli; } catch (e) { robos.delete(casa); throw e; }
}

async function naCasaDoRobo<T>(casa: number, fn: () => Promise<T>): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    const cli = await obterRobo(casa);
    try { return await contexto.run({ db: cli, casa }, fn); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (tentativa >= 3 || !/issued at future|JWT expired/i.test(msg)) throw e;
      if (/JWT expired/i.test(msg)) robos.delete(casa);
      await dormir(2000 * tentativa);
    }
  }
}

/** Casas com Open Finance configurado (para a sincronização agendada). */
async function casasComPluggy(): Promise<number[]> {
  const linhas = ok(await adm.from("casa_config").select("casa_id").eq("chave", "pluggy_client_secret")) as any[];
  return [...new Set(linhas.map((l) => Number(l.casa_id)))].sort((a, b) => a - b);
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
          await db.from("regras_categoria").upsert(novasRegras.map((r) => ({ ...r, casa_id: casaAtual() })), { onConflict: "casa_id,alvo,tipo,padrao", ignoreDuplicates: true });
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

// ------------------------------------------------------------------ Notificações (Web Push)
type NovaTx = { id: string; data: string; descricao: string; valor: number; sentido: string; categoria_id: number | null; conta: string };
type PrefsPush = { despesas: boolean; receitas: boolean; valores: boolean; email: string | null };
const CONTATO_PUSH = "https://henriqkol.github.io/financas-casa/";

/** Chaves VAPID do app (geradas na primeira vez e guardadas na configuração global). */
async function chavesVapid(): Promise<ChavesVapid> {
  const c = await lerConfigGlobal(["vapid_publica", "vapid_privada"]);
  if (c.vapid_publica && c.vapid_privada) return { publica: c.vapid_publica, privadaJwk: JSON.parse(c.vapid_privada) };
  const novas = await gerarChavesVapid();
  await gravarConfigGlobal("vapid_privada", JSON.stringify(novas.privadaJwk));
  await gravarConfigGlobal("vapid_publica", novas.publica);
  return novas;
}
async function chaveAssinatura(endpoint: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return "push:" + [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Aparelhos que pediram aviso nesta casa (guardados em casa_config, só o servidor lê). */
async function assinaturasDaCasa(casa: number): Promise<{ chave: string; sub: AssinaturaPush; prefs: PrefsPush }[]> {
  const linhas = ok(await adm.from("casa_config").select("chave, valor").eq("casa_id", casa).like("chave", "push:%")) as any[];
  return linhas.map((l) => { try { const v = JSON.parse(l.valor); return { chave: l.chave, sub: v.sub, prefs: v.prefs }; } catch { return null; } })
    .filter((x): x is { chave: string; sub: AssinaturaPush; prefs: PrefsPush } => !!x?.sub?.endpoint);
}
const brl = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "Compra no débito|COMERCIAL ZAFFARI LTDA" → "Comercial Zaffari" (ou o apelido que a casa deu). */
function nomeParaAviso(descricao: string, apelidos: Record<string, string>): string {
  const i = descricao.indexOf("|");
  let n = decodificarEntidades(i > 0 ? descricao.slice(i + 1) : descricao).trim();
  const ap = apelidos[chaveAprendizado(n)];
  if (ap) return ap;
  n = n.replace(/\s*(PARC(ELA)?\.?\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*$/i, "").replace(/[\s.,*-]+(LTDA|S\.?\s?\/?A|ME|EPP|EIRELI)\.?$/i, "").trim() || n;
  if (!/[a-zà-ÿ]/.test(n)) n = n.toLowerCase().replace(/(^|\s)(\S)/g, (_m, e, c) => e + c.toUpperCase());
  return n.slice(0, 60);
}

/** Um aviso por lançamento novo (despesa ou receita) para cada aparelho inscrito na casa. */
async function notificarNovas(novas: NovaTx[]): Promise<number> {
  if (!novas.length) return 0;
  const casa = casaAtual();
  const assinaturas = await assinaturasDaCasa(casa);
  if (!assinaturas.length) return 0;
  const cats = await categorias();
  const apelidosTxt = await lerPreferencia("apelidos");
  let apelidos: Record<string, string> = {};
  try { apelidos = apelidosTxt ? JSON.parse(apelidosTxt) : {}; } catch { /* sem apelidos */ }
  // Só consumo e renda: transferências entre contas, faturas e investimentos não viram aviso
  const tipoDe = (t: NovaTx) => {
    const nat = t.categoria_id != null ? cats.porId[t.categoria_id]?.natureza : null;
    if (nat === "neutro") return null;
    if (t.sentido === "entrada") return nat === "despesa" ? null : "receita";
    return nat === "receita" ? null : "despesa";
  };
  const lista = novas.map((t) => ({ t, tipo: tipoDe(t) })).filter((x) => x.tipo).sort((a, b) => b.t.data.localeCompare(a.t.data));
  if (!lista.length) return 0;
  const chaves = await chavesVapid();
  const MAX = 8;
  let enviados = 0;
  for (const a of assinaturas) {
    const minhas = lista.filter((x) => (x.tipo === "despesa" ? a.prefs?.despesas !== false : a.prefs?.receitas !== false));
    if (!minhas.length) continue;
    const mensagens = minhas.slice(0, MAX).map(({ t, tipo }) => {
      const nome = nomeParaAviso(t.descricao, apelidos);
      const cat = t.categoria_id != null ? cats.porId[t.categoria_id]?.nome : "sem categoria";
      const valor = `${tipo === "receita" ? "+" : "−"}${brl(t.valor)}`;
      return {
        titulo: a.prefs?.valores === false ? `${tipo === "receita" ? "Nova receita" : "Nova despesa"} · ${nome}` : `${valor} · ${nome}`,
        corpo: [t.conta, cat].filter(Boolean).join(" · "),
        tag: `tx-${t.id}`, url: "./#gastos",
      };
    });
    if (minhas.length > MAX) mensagens.push({ titulo: `Mais ${minhas.length - MAX} lançamentos novos`, corpo: "Abra o extrato para ver todos", tag: `resumo-${Date.now()}`, url: "./#gastos" });
    for (const m of mensagens) {
      try {
        const st = await enviarPush(a.sub, m, chaves, CONTATO_PUSH);
        if (st === 404 || st === 410) { await adm.from("casa_config").delete().eq("casa_id", casa).eq("chave", a.chave); break; }
        if (st >= 200 && st < 300) enviados++;
      } catch (e) { console.warn("push:", e); }
    }
  }
  return enviados;
}

// ------------------------------------------------------------------ Verificação rápida (há dados novos na Pluggy?)
/** Pergunta à Pluggy quando cada conexão foi atualizada; sincroniza só se mudou desde a última vez. */
async function verificarAtualizacoes(origem: string) {
  const cfg = await lerConfig(["pluggy_client_id", "pluggy_client_secret"]);
  if (!cfg.pluggy_client_id || !cfg.pluggy_client_secret) return { configurado: false, sincronizou: false };
  // Já tem uma sincronização rodando (começou há menos de 5 min e não terminou): não começa outra
  const emCurso = ok(await db.from("sync_log").select("id").is("fim", null).gte("inicio", new Date(Date.now() - 5 * 60000).toISOString()).limit(1)) as any[];
  if (emCurso.length) return { configurado: true, sincronizou: false, motivo: "sincronização em andamento" };
  const itens = ok(await db.from("pluggy_itens").select("id")) as any[];
  if (!itens.length) return { configurado: true, sincronizou: false };
  const apiKey = await autenticar(cfg.pluggy_client_id, cfg.pluggy_client_secret);
  const vistos = await lerConfig(itens.map((i) => `pluggy_visto:${i.id}`));
  const mudaram: string[] = [];
  for (const it of itens) {
    try {
      const item = await obterItem(apiKey, it.id);
      const marcador = item.lastUpdatedAt ?? item.updatedAt ?? null;
      if (marcador && String(marcador) !== vistos[`pluggy_visto:${it.id}`]) mudaram.push(it.id);
    } catch (e) { console.warn("verificar item", it.id, e); }
  }
  if (!mudaram.length) return { configurado: true, sincronizou: false };
  const r = await sincronizar(origem);
  return { configurado: true, sincronizou: true, ...r };
}

// ------------------------------------------------------------------ Open Finance

async function sincronizar(origem: string) {
  const log = ok(await db.from("sync_log").insert({ origem }).select("id").single()) as any;
  const resumo = { novas: 0, atualizadas: 0, removidas: 0, vinculadas: 0, contas: 0, investimentos: 0, emprestimos: 0, pagamentos: 0, notificadas: 0, avisos: [] as string[] };
  const novasParaAvisar: NovaTx[] = [];
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
    const cart = await carteiras();

    for (const it of itens) {
      try {
        const item = await obterItem(apiKey, it.id);
        const marcador = item.lastUpdatedAt ?? item.updatedAt ?? null;
        if (marcador) await gravarConfig(`pluggy_visto:${it.id}`, String(marcador));
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
          const r = await sincronizarConta(apiKey, c, rg, cats.porNome, cart);
          resumo.novas += r.novas; resumo.atualizadas += r.atualizadas; resumo.removidas += r.removidas;
          novasParaAvisar.push(...r.novasRecentes);
        }

        try {
          resumo.investimentos += await sincronizarInvestimentos(apiKey, it.id);
        } catch (e) {
          resumo.avisos.push(`Investimentos: ${e instanceof Error ? e.message : e}`);
        }
        try {
          resumo.emprestimos += await sincronizarEmprestimos(apiKey, it.id);
        } catch (e) {
          resumo.avisos.push(`Empréstimos: ${e instanceof Error ? e.message : e}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resumo.avisos.push(`Conexão ${it.id.slice(0, 8)}…: ${msg}`);
        await db.from("pluggy_itens").update({ ultimo_erro: msg }).eq("id", it.id);
      }
    }

    resumo.vinculadas = await vincularPendentes();
    resumo.pagamentos = await reconhecerPagamentosDeDividas();
    ok(await db.from("sync_log").update({
      fim: new Date().toISOString(), ok: resumo.avisos.length === 0,
      mensagem: resumo.avisos.join(" | ") || `${resumo.contas} contas, ${resumo.investimentos} investimentos`,
      novas: resumo.novas, atualizadas: resumo.atualizadas, removidas: resumo.removidas, vinculadas: resumo.vinculadas,
    }).eq("id", log.id));
    try { resumo.notificadas = await notificarNovas(novasParaAvisar); }
    catch (e) { console.warn("notificações:", e); }
    return resumo;
  } catch (e) {
    await db.from("sync_log").update({ fim: new Date().toISOString(), ok: false, mensagem: e instanceof Error ? e.message : String(e) }).eq("id", log.id);
    throw e;
  }
}

function hojeBrasilia(): string {
  return dataBrasilia(new Date());
}

/** Atualiza as aplicações e grava a fotografia do dia (a última sincronização do dia vale). */
async function sincronizarInvestimentos(apiKey: string, itemId: string): Promise<number> {
  const brutos = await listarInvestimentos(apiKey, itemId);
  if (!brutos.length) return 0;
  const linhas = brutos.map((b) => normalizarInvestimento(b, itemId));
  // caixinha_id e apelido não vêm da Pluggy: o upsert só mexe nas colunas enviadas.
  for (let i = 0; i < linhas.length; i += 500) {
    ok(await db.from("investimentos").upsert(linhas.slice(i, i + 500), { onConflict: "id" }));
  }
  const dia = hojeBrasilia();
  const fotos = linhas.map((l) => ({
    investimento_id: l.id, dia, saldo_bruto: l.saldo_bruto, saldo_liquido: l.saldo_liquido,
    valor_aplicado: l.valor_aplicado, registrado_em: new Date().toISOString(),
  }));
  for (let i = 0; i < fotos.length; i += 500) {
    ok(await db.from("investimento_saldos").upsert(fotos.slice(i, i + 500), { onConflict: "investimento_id,dia" }));
  }
  return linhas.length;
}

async function sincronizarEmprestimos(apiKey: string, itemId: string): Promise<number> {
  const brutos = await listarEmprestimos(apiKey, itemId);
  if (!brutos.length) return 0;
  const linhas = brutos.map(normalizarEmprestimo);
  const salvas = ok(await db.from("dividas").upsert(linhas, { onConflict: "pluggy_id" }).select("id, saldo_devedor")) as any[];
  const dia = hojeBrasilia();
  if (salvas.length) {
    ok(await db.from("divida_saldos").upsert(
      salvas.map((d) => ({ divida_id: d.id, dia, saldo_devedor: d.saldo_devedor })),
      { onConflict: "divida_id,dia" },
    ));
  }
  return linhas.length;
}

/** Liga ao cadastro de dívidas os lançamentos que batem com o "texto do extrato" de cada dívida. */
async function reconhecerPagamentosDeDividas(): Promise<number> {
  const dividas = ok(await db.from("dividas").select("id, padrao_pagamento, parcela_valor, data_inicio, criado_em").eq("origem", "manual").eq("ativa", true).not("padrao_pagamento", "is", null)) as any[];
  if (!dividas.length) return 0;
  const desde = addDias(hojeBrasilia(), -75);
  const txs = await todos((de, ate) => db.from("transacoes")
    .select("id, data, valor, descricao, recebedor_nome")
    .eq("sentido", "saida").eq("removida", false).gte("data", desde).range(de, ate)) as any[];
  const usados = new Set((ok(await db.from("divida_pagamentos").select("transacao_id").not("transacao_id", "is", null)) as any[]).map((p) => p.transacao_id));
  const achados = reconhecerPagamentos(dividas, txs.map((t) => ({ ...t, valor: Number(t.valor) })), usados)
    .filter((p) => {
      const d = dividas.find((x) => x.id === p.divida_id);
      // Só pagamentos depois do cadastro (os anteriores já estão em "parcelas pagas antes")
      const desdeCadastro = d?.data_inicio ?? (d?.criado_em ? dataBrasilia(d.criado_em) : null);
      return !desdeCadastro || p.data >= desdeCadastro;
    });
  if (!achados.length) return 0;
  ok(await db.from("divida_pagamentos").insert(achados));
  const cat = (await categorias()).porNome["Pagamento de dívida"];
  if (cat) {
    ok(await db.from("transacoes").update({ categoria_id: cat, categoria_origem: "regra" })
      .in("id", achados.map((a) => a.transacao_id)).or("categoria_origem.is.null,categoria_origem.not.in.(manual,nota)"));
  }
  return achados.length;
}

// ------------------------------------------------------------------ sugestões

/** CDI anualizado do Banco Central (série SGS 4389), guardado por um dia. */
async function cdiAnual(): Promise<number> {
  const c = await lerConfigGlobal(["cdi_anual", "cdi_data"]);
  const hoje = hojeBrasilia();
  if (c.cdi_anual && c.cdi_data === hoje) return Number(c.cdi_anual);
  try {
    const r = await fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const v = Number(String(j?.[0]?.valor ?? "").replace(",", "."));
    if (Number.isFinite(v) && v > 0) {
      await gravarConfigGlobal("cdi_anual", String(v));
      await gravarConfigGlobal("cdi_data", hoje);
      return v;
    }
  } catch { /* usa o último valor conhecido */ }
  return Number(c.cdi_anual ?? 14.9);
}

async function montarSugestoes() {
  const hoje = hojeBrasilia();
  const ref = mesesAnteriores(hoje, 3);
  const desdeMes = ref[0];
  const desdeDia = `${desdeMes}-01`;
  const catLista = ok(await db.from("categorias").select("id, nome, classe, natureza")) as any[];
  const desde12 = mesesAnteriores(hoje, 12)[0];   // imprevistos e viagens usam 12 meses
  const catPorId = Object.fromEntries(catLista.map((c) => [c.id, c]));
  const catPorNome = Object.fromEntries(catLista.map((c) => [c.nome, c]));

  const [orcGrupos, orcItens] = await Promise.all([
    db.from("orcamento_grupos").select("id, nome, categorias").then((r) => r.data ?? []),
    db.from("orcamento_itens").select("grupo_id, nome, valor, periodicidade_meses, ativo").then((r) => r.data ?? []),
  ]);
  const [gastosLin, receitasLin, fluxo, txs, contas, dividas, vdiv, invs, prefs, pend, notasUf] = await Promise.all([
    todos((de, ate) => db.from("v_gastos").select("transacao_id, mes, categoria, categoria_id, valor, via_nota").eq("conta_como_gasto", true).gte("mes", desde12).range(de, ate), "transacao_id,categoria_id"),
    todos((de, ate) => db.from("v_receitas").select("mes, categoria, valor").gte("mes", desdeMes).range(de, ate), "transacao_id"),
    ok(await db.from("v_fluxo_mensal").select("mes, pagamento_dividas").gte("mes", desdeMes)),
    todos((de, ate) => db.from("transacoes").select("id, data, descricao, recebedor_nome, valor, tipo_operacao, categoria_id").eq("sentido", "saida").eq("removida", false).gte("data", desdeDia).range(de, ate)),
    ok(await db.from("contas").select("nome, apelido, tipo, saldo, negativo_em_acordo").eq("ativa", true)),
    ok(await db.from("dividas").select("nome, tipo, saldo_devedor, taxa_juros_mensal, cet_anual, parcela_valor, origem").eq("ativa", true)),
    ok(await db.from("v_dividas").select("fonte, saldo_devedor")),
    ok(await db.from("investimentos").select("saldo_liquido, status")),
    ok(await db.from("preferencias").select("chave, valor")),
    ok(await db.from("v_pendencias").select("tipo")),
    ok(await db.from("notas").select("uf").not("uf", "is", null).limit(200)),
  ]) as any[];

  // Gastos agregados por mês × categoria
  const agg = new Map<string, { mes: string; categoria: string; classe: string | null; valor: number; ids: Set<string> }>();
  for (const g of gastosLin) {
    const k = `${g.mes}|${g.categoria}`;
    const a = agg.get(k) ?? { mes: g.mes, categoria: g.categoria, classe: g.categoria_id == null ? "sem_categoria" : (catPorId[g.categoria_id]?.classe ?? "estilo_vida"), valor: 0, ids: new Set<string>() };
    a.valor += Number(g.valor); a.ids.add(g.transacao_id);
    agg.set(k, a);
  }
  const repasseCat = "Pix para esposa (sem nota)";
  // Pix para a esposa: o que ainda está sem nota + Pix que já têm nota ligada (compras da casa)
  const opPorTx = new Map((txs as any[]).map((t) => [t.id, t.tipo_operacao]));
  const repasseSemNota = gastosLin.filter((g: any) => g.categoria === repasseCat && ref.includes(g.mes)).reduce((s: number, g: any) => s + Number(g.valor), 0);
  const repasseNota = gastosLin.filter((g: any) => ref.includes(g.mes) && g.via_nota && opPorTx.get(g.transacao_id) === "PIX").reduce((s: number, g: any) => s + Number(g.valor), 0);
  const repasseTotal = repasseSemNota + repasseNota;

  // Juros e tarifas por tipo
  const idJuros = catPorNome["Tarifas e juros"]?.id;
  const juros = txs.filter((t: any) => t.categoria_id === idJuros)
    .map((t: any) => ({ mes: t.data.slice(0, 7), tipo: tipoDeJuros(textoTx(t), t.tipo_operacao), valor: Number(t.valor) }));

  // Recorrentes: mesma descrição em meses diferentes, valor parecido (últimos 3 meses completos)
  const grupos = new Map<string, { descricao: string; categoria_id: number | null; meses: Map<string, number> }>();
  for (const t of txs) {
    const mes = t.data.slice(0, 7);
    if (!ref.includes(mes)) continue;
    const cat = catPorId[t.categoria_id];
    if (cat && cat.natureza !== "despesa") continue;
    if (cat?.nome === repasseCat || cat?.nome === "Repasse família" || cat?.nome === "Tarifas e juros") continue;
    const k = chaveAprendizado(textoTx(t));
    if (!k) continue;
    const g = grupos.get(k) ?? { descricao: t.recebedor_nome || t.descricao, categoria_id: t.categoria_id, meses: new Map() };
    g.meses.set(mes, (g.meses.get(mes) ?? 0) + Number(t.valor));
    grupos.set(k, g);
  }
  const recorrentes = [...grupos.values()].map((g) => {
    const vals = [...g.meses.values()];
    const media = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variacao = Math.max(...vals) / Math.max(Math.min(...vals), 0.01);
    const cat = catPorId[g.categoria_id as number]?.nome ?? null;
    return { descricao: g.descricao.replace(/^.*\|/, "").slice(0, 40), categoria: cat, valor_medio: media, meses: vals.length, variacao };
  }).filter((r) => r.valor_medio >= 10 && ((r.meses >= 3 && r.variacao <= 1.25) || (r.categoria === "Assinaturas" && r.meses >= 2)))
    .map(({ variacao: _v, ...r }) => r);

  const p = Object.fromEntries((prefs as any[]).map((x) => [x.chave, x.valor]));
  const dados: DadosSugestoes = {
    hoje,
    gastos: [...agg.values()].map((a) => ({ mes: a.mes, categoria: a.categoria, classe: a.classe, valor: a.valor, n: a.ids.size })),
    receitas: (receitasLin as any[]).map((r) => ({ mes: r.mes, categoria: r.categoria, valor: Number(r.valor) })),
    pagamentosDivida: (fluxo as any[]).map((f) => ({ mes: f.mes, valor: Number(f.pagamento_dividas) })),
    juros, recorrentes,
    contas: (contas as any[]).map((c) => ({ nome: c.apelido || c.nome, tipo: c.tipo, saldo: Number(c.saldo ?? 0), em_acordo: !!c.negativo_em_acordo })),
    dividas: (dividas as any[]).map((d) => ({
      nome: d.nome, tipo: d.tipo, saldo: Number(d.saldo_devedor ?? 0), parcela: d.parcela_valor != null ? Number(d.parcela_valor) : null, origem: d.origem,
      taxa_mensal: d.taxa_juros_mensal != null ? Number(d.taxa_juros_mensal)
        : d.cet_anual != null ? Math.round((Math.pow(1 + Number(d.cet_anual) / 100, 1 / 12) - 1) * 10000) / 100 : null,
    })),
    cartao: {
      fatura: (vdiv as any[]).filter((v) => v.fonte === "fatura").reduce((s, v) => s + Number(v.saldo_devedor), 0),
      parcelas_futuras: (vdiv as any[]).filter((v) => v.fonte === "parcelas").reduce((s, v) => s + Number(v.saldo_devedor), 0),
    },
    investido: (invs as any[]).filter((i) => i.status !== "TOTAL_WITHDRAWAL").reduce((s, i) => s + Number(i.saldo_liquido ?? 0), 0),
    repasse: { total: repasseTotal, com_nota: repasseNota },
    prefs: {
      renda_mensal: p.renda_mensal ? Number(p.renda_mensal) : null,
      meta_poupanca_pct: Number(p.meta_poupanca_pct ?? 20),
      reserva_meses: Number(p.reserva_meses ?? 6),
    },
    metas: [
      // Grupos do orçamento (meta mensal = soma dos itens)
      ...(orcGrupos as any[]).map((g) => {
        const its = (orcItens as any[]).filter((i) => i.grupo_id === g.id && i.ativo);
        return { categoria: g.nome, classe: null, periodicidade_meses: 1,
          meta_mensal: its.reduce((s, i) => s + Number(i.valor) / Number(i.periodicidade_meses || 1), 0),
          categorias: (g.categorias ?? []).map((id: number) => catPorId[id]?.nome).filter(Boolean) };
      }).filter((m) => m.meta_mensal > 0),
      // Itens que não vencem todo mês viram provisão
      ...(orcItens as any[]).filter((i) => i.ativo && Number(i.periodicidade_meses) > 1).map((i) => ({
        categoria: i.nome, classe: null, periodicidade_meses: Number(i.periodicidade_meses), meta_mensal: Number(i.valor) / Number(i.periodicidade_meses), categorias: [],
      })),
    ],
    cdi_anual: await cdiAnual(),
    pendencias: {
      notas: (pend as any[]).filter((x) => x.tipo === "nota_sem_gasto").length,
      sem_categoria: (pend as any[]).filter((x) => x.tipo === "gasto_sem_categoria").length,
    },
    ufs_notas: [...new Set((notasUf as any[]).map((n) => n.uf))],
  };
  return gerarDiagnostico(dados);
}

// ------------------------------------------------------------------ metas

/** Metas de um mês. Mês passado: calcula como estava no último dia dele (contas, orçamento, resultado). */
async function dadosEMetas(mesPedido?: string) {
  await reconhecerPagamentosDeDividas().catch((e) => console.warn("pagamentos:", e));
  const cart = await carteiras();
  const hojeReal = hojeBrasilia();
  const mesReal = hojeReal.slice(0, 7);
  const mes = typeof mesPedido === "string" && /^\d{4}-\d{2}$/.test(mesPedido) && mesPedido < mesReal ? mesPedido : mesReal;
  const historico = mes !== mesReal;
  // mês passado: "hoje" é o último dia dele
  const hoje = historico ? addDias(addDias(`${mes}-01`, 40).slice(0, 7) + "-01", -1) : hojeReal;
  const [prefs, receitas, grupos, itens, gastos, pixCat, saidas, acordos, fluxo, contas, invs, objetivos] = await Promise.all([
    ok(await db.from("preferencias").select("chave, valor")),
    todos((de, ate) => db.from("v_receitas").select("valor").eq("mes", mes).lte("data", hoje).range(de, ate), "transacao_id"),
    ok(await db.from("orcamento_grupos").select("id, nome, ordem, categorias, observacao")),
    ok(await db.from("orcamento_itens").select("*").eq("ativo", true).order("ordem")),
    todos((de, ate) => db.from("v_gastos").select("categoria_id, categoria, valor").eq("mes", mes).eq("conta_como_gasto", true).lte("data", hoje).range(de, ate), "transacao_id,categoria_id"),
    ok(await db.from("categorias").select("id").eq("nome", "Pix para esposa (sem nota)").maybeSingle()),
    todos((de, ate) => db.from("transacoes").select("id, data, valor, descricao, recebedor_nome, recebedor_ispb, observacao, categorias(nome)").eq("sentido", "saida").eq("removida", false)
      .gte("data", `${mes}-01`).lte("data", hoje).range(de, ate)),
    ok(await db.from("dividas").select("id, nome, credor, parcela_valor, parcelas_total, parcelas_pagas, saldo_devedor, vencimentos, observacao").eq("tipo", "acordo").eq("ativa", true).order("id")),
    ok(await db.from("v_fluxo_mensal").select("mes, sobra").gte("mes", "2026-10")),
    ok(await db.from("contas").select("tipo, saldo, negativo_em_acordo").eq("ativa", true)),
    ok(await db.from("investimentos").select("saldo_liquido, status")),
    ok(await db.from("objetivos").select("*")),
  ]) as any[];
  const p = Object.fromEntries((prefs as any[]).map((x) => [x.chave, x.valor]));
  const idsAcordos = (acordos as any[]).map((a) => a.id);
  const pagamentos = idsAcordos.length ? ok(await db.from("divida_pagamentos").select("divida_id, data, valor").in("divida_id", idsAcordos)) as any[] : [];
  const colchaoContas = (contas as any[]).filter((c) => c.tipo === "BANK" && Number(c.saldo) > 0).reduce((s, c) => s + Number(c.saldo), 0);
  const colchaoInvest = (invs as any[]).filter((i) => i.status !== "TOTAL_WITHDRAWAL").reduce((s, i) => s + Number(i.saldo_liquido ?? 0), 0);
  const colchao = colchaoContas + colchaoInvest;
  const r = montarMetas({
    hoje, renda_plano: Number(p.renda_mensal ?? 0),
    receitas_mes: (receitas as any[]).reduce((s, x) => s + Number(x.valor), 0),
    grupos: (grupos as any[]).map((g) => ({ ...g, itens: (itens as any[]).filter((i) => i.grupo_id === g.id).map((i) => ({ ...i, valor: Number(i.valor) })) })),
    gastos_mes: (gastos as any[]).map((g) => ({ categoria_id: g.categoria_id, categoria: g.categoria, valor: Number(g.valor) })),
    pix_esposa_categoria_id: (pixCat as any)?.id ?? null,
    // a observação escrita no app também vale (ex.: Pix sem nome do recebedor → "Telefonica")
    // + nome da carteira de destino (ex.: Pix para a própria conta PicPay vira "... PICPAY")
    saidas_mes: (saidas as any[]).map((t) => ({ id: t.id, data: t.data, valor: Number(t.valor),
      // e o nome da categoria (o texto do item pode ser "ASSINATURAS")
      // (a carteira só entra quando o Pix foi para a própria conta, ou seja, já está na categoria dela)
      texto: [textoTx(t), t.observacao, cart.find((c) => c.ispb === t.recebedor_ispb && c.categoria === t.categorias?.nome)?.nome, t.categorias?.nome].filter(Boolean).join(" ") })),
    acordos: (acordos as any[]).map((a) => ({ ...a, parcela_valor: Number(a.parcela_valor), saldo_devedor: a.saldo_devedor != null ? Number(a.saldo_devedor) : null, vencimentos: a.vencimentos ?? [] })),
    pagamentos: pagamentos.map((x) => ({ ...x, valor: Number(x.valor) })),
    fluxo: (fluxo as any[]).map((f) => ({ mes: f.mes, sobra: Number(f.sobra) })),
    colchao, colchao_partes: { contas: colchaoContas, investido: colchaoInvest },
    objetivos: (objetivos as any[]).map((o) => ({ ...o, valor_alvo: o.valor_alvo != null ? Number(o.valor_alvo) : null, valor_atual: o.valor_atual != null ? Number(o.valor_atual) : null })),
    inicio_relogio: p.acordos_ultimo_atraso ?? "2026-09-28",
    inicio_plano: p.plano_inicio ?? "2026-10-01",
  });
  // Atraso quebra a sequência de meses em dia: o relógio recomeça a partir de hoje
  if (!historico && r.atraso_acordo && p.acordos_ultimo_atraso !== hoje) {
    await db.from("preferencias").upsert({ chave: "acordos_ultimo_atraso", valor: hoje, atualizado_em: new Date().toISOString() });
  }
  return { ...r, historico, mes_atual: mesReal, renda_origem: p.renda_mensal ? "informada" : "nao_informada" };
}

async function sincronizarConta(apiKey: string, conta: any, rg: RegraCompilada[], cat: Record<string, number>, cart: CarteiraDespesa[] = []) {
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
      const r = categorizarTransacao({ ...l, conta_tipo: conta.type }, rg, cat, cart);
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

  // Para avisar: só lançamentos realmente novos de uma conta que já existia (não a primeira importação) e recentes
  const limite = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const catPorTx = new Map(comCategoria.map((l) => [l.id, l.categoria_id]));
  const novasRecentes = (count ?? 0) === 0 ? [] : linhas.filter((l) => !porId.has(l.id) && l.data >= limite && !idsSubstitutos(usados, l.id))
    .map((l) => ({ id: l.id, data: l.data, descricao: l.descricao, valor: l.valor, sentido: l.sentido, categoria_id: catPorTx.get(l.id) ?? null, conta: conta.marketingName || conta.name }));
  return {
    novas: linhas.filter((l) => !porId.has(l.id)).length,
    atualizadas: linhas.filter((l) => porId.has(l.id)).length,
    removidas: sumiram.length,
    novasRecentes,
  };
}
/** Lançamento que só substituiu outro (o banco trocou o id): não é novidade para avisar. */
function idsSubstitutos(usados: Set<string>, id: string) { return usados.has(id); }

// ------------------------------------------------------------------ recategorizar

async function recategorizar() {
  cacheCategorias.delete(casaAtual());
  const rg = await regras();
  const cats = await categorias();
  const cart = await carteiras();

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
    .select("id, descricao, recebedor_nome, recebedor_ispb, sentido, tipo_operacao, pagador_doc, recebedor_doc, categoria_id, categoria_origem, contas(tipo)")
    .eq("removida", false).range(de, ate)) as any[];
  let mudouTx = 0;
  for (const t of txs) {
    if (t.categoria_origem === "manual" || t.categoria_origem === "nota") continue;
    const r = categorizarTransacao({ ...t, conta_tipo: t.contas?.tipo }, rg, cats.porNome, cart);
    const nova = r?.categoria_id ?? null;
    if (nova !== t.categoria_id) {
      ok(await db.from("transacoes").update({ categoria_id: nova, categoria_origem: r?.origem ?? null }).eq("id", t.id));
      mudouTx++;
    }
  }
  // Gastos com nota seguem a categoria dos itens
  const vinculados = await todos((de, ate) => db.from("nota_transacao").select("transacao_id").range(de, ate), "nota_id,transacao_id") as any[];
  for (const id of new Set(vinculados.map((v) => v.transacao_id))) await atualizarCategoriaPelaNota(id);
  return { itens_alterados: mudouItens, gastos_alterados: mudouTx };
}

// ------------------------------------------------------------------ servidor

async function rotear(rota: string, req: Request, corpo: any, quem: Quem): Promise<Response> {
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
        const r = categorizarTransacao({ ...tx, conta_tipo: tx.contas?.tipo }, await regras(), (await categorias()).porNome, await carteiras());
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
          casa_id: casaAtual(), alvo: "item", tipo: "exato", padrao: item.descricao_norm, categoria_id: corpo.categoria_id, prioridade: 1, origem: "aprendida",
        }, { onConflict: "casa_id,alvo,tipo,padrao" }));
        const iguais = ok(await db.from("nota_itens").update({ categoria_id: corpo.categoria_id, categoria_origem: "aprendida" })
          .eq("descricao_norm", item.descricao_norm).or("categoria_origem.is.null,categoria_origem.neq.manual").select("nota_id")) as any[];
        iguais.forEach((i) => afetadas.add(i.nota_id));
      }
      const links = ok(await db.from("nota_transacao").select("transacao_id").in("nota_id", [...afetadas])) as any[];
      for (const l of links) await atualizarCategoriaPelaNota(l.transacao_id);
      return json({ ok: true, notas_afetadas: afetadas.size });
    }

    case "/categorizar-transacao": {
      const tx = ok(await db.from("transacoes").select("id, descricao, recebedor_nome, sentido").eq("id", corpo.transacao_id).single()) as any;
      ok(await db.from("transacoes").update({ categoria_id: corpo.categoria_id, categoria_origem: "manual" }).eq("id", tx.id));
      let outros = 0;
      if (corpo.aprender) {
        const chave = chaveAprendizado(textoTx(tx));
        ok(await db.from("regras_categoria").upsert({
          casa_id: casaAtual(), alvo: "transacao", tipo: "exato", padrao: chave, categoria_id: corpo.categoria_id, prioridade: 1, origem: "aprendida", sentido: tx.sentido,
        }, { onConflict: "casa_id,alvo,tipo,padrao" }));
        const candidatos = await todos((de, ate) => db.from("transacoes").select("id, descricao, recebedor_nome")
          .eq("removida", false).eq("sentido", tx.sentido).or("categoria_origem.is.null,categoria_origem.not.in.(manual,nota)").range(de, ate)) as any[];
        const alvo = candidatos.filter((t) => t.id !== tx.id && chaveAprendizado(textoTx(t)) === chave).map((t) => t.id);
        for (let i = 0; i < alvo.length; i += 200) {
          ok(await db.from("transacoes").update({ categoria_id: corpo.categoria_id, categoria_origem: "aprendida" }).in("id", alvo.slice(i, i + 200)));
        }
        outros = alvo.length;
      }
      return json({ ok: true, outros_atualizados: outros });
    }

    case "/categorizar-lote": {
      // Triagem: vários lançamentos parecidos de uma vez; aprende uma regra por descrição
      const ids: string[] = [...new Set<string>((corpo.transacao_ids ?? []).map(String))].slice(0, 3000);
      if (!ids.length) throw new HttpErro(400, "Nenhum lançamento informado");
      const cat = corpo.categoria_id == null || corpo.categoria_id === "" ? null : Number(corpo.categoria_id);
      for (let i = 0; i < ids.length; i += 200) {
        ok(await db.from("transacoes").update({ categoria_id: cat, categoria_origem: cat ? "manual" : null }).in("id", ids.slice(i, i + 200)));
      }
      let outros = 0;
      if (cat && corpo.aprender) {
        const txs: any[] = [];
        for (let i = 0; i < ids.length; i += 200) txs.push(...(ok(await db.from("transacoes").select("id, descricao, recebedor_nome, sentido").in("id", ids.slice(i, i + 200))) as any[]));
        const chaves = new Map<string, string>();
        for (const t of txs) { const k = chaveAprendizado(textoTx(t)); if (k) chaves.set(`${t.sentido}|${k}`, t.sentido); }
        if (chaves.size) {
          ok(await db.from("regras_categoria").upsert([...chaves.entries()].map(([k, sentido]) => ({
            casa_id: casaAtual(), alvo: "transacao", tipo: "exato", padrao: k.slice(k.indexOf("|") + 1), categoria_id: cat, prioridade: 1, origem: "aprendida", sentido,
          })), { onConflict: "casa_id,alvo,tipo,padrao" }));
          const candidatos = await todos((de, ate) => db.from("transacoes").select("id, descricao, recebedor_nome, sentido")
            .eq("removida", false).or("categoria_origem.is.null,categoria_origem.not.in.(manual,nota)").range(de, ate)) as any[];
          const jaFeitos = new Set(ids);
          const alvo = candidatos.filter((t) => !jaFeitos.has(t.id) && chaves.has(`${t.sentido}|${chaveAprendizado(textoTx(t))}`)).map((t) => t.id);
          for (let i = 0; i < alvo.length; i += 200) {
            ok(await db.from("transacoes").update({ categoria_id: cat, categoria_origem: "aprendida" }).in("id", alvo.slice(i, i + 200)));
          }
          outros = alvo.length;
        }
      }
      return json({ ok: true, atualizados: ids.length, outros_atualizados: outros });
    }

    case "/pagar-divida": {
      // Liga um lançamento (ou valor avulso) a uma dívida; opcionalmente aprende o texto do extrato.
      const divida = ok(await db.from("dividas").select("id, padrao_pagamento").eq("id", corpo.divida_id).single()) as any;
      let data = corpo.data, valor = corpo.valor;
      if (corpo.transacao_id) {
        const tx = ok(await db.from("transacoes").select("id, data, valor, descricao, recebedor_nome").eq("id", corpo.transacao_id).single()) as any;
        data = tx.data; valor = Number(tx.valor);
        if (corpo.aprender && !divida.padrao_pagamento) {
          ok(await db.from("dividas").update({ padrao_pagamento: chaveAprendizado(textoTx(tx)) }).eq("id", divida.id));
        }
        const cat = (await categorias()).porNome["Pagamento de dívida"];
        if (cat) ok(await db.from("transacoes").update({ categoria_id: cat, categoria_origem: "manual" }).eq("id", tx.id));
      }
      if (!data || !valor) throw new HttpErro(400, "Informe data e valor do pagamento");
      ok(await db.from("divida_pagamentos").upsert(
        { divida_id: divida.id, data, valor, transacao_id: corpo.transacao_id ?? null, observacao: corpo.observacao ?? null },
        { onConflict: "transacao_id" },
      ));
      const outros = corpo.aprender ? await reconhecerPagamentosDeDividas() : 0;
      return json({ ok: true, outros_reconhecidos: outros });
    }

    case "/sugestoes":
      return json(await montarSugestoes());

    case "/metas":
      return json(await dadosEMetas(corpo.mes));

    case "/sync-pagamentos":
      return json({ pagamentos: await reconhecerPagamentosDeDividas() });

    case "/recategorizar":
      return json(await recategorizar());

    case "/sync":
      return json(await sincronizar(quem.cron ? "agendado" : `app (${quem.email})`));

    case "/verificar":
      return json(await verificarAtualizacoes(quem.cron ? "verificação automática" : `app aberto (${quem.email})`));

    case "/notificacoes": {
      const casa = casaAtual();
      const acao = String(corpo.acao ?? "chave");
      if (acao === "chave") return json({ publica: (await chavesVapid()).publica });
      const sub = corpo.subscription as AssinaturaPush | undefined;
      const endpoint = String(sub?.endpoint ?? corpo.endpoint ?? "");
      if (!/^https:\/\//.test(endpoint)) throw new HttpErro(400, "Assinatura de notificação inválida");
      const chave = await chaveAssinatura(endpoint);
      if (acao === "assinar") {
        if (!sub?.keys?.p256dh || !sub?.keys?.auth) throw new HttpErro(400, "Assinatura de notificação incompleta");
        const prefs: PrefsPush = { despesas: corpo.despesas !== false, receitas: corpo.receitas !== false, valores: corpo.valores !== false, email: quem.email };
        await gravarConfigDe(casa, chave, JSON.stringify({ sub: { endpoint, keys: sub.keys }, prefs, criado_em: new Date().toISOString() }));
        return json({ ok: true, prefs });
      }
      if (acao === "cancelar") { await gravarConfigDe(casa, chave, null); return json({ ok: true }); }
      const atual = (await lerConfigDe(casa, [chave]))[chave];
      if (acao === "estado") return json({ inscrito: !!atual, prefs: atual ? JSON.parse(atual).prefs : null });
      if (acao === "testar") {
        if (!atual) throw new HttpErro(400, "Este aparelho não está inscrito");
        const st = await enviarPush(JSON.parse(atual).sub, { titulo: "Notificações ligadas ✓", corpo: "Você será avisado quando entrar um lançamento novo.", tag: "teste", url: "./#inicio" }, await chavesVapid(), CONTATO_PUSH);
        if (st === 404 || st === 410) { await gravarConfigDe(casa, chave, null); throw new HttpErro(410, "O navegador cancelou esta inscrição; ligue as notificações de novo"); }
        return json({ ok: st >= 200 && st < 300, status: st });
      }
      throw new HttpErro(400, "Ação desconhecida");
    }

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
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
  try {
    if (rota === "/saude") return json({ ok: true, hora: new Date().toISOString() });

    const quem = await autorizar(req, rota);
    const corpo: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (quem.cron) {
      // Agendamento: sincroniza cada casa com Open Finance configurado, como o robô daquela casa
      if (rota === "/sync" || rota === "/verificar") {
        const casas = corpo.casa ? [Number(corpo.casa)] : await casasComPluggy();
        const resultados: any[] = [];
        for (const casa of casas) {
          try {
            const r: Record<string, unknown> = rota === "/sync"
              ? await naCasaDoRobo(casa, () => sincronizar("agendado"))
              : await naCasaDoRobo(casa, () => verificarAtualizacoes("verificação automática"));
            resultados.push({ casa, ...r });
          }
          catch (e) { resultados.push({ casa, erro: e instanceof Error ? e.message : String(e) }); }
        }
        return json({ casas: resultados });
      }
      return await naCasaDoRobo(Number(corpo.casa ?? 1), () => rotear(rota, req, corpo, quem));
    }
    return await contexto.run({ db: quem.db!, casa: quem.casa! }, () => rotear(rota, req, corpo, quem));
  } catch (e) {
    const status = e instanceof HttpErro ? e.status : 500;
    const msg = e instanceof Error ? e.message : String(e);
    if (status >= 500) console.error(rota, e);
    return json({ erro: msg }, status);
  }
});
