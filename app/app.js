// Finanças da Casa — app (PWA). Sem build: módulos ES direto no navegador.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, VERSAO } from "./config.js";
import { iniciarLeitor } from "./scanner.js";

const HASH_INICIAL = location.hash;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ------------------------------------------------------------------ utilidades
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const abas = $("#abas");
const folha = $("#folha");
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const R = (v) => brl.format(Number(v || 0));
/** Valor sensível (saldos, receitas, dívidas): some quando o olho está fechado. */
const Rp = (v, sinal = "") => `<span class="priv"><span class="pv">${sinal}${R(v)}</span><span class="pm">${sinal}R$ •••••</span></span>`;
/** Mascara todos os "R$ 1.234,56" de um texto já escapado. */
const privTexto = (html) => html.replace(/R\$\s?[\d.]+,\d{2}/g, (m) => `<span class="priv"><span class="pv">${m}</span><span class="pm">R$ •••••</span></span>`);
const OLHO_ABERTO = `<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const OLHO_FECHADO = `<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;
function botaoOlho() {
  return `<button class="olho" data-acao="alternarOlho" aria-label="Mostrar ou ocultar valores" title="Mostrar/ocultar saldos"><span class="aberto">${OLHO_ABERTO}</span><span class="fechado">${OLHO_FECHADO}</span></button>`;
}
function aplicarOlho(oculto) { document.body.classList.toggle("oculto", oculto); }
try { aplicarOlho(localStorage.getItem("ocultarValores") === "1"); } catch { /* sem armazenamento */ }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ICONE_NOTA = `<svg class="icone-nota" viewBox="0 0 24 24" aria-label="tem nota fiscal"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/></svg>`;

function mesAtual() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function somarMes(m, n) { const [a, b] = m.split("-").map(Number); const d = new Date(a, b - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function nomeMes(m) { const [a, b] = m.split("-").map(Number); return new Date(a, b - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }); }
function limites(m) { return [`${m}-01`, `${somarMes(m, 1)}-01`]; }
function dataLonga(d) { return maiuscula(new Date(d + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })); }
function dataCurta(d) { if (!d) return "—"; const [a, m, dd] = d.slice(0, 10).split("-"); return `${dd}/${m}/${a}`; }
function dataHora(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
function haQuanto(iso) {
  if (!iso) return "nunca";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}
function cnpjFmt(c) { const d = String(c ?? "").replace(/\D/g, ""); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : c ?? ""; }
function normalizar(s) { return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim(); }

let timerAviso;
function avisar(msg, erro = false) {
  const el = $("#aviso");
  el.textContent = msg;
  el.className = erro ? "erro" : "";
  el.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.hidden = true), erro ? 6000 : 3500);
}

// ------------------------------------------------------------------ dados guardados no aparelho (offline)
// Toda consulta de leitura bem-sucedida fica guardada no IndexedDB. Sem internet, o app mostra a última cópia.
const ehErroDeRede = (msg) => !navigator.onLine || /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(String(msg ?? ""));
let bancoLocal = null;
function abrirBancoLocal() {
  if (!bancoLocal) {
    bancoLocal = new Promise((ok, falha) => {
      const r = indexedDB.open("financas-cache", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("consultas");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => falha(r.error);
    }).catch(() => null);
  }
  return bancoLocal;
}
async function guardarLocal(chave, dados) {
  try {
    const db = await abrirBancoLocal(); if (!db) return;
    db.transaction("consultas", "readwrite").objectStore("consultas").put({ em: Date.now(), dados }, chave);
  } catch { /* sem espaço ou modo privado: segue sem cópia */ }
}
async function lerLocal(chave) {
  try {
    const db = await abrirBancoLocal(); if (!db) return null;
    return await new Promise((ok) => {
      const r = db.transaction("consultas").objectStore("consultas").get(chave);
      r.onsuccess = () => ok(r.result ?? null);
      r.onerror = () => ok(null);
    });
  } catch { return null; }
}
async function apagarLocal() {
  try { const db = await abrirBancoLocal(); if (db) db.transaction("consultas", "readwrite").objectStore("consultas").clear(); } catch { /* ok */ }
}
/** Mostra a faixa "sem internet" com a data da cópia mais antiga usada na tela. */
function marcarOffline(em) {
  estado.offlineDesde = Math.min(estado.offlineDesde ?? em, em);
  const el = $("#offline");
  if (!el) return;
  const d = new Date(estado.offlineDesde);
  el.innerHTML = `<span>Sem internet · dados salvos em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>`;
  el.hidden = false;
}
window.addEventListener("online", () => {
  const el = $("#offline");
  if (el && !el.hidden) { el.hidden = true; estado.offlineDesde = null; if (sessaoOffline) location.reload(); else recarregar(); }
});
let sessaoOffline = false;

async function q(consulta) {
  const leitura = consulta?.method === "GET" && consulta?.url;
  const chave = leitura ? "q:" + consulta.url.toString() : null;
  if (!navigator.onLine) {
    // Sem rede: nem tenta (a biblioteca repetiria a chamada várias vezes antes de desistir)
    const c = chave ? await lerLocal(chave) : null;
    if (c) { marcarOffline(c.em); return c.dados; }
    throw new Error(chave ? "Sem internet e estes dados ainda não foram guardados neste aparelho" : "Sem internet: tente de novo quando a conexão voltar");
  }
  const { data, error } = await consulta;
  if (error) {
    if (ehErroDeRede(error.message)) {
      if (chave) {
        const c = await lerLocal(chave);
        if (c) { marcarOffline(c.em); return c.dados; }
        throw new Error("Sem internet e estes dados ainda não foram guardados neste aparelho");
      }
      throw new Error("Sem internet: tente de novo quando a conexão voltar");
    }
    throw new Error(error.message);
  }
  if (chave) guardarLocal(chave, data);
  return data;
}
async function todas(fabrica) {
  const out = [];
  for (let de = 0; ; de += 1000) {
    const lote = await q(fabrica().range(de, de + 999));
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

/** Chama a função do servidor. */
async function fn(rota, corpo, metodo = "POST") {
  // Leituras do servidor (sem corpo) também ficam guardadas para uso offline
  const chave = !corpo && ["/sugestoes", "/config"].includes(rota) ? "fn:" + rota : null;
  if (chave && !navigator.onLine) {
    const c = await lerLocal(chave);
    if (c) { marcarOffline(c.em); return c.dados; }
  }
  const j = await fnRede(rota, corpo, metodo).catch(async (e) => {
    if (chave && e.rede) { const c = await lerLocal(chave); if (c) { marcarOffline(c.em); return c.dados; } }
    throw e;
  });
  if (chave) guardarLocal(chave, j);
  return j;
}
async function fnRede(rota, corpo, metodo) {
  const { data: { session } } = await sb.auth.getSession().catch(() => ({ data: { session: null } }));
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/api${rota}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${session?.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: metodo === "POST" ? JSON.stringify(corpo ?? {}) : undefined,
    });
  } catch (e) {
    const err = new Error("Sem conexão com o servidor");
    err.rede = true;
    throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ estado e navegação
const estado = {
  aba: "inicio",
  mes: mesAtual(),
  filtroGastos: "tudo",
  categoriaFiltro: null,
  filtroNotas: "confirmar",
  categorias: [],
  catPorId: {},
  email: null,
  leitor: null,
};

const acoes = {};    // cliques: data-acao="nome"
const mudancas = {}; // selects/inputs: data-muda="nome"

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-acao]");
  if (el && acoes[el.dataset.acao]) { e.preventDefault(); acoes[el.dataset.acao](el, e); }
});
document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-muda]");
  if (el && mudancas[el.dataset.muda]) mudancas[el.dataset.muda](el, e);
});
abas.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-aba]");
  if (b) irPara(b.dataset.aba);
});

function pararLeitor() { estado.leitor?.parar(); estado.leitor = null; }

async function irPara(aba) {
  pararLeitor();
  estado.aba = aba;
  history.replaceState(null, "", `#${aba}`);
  abas.querySelectorAll("button").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  window.scrollTo(0, 0);
  const tela = { inicio: telaInicio, gastos: telaGastos, escanear: telaEscanear, notas: telaNotas, mais: telaMais, patrimonio: telaPatrimonio, sugestoes: telaSugestoes }[aba] ?? telaInicio;
  try { await tela(); } catch (e) {
    const semRede = /^Sem internet/.test(e.message);
    const alvo = $("#conteudo") ?? app;
    alvo.innerHTML = semRede
      ? `<div class="vazio"><strong>Sem internet</strong>Esta tela ainda não tinha sido aberta neste aparelho, então não há dados guardados. Com internet, abra-a uma vez e ela passa a funcionar offline.</div>`
      : `<div class="vazio"><strong>Algo deu errado</strong>${esc(e.message)}</div>`;
  }
}
function recarregar() { return irPara(estado.aba); }

// Folha inferior (detalhes). O botão "voltar" do Android fecha a folha.
let folhaAberta = false;
function abrirFolha(html) {
  folha.innerHTML = `<div class="painel" role="dialog"><div class="alca"></div><button class="fechar" data-acao="fecharFolha" aria-label="Fechar">×</button>${html}</div>`;
  folha.hidden = false;
  if (!folhaAberta) { history.pushState({ folha: 1 }, ""); folhaAberta = true; }
}
function fecharFolha(viaHistorico = false) {
  if (!folhaAberta) return;
  folhaAberta = false;
  folha.hidden = true;
  folha.innerHTML = "";
  if (!viaHistorico) history.back();
}
window.addEventListener("popstate", () => { if (folhaAberta) fecharFolha(true); });
folha.addEventListener("click", (e) => { if (e.target === folha) fecharFolha(); });
acoes.fecharFolha = () => fecharFolha();

function carregando() { return `<div class="carregando-tela"><div class="spinner"></div></div>`; }

function mesCurto(m) { const [a, b] = m.split("-").map(Number); return maiuscula(new Date(a, b - 1, 1).toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")) + " " + a; }
function topoMes(titulo) {
  return `<div class="topo"><h1>${titulo}</h1>${botaoOlho()}
    <div class="seletor-mes"><button data-acao="mesAnterior" aria-label="Mês anterior">‹</button><span>${mesCurto(estado.mes)}</span><button data-acao="mesSeguinte" aria-label="Próximo mês">›</button></div></div>`;
}
acoes.mesAnterior = () => { estado.mes = somarMes(estado.mes, -1); recarregar(); };
acoes.mesSeguinte = () => { estado.mes = somarMes(estado.mes, 1); recarregar(); };

function seletorCategoria(atual, attrs = "", sentido = null) {
  const grupos = {};
  const ordemNat = sentido === "entrada" ? { receita: 0, neutro: 1, despesa: 2 } : sentido === "saida" ? { despesa: 0, neutro: 1, receita: 2 } : { despesa: 0, receita: 1, neutro: 2 };
  const lista = estado.categorias.filter((c) => c.ativa || c.id === atual)
    .sort((a, b) => (ordemNat[a.natureza] ?? 0) - (ordemNat[b.natureza] ?? 0) || a.ordem - b.ordem);
  for (const c of lista) (grupos[c.grupo] ??= []).push(c);
  return `<select ${attrs}><option value="">Sem categoria</option>${Object.entries(grupos).map(([g, cs]) =>
    `<optgroup label="${esc(g)}">${cs.map((c) => `<option value="${c.id}" ${c.id === atual ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}</optgroup>`).join("")}</select>`;
}
function chipCategoria(id) {
  const c = estado.catPorId[id];
  if (!c) return `<span class="chip alerta">sem categoria</span>`;
  if (c.natureza === "receita") return `<span class="chip ok"><span class="ponto" style="background:${esc(c.cor)}"></span>${esc(c.nome)}</span>`;
  return `<span class="chip"><span class="ponto" style="background:${esc(c.cor)}"></span>${esc(c.nome)}</span>`;
}
async function carregarCategorias() {
  estado.categorias = await q(sb.from("categorias").select("*").order("ordem").order("nome"));
  estado.catPorId = Object.fromEntries(estado.categorias.map((c) => [c.id, c]));
}

// ------------------------------------------------------------------ INÍCIO
async function telaInicio() {
  app.innerHTML = topoMes("Resumo") + `<div id="conteudo">${carregando()}</div>`;
  const ant = somarMes(estado.mes, -1);
  const [linhas, anteriores, pend, ultimo, invs, divs, receitas, receitasAnt, contasSaldo] = await Promise.all([
    todas(() => sb.from("v_gastos").select("transacao_id, data, categoria_id, categoria, valor, conta_como_gasto, via_nota").eq("mes", estado.mes)),
    todas(() => sb.from("v_gastos").select("data, valor").eq("mes", ant).eq("conta_como_gasto", true)),
    q(sb.from("v_pendencias").select("tipo")),
    q(sb.from("sync_log").select("inicio, fim, ok, mensagem").order("inicio", { ascending: false }).limit(1)),
    q(sb.from("investimentos").select("saldo_liquido, status")).catch(() => []),
    q(sb.from("v_dividas").select("saldo_devedor")).catch(() => []),
    todas(() => sb.from("v_receitas").select("categoria_id, categoria, valor").eq("mes", estado.mes)).catch(() => []),
    todas(() => sb.from("v_receitas").select("valor, data").eq("mes", ant)).catch(() => []),
    q(sb.from("contas").select("id, nome, apelido, tipo, saldo, atualizado_em").eq("ativa", true).order("tipo").order("saldo", { ascending: false })).catch(() => []),
  ]);
  const totalReceitas = receitas.reduce((s, r) => s + Number(r.valor), 0);
  const totalReceitasAnt = receitasAnt.reduce((s, r) => s + Number(r.valor), 0);
  const recPorCat = new Map();
  for (const r of receitas) recPorCat.set(r.categoria_id ?? 0, { id: r.categoria_id, nome: r.categoria, valor: (recPorCat.get(r.categoria_id ?? 0)?.valor ?? 0) + Number(r.valor) });
  const recCats = [...recPorCat.values()].sort((a, b) => b.valor - a.valor);
  const bancos = contasSaldo.filter((c) => c.tipo === "BANK");
  const cartoes = contasSaldo.filter((c) => c.tipo === "CREDIT" && Math.abs(Number(c.saldo || 0)) > 0);
  const saldoTotal = bancos.reduce((s, c) => s + Number(c.saldo || 0), 0);
  const investido = invs.filter((i) => i.status !== "TOTAL_WITHDRAWAL").reduce((s, i) => s + Number(i.saldo_liquido || 0), 0);
  const devido = divs.reduce((s, d) => s + Number(d.saldo_devedor || 0), 0);
  const gastos = linhas.filter((l) => l.conta_como_gasto);
  const total = gastos.reduce((s, l) => s + Number(l.valor), 0);
  const totalAnt = anteriores.reduce((s, l) => s + Number(l.valor), 0);
  const ehMesAtual = estado.mes === mesAtual();
  const diaHoje = new Date().getDate();
  const antAteHoje = anteriores.filter((l) => Number(l.data.slice(8, 10)) <= diaHoje).reduce((s, l) => s + Number(l.valor), 0);
  const base = ehMesAtual ? antAteHoje : totalAnt;
  const variacao = base > 0 ? (total - base) / base : null;
  const comNota = gastos.filter((l) => l.via_nota).reduce((s, l) => s + Number(l.valor), 0);

  const porCat = new Map();
  for (const l of gastos) {
    const k = l.categoria_id ?? 0;
    const atual = porCat.get(k) ?? { id: l.categoria_id, nome: l.categoria, valor: 0 };
    atual.valor += Number(l.valor);
    porCat.set(k, atual);
  }
  const cats = [...porCat.values()].sort((a, b) => b.valor - a.valor);
  const max = cats[0]?.valor || 1;
  const nNotas = pend.filter((p) => p.tipo === "nota_sem_gasto").length;
  const nSemCat = pend.filter((p) => p.tipo === "gasto_sem_categoria").length;
  const sync = ultimo[0];

  $("#conteudo").innerHTML = `
    <div class="cartao destaque">
      <div class="nota-texto">Gasto em ${nomeMes(estado.mes)}</div>
      <div class="valor num">${Rp(total)}</div>
      <div class="compara">${variacao == null ? "Sem dados do mês anterior para comparar" :
        `<span class="${variacao > 0 ? "sobe" : "desce"}">${variacao > 0 ? "▲" : "▼"} ${Math.abs(variacao * 100).toFixed(0)}%</span> em relação a ${ehMesAtual ? `${nomeMes(ant).split(" ")[0]} até o dia ${diaHoje}` : nomeMes(ant).split(" ")[0]} (${Rp(base)})`}</div>
      ${total > 0 ? `<div class="compara">${Math.round((comNota / total) * 100)}% do valor tem nota fiscal detalhada</div>` : ""}
      ${totalReceitas > 0 ? `<div class="compara">Entrou ${Rp(totalReceitas)} · ${totalReceitas - total >= 0 ? `sobrou <span class="desce">${Rp(totalReceitas - total)}</span>` : `faltou <span class="sobe">${Rp(total - totalReceitas)}</span>`}</div>` : ""}
    </div>
    <div class="cartao" id="cartaoEvolucao">
      <h3>Evolução</h3>
      <div class="seg seg-peq">${PERIODOS_EVO.map(([k, n]) => `<button data-acao="periodoEvo" data-p="${k}">${n}</button>`).join("")}</div>
      <p class="nota-texto priv-aviso">Gráfico oculto. Toque no olho para ver.</p>
      <div class="corpo-evo priv-bloco"><div class="nota-texto"><span class="spinner peq"></span> Montando o gráfico…</div></div>
    </div>
    <div class="cartao" id="cartaoSugestoes" data-acao="irSugestoes" style="cursor:pointer">
      <h3>Sugestões</h3><div class="nota-texto"><span class="spinner peq"></span> Analisando suas finanças…</div>
    </div>
    ${(nNotas || nSemCat) ? `<div class="cartao">
      <h3>Precisa de atenção</h3>
      ${nNotas ? `<div class="linha" data-acao="verNotasPendentes"><div class="corpo"><div class="titulo">${nNotas} nota${nNotas > 1 ? "s" : ""} sem gasto ligado</div><div class="meta">Confirme qual gasto é cada nota</div></div><span class="chip alerta">ver</span></div>` : ""}
      ${nSemCat ? `<div class="linha" data-acao="verSemCategoria"><div class="corpo"><div class="titulo">${nSemCat} gasto${nSemCat > 1 ? "s" : ""} sem categoria</div><div class="meta">Categorize uma vez e o app aprende</div></div><span class="chip alerta">ver</span></div>` : ""}
    </div>` : ""}
    <div class="cartao">
      <h3>Por categoria</h3>
      ${cats.length ? cats.map((c) => {
        const cor = estado.catPorId[c.id]?.cor ?? "#8a8f98";
        return `<div class="barra-cat" data-acao="verCategoria" data-id="${c.id ?? ""}">
          <div class="nome"><span class="ponto" style="background:${esc(cor)}"></span><span>${esc(c.nome)}</span></div>
          <div class="num">${Rp(c.valor)}<span class="pct">${Math.round((c.valor / total) * 100)}%</span></div>
          <div class="trilho"><i style="width:${(c.valor / max) * 100}%;background:${esc(cor)}"></i></div></div>`;
      }).join("") : `<div class="vazio"><strong>Nenhum gasto neste mês</strong>Sincronize o Open Finance em Mais, ou escaneie uma nota.</div>`}
    </div>
    <div class="cartao">
      <h3>Receitas</h3>
      <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="titulo num entrada" style="font-size:20px">${Rp(totalReceitas)}</div>
        <div class="meta">${totalReceitasAnt ? `${nomeMes(ant).split(" ")[0]} inteiro: ${Rp(totalReceitasAnt)}` : "Entradas que são renda: salário, pix recebidos, reembolsos"}</div></div></div>
      ${recCats.map((c) => {
        const cor = estado.catPorId[c.id]?.cor ?? "#2a9d8f";
        return `<div class="barra-cat" data-acao="verReceita" data-id="${c.id ?? ""}">
          <div class="nome"><span class="ponto" style="background:${esc(cor)}"></span><span>${esc(c.nome)}</span></div>
          <div class="num">${Rp(c.valor)}<span class="pct">${Math.round((c.valor / (totalReceitas || 1)) * 100)}%</span></div>
          <div class="trilho"><i style="width:${(c.valor / (recCats[0]?.valor || 1)) * 100}%;background:${esc(cor)}"></i></div></div>`;
      }).join("") || `<p class="nota-texto">Nenhuma receita neste mês.</p>`}
    </div>
    ${bancos.length ? `<div class="cartao">
      <h3>Saldo nas contas</h3>
      <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="titulo num ${saldoTotal < 0 ? "sobe" : ""}" style="font-size:20px">${Rp(Math.abs(saldoTotal), saldoTotal < 0 ? "−" : "")}</div>
        <div class="meta">Soma das contas correntes · atualizado ${haQuanto(bancos[0].atualizado_em)}</div></div></div>
      ${bancos.map((c) => `<div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(c.apelido || c.nome)}</div>
        ${Number(c.saldo) < 0 ? `<div class="meta"><span class="chip alerta">usando cheque especial</span></div>` : ""}</div>
        <div class="valor num ${Number(c.saldo) < 0 ? "sobe" : ""}">${Rp(Math.abs(Number(c.saldo)), Number(c.saldo) < 0 ? "−" : "")}</div></div>`).join("")}
      ${cartoes.map((c) => `<div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(c.apelido || c.nome)}</div><div class="meta">fatura do cartão</div></div>
        <div class="valor num neutro">${Rp(Math.abs(Number(c.saldo)))}</div></div>`).join("")}
    </div>` : ""}
    ${(invs.length || divs.length) ? `<div class="cartao">
      <h3>Patrimônio</h3>
      <div class="linha" data-acao="irPatrimonio" data-s="investimentos"><div class="corpo"><div class="titulo">Investimentos e caixinhas</div></div><div class="valor num entrada">${Rp(investido)}</div></div>
      <div class="linha" data-acao="irPatrimonio" data-s="dividas"><div class="corpo"><div class="titulo">Dívidas</div></div><div class="valor num">${Rp(devido, devido ? "−" : "")}</div></div>
    </div>` : ""}
    <div class="cartao plano">
      <div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">Open Finance</div>
        <div class="meta">${sync ? `Atualizado ${haQuanto(sync.fim ?? sync.inicio)}${sync.ok === false ? ` · <span class="erro-texto">${esc(sync.mensagem ?? "erro")}</span>` : ""}` : "Ainda não sincronizado"}</div></div>
        <button class="botao peq sec" data-acao="sincronizar">Sincronizar</button></div>
    </div>`;
  carregarEvolucao();
  carregarResumoSugestoes();
}
// ---------- Gráfico de evolução (despesas, receitas, investimentos)
const SERIES_EVO = [
  { k: "despesas", nome: "Despesas", cls: "s-desp" },
  { k: "receitas", nome: "Receitas", cls: "s-rec" },
  { k: "invest", nome: "Investimentos", cls: "s-inv" },
];
const PERIODOS_EVO = [["12m", "1 ano"], ["6m", "6 meses"], ["3m", "3 meses"], ["1m", "1 mês"]];
function isoDia(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function somarDias(dia, n) { const d = new Date(dia + "T12:00:00"); d.setDate(d.getDate() + n); return isoDia(d); }

async function dadosEvolucao() {
  if (estado.evo && Date.now() - estado.evo.em < 5 * 60000) return estado.evo;
  const hoje = isoDia(new Date());
  const inicio = somarMes(mesAtual(), -11) + "-01";
  const [g, r, inv] = await Promise.all([
    todas(() => sb.from("v_gastos").select("data, valor").eq("conta_como_gasto", true).gte("data", inicio)),
    todas(() => sb.from("v_receitas").select("data, valor").gte("data", inicio)).catch(() => []),
    todas(() => sb.from("v_investimentos_historico").select("dia, saldo_liquido").order("dia")).catch(() => []),
  ]);
  estado.evo = { em: Date.now(), hoje, gastos: g, receitas: r, invest: inv };
  return estado.evo;
}

/** Agrupa em baldes conforme o período: meses (1 ano / 6 meses), semanas (3 meses) ou dias acumulados (1 mês). */
function baldesEvolucao(dd, periodo) {
  const hoje = dd.hoje;
  let baldes;
  if (periodo === "12m" || periodo === "6m") {
    const n = periodo === "12m" ? 12 : 6;
    baldes = Array.from({ length: n }, (_, i) => {
      const m = somarMes(mesAtual(), i - n + 1);
      const fim = i === n - 1 ? hoje : somarDias(somarMes(m, 1) + "-01", -1);
      return { ini: m + "-01", fim, rot: maiuscula(nomeMes(m).split(" ")[0].slice(0, 3)), dica: maiuscula(nomeMes(m)) + (i === n - 1 ? " (até hoje)" : "") };
    });
  } else if (periodo === "3m") {
    baldes = Array.from({ length: 13 }, (_, i) => {
      const fim = somarDias(hoje, -7 * (12 - i)), ini = somarDias(fim, -6);
      return { ini, fim, rot: dataCurta(fim).slice(0, 5), dica: `Semana de ${dataCurta(ini).slice(0, 5)} a ${dataCurta(fim).slice(0, 5)}` };
    });
  } else {
    baldes = Array.from({ length: 30 }, (_, i) => {
      const dia = somarDias(hoje, i - 29);
      return { ini: dia, fim: dia, rot: dataCurta(dia).slice(0, 5), dica: dataCurta(dia) };
    });
  }
  const acumulado = periodo === "1m";
  const somar = (lista, campo) => baldes.map((b) => lista.filter((x) => x[campo] >= b.ini && x[campo] <= b.fim).reduce((s, x) => s + Number(x.valor), 0));
  let desp = somar(dd.gastos, "data"), rec = somar(dd.receitas, "data");
  if (acumulado) {
    let a = 0, c = 0;
    desp = desp.map((v) => (a += v)); rec = rec.map((v) => (c += v));
  }
  // Investimentos: saldo na última fotografia até o fim de cada balde (vazio antes da primeira)
  const inv = baldes.map((b) => {
    let ult = null;
    for (const h of dd.invest) { if (h.dia <= b.fim) ult = Number(h.saldo_liquido); else break; }
    return ult;
  });
  return { baldes, acumulado, series: { despesas: desp, receitas: rec, invest: inv } };
}

function fmtEixo(v) {
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: a >= 10000 ? 0 : 1 }) + " mil";
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

function graficoEvolucao(ev) {
  const W = 360, H = 180, pe = 38, pd = 8, pt = 10, pb = 22;
  const n = ev.baldes.length;
  const todos = SERIES_EVO.flatMap((s) => ev.series[s.k]).filter((v) => v != null);
  let max = Math.max(...todos, 1);
  const passo = Math.pow(10, Math.floor(Math.log10(max)));
  max = Math.ceil(max / passo) * passo;
  const x = (i) => pe + (n === 1 ? 0 : (i * (W - pe - pd)) / (n - 1));
  const y = (v) => pt + (1 - v / max) * (H - pt - pb);
  const caminho = (vals) => {
    let d = "", aberto = false;
    vals.forEach((v, i) => {
      if (v == null) { aberto = false; return; }
      d += `${aberto ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; aberto = true;
    });
    return d.trim();
  };
  const ticks = [0, max / 2, max];
  const idxRot = n <= 6 ? [...Array(n).keys()] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const dados = esc(JSON.stringify(ev.baldes.map((b, i) => ({ x: x(i), d: b.dica, v: SERIES_EVO.map((s) => ev.series[s.k][i]), y: SERIES_EVO.map((s) => ev.series[s.k][i] == null ? null : y(ev.series[s.k][i])) }))));
  return `
    <div class="legenda-evo">${SERIES_EVO.map((s) => `<span><i class="${s.cls}"></i>${s.nome}</span>`).join("")}</div>
    <div class="grafico-evo" data-pontos="${dados}" data-w="${W}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Despesas, receitas e investimentos no período">
      ${ticks.map((t) => `<line x1="${pe}" x2="${W - pd}" y1="${y(t)}" y2="${y(t)}" class="grade"/><text x="${pe - 6}" y="${y(t) + 4}" text-anchor="end" class="eixo">${fmtEixo(t)}</text>`).join("")}
      ${idxRot.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" class="eixo">${esc(ev.baldes[i].rot)}</text>`).join("")}
      ${SERIES_EVO.map((s) => `<path d="${caminho(ev.series[s.k])}" class="linha-evo ${s.cls}"/>`).join("")}
      <line class="cursor" y1="${pt}" y2="${H - pb}" x1="0" x2="0" visibility="hidden"/>
      ${SERIES_EVO.map((s) => `<circle class="marc-evo ${s.cls}" r="5" visibility="hidden"/>`).join("")}
      <rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
    </svg>
    <div class="dica dica-evo" hidden></div></div>
    <p class="nota-texto" style="margin:6px 0 0">${ev.acumulado ? "Despesas e receitas somadas desde o início do período." : `Despesas e receitas somadas por ${n === 13 ? "semana" : "mês"}.`} Investimentos: saldo no fim de cada ${ev.acumulado ? "dia" : n === 13 ? "semana" : "mês"}${ev.series.invest.some((v) => v == null) ? " (o histórico começa na primeira sincronização)" : ""}.</p>`;
}

function ativarGraficoEvolucao(g) {
  const pts = JSON.parse(g.dataset.pontos);
  const svg = g.querySelector("svg"), dica = g.querySelector(".dica");
  const cursor = svg.querySelector(".cursor"), marcs = [...svg.querySelectorAll(".marc-evo")];
  const mover = (ev) => {
    const r = svg.getBoundingClientRect();
    const W = Number(g.dataset.w);
    const px = ((ev.clientX - r.left) / r.width) * W;
    let p = pts[0];
    for (const q of pts) if (Math.abs(q.x - px) < Math.abs(p.x - px)) p = q;
    cursor.setAttribute("x1", p.x); cursor.setAttribute("x2", p.x); cursor.setAttribute("visibility", "visible");
    marcs.forEach((m, i) => {
      if (p.y[i] == null) return m.setAttribute("visibility", "hidden");
      m.setAttribute("cx", p.x); m.setAttribute("cy", p.y[i]); m.setAttribute("visibility", "visible");
    });
    dica.hidden = false;
    dica.innerHTML = `<span>${esc(p.d)}</span>${SERIES_EVO.map((s, i) => `<div class="l"><i class="${s.cls}"></i>${s.nome}<strong class="num">${p.v[i] == null ? "—" : R(p.v[i])}</strong></div>`).join("")}`;
    const esq = (p.x / W) * r.width;
    dica.style.left = `${Math.min(Math.max(esq - 90, 0), r.width - 180)}px`;
  };
  const sair = () => { dica.hidden = true; cursor.setAttribute("visibility", "hidden"); marcs.forEach((m) => m.setAttribute("visibility", "hidden")); };
  svg.addEventListener("pointermove", mover);
  svg.addEventListener("pointerdown", mover);
  svg.addEventListener("pointerleave", sair);
}

async function carregarEvolucao() {
  const el = $("#cartaoEvolucao");
  if (!el) return;
  const periodo = estado.periodoEvo ?? "6m";
  el.querySelectorAll("[data-acao=periodoEvo]").forEach((b) => b.classList.toggle("ativo", b.dataset.p === periodo));
  const corpo = el.querySelector(".corpo-evo");
  try {
    const dd = await dadosEvolucao();
    if (!$("#cartaoEvolucao")) return;
    corpo.innerHTML = graficoEvolucao(baldesEvolucao(dd, periodo));
    ativarGraficoEvolucao(corpo.querySelector(".grafico-evo"));
  } catch (e) {
    corpo.innerHTML = `<p class="nota-texto">Não consegui montar o gráfico (${esc(e.message)}).</p>`;
  }
}
acoes.periodoEvo = (el) => { estado.periodoEvo = el.dataset.p; carregarEvolucao(); };
async function carregarResumoSugestoes() {
  const el = $("#cartaoSugestoes");
  if (!el) return;
  try {
    const d = await obterSugestoes();
    if (!$("#cartaoSugestoes")) return;
    const top = d.sugestoes.filter((x) => x.tipo !== "dica").slice(0, 3);
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Sugestões</h3><span class="chip">ver todas ›</span></div>
      ${d.economia_potencial > 0 ? `<div class="valor num desce" style="font-size:22px;font-weight:700;margin-top:6px">${Rp(d.economia_potencial)}<span class="nota-texto" style="font-weight:400"> por mês de economia possível</span></div>` : ""}
      <p class="nota-texto priv-aviso">Sugestões ocultas. Toque no olho para ver.</p><ul class="lista priv-bloco">${top.map((x) => `<li class="linha" style="cursor:pointer"><span class="icone-sug ${x.tipo}">${ICONES_SUG[x.tipo]}</span><div class="corpo"><div class="titulo">${esc(x.titulo)}</div></div>${x.economia_mensal ? `<div class="valor num desce" style="font-size:13px">${Rp(x.economia_mensal)}/mês</div>` : ""}</li>`).join("")}</ul>`;
  } catch (e) {
    el.innerHTML = `<h3>Sugestões</h3><p class="nota-texto">Não consegui analisar agora (${esc(e.message)}).</p>`;
  }
}
acoes.irSugestoes = () => irPara("sugestoes");
acoes.tentarDeNovo = () => location.reload();
acoes.alternarOlho = () => {
  const oculto = !document.body.classList.contains("oculto");
  aplicarOlho(oculto);
  try { localStorage.setItem("ocultarValores", oculto ? "1" : "0"); } catch { /* sem armazenamento */ }
};
acoes.verReceita = (el) => { estado.categoriaFiltro = el.dataset.id ? Number(el.dataset.id) : "nula"; estado.filtroGastos = "receitas"; irPara("gastos"); };
acoes.verNotasPendentes = () => { estado.filtroNotas = "confirmar"; irPara("notas"); };
acoes.verSemCategoria = () => { estado.filtroGastos = "sem-categoria"; estado.categoriaFiltro = null; irPara("gastos"); };
acoes.verCategoria = (el) => { estado.categoriaFiltro = el.dataset.id ? Number(el.dataset.id) : "nula"; estado.filtroGastos = "tudo"; irPara("gastos"); };
acoes.sincronizar = async (el) => {
  el.disabled = true;
  el.innerHTML = `<span class="spinner peq"></span> Sincronizando`;
  try {
    const r = await fn("/sync");
    avisar(`${r.novas} lançamento(s) novo(s), ${r.vinculadas} nota(s) ligada(s)${r.avisos?.length ? " · " + r.avisos[0] : ""}`, !!r.avisos?.length);
    await recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; el.textContent = "Sincronizar"; }
};

// ------------------------------------------------------------------ MOVIMENTAÇÕES (despesas e receitas)
const natureza = (catId) => estado.catPorId[catId]?.natureza ?? null;
/** Tipo do lançamento para exibição: despesa (consumo), receita (renda) ou neutro (entre contas, fatura, investimento). */
function tipoLancamento(t) {
  const n = natureza(t.categoria_id);
  if (n === "neutro") return "neutro";
  if (t.sentido === "entrada") return n === "despesa" ? "neutro" : "receita";
  return n === "receita" ? "neutro" : "despesa";
}
async function telaGastos() {
  const f = estado.filtroGastos;
  const catF = estado.categoriaFiltro;
  const nomeCat = catF === "nula" ? "Sem categoria" : estado.catPorId[catF]?.nome;
  app.innerHTML = topoMes("Movimentações") + `
    <div class="filtros">
      ${catF != null ? `<button class="filtro ativo" data-acao="limparCategoria">${esc(nomeCat)} ✕</button>` : ""}
      ${[["tudo", "Tudo"], ["despesas", "Despesas"], ["receitas", "Receitas"], ["sem-nota", "Sem nota"], ["sem-categoria", "Sem categoria"]]
        .map(([k, n]) => `<button class="filtro ${f === k ? "ativo" : ""}" data-acao="filtroGastos" data-f="${k}">${n}</button>`).join("")}
    </div><div id="conteudo">${carregando()}</div>`;

  const [ini, fim] = limites(estado.mes);
  let txs = await todas(() => sb.from("transacoes")
    .select("id, data, descricao, valor, sentido, status, categoria_id, parcela_numero, parcelas_total, observacao, contas(apelido, nome, tipo), nota_transacao(nota_id, notas(nome_emitente))")
    .eq("removida", false).gte("data", ini).lt("data", fim)
    .order("data", { ascending: false }).order("valor", { ascending: false }));

  let valorNaCategoria = null;
  if (catF != null && natureza(catF) === "despesa" || catF === "nula") {
    // Despesas com nota são divididas pelas categorias dos itens
    const alocado = await todas(() => {
      let c = sb.from("v_gastos").select("transacao_id, valor").eq("mes", estado.mes);
      return catF === "nula" ? c.is("categoria_id", null) : c.eq("categoria_id", catF);
    });
    valorNaCategoria = new Map();
    for (const a of alocado) valorNaCategoria.set(a.transacao_id, (valorNaCategoria.get(a.transacao_id) ?? 0) + Number(a.valor));
    txs = txs.filter((t) => valorNaCategoria.has(t.id) || (catF === "nula" && t.categoria_id == null));
  } else if (catF != null) {
    txs = txs.filter((t) => t.categoria_id === catF);
  }
  if (f === "despesas") txs = txs.filter((t) => tipoLancamento(t) === "despesa");
  if (f === "receitas") txs = txs.filter((t) => tipoLancamento(t) === "receita");
  if (f === "sem-nota") txs = txs.filter((t) => tipoLancamento(t) === "despesa" && !t.nota_transacao.length);
  if (f === "sem-categoria") txs = txs.filter((t) => t.categoria_id == null);

  if (!txs.length) {
    $("#conteudo").innerHTML = `<div class="vazio"><strong>Nada por aqui</strong>Nenhum lançamento com este filtro em ${nomeMes(estado.mes)}.</div>`;
    return;
  }
  const valorDe = (t) => Number(valorNaCategoria?.get(t.id) ?? t.valor);
  const somaTipo = (lista, tipo) => lista.filter((t) => tipoLancamento(t) === tipo).reduce((s, t) => s + valorDe(t), 0);
  const entradas = somaTipo(txs, "receita"), saidas = somaTipo(txs, "despesa");
  const porDia = new Map();
  for (const t of txs) porDia.set(t.data, [...(porDia.get(t.data) ?? []), t]);

  $("#conteudo").innerHTML = `
    <div class="cartao resumo-mov">
      <div><span class="nota-texto">Receitas</span><strong class="num entrada">${Rp(entradas, "+")}</strong></div>
      <div><span class="nota-texto">Despesas</span><strong class="num">${Rp(saidas, "−")}</strong></div>
      <div><span class="nota-texto">Resultado</span><strong class="num ${entradas - saidas >= 0 ? "entrada" : "sobe"}">${Rp(Math.abs(entradas - saidas), entradas - saidas >= 0 ? "+" : "−")}</strong></div>
    </div>
    <div class="nota-texto" style="margin:0 2px 4px">${txs.length} lançamento(s)${valorNaCategoria && catF !== "nula" ? ` · ${Rp(saidas)} em ${esc(nomeCat)}` : ""}. Movimentos entre contas, faturas e investimentos aparecem em cinza e não entram nas somas.</div>
    ${[...porDia.entries()].map(([dia, lista]) => {
      const e = somaTipo(lista, "receita"), sd = somaTipo(lista, "despesa");
      return `<div class="dia"><span>${dataLonga(dia)}</span><span class="num">${e ? `<span class="entrada">${Rp(e, "+")}</span>` : ""}${e && sd ? " · " : ""}${sd ? `−${R(sd)}` : ""}</span></div>
      <div class="cartao" style="padding:2px 14px"><ul class="lista">
      ${lista.map((t) => {
        const nota = t.nota_transacao[0]?.notas;
        const tipo = tipoLancamento(t);
        const vCat = valorNaCategoria?.get(t.id);
        return `<li class="linha" data-acao="abrirTransacao" data-id="${esc(t.id)}">
          <div class="corpo">
            <div class="titulo">${nota ? ICONE_NOTA + " " : ""}${esc(nota?.nome_emitente || t.descricao)}</div>
            <div class="meta">${esc(t.contas?.apelido || t.contas?.nome || "")}${t.parcelas_total > 1 ? ` · ${t.parcela_numero}/${t.parcelas_total}` : ""}${t.status === "PENDING" ? " · pendente" : ""} ${chipCategoria(t.categoria_id)}</div>
          </div>
          <div class="valor num ${tipo === "receita" ? "entrada" : tipo === "neutro" ? "neutro" : ""}">${t.sentido === "entrada" ? Rp(t.valor, "+") : `−${R(t.valor)}`}${vCat != null && Math.abs(vCat - t.valor) > 0.01 ? `<div class="nota-texto" style="text-align:right">${R(vCat)} aqui</div>` : ""}</div>
        </li>`;
      }).join("")}
      </ul></div>`;
    }).join("")}`;
}
acoes.filtroGastos = (el) => { estado.filtroGastos = el.dataset.f; recarregar(); };
acoes.limparCategoria = () => { estado.categoriaFiltro = null; recarregar(); };

acoes.abrirTransacao = (el) => abrirTransacao(el.dataset.id);
async function abrirTransacao(id) {
  abrirFolha(carregando());
  const t = await q(sb.from("transacoes")
    .select("*, contas(apelido, nome, tipo), nota_transacao(nota_id, origem, notas(id, nome_emitente, valor_pago, emissao))")
    .eq("id", id).single());
  const d0 = new Date(t.data + "T12:00:00");
  const de = new Date(d0.getTime() - 15 * 86400000).toISOString();
  const ate = new Date(d0.getTime() + 4 * 86400000).toISOString();
  const notasLivres = t.sentido === "saida" ? await q(sb.from("notas").select("id, nome_emitente, valor_pago, emissao")
    .in("vinculo_status", ["pendente", "confirmar"]).gte("emissao", de).lte("emissao", ate).order("emissao", { ascending: false }).limit(30)) : [];
  notasLivres.sort((a, b) => Math.abs(a.valor_pago - t.valor) - Math.abs(b.valor_pago - t.valor));
  const [dividasAtivas, pagamentoDivida] = t.sentido === "saida" ? await Promise.all([
    q(sb.from("dividas").select("id, nome").eq("ativa", true).eq("origem", "manual").order("nome")).catch(() => []),
    q(sb.from("divida_pagamentos").select("id, dividas(nome)").eq("transacao_id", t.id).maybeSingle()).catch(() => null),
  ]) : [[], null];

  abrirFolha(`
    <h2 style="margin-right:40px">${esc(t.descricao)}</h2>
    <div class="destaque" style="margin:8px 0 12px"><div class="valor num">${t.sentido === "entrada" ? Rp(t.valor, "+") : R(t.valor)}</div></div>
    <dl class="kv">
      <dt>Data</dt><dd>${dataCurta(t.data)}${t.status === "PENDING" ? " (pendente)" : ""}</dd>
      <dt>Conta</dt><dd>${esc(t.contas?.apelido || t.contas?.nome)}</dd>
      ${t.parcelas_total > 1 ? `<dt>Parcela</dt><dd>${t.parcela_numero} de ${t.parcelas_total}</dd>` : ""}
      ${t.tipo_operacao ? `<dt>Tipo</dt><dd>${esc(t.tipo_operacao)}</dd>` : ""}
      ${t.recebedor_nome ? `<dt>Para</dt><dd>${esc(t.recebedor_nome)}</dd>` : ""}
    </dl>
    <div class="cartao" style="margin-top:14px">
      <h3>Categoria</h3>
      ${seletorCategoria(t.categoria_id, `id="catTx"`, t.sentido)}
      <label class="check"><input type="checkbox" id="aprenderTx" checked> Usar esta categoria também para lançamentos parecidos (mesma descrição)</label>
      ${t.nota_transacao.length ? `<p class="nota-texto">Este gasto tem nota fiscal: nos resumos, o valor é dividido pelas categorias dos itens.</p>` : ""}
      <button class="botao peq" data-acao="salvarCategoriaTx" data-id="${esc(t.id)}">Salvar categoria</button>
    </div>
    <div class="cartao">
      <h3>Nota fiscal</h3>
      ${t.nota_transacao.length ? t.nota_transacao.map((v) => `
        <div class="linha" style="cursor:default"><div class="corpo" data-acao="abrirNota" data-id="${v.nota_id}" style="cursor:pointer">
          <div class="titulo">${ICONE_NOTA} ${esc(v.notas?.nome_emitente ?? "Nota")}</div>
          <div class="meta">${dataHora(v.notas?.emissao)} · ${R(v.notas?.valor_pago)}${v.origem === "parcela" ? " · parcela" : ""}</div></div>
          <button class="botao peq sec" data-acao="desvincular" data-nota="${v.nota_id}" data-tx="${esc(t.id)}">Desligar</button></div>`).join("")
        : `<p class="nota-texto">Nenhuma nota ligada.</p>`}
      ${notasLivres.length ? `<details style="margin-top:8px"><summary class="nota-texto" style="cursor:pointer">Ligar a uma nota escaneada (${notasLivres.length})</summary>
        ${notasLivres.map((n) => `<div class="candidato"><div class="corpo"><div class="titulo">${esc(n.nome_emitente ?? "Nota")}</div>
          <div class="meta nota-texto">${dataHora(n.emissao)} · ${R(n.valor_pago)}</div></div>
          <button class="botao peq" data-acao="vincular" data-nota="${n.id}" data-tx="${esc(t.id)}">Ligar</button></div>`).join("")}</details>` : ""}
    </div>
    ${pagamentoDivida ? `<div class="cartao"><h3>Dívida</h3><p class="nota-texto">Este lançamento é pagamento de <strong>${esc(pagamentoDivida.dividas?.nome)}</strong>.</p></div>`
      : dividasAtivas.length ? `<details class="cartao"><summary class="nota-texto" style="cursor:pointer">É pagamento de dívida?</summary>
      <label class="campo"><span>Dívida</span><select id="dvLigar"><option value="">Escolha…</option>${dividasAtivas.map((d) => `<option value="${d.id}">${esc(d.nome)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="dvAprender" checked> Reconhecer sozinho os próximos pagamentos com esta descrição</label>
      <button class="botao peq" data-acao="ligarDivida" data-tx="${esc(t.id)}">Registrar pagamento</button></details>` : ""}
    <div class="cartao">
      <h3>Observação</h3>
      <textarea id="obsTx" rows="2" placeholder="Ex.: presente de aniversário">${esc(t.observacao ?? "")}</textarea>
      <div class="botoes"><button class="botao peq sec" data-acao="salvarObs" data-id="${esc(t.id)}">Salvar observação</button></div>
    </div>`);
}
acoes.salvarCategoriaTx = async (el) => {
  const cat = $("#catTx").value ? Number($("#catTx").value) : null;
  el.disabled = true;
  try {
    if (cat == null) {
      await q(sb.from("transacoes").update({ categoria_id: null, categoria_origem: null }).eq("id", el.dataset.id));
      avisar("Categoria removida");
    } else {
      const r = await fn("/categorizar-transacao", { transacao_id: el.dataset.id, categoria_id: cat, aprender: $("#aprenderTx").checked });
      avisar(r.outros_atualizados ? `Salvo. Mais ${r.outros_atualizados} lançamento(s) parecido(s) atualizado(s).` : "Categoria salva");
    }
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.salvarObs = async (el) => {
  try {
    await q(sb.from("transacoes").update({ observacao: $("#obsTx").value.trim() || null }).eq("id", el.dataset.id));
    avisar("Observação salva");
  } catch (e) { avisar(e.message, true); }
};
acoes.vincular = async (el) => {
  el.disabled = true;
  try {
    await fn("/vincular", { nota_id: el.dataset.nota, transacao_id: el.dataset.tx });
    avisar("Nota ligada ao gasto");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.desvincular = async (el) => {
  el.disabled = true;
  try {
    await fn("/desvincular", { nota_id: el.dataset.nota, transacao_id: el.dataset.tx });
    avisar("Nota desligada");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ ESCANEAR
const FILA = "filaNotas";
/** Fila de notas escaneadas sem internet: [{texto, em}] (versões antigas guardavam só o texto). */
function lerFila() {
  try { return JSON.parse(localStorage.getItem(FILA) ?? "[]").map((x) => (typeof x === "string" ? { texto: x, em: Date.now() } : x)); }
  catch { return []; }
}
/** Número da nota a partir da chave de 44 dígitos do QR (para mostrar na fila). */
function numeroDaChave(texto) {
  const m = String(texto).replace(/\s/g, "").match(/\d{44}/);
  return m ? String(Number(m[0].slice(25, 34))) : null;
}
function guardarNaFila(texto) {
  const fila = lerFila();
  const chave = String(texto).replace(/\s/g, "").match(/\d{44}/)?.[0];
  if (fila.some((x) => x.texto === texto || (chave && x.texto.replace(/\s/g, "").includes(chave)))) return false;
  gravarFila([...fila, { texto, em: Date.now() }]);
  return true;
}
function cartaoFila(fila) {
  if (!fila.length) return "";
  return `<div class="cartao cartao-fila"><div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo">
    <div class="titulo">${fila.length} nota(s) aguardando internet</div>
    <div class="meta">Serão enviadas à SEFAZ assim que a conexão voltar</div></div>
    ${navigator.onLine ? `<button class="botao peq" data-acao="enviarFila">Enviar agora</button>` : `<span class="chip alerta">offline</span>`}</div>
    <ul class="lista">${fila.map((x) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${numeroDaChave(x.texto) ? `Nota nº ${esc(numeroDaChave(x.texto))}` : "Nota fiscal"}</div>
      <div class="meta">escaneada ${dataHora(new Date(x.em).toISOString())}</div></div></li>`).join("")}</ul></div>`;
}
function gravarFila(f) { try { localStorage.setItem(FILA, JSON.stringify(f)); } catch { /* sem armazenamento */ } }

async function telaEscanear() {
  const fila = lerFila();
  app.innerHTML = `
    <div class="topo"><h1>Escanear nota</h1></div>
    <div class="scanner"><video playsinline muted></video><div class="mira"></div><div class="status" id="statusLeitor">Abrindo a câmera…</div></div>
    <div class="botoes">
      <button class="botao sec" id="btLanterna" data-acao="lanterna" hidden>Lanterna</button>
      <button class="botao sec" data-acao="digitarQr">Colar link ou chave</button>
    </div>
    <div style="margin-top:12px">${cartaoFila(fila)}</div>
    <p class="nota-texto" style="margin-top:12px">Aponte para o QR code no rodapé da nota fiscal (NFC-e). O app busca os itens na SEFAZ, categoriza e liga a nota ao gasto do banco quando ele aparecer.</p>`;
  const video = $("video", app);
  const status = $("#statusLeitor");
  try {
    estado.leitor = await iniciarLeitor(video, (texto) => enviarNota(texto), (s) => (status.textContent = s));
    if (estado.leitor.temLanterna) $("#btLanterna").hidden = false;
  } catch (e) {
    status.textContent = e.name === "NotAllowedError" ? "Permita o uso da câmera para escanear" : "Não consegui abrir a câmera";
  }
}
let lanternaLigada = false;
acoes.lanterna = () => { lanternaLigada = !lanternaLigada; estado.leitor?.lanterna(lanternaLigada); };
acoes.digitarQr = () => {
  abrirFolha(`<h2>Colar link ou chave</h2>
    <p class="nota-texto">Cole o endereço do QR code ou a chave de acesso de 44 dígitos.</p>
    <textarea id="textoQr" rows="4" placeholder="https://… ou 4326 0904 …"></textarea>
    <div class="botoes"><button class="botao cheio" data-acao="enviarDigitado">Buscar nota</button></div>`);
  setTimeout(() => $("#textoQr")?.focus(), 50);
};
acoes.enviarDigitado = () => {
  const t = $("#textoQr").value.trim();
  if (!t) return;
  fecharFolha();
  pararLeitor();
  enviarNota(t);
};

async function enviarNota(texto) {
  if (!navigator.onLine) return guardarOffline(texto);
  app.innerHTML = `<div class="topo"><h1>Escanear nota</h1></div>
    <div class="cartao" style="text-align:center;padding:40px 16px"><div class="spinner"></div>
    <p>Consultando a nota na SEFAZ…</p><p class="nota-texto">Isso leva alguns segundos.</p></div>`;
  try {
    const r = await fn("/nfce", { texto });
    if (r.duplicada) avisar("Esta nota já tinha sido escaneada");
    telaPosLeitura(r.nota);
    abrirNota(r.nota.id, r);
  } catch (e) {
    if (e.rede || !navigator.onLine) return guardarOffline(texto);
    avisar(e.message, true);
    telaPosLeitura(null);
  }
}
function guardarOffline(texto) {
  const nova = guardarNaFila(texto);
  avisar(nova ? "Sem internet: nota guardada, será enviada quando a conexão voltar" : "Esta nota já está na fila");
  app.innerHTML = `<div class="topo"><h1>Escanear nota</h1></div>
    <div class="cartao" style="text-align:center;padding:24px 16px"><h2 style="margin:0 0 6px">Nota guardada</h2>
    <p class="nota-texto" style="margin:0">Sem internet agora. Assim que a conexão voltar, o app consulta a SEFAZ, categoriza os itens e liga a nota ao gasto — sozinho.</p></div>
    ${cartaoFila(lerFila())}
    <button class="botao cheio" data-acao="escanearOutra">Escanear outra nota</button>`;
}
function telaPosLeitura(nota) {
  app.innerHTML = `<div class="topo"><h1>Escanear nota</h1></div>
    ${nota ? `<div class="cartao" data-acao="abrirNota" data-id="${nota.id}" style="cursor:pointer">
      <div class="nota-texto">Última nota</div><h2>${esc(nota.nome_emitente ?? "Nota fiscal")}</h2>
      <div class="meta nota-texto">${dataHora(nota.emissao)} · ${R(nota.valor_pago)}</div></div>` : ""}
    <button class="botao cheio" data-acao="escanearOutra">Escanear outra nota</button>`;
}
acoes.escanearOutra = () => irPara("escanear");

let processandoFila = false;
async function processarFila() {
  if (processandoFila || !navigator.onLine || !lerFila().length) return;
  processandoFila = true;
  let enviadas = 0;
  const falhas = [];
  try {
    for (const item of lerFila()) {
      try {
        await fn("/nfce", { texto: item.texto });
        enviadas++;
      } catch (e) {
        if (e.rede) break;                 // caiu de novo: tenta depois
        falhas.push(e.message);            // nota inválida: sai da fila e avisa
      }
      gravarFila(lerFila().filter((x) => x.texto !== item.texto));
    }
  } finally { processandoFila = false; }
  if (enviadas) avisar(`${enviadas} nota(s) guardada(s) offline foram processadas`);
  if (falhas.length) avisar(`${falhas.length} nota(s) da fila não puderam ser lidas: ${falhas[0]}`, true);
  if ((enviadas || falhas.length) && ["inicio", "notas", "escanear"].includes(estado.aba) && folha.hidden) recarregar();
}
acoes.enviarFila = async () => { await processarFila(); recarregar(); };
window.addEventListener("online", processarFila);
document.addEventListener("visibilitychange", () => { if (!document.hidden) processarFila(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && estado.aba === "escanear") pararLeitor(); });

// ------------------------------------------------------------------ NOTAS
async function telaNotas() {
  const f = estado.filtroNotas;
  app.innerHTML = `<div class="topo"><h1>Notas fiscais</h1></div>
    <div class="filtros">${[["confirmar", "Para confirmar"], ["pendente", "Aguardando gasto"], ["vinculada", "Ligadas"], ["erro", "Com erro"], ["todas", "Todas"]]
      .map(([k, n]) => `<button class="filtro ${f === k ? "ativo" : ""}" data-acao="filtroNotas" data-f="${k}">${n}<span id="cont-${k}"></span></button>`).join("")}</div>
    ${cartaoFila(lerFila())}
    <div id="conteudo">${carregando()}</div>`;
  const todasNotas = await q(sb.from("notas")
    .select("id, nome_emitente, emissao, valor_pago, vinculo_status, consulta_status, consulta_erro, criado_em, nota_itens(count)")
    .order("criado_em", { ascending: false }).limit(500));
  const filtro = {
    confirmar: (n) => n.vinculo_status === "confirmar" && n.consulta_status === "ok",
    pendente: (n) => n.vinculo_status === "pendente" && n.consulta_status === "ok",
    vinculada: (n) => n.vinculo_status === "vinculada",
    erro: (n) => n.consulta_status !== "ok",
    todas: () => true,
  };
  for (const k of ["confirmar", "pendente", "erro"]) {
    const c = todasNotas.filter(filtro[k]).length;
    const el = $(`#cont-${k}`);
    if (el && c) el.textContent = ` · ${c}`;
  }
  const lista = todasNotas.filter(filtro[f]);
  const vazio = {
    confirmar: "Nenhuma nota esperando confirmação.",
    pendente: "Nenhuma nota aguardando o gasto aparecer no banco.",
    vinculada: "Nenhuma nota ligada ainda.",
    erro: "Nenhuma nota com erro de leitura.",
    todas: "Nenhuma nota escaneada ainda. Toque no botão do meio para escanear.",
  }[f];
  $("#conteudo").innerHTML = lista.length ? `<div class="cartao" style="padding:2px 14px"><ul class="lista">${lista.map((n) => `
    <li class="linha" data-acao="abrirNota" data-id="${n.id}">
      <div class="corpo"><div class="titulo">${esc(n.nome_emitente ?? "Nota fiscal")}</div>
      <div class="meta">${dataHora(n.emissao ?? n.criado_em)} · ${n.nota_itens?.[0]?.count ?? 0} itens ${statusNota(n)}</div></div>
      <div class="valor num">${n.valor_pago != null ? R(n.valor_pago) : "—"}</div></li>`).join("")}</ul></div>`
    : `<div class="vazio"><strong>Tudo certo</strong>${vazio}</div>`;
}
function statusNota(n) {
  if (n.consulta_status !== "ok") return `<span class="chip alerta">erro na leitura</span>`;
  return {
    vinculada: `<span class="chip ok">ligada</span>`,
    confirmar: `<span class="chip alerta">confirmar gasto</span>`,
    pendente: `<span class="chip">aguardando banco</span>`,
    ignorada: `<span class="chip">sem gasto</span>`,
  }[n.vinculo_status] ?? "";
}
acoes.filtroNotas = (el) => { estado.filtroNotas = el.dataset.f; recarregar(); };

acoes.abrirNota = (el) => abrirNota(el.dataset.id);
async function abrirNota(id, dados) {
  if (!dados) abrirFolha(carregando());
  const r = dados ?? await fn("/nota", { nota_id: id });
  const n = r.nota;
  const itens = [...(n.nota_itens ?? [])].sort((a, b) => a.ordem - b.ordem);
  const idsTx = (n.nota_transacao ?? []).map((v) => v.transacao_id);
  const txs = idsTx.length ? await q(sb.from("transacoes").select("id, data, descricao, valor, contas(apelido, nome)").in("id", idsTx)) : [];

  // Resumo por categoria dos itens
  const porCat = new Map();
  for (const i of itens) porCat.set(i.categoria_id, (porCat.get(i.categoria_id) ?? 0) + Number(i.valor_total));
  const somaItens = itens.reduce((s, i) => s + Number(i.valor_total), 0) || 1;

  let blocoVinculo = "";
  if (n.consulta_status !== "ok") {
    blocoVinculo = `<div class="cartao"><h3>Leitura da nota</h3><p class="erro-texto">${esc(n.consulta_erro ?? "Não foi possível ler a nota.")}</p>
      <p class="nota-texto">A SEFAZ às vezes fica fora do ar. Tente de novo mais tarde.</p>
      <button class="botao peq" data-acao="reconsultar" data-id="${n.id}">Tentar de novo</button></div>`;
  } else if (n.vinculo_status === "vinculada") {
    blocoVinculo = `<div class="cartao"><h3>Gasto ligado</h3>${txs.map((t) => `
      <div class="linha" style="cursor:default"><div class="corpo" data-acao="abrirTransacao" data-id="${esc(t.id)}" style="cursor:pointer"><div class="titulo">${esc(t.descricao)}</div>
      <div class="meta">${dataCurta(t.data)} · ${esc(t.contas?.apelido || t.contas?.nome)}</div></div>
      <div class="valor num">${R(t.valor)}</div></div>
      <div class="botoes" style="margin-top:0"><button class="botao peq sec" data-acao="desvincular" data-nota="${n.id}" data-tx="${esc(t.id)}">Desligar</button></div>`).join("")}</div>`;
  } else if (n.vinculo_status === "ignorada") {
    blocoVinculo = `<div class="cartao"><h3>Gasto</h3><p class="nota-texto">Você marcou que esta nota não tem gasto correspondente.</p>
      <button class="botao peq sec" data-acao="ignorarNota" data-id="${n.id}" data-ignorar="0">Voltar a procurar</button></div>`;
  } else {
    const cands = r.candidatos ?? [];
    const fortes = cands.filter((c) => c.forte), outros = cands.filter((c) => !c.forte);
    const linhaCand = (c) => `<div class="candidato ${c.forte ? "forte" : ""}"><div class="corpo">
        <div class="titulo">${esc(c.descricao)}</div>
        <div class="meta nota-texto">${dataCurta(c.data)} · ${esc(c.conta ?? "")} · ${R(c.valor)}${c.motivos?.length ? ` · ${esc(c.motivos.join(", "))}` : ""}</div></div>
        <button class="botao peq" data-acao="vincular" data-nota="${n.id}" data-tx="${esc(c.transacao_id)}">É este</button></div>`;
    blocoVinculo = `<div class="cartao"><h3>Qual gasto é esta nota?</h3>
      ${fortes.length ? fortes.map(linhaCand).join("") : `<p class="nota-texto">O gasto de ${R(n.valor_pago)} ainda não apareceu no banco. Quando aparecer (o app sincroniza 2 vezes por dia), a ligação é feita sozinha.</p>`}
      ${outros.length ? `<details style="margin-top:10px"><summary class="nota-texto" style="cursor:pointer">Valores parecidos (${outros.length})</summary>${outros.map(linhaCand).join("")}</details>` : ""}
      <div class="botoes"><button class="botao peq sec" data-acao="ignorarNota" data-id="${n.id}" data-ignorar="1">Não tem gasto (ignorar)</button></div></div>`;
  }

  abrirFolha(`
    <h2 style="margin-right:40px">${esc(n.nome_emitente ?? "Nota fiscal")}</h2>
    <div class="nota-texto">${n.cnpj_emitente ? `CNPJ ${cnpjFmt(n.cnpj_emitente)}` : ""}${n.endereco ? ` · ${esc(n.endereco)}` : ""}</div>
    <div class="destaque" style="margin:10px 0"><div class="valor num">${n.valor_pago != null ? R(n.valor_pago) : "—"}</div>
      <div class="compara">${dataHora(n.emissao)}${n.forma_pagamento ? ` · ${esc(n.forma_pagamento)}` : ""}${Number(n.desconto) > 0 ? ` · desconto ${R(n.desconto)}` : ""}</div></div>
    ${blocoVinculo}
    ${itens.length ? `<div class="cartao"><h3>Categorias desta nota</h3>
      ${[...porCat.entries()].sort((a, b) => b[1] - a[1]).map(([cid, v]) => {
        const c = estado.catPorId[cid]; const cor = c?.cor ?? "#8a8f98";
        return `<div class="barra-cat" style="cursor:default"><div class="nome"><span class="ponto" style="background:${esc(cor)}"></span><span>${esc(c?.nome ?? "Sem categoria")}</span></div>
          <div class="num">${R(v)}</div><div class="trilho"><i style="width:${(v / somaItens) * 100}%;background:${esc(cor)}"></i></div></div>`;
      }).join("")}</div>
    <div class="cartao"><h3>Itens (${itens.length})</h3>
      ${itens.map((i) => `<div class="item-nota">
        <div class="l1"><span>${esc(i.descricao)}</span><span class="num">${R(i.valor_total)}</span></div>
        <div class="l2"><span>${i.quantidade != null ? `${String(i.quantidade).replace(".", ",")} ${esc(i.unidade ?? "")}` : ""}${i.valor_unitario != null ? ` × ${R(i.valor_unitario)}` : ""}</span>
        ${seletorCategoria(i.categoria_id, `data-muda="categoriaItem" data-id="${i.id}" aria-label="Categoria do item"`)}</div></div>`).join("")}
      <p class="nota-texto">Ao trocar a categoria de um item, os itens iguais das próximas notas seguem a mesma escolha.</p></div>` : ""}
    <div class="botoes"><button class="botao perigo peq" data-acao="excluirNota" data-id="${n.id}">Excluir nota</button></div>`);
}
mudancas.categoriaItem = async (el) => {
  const cat = el.value ? Number(el.value) : null;
  if (cat == null) return;
  el.disabled = true;
  try {
    const r = await fn("/categorizar-item", { item_id: Number(el.dataset.id), categoria_id: cat, aprender: true });
    avisar(r.notas_afetadas > 1 ? `Salvo e aplicado em ${r.notas_afetadas} notas` : "Categoria do item salva");
  } catch (e) { avisar(e.message, true); }
  el.disabled = false;
};
acoes.reconsultar = async (el) => {
  el.disabled = true;
  el.innerHTML = `<span class="spinner peq"></span> Consultando`;
  try { const r = await fn("/nfce/reconsultar", { nota_id: el.dataset.id }); abrirNota(el.dataset.id, r); }
  catch (e) { avisar(e.message, true); el.disabled = false; el.textContent = "Tentar de novo"; }
};
acoes.ignorarNota = async (el) => {
  try {
    await fn("/ignorar-nota", { nota_id: el.dataset.id, ignorar: el.dataset.ignorar === "1" });
    abrirNota(el.dataset.id);
    if (estado.aba === "notas") telaNotas();
  } catch (e) { avisar(e.message, true); }
};
acoes.excluirNota = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Toque de novo para excluir"; return; }
  try {
    await q(sb.from("notas").delete().eq("id", el.dataset.id));
    avisar("Nota excluída");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); }
};

// ------------------------------------------------------------------ MAIS
async function telaMais() {
  app.innerHTML = `<div class="topo"><h1>Mais</h1></div><div id="conteudo">${carregando()}</div>`;
  const [cfg, itens, contas, logs, membros, regras] = await Promise.all([
    fn("/config", null, "GET").catch((e) => ({ erro: e.message })),
    q(sb.from("pluggy_itens").select("*").order("criado_em")),
    q(sb.from("contas").select("*").order("tipo").order("nome")),
    q(sb.from("sync_log").select("*").order("inicio", { ascending: false }).limit(8)),
    q(sb.from("membros").select("*").order("criado_em")),
    q(sb.from("regras_categoria").select("id, alvo, tipo, padrao, origem, categoria_id").neq("origem", "sistema").order("criado_em", { ascending: false }).limit(200)),
  ]);
  const ultimo = logs[0];

  $("#conteudo").innerHTML = `
    <div class="cartao">
      <div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">Open Finance</div>
      <div class="meta">${ultimo ? `Última: ${haQuanto(ultimo.fim ?? ultimo.inicio)}${ultimo.ok === false ? ` · <span class="erro-texto">${esc(ultimo.mensagem ?? "")}</span>` : ""}` : "Nunca sincronizado"}</div></div>
      <button class="botao peq" data-acao="sincronizar">Sincronizar</button></div>
    </div>

    <div class="cartao"><div class="linha" data-acao="irPatrimonio" data-s="investimentos"><div class="corpo"><div class="titulo">Patrimônio</div>
      <div class="meta">Investimentos, caixinhas e dívidas</div></div><span class="chip">abrir</span></div></div>
    <div class="cartao"><div class="linha" data-acao="irSugestoes"><div class="corpo"><div class="titulo">Sugestões e plano</div>
      <div class="meta">Gasto ideal para a renda, onde economizar e como sair das dívidas</div></div><span class="chip">abrir</span></div></div>

    <details class="secao" ${!cfg.pluggy_configurado || !itens.length ? "open" : ""}><summary>Open Finance (Pluggy)</summary><div class="conteudo">
      <p class="nota-texto">${cfg.pluggy_configurado ? `Credenciais salvas (Client ID terminando em ${esc(cfg.pluggy_client_id_fim)}).` : "Cole as credenciais da sua aplicação no dashboard.pluggy.ai (aba Aplicação)."}</p>
      <label class="campo"><span>Client ID</span><input type="text" id="pgId" autocomplete="off" placeholder="${cfg.pluggy_configurado ? "(salvo — preencha só para trocar)" : ""}"></label>
      <label class="campo"><span>Client Secret</span><input type="password" id="pgSecret" autocomplete="off" placeholder="${cfg.pluggy_configurado ? "(salvo — preencha só para trocar)" : ""}"></label>
      <button class="botao peq" data-acao="salvarPluggy">Salvar e testar</button>
      <h3 style="margin-top:18px">Conexões (bancos)</h3>
      ${itens.length ? `<ul class="lista">${itens.map((i) => `<li class="linha" style="cursor:default"><div class="corpo">
        <div class="titulo">${esc(i.nome || i.conector || "Conexão")}</div>
        <div class="meta">${esc(i.id.slice(0, 8))}… · ${esc(i.status ?? "")} · ${i.ultimo_sync ? haQuanto(i.ultimo_sync) : "não sincronizada"}</div>
        ${i.ultimo_erro ? `<div class="erro-texto">${esc(i.ultimo_erro)}</div>` : ""}</div>
        <button class="botao peq perigo" data-acao="removerItem" data-id="${esc(i.id)}">Remover</button></li>`).join("")}</ul>`
        : `<p class="nota-texto">Nenhuma conexão. No dashboard da Pluggy, depois de conectar o "MeuPluggy", copie o ID da conexão (Item ID) e cole abaixo.</p>`}
      <label class="campo"><span>ID da conexão (Item ID)</span><input type="text" id="itemId" autocomplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></label>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="adicionarItem">Adicionar</button>
      <button class="botao peq sec" data-acao="descobrirItens">Procurar automaticamente</button></div>
    </div></details>

    <details class="secao"><summary>Contas e cartões (${contas.length})</summary><div class="conteudo">
      ${contas.length ? contas.map((c) => `<label class="campo"><span>${esc(c.nome)} · ${c.tipo === "CREDIT" ? "cartão" : "conta"}${c.numero ? ` ${esc(c.numero)}` : ""}${c.saldo != null ? ` · ${c.tipo === "CREDIT" ? "fatura" : "saldo"} ${R(Math.abs(c.saldo))}` : ""}</span>
        <input type="text" value="${esc(c.apelido ?? "")}" placeholder="Apelido (ex.: Itaú, Nubank cartão)" data-muda="apelidoConta" data-id="${esc(c.id)}"></label>`).join("")
        : `<p class="nota-texto">As contas aparecem depois da primeira sincronização.</p>`}
    </div></details>

    <details class="secao"><summary>Regras e categorias</summary><div class="conteudo">
      <p class="nota-texto">O app já vem com regras para mercados, farmácias, combustível, apps de transporte etc. Crie regras próprias para o que for só de vocês.</p>
      <label class="campo"><span>Quando a descrição contém</span><input type="text" id="regraTexto" placeholder="Ex.: PIX TRANSF MARIA"></label>
      <div style="display:flex;gap:8px">
        <label class="campo" style="flex:1"><span>Em</span><select id="regraAlvo"><option value="transacao">Lançamentos do banco</option><option value="item">Itens de nota</option></select></label>
        <label class="campo" style="flex:1"><span>Categoria</span>${seletorCategoria(null, `id="regraCat"`)}</label>
      </div>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="criarRegra">Criar regra</button>
      <button class="botao peq sec" data-acao="reaplicarRegras">Reaplicar regras a tudo</button></div>
      ${regras.length ? `<h3 style="margin-top:18px">Regras suas e aprendidas (${regras.length})</h3><ul class="lista">${regras.map((r) => `
        <li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(r.tipo === "exato" ? r.padrao : r.padrao.replace(/\\/g, ""))}</div>
        <div class="meta">${r.alvo === "item" ? "item de nota" : "lançamento"} · ${r.origem} ${chipCategoria(r.categoria_id)}</div></div>
        <button class="botao peq sec" data-acao="apagarRegra" data-id="${r.id}" aria-label="Apagar regra">✕</button></li>`).join("")}</ul>` : ""}
      <h3 style="margin-top:18px">Nova categoria</h3>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label class="campo" style="flex:2"><span>Nome</span><input type="text" id="catNome" placeholder="Ex.: Filhos"></label>
        <label class="campo" style="flex:1"><span>Grupo</span><input type="text" id="catGrupo" placeholder="Família"></label>
        <label class="campo" style="flex:0 0 52px"><span>Cor</span><input type="color" id="catCor" value="#4b8f8c" style="height:44px;width:52px;padding:2px;border-radius:10px;border:1px solid var(--borda)"></label>
      </div>
      <button class="botao peq" data-acao="criarCategoria">Adicionar categoria</button>
    </div></details>

    <details class="secao"><summary>Categorização com IA (opcional)</summary><div class="conteudo">
      <p class="nota-texto">Itens que nenhuma regra reconhece podem ser classificados pelo Claude (custa centavos por mês). Crie uma chave em console.anthropic.com.</p>
      <p class="nota-texto">${cfg.anthropic_configurado ? "✓ Chave configurada." : "Nenhuma chave configurada."}</p>
      <label class="campo"><span>Chave da API Anthropic</span><input type="password" id="chaveIA" autocomplete="off" placeholder="sk-ant-…"></label>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="salvarIA">Salvar</button>
      ${cfg.anthropic_configurado ? `<button class="botao peq perigo" data-acao="removerIA">Remover</button>` : ""}</div>
    </div></details>

    <details class="secao"><summary>Quem tem acesso (${membros.length})</summary><div class="conteudo">
      <ul class="lista">${membros.map((m) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(m.email)}</div></div>
        ${m.email !== estado.email ? `<button class="botao peq perigo" data-acao="removerMembro" data-email="${esc(m.email)}">Remover</button>` : `<span class="chip">você</span>`}</li>`).join("")}</ul>
      <label class="campo"><span>Adicionar e-mail</span><input type="email" id="novoMembro" placeholder="email@exemplo.com"></label>
      <button class="botao peq" data-acao="adicionarMembro">Dar acesso</button>
      <p class="nota-texto">A pessoa cria a conta no app com este e-mail e passa a ver os mesmos dados.</p>
    </div></details>

    <details class="secao"><summary>Histórico de sincronização</summary><div class="conteudo"><ul class="lista">
      ${logs.map((l) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${dataHora(l.inicio)} · ${esc(l.origem ?? "")}</div>
        <div class="meta">${l.ok ? `${l.novas} novos · ${l.vinculadas} notas ligadas` : `<span class="erro-texto">${esc(l.mensagem ?? "em andamento")}</span>`}</div></div></li>`).join("") || "<li class='nota-texto'>Nada ainda.</li>"}
    </ul></div></details>

    <div class="cartao plano"><div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(estado.email)}</div><div class="meta">Versão ${VERSAO}</div></div>
      <button class="botao peq sec" data-acao="sair">Sair</button></div></div>`;
}
acoes.salvarPluggy = async (el) => {
  const corpo = {};
  const id = $("#pgId").value.trim(), sec = $("#pgSecret").value.trim();
  if (id) corpo.pluggy_client_id = id;
  if (sec) corpo.pluggy_client_secret = sec;
  if (!id && !sec) return avisar("Preencha o Client ID e o Client Secret", true);
  el.disabled = true;
  try {
    const r = await fn("/config", corpo);
    if (r.pluggy_teste === false) avisar(r.pluggy_erro ?? "A Pluggy recusou as credenciais", true);
    else avisar(r.pluggy_teste ? "Credenciais testadas e salvas ✓" : "Salvo");
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.adicionarItem = async (el) => {
  const id = $("#itemId").value.trim();
  if (!id) return;
  el.disabled = true;
  try { const r = await fn("/itens", { id, acao: "adicionar" }); avisar(`Conexão adicionada (${r.conector ?? "ok"})`); recarregar(); }
  catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.removerItem = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Confirmar"; return; }
  try { await fn("/itens", { id: el.dataset.id, acao: "remover" }); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.descobrirItens = async (el) => {
  el.disabled = true;
  try { const r = await fn("/descobrir-itens"); avisar(r.encontrados ? `${r.encontrados} conexão(ões) encontrada(s)` : (r.aviso ?? "Nenhuma encontrada"), !r.encontrados); recarregar(); }
  catch (e) { avisar(e.message, true); el.disabled = false; }
};
mudancas.apelidoConta = async (el) => {
  try { await q(sb.from("contas").update({ apelido: el.value.trim() || null }).eq("id", el.dataset.id)); avisar("Apelido salvo"); }
  catch (e) { avisar(e.message, true); }
};
acoes.criarRegra = async () => {
  const texto = normalizar($("#regraTexto").value);
  const cat = Number($("#regraCat").value);
  if (!texto || !cat) return avisar("Preencha o texto e escolha a categoria", true);
  const padrao = texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const nat = estado.categorias.find((c) => c.id === cat)?.natureza;
    const sentido = $("#regraAlvo").value === "transacao" ? (nat === "receita" ? "entrada" : nat === "despesa" ? "saida" : null) : null;
    await q(sb.from("regras_categoria").insert({ alvo: $("#regraAlvo").value, tipo: "regex", padrao, categoria_id: cat, prioridade: 2, origem: "usuario", sentido }));
    const r = await fn("/recategorizar");
    avisar(`Regra criada · ${r.gastos_alterados} lançamento(s) e ${r.itens_alterados} item(ns) atualizados`);
    recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.reaplicarRegras = async (el) => {
  el.disabled = true;
  try { const r = await fn("/recategorizar"); avisar(`${r.gastos_alterados} lançamento(s) e ${r.itens_alterados} item(ns) atualizados`); }
  catch (e) { avisar(e.message, true); }
  el.disabled = false;
};
acoes.apagarRegra = async (el) => {
  try { await q(sb.from("regras_categoria").delete().eq("id", Number(el.dataset.id))); el.closest("li").remove(); avisar("Regra apagada"); }
  catch (e) { avisar(e.message, true); }
};
acoes.criarCategoria = async () => {
  const nome = $("#catNome").value.trim();
  if (!nome) return avisar("Dê um nome à categoria", true);
  try {
    await q(sb.from("categorias").insert({ nome, grupo: $("#catGrupo").value.trim() || "Outros", cor: $("#catCor").value, ordem: 85 }));
    await carregarCategorias();
    avisar("Categoria criada");
    recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.salvarIA = async () => {
  const k = $("#chaveIA").value.trim();
  if (!k) return;
  try { await fn("/config", { anthropic_key: k }); avisar("Chave salva"); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.removerIA = async () => {
  try { await fn("/config", { anthropic_key: "" }); avisar("Chave removida"); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.adicionarMembro = async () => {
  const email = $("#novoMembro").value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return avisar("E-mail inválido", true);
  try { await q(sb.from("membros").insert({ email })); avisar("Acesso liberado"); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.removerMembro = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Confirmar"; return; }
  try { await q(sb.from("membros").delete().eq("email", el.dataset.email)); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.sair = async () => { await apagarLocal(); await sb.auth.signOut().catch(() => {}); location.hash = ""; location.reload(); };

// ------------------------------------------------------------------ PATRIMÔNIO
// Investimentos (aplicações agrupadas em caixinhas) e dívidas.
const TIPOS_DIVIDA = { emprestimo: "Empréstimo", financiamento: "Financiamento", cartao: "Cartão", cheque_especial: "Cheque especial", pessoa: "Pessoa", outro: "Outro" };
const CORES_CAIXINHA = ["#2e9e5b", "#3b7dd8", "#e5813b", "#8e6fd8", "#d64545", "#37a3a3", "#c96f9d", "#9a7b4f"];

function variacaoTexto(v, base) {
  if (v == null || Math.abs(v) < 0.005) return `<span class="nota-texto">sem variação</span>`;
  const pct = base > 0 ? ` (${v > 0 ? "+" : ""}${((v / base) * 100).toFixed(2).replace(".", ",")}%)` : "";
  return `<span class="${v > 0 ? "desce" : "sobe"}">${v > 0 ? "+" : "−"}${Rp(Math.abs(v))}${pct}</span>`;
}

/** Gráfico de linha simples (uma série) com dica ao tocar/passar o dedo. */
function graficoLinha(pontos, rotulo) {
  if (pontos.length < 2) return "";
  const W = 600, H = 180, pe = 44, pd = 12, pt = 12, pb = 26;
  const vals = pontos.map((p) => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 0.01) { min -= 1; max += 1; }
  const folga = (max - min) * 0.1; min -= folga; max += folga;
  const x = (i) => pe + (i * (W - pe - pd)) / (pontos.length - 1);
  const y = (v) => pt + (1 - (v - min) / (max - min)) * (H - pt - pb);
  const d = pontos.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks = [min + folga, (min + max) / 2, max - folga];
  const casas = max - min < 30 ? 2 : 0;
  const fmtCurto = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const dados = esc(JSON.stringify(pontos.map((p, i) => ({ x: x(i), y: y(p.v), d: p.d, v: p.v }))));
  return `<div class="grafico" data-pontos="${dados}" data-rotulo="${esc(rotulo)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rotulo)}: de ${R(vals[0])} em ${dataCurta(pontos[0].d)} para ${R(vals.at(-1))} em ${dataCurta(pontos.at(-1).d)}">
      ${ticks.map((t) => `<line x1="${pe}" x2="${W - pd}" y1="${y(t)}" y2="${y(t)}" class="grade"/><text x="${pe - 6}" y="${y(t) + 4}" text-anchor="end" class="eixo priv-svg">${fmtCurto(t)}</text>`).join("")}
      <text x="${pe}" y="${H - 6}" class="eixo">${dataCurta(pontos[0].d).slice(0, 5)}</text>
      <text x="${W - pd}" y="${H - 6}" text-anchor="end" class="eixo">${dataCurta(pontos.at(-1).d).slice(0, 5)}</text>
      <path d="${d}" class="linha-serie"/>
      <line class="cursor" y1="${pt}" y2="${H - pb}" x1="0" x2="0" visibility="hidden"/>
      <circle class="marcador" r="5" visibility="hidden"/>
      <rect x="${pe}" y="0" width="${W - pe - pd}" height="${H}" fill="transparent" class="alvo"/>
    </svg>
    <div class="dica" hidden></div></div>`;
}
function ativarGraficos(raiz = document) {
  raiz.querySelectorAll(".grafico").forEach((g) => {
    const pts = JSON.parse(g.dataset.pontos);
    const svg = g.querySelector("svg"), dica = g.querySelector(".dica");
    const cursor = svg.querySelector(".cursor"), marc = svg.querySelector(".marcador");
    const mover = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * 600;
      let melhor = pts[0];
      for (const p of pts) if (Math.abs(p.x - px) < Math.abs(melhor.x - px)) melhor = p;
      cursor.setAttribute("x1", melhor.x); cursor.setAttribute("x2", melhor.x); cursor.setAttribute("visibility", "visible");
      marc.setAttribute("cx", melhor.x); marc.setAttribute("cy", melhor.y); marc.setAttribute("visibility", "visible");
      dica.hidden = false;
      dica.innerHTML = `<strong class="num">${Rp(melhor.v)}</strong><span>${dataCurta(melhor.d)}</span>`;
      const esquerda = (melhor.x / 600) * r.width;
      dica.style.left = `${Math.min(Math.max(esquerda - 60, 0), r.width - 120)}px`;
    };
    const sair = () => { dica.hidden = true; cursor.setAttribute("visibility", "hidden"); marc.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", mover);
    svg.addEventListener("pointerdown", mover);
    svg.addEventListener("pointerleave", sair);
  });
}

async function telaPatrimonio() {
  const sub = estado.abaPatrimonio ?? "investimentos";
  app.innerHTML = `<div class="topo"><h1>Patrimônio</h1>${botaoOlho()}</div>
    <div class="seg"><button class="${sub === "investimentos" ? "ativo" : ""}" data-acao="abaPatrimonio" data-s="investimentos">Investimentos</button>
    <button class="${sub === "dividas" ? "ativo" : ""}" data-acao="abaPatrimonio" data-s="dividas">Dívidas</button></div>
    <div id="conteudo">${carregando()}</div>`;
  if (sub === "dividas") return telaDividas();
  return telaInvestimentos();
}
acoes.abaPatrimonio = (el) => { estado.abaPatrimonio = el.dataset.s; recarregar(); };
acoes.irPatrimonio = (el) => { estado.abaPatrimonio = el.dataset.s || "investimentos"; irPara("patrimonio"); };

// ---------- Investimentos
async function telaInvestimentos() {
  const [invs, caixinhas, hist, histCx] = await Promise.all([
    q(sb.from("v_investimentos").select("*").order("data_aplicacao", { ascending: false })),
    q(sb.from("caixinhas").select("*").order("ordem").order("nome")),
    q(sb.from("v_investimentos_historico").select("*").order("dia")),
    q(sb.from("v_caixinhas_historico").select("*").order("dia")),
  ]);
  const ativos = invs.filter((i) => i.status !== "TOTAL_WITHDRAWAL" && Number(i.saldo_liquido) > 0);
  const resgatados = invs.filter((i) => !ativos.includes(i));
  const total = ativos.reduce((s, i) => s + Number(i.saldo_liquido || 0), 0);
  const aplicado = ativos.reduce((s, i) => s + Number(i.valor_aplicado || 0), 0);
  const primeiro = hist[0], ultimo = hist.at(-1);
  const semCaixinha = ativos.filter((i) => !i.caixinha_id);

  // Saldo e variação por caixinha (desde a primeira fotografia de cada uma)
  const grupos = caixinhas.map((c) => ({ ...c, itens: ativos.filter((i) => i.caixinha_id === c.id) }));
  if (semCaixinha.length) grupos.push({ id: null, nome: "Sem caixinha", cor: "#8a8f98", itens: semCaixinha });
  for (const g of grupos) {
    g.saldo = g.itens.reduce((s, i) => s + Number(i.saldo_liquido || 0), 0);
    const h = histCx.filter((x) => (x.caixinha_id ?? null) === g.id);
    g.inicio = h[0] ? Number(h[0].saldo_liquido) : null;
    g.inicioDia = h[0]?.dia;
  }

  $("#conteudo").innerHTML = `
    <div class="cartao destaque">
      <div class="nota-texto">Investido hoje (líquido de impostos)</div>
      <div class="valor num">${Rp(total)}</div>
      <div class="compara">Aplicado ${Rp(aplicado)} · rendimento ${variacaoTexto(total - aplicado, aplicado)}</div>
      ${primeiro ? `<div class="compara">Desde ${dataCurta(primeiro.dia)} (primeiro registro): ${variacaoTexto(Number(ultimo.saldo_liquido) - Number(primeiro.saldo_liquido), Number(primeiro.saldo_liquido))}</div>` : ""}
    </div>
    <div class="cartao">
      <h3>Evolução</h3>
      ${hist.length >= 2 ? graficoLinha(hist.map((h) => ({ d: h.dia, v: Number(h.saldo_liquido) })), "Total investido")
        : `<p class="nota-texto">${hist.length ? `O histórico começou em ${dataCurta(hist[0].dia)}. ` : ""}Cada sincronização guarda uma fotografia do saldo; o gráfico aparece a partir do segundo dia.</p>`}
    </div>
    ${semCaixinha.length ? `<div class="cartao"><div class="linha" data-acao="abrirCaixinha" data-id=""><div class="corpo">
      <div class="titulo">${semCaixinha.length} aplicaç${semCaixinha.length > 1 ? "ões" : "ão"} sem caixinha</div>
      <div class="meta">O Open Finance não informa o nome da caixinha. Toque para dizer onde cada uma está.</div></div><span class="chip alerta">organizar</span></div></div>` : ""}
    <div class="cartao">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h3 style="margin:0">Caixinhas</h3>
      <button class="botao peq sec" data-acao="novaCaixinha">+ Nova</button></div>
      ${grupos.length ? `<ul class="lista">${grupos.map((g) => `
        <li class="linha" data-acao="abrirCaixinha" data-id="${g.id ?? ""}">
          <span class="ponto" style="background:${esc(g.cor)}"></span>
          <div class="corpo"><div class="titulo">${esc(g.nome)}</div>
          <div class="meta">${g.itens.length} aplicaç${g.itens.length === 1 ? "ão" : "ões"}${g.inicio != null ? ` · desde ${dataCurta(g.inicioDia).slice(0, 5)}: ${variacaoTexto(g.saldo - g.inicio, g.inicio)}` : ""}</div>
          ${g.meta ? `<div class="trilho" style="height:6px;background:var(--superficie-2);border-radius:3px;margin-top:6px;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, (g.saldo / g.meta) * 100)}%;background:${esc(g.cor)}"></i></div>
            <div class="meta">${Math.round((g.saldo / g.meta) * 100)}% da meta de ${Rp(g.meta)}</div>` : ""}</div>
          <div class="valor num">${Rp(g.saldo)}</div></li>`).join("")}</ul>`
        : `<p class="nota-texto">Crie as suas caixinhas (ex.: Reserva, Viagem) e associe as aplicações.</p>`}
    </div>
    ${resgatados.length ? `<details class="secao"><summary>Resgatadas ou zeradas (${resgatados.length})</summary><div class="conteudo"><ul class="lista">
      ${resgatados.map((i) => linhaAplicacao(i)).join("")}</ul></div></details>` : ""}
    ${!invs.length ? `<div class="vazio"><strong>Nenhum investimento ainda</strong>Os investimentos chegam na próxima sincronização do Open Finance.</div>` : ""}`;
  ativarGraficos($("#conteudo"));
}

function linhaAplicacao(i) {
  return `<li class="linha" data-acao="abrirAplicacao" data-id="${esc(i.id)}"><div class="corpo">
    <div class="titulo">${esc(i.nome)}</div>
    <div class="meta">aplicado em ${dataCurta(i.data_aplicacao)}${i.vencimento ? ` · vence ${dataCurta(i.vencimento)}` : ""}${i.status === "TOTAL_WITHDRAWAL" ? " · resgatada" : ""}</div></div>
    <div class="valor num">${Rp(i.saldo_liquido)}</div></li>`;
}

acoes.abrirCaixinha = async (el) => {
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  abrirFolha(carregando());
  const [invs, caixinhas] = await Promise.all([
    q(sb.from("v_investimentos").select("*").neq("status", "TOTAL_WITHDRAWAL").order("data_aplicacao", { ascending: false })),
    q(sb.from("caixinhas").select("*").order("ordem").order("nome")),
  ]);
  const cx = caixinhas.find((c) => c.id === id);
  const lista = invs.filter((i) => (i.caixinha_id ?? null) === id);
  const opcoes = (atual) => `<option value="">Sem caixinha</option>${caixinhas.map((c) => `<option value="${c.id}" ${c.id === atual ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}`;
  abrirFolha(`
    <h2 style="margin-right:40px">${esc(cx?.nome ?? "Sem caixinha")}</h2>
    <div class="destaque" style="margin:8px 0"><div class="valor num">${Rp(lista.reduce((s, i) => s + Number(i.saldo_liquido || 0), 0))}</div></div>
    ${!caixinhas.length ? `<p class="nota-texto">Crie uma caixinha primeiro para poder associar as aplicações.</p>` : ""}
    <div class="cartao"><h3>Aplicações</h3>
      ${lista.length ? lista.map((i) => `<div class="item-nota">
        <div class="l1"><span data-acao="abrirAplicacao" data-id="${esc(i.id)}" style="cursor:pointer">${esc(i.nome)}</span><span class="num">${Rp(i.saldo_liquido)}</span></div>
        <div class="l2"><span>aplicado ${dataCurta(i.data_aplicacao)} · ${Rp(i.valor_aplicado)}</span>
        ${caixinhas.length ? `<select data-muda="caixinhaAplicacao" data-id="${esc(i.id)}" aria-label="Caixinha">${opcoes(i.caixinha_id)}</select>` : ""}</div></div>`).join("")
        : `<p class="nota-texto">Nenhuma aplicação ativa aqui.</p>`}
    </div>
    ${cx ? `<div class="cartao"><h3>Editar caixinha</h3>
      <label class="campo"><span>Nome</span><input type="text" id="cxNome" value="${esc(cx.nome)}"></label>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label class="campo" style="flex:1"><span>Meta (opcional)</span><input type="text" inputmode="decimal" id="cxMeta" value="${cx.meta ?? ""}" placeholder="Ex.: 10000"></label>
        <label class="campo" style="flex:0 0 52px"><span>Cor</span><input type="color" id="cxCor" value="${esc(cx.cor)}" style="height:44px;width:52px;padding:2px;border-radius:10px;border:1px solid var(--borda)"></label>
      </div>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="salvarCaixinha" data-id="${cx.id}">Salvar</button>
      <button class="botao peq perigo" data-acao="apagarCaixinha" data-id="${cx.id}">Apagar caixinha</button></div></div>` : ""}`);
};
mudancas.caixinhaAplicacao = async (el) => {
  try {
    await q(sb.from("investimentos").update({ caixinha_id: el.value ? Number(el.value) : null }).eq("id", el.dataset.id));
    avisar("Aplicação movida");
    el.closest(".item-nota").remove();
    if (estado.aba === "patrimonio") telaPatrimonio();
  } catch (e) { avisar(e.message, true); }
};
acoes.novaCaixinha = () => {
  abrirFolha(`<h2>Nova caixinha</h2>
    <label class="campo"><span>Nome</span><input type="text" id="cxNome" placeholder="Ex.: Reserva de emergência"></label>
    <label class="campo"><span>Meta (opcional)</span><input type="text" inputmode="decimal" id="cxMeta" placeholder="Ex.: 10000"></label>
    <div class="botoes"><button class="botao cheio" data-acao="salvarCaixinha">Criar</button></div>`);
  setTimeout(() => $("#cxNome")?.focus(), 50);
};
function numeroDigitado(s) {
  const t = String(s ?? "").trim().replace(/[^\d,.-]/g, "");
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : null;
}
acoes.salvarCaixinha = async (el) => {
  const nome = $("#cxNome").value.trim();
  if (!nome) return avisar("Dê um nome à caixinha", true);
  const dados = { nome, meta: numeroDigitado($("#cxMeta").value) };
  if ($("#cxCor")) dados.cor = $("#cxCor").value;
  try {
    if (el.dataset.id) await q(sb.from("caixinhas").update(dados).eq("id", Number(el.dataset.id)));
    else {
      const n = (await q(sb.from("caixinhas").select("id"))).length;
      await q(sb.from("caixinhas").insert({ ...dados, cor: CORES_CAIXINHA[n % CORES_CAIXINHA.length] }));
    }
    avisar("Caixinha salva");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message.includes("duplicate") ? "Já existe uma caixinha com esse nome" : e.message, true); }
};
acoes.apagarCaixinha = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Toque de novo: as aplicações voltam para Sem caixinha"; return; }
  try { await q(sb.from("caixinhas").delete().eq("id", Number(el.dataset.id))); fecharFolha(); recarregar(); }
  catch (e) { avisar(e.message, true); }
};

acoes.abrirAplicacao = async (el) => {
  abrirFolha(carregando());
  const [i, fotos, caixinhas] = await Promise.all([
    q(sb.from("v_investimentos").select("*").eq("id", el.dataset.id).single()),
    q(sb.from("investimento_saldos").select("dia, saldo_liquido, saldo_bruto").eq("investimento_id", el.dataset.id).order("dia")),
    q(sb.from("caixinhas").select("id, nome").order("nome")),
  ]);
  const inv = await q(sb.from("investimentos").select("apelido, emissor").eq("id", el.dataset.id).single());
  abrirFolha(`
    <h2 style="margin-right:40px">${esc(i.nome)}</h2>
    <div class="nota-texto">${esc(inv.emissor ?? "")}</div>
    <div class="destaque" style="margin:8px 0"><div class="valor num">${Rp(i.saldo_liquido)}</div>
      <div class="compara">Aplicado ${Rp(i.valor_aplicado)} · rendimento ${variacaoTexto(Number(i.rendimento_liquido), Number(i.valor_aplicado))}</div></div>
    <dl class="kv">
      <dt>Aplicado em</dt><dd>${dataCurta(i.data_aplicacao)}</dd>
      <dt>Vencimento</dt><dd>${dataCurta(i.vencimento)}</dd>
      <dt>Rentabilidade</dt><dd>${i.taxa != null ? `${String(Number(i.taxa)).replace(".", ",")}% ` : ""}${esc(i.indexador ?? "")}</dd>
      <dt>Saldo bruto</dt><dd>${Rp(i.saldo_bruto)}</dd>
      <dt>Resgatável</dt><dd>${Rp(i.saldo_resgatavel)}</dd>
      <dt>Situação</dt><dd>${i.status === "ACTIVE" ? "Ativa" : i.status === "TOTAL_WITHDRAWAL" ? "Resgatada" : esc(i.status ?? "")}</dd>
    </dl>
    <div class="cartao" style="margin-top:12px">
      <label class="campo"><span>Caixinha</span><select id="apCx"><option value="">Sem caixinha</option>${caixinhas.map((c) => `<option value="${c.id}" ${c.id === i.caixinha_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}</select></label>
      <label class="campo"><span>Apelido (opcional)</span><input type="text" id="apApelido" value="${esc(inv.apelido ?? "")}" placeholder="Ex.: Depósito do 13º"></label>
      <button class="botao peq" data-acao="salvarAplicacao" data-id="${esc(el.dataset.id)}">Salvar</button>
    </div>
    <div class="cartao"><h3>Histórico</h3>
      ${fotos.length >= 2 ? graficoLinha(fotos.map((f) => ({ d: f.dia, v: Number(f.saldo_liquido) })), "Saldo da aplicação") : ""}
      <ul class="lista">${fotos.slice().reverse().slice(0, 30).map((f) => `<li class="linha" style="cursor:default"><div class="corpo">${dataCurta(f.dia)}</div><div class="valor num">${Rp(f.saldo_liquido)}</div></li>`).join("") || "<li class='nota-texto'>Sem registros ainda.</li>"}</ul>
    </div>`);
  ativarGraficos(folha);
};
acoes.salvarAplicacao = async (el) => {
  try {
    await q(sb.from("investimentos").update({
      caixinha_id: $("#apCx").value ? Number($("#apCx").value) : null,
      apelido: $("#apApelido").value.trim() || null,
    }).eq("id", el.dataset.id));
    avisar("Aplicação salva");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); }
};

// ---------- Dívidas
async function telaDividas() {
  const [itens, parcelas] = await Promise.all([
    q(sb.from("v_dividas").select("*").order("saldo_devedor", { ascending: false })),
    q(sb.from("v_cartao_parcelas_futuras").select("*").order("valor_restante", { ascending: false })),
  ]);
  const total = itens.reduce((s, d) => s + Number(d.saldo_devedor || 0), 0);
  const mensal = itens.filter((d) => d.fonte === "divida").reduce((s, d) => s + Number(d.parcela_valor || 0), 0);
  $("#conteudo").innerHTML = `
    <div class="cartao destaque">
      <div class="nota-texto">Total devido hoje</div>
      <div class="valor num">${Rp(total)}</div>
      ${mensal ? `<div class="compara">Parcelas de empréstimos e dívidas: ${Rp(mensal)} por mês</div>` : ""}
    </div>
    <div class="cartao">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h3 style="margin:0">Dívidas</h3>
      <button class="botao peq sec" data-acao="novaDivida">+ Cadastrar</button></div>
      ${itens.length ? `<ul class="lista">${itens.map((d) => {
        const progresso = d.parcelas_total ? Math.min(100, (Number(d.parcelas_pagas || 0) / d.parcelas_total) * 100) : null;
        const acao = d.fonte === "divida" ? `data-acao="abrirDivida" data-id="${d.id}"` : d.fonte === "parcelas" ? `data-acao="verParcelasFuturas"` : "";
        return `<li class="linha" ${acao} style="${acao ? "" : "cursor:default"}"><div class="corpo">
          <div class="titulo">${esc(d.nome)}</div>
          <div class="meta">${esc(TIPOS_DIVIDA[d.tipo] ?? d.tipo)}${d.credor ? ` · ${esc(d.credor)}` : ""}${d.origem === "open_finance" ? " · Open Finance" : ""}${d.parcela_valor ? ` · ${Rp(d.parcela_valor)}/mês` : ""}${d.parcelas_total ? ` · ${d.parcelas_pagas}/${d.parcelas_total} pagas` : ""}</div>
          ${progresso != null ? `<div style="height:6px;background:var(--superficie-2);border-radius:3px;margin-top:6px;overflow:hidden"><i style="display:block;height:100%;width:${progresso}%;background:var(--acento)"></i></div>` : ""}</div>
          <div class="valor num">${Rp(d.saldo_devedor)}</div></li>`;
      }).join("")}</ul>`
        : `<p class="nota-texto">Nenhuma dívida. Empréstimos do Open Finance e a fatura do cartão aparecem aqui sozinhos; o resto você cadastra.</p>`}
    </div>
    ${parcelas.length ? `<details class="secao" id="parcelasFuturas"><summary>Compras parceladas em aberto (${parcelas.length})</summary><div class="conteudo"><ul class="lista">
      ${parcelas.map((p) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(p.descricao)}</div>
        <div class="meta">${p.parcelas_restantes} de ${p.parcelas_total} restantes · ${Rp(p.valor_parcela)} cada</div></div>
        <div class="valor num">${Rp(p.valor_restante)}</div></li>`).join("")}</ul></div></details>` : ""}`;
}
acoes.verParcelasFuturas = () => { const d = $("#parcelasFuturas"); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth" }); } };

function formularioDivida(d = {}) {
  return `
    <label class="campo"><span>Nome</span><input type="text" id="dvNome" value="${esc(d.nome ?? "")}" placeholder="Ex.: Financiamento do carro"></label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Tipo</span><select id="dvTipo">${Object.entries(TIPOS_DIVIDA).map(([k, n]) => `<option value="${k}" ${d.tipo === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="campo" style="flex:1"><span>Credor</span><input type="text" id="dvCredor" value="${esc(d.credor ?? "")}" placeholder="Banco ou pessoa"></label>
    </div>
    <p class="nota-texto">Preencha o que souber. Com parcela e nº de parcelas, o saldo é calculado sozinho a cada pagamento.</p>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Valor da parcela</span><input type="text" inputmode="decimal" id="dvParcela" value="${d.parcela_valor ?? ""}"></label>
      <label class="campo" style="flex:1"><span>Nº de parcelas</span><input type="text" inputmode="numeric" id="dvTotal" value="${d.parcelas_total ?? ""}"></label>
    </div>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Já pagas antes</span><input type="text" inputmode="numeric" id="dvAntes" value="${d.parcelas_pagas_antes ?? ""}" placeholder="0"></label>
      <label class="campo" style="flex:1"><span>Juros % ao mês</span><input type="text" inputmode="decimal" id="dvJuros" value="${d.taxa_juros_mensal ?? ""}" placeholder="Ex.: 1,99"></label>
    </div>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Valor total (sem parcelas)</span><input type="text" inputmode="decimal" id="dvOriginal" value="${d.valor_original ?? ""}" placeholder="Ex.: dívida com pessoa"></label>
      <label class="campo" style="flex:1"><span>Dia do vencimento</span><input type="text" inputmode="numeric" id="dvDia" value="${d.dia_vencimento ?? ""}"></label>
    </div>
    <label class="campo"><span>Texto no extrato (para reconhecer os pagamentos)</span><input type="text" id="dvPadrao" value="${esc(d.padrao_pagamento ?? "")}" placeholder="Ex.: PIX TRANSF JOAO ou EMPRESTIMO PESSOAL"></label>
    <label class="campo"><span>Observação</span><input type="text" id="dvObs" value="${esc(d.observacao ?? "")}"></label>`;
}
function lerFormularioDivida() {
  const int = (v) => { const n = parseInt(String(v).replace(/\D/g, ""), 10); return Number.isFinite(n) ? n : null; };
  const padrao = normalizar($("#dvPadrao").value).replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    nome: $("#dvNome").value.trim(),
    tipo: $("#dvTipo").value,
    credor: $("#dvCredor").value.trim() || null,
    parcela_valor: numeroDigitado($("#dvParcela").value),
    parcelas_total: int($("#dvTotal").value),
    parcelas_pagas_antes: int($("#dvAntes").value) ?? 0,
    taxa_juros_mensal: numeroDigitado($("#dvJuros").value),
    valor_original: numeroDigitado($("#dvOriginal").value),
    dia_vencimento: int($("#dvDia").value),
    padrao_pagamento: padrao || null,
    observacao: $("#dvObs").value.trim() || null,
  };
}
acoes.novaDivida = () => {
  abrirFolha(`<h2>Cadastrar dívida</h2>${formularioDivida()}<div class="botoes"><button class="botao cheio" data-acao="salvarDivida">Salvar</button></div>`);
};
acoes.salvarDivida = async (el) => {
  const dados = lerFormularioDivida();
  if (!dados.nome) return avisar("Dê um nome à dívida", true);
  if (!dados.parcela_valor && !dados.valor_original) return avisar("Informe o valor da parcela ou o valor total", true);
  el.disabled = true;
  try {
    if (el.dataset.id) await q(sb.from("dividas").update({ ...dados, atualizado_em: new Date().toISOString() }).eq("id", Number(el.dataset.id)));
    else await q(sb.from("dividas").insert({ ...dados, origem: "manual" }));
    if (dados.padrao_pagamento) await fn("/sync-pagamentos").catch(() => {});
    avisar("Dívida salva");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.abrirDivida = async (el) => {
  abrirFolha(carregando());
  const id = Number(el.dataset.id);
  const [d, pags, saldos] = await Promise.all([
    q(sb.from("dividas").select("*").eq("id", id).single()),
    q(sb.from("divida_pagamentos").select("*, transacoes(descricao)").eq("divida_id", id).order("data", { ascending: false })),
    q(sb.from("divida_saldos").select("dia, saldo_devedor").eq("divida_id", id).order("dia")),
  ]);
  const manual = d.origem === "manual";
  abrirFolha(`
    <h2 style="margin-right:40px">${esc(d.nome)}</h2>
    <div class="nota-texto">${esc(TIPOS_DIVIDA[d.tipo] ?? d.tipo)}${d.credor ? ` · ${esc(d.credor)}` : ""}${manual ? "" : " · Open Finance"}</div>
    <div class="destaque" style="margin:8px 0"><div class="valor num">${Rp(d.saldo_devedor)}</div>
      <div class="compara">${d.parcelas_total ? `${d.parcelas_pagas} de ${d.parcelas_total} parcelas pagas` : ""}${d.parcela_valor ? ` · ${Rp(d.parcela_valor)}/mês` : ""}${d.dia_vencimento ? ` · vence dia ${d.dia_vencimento}` : ""}</div></div>
    ${saldos.length >= 2 ? `<div class="cartao"><h3>Evolução do saldo</h3>${graficoLinha(saldos.map((s) => ({ d: s.dia, v: Number(s.saldo_devedor) })), "Saldo devedor")}</div>` : ""}
    ${manual ? `<div class="cartao"><h3>Registrar pagamento</h3>
      <div style="display:flex;gap:8px">
        <label class="campo" style="flex:1"><span>Data</span><input type="date" id="pgData" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="campo" style="flex:1"><span>Valor</span><input type="text" inputmode="decimal" id="pgValor" value="${d.parcela_valor ?? ""}"></label>
      </div>
      <button class="botao peq" data-acao="registrarPagamento" data-id="${d.id}">Registrar</button>
      <p class="nota-texto">${d.padrao_pagamento ? `Pagamentos com "${esc(d.padrao_pagamento)}" no extrato são registrados sozinhos.` : "Dica: abra o lançamento do pagamento em Gastos e toque em \"É pagamento de dívida\" para o app aprender a reconhecer os próximos."}</p></div>` : ""}
    <div class="cartao"><h3>Pagamentos (${pags.length})</h3>
      <ul class="lista">${pags.map((p) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${dataCurta(p.data)}</div>
        <div class="meta">${esc(p.transacoes?.descricao ?? p.observacao ?? "registrado no app")}</div></div>
        <div class="valor num">${Rp(p.valor)}</div>
        ${manual ? `<button class="botao peq sec" data-acao="apagarPagamento" data-id="${p.id}" data-divida="${d.id}" aria-label="Apagar pagamento">✕</button>` : ""}</li>`).join("") || "<li class='nota-texto'>Nenhum pagamento registrado.</li>"}</ul></div>
    ${manual ? `<details class="secao"><summary>Editar dados</summary><div class="conteudo">${formularioDivida(d)}
      <div class="botoes"><button class="botao peq" data-acao="salvarDivida" data-id="${d.id}">Salvar</button>
      <button class="botao peq perigo" data-acao="quitarDivida" data-id="${d.id}">Marcar como quitada</button></div></div></details>` : ""}`);
  ativarGraficos(folha);
};
acoes.registrarPagamento = async (el) => {
  const valor = numeroDigitado($("#pgValor").value);
  if (!valor) return avisar("Informe o valor", true);
  try {
    await fn("/pagar-divida", { divida_id: Number(el.dataset.id), data: $("#pgData").value, valor });
    avisar("Pagamento registrado");
    acoes.abrirDivida(el);
    if (estado.aba === "patrimonio") telaPatrimonio();
  } catch (e) { avisar(e.message, true); }
};
acoes.apagarPagamento = async (el) => {
  try {
    await q(sb.from("divida_pagamentos").delete().eq("id", Number(el.dataset.id)));
    acoes.abrirDivida({ dataset: { id: el.dataset.divida } });
  } catch (e) { avisar(e.message, true); }
};
acoes.quitarDivida = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Toque de novo para confirmar"; return; }
  try { await q(sb.from("dividas").update({ ativa: false, saldo_devedor: 0 }).eq("id", Number(el.dataset.id))); fecharFolha(); recarregar(); }
  catch (e) { avisar(e.message, true); }
};

// Ligar um lançamento do extrato a uma dívida (a partir da tela do lançamento)
acoes.ligarDivida = async (el) => {
  const sel = $("#dvLigar");
  if (!sel.value) return avisar("Escolha a dívida", true);
  el.disabled = true;
  try {
    const r = await fn("/pagar-divida", { divida_id: Number(sel.value), transacao_id: el.dataset.tx, aprender: $("#dvAprender").checked });
    avisar(r.outros_reconhecidos ? `Registrado. Mais ${r.outros_reconhecidos} pagamento(s) reconhecido(s) no extrato.` : "Pagamento registrado na dívida");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ SUGESTÕES E PLANO
const ICONES_SUG = { alerta: "!", economia: "$", divida: "↓", meta: "◎", dica: "i" };
const NOMES_TIPO_SUG = { alerta: "Alerta", economia: "Economia", divida: "Dívida", meta: "Meta", dica: "Dica" };
let cacheSugestoes = null;
async function obterSugestoes(forcar = false) {
  if (!forcar && cacheSugestoes && Date.now() - cacheSugestoes.em < 5 * 60000) return cacheSugestoes.dados;
  const dados = await fn("/sugestoes");
  cacheSugestoes = { em: Date.now(), dados };
  return dados;
}

function barraPlano(rotulo, atual, ideal, cor, inverso = false, privado = false) {
  const V = privado ? Rp : R;
  // inverso: para poupança, ficar abaixo do ideal é o problema
  const max = Math.max(atual, ideal, 1) * 1.1;
  const ruim = inverso ? atual < ideal : atual > ideal;
  return `<div class="plano-linha">
    <div class="plano-rotulo"><span>${rotulo}</span><span class="num"><strong class="${ruim ? "sobe" : "desce"}">${V(Math.abs(atual), atual < 0 ? "−" : "")}</strong> <span class="nota-texto">/ ideal ${V(ideal)}</span></span></div>
    <div class="plano-trilho"><i style="width:${Math.max(0, (atual / max) * 100)}%;background:${cor}"></i><b style="left:${(ideal / max) * 100}%" title="ideal"></b></div>
  </div>`;
}

async function telaSugestoes() {
  app.innerHTML = `<div class="topo"><h1>Sugestões</h1>${botaoOlho()}<button class="botao peq sec" data-acao="abrirPreferencias">Ajustar plano</button></div>
    <div id="conteudo">${carregando()}</div>`;
  let d;
  try { d = await obterSugestoes(true); }
  catch (e) { $("#conteudo").innerHTML = `<div class="vazio"><strong>Não consegui analisar</strong>${esc(e.message)}</div>`; return; }
  const p = d.plano;
  const mesesTxt = p.meses.length ? `média de ${p.meses.map((m) => nomeMes(m).split(" ")[0].slice(0, 3)).join(", ")}` : "sem meses completos ainda";

  $("#conteudo").innerHTML = `
    ${d.economia_potencial > 0 ? `<div class="cartao destaque">
      <div class="nota-texto">Economia possível seguindo as sugestões</div>
      <div class="valor num desce">${Rp(d.economia_potencial)}<span class="nota-texto" style="font-size:15px;font-weight:400"> por mês</span></div>
      <div class="compara">${Rp(d.economia_potencial * 12)} em um ano</div></div>` : ""}

    <div class="cartao">
      <h3>Plano de gastos</h3>
      <p class="nota-texto" style="margin-top:0">Renda ${Rp(p.renda)} por mês (${esc(p.origem_renda || "não identificada")}). Pela regra ${Math.round(p.pct.essencial * 100)}/${Math.round(p.pct.estilo_vida * 100)}/${Math.round(p.pct.poupanca * 100)}, o <strong>gasto ideal é até ${Rp(p.gasto_ideal)}</strong>. Valores atuais: ${mesesTxt}.</p>
      ${barraPlano("Essencial", p.essencial.atual, p.essencial.ideal, "var(--acento)", false, true)}
      ${barraPlano("Estilo de vida", p.estilo_vida.atual, p.estilo_vida.ideal, "#e5813b", false, true)}
      ${barraPlano("Sobra para guardar/quitar", p.poupanca.atual, p.poupanca.ideal, "#3b7dd8", true, true)}
      <p class="nota-texto">Essencial: mercado, casa, saúde, transporte, educação, juros. Estilo de vida: restaurantes, lazer, compras, assinaturas. ${p.dividas_media ? `Além das despesas, ${Rp(p.dividas_media)}/mês foram para pagar dívidas.` : ""}</p>
    </div>

    ${d.dividas.ordem.length ? `<div class="cartao" data-acao="irPatrimonio" data-s="dividas" style="cursor:pointer">
      <h3>Dívidas</h3>
      <div class="linha" style="cursor:inherit;border-top:0;padding-top:0"><div class="corpo"><div class="titulo num" style="font-size:20px">${Rp(d.dividas.total)}</div>
      <div class="meta">${d.dividas.comprometimento ? `${Math.round(d.dividas.comprometimento * 100)}% da renda vai para dívidas · ` : ""}juros estimados ${Rp(d.dividas.ordem.reduce((s, x) => s + x.juros_mes, 0))}/mês</div></div></div>
    </div>` : ""}

    <div class="cartao">
      <h3>Reserva de emergência</h3>
      ${barraPlano(`${Math.round(d.reserva.meses_cobertos * 10) / 10} de ${estado.prefs?.reserva_meses ?? 6} meses`, d.reserva.atual, d.reserva.meta, "var(--acento)", true, true)}
    </div>

    <h3 style="margin:18px 2px 8px">O que fazer</h3>
    ${d.sugestoes.map((x) => `<div class="cartao sugestao ${x.tipo}">
      <div class="sug-topo"><span class="icone-sug ${x.tipo}">${ICONES_SUG[x.tipo]}</span><span class="chip">${NOMES_TIPO_SUG[x.tipo]}</span>
        ${x.economia_mensal ? `<span class="chip ok" style="margin-left:auto">${Rp(x.economia_mensal)}/mês</span>` : ""}</div>
      <h2 style="margin:8px 0 4px">${privTexto(esc(x.titulo))}</h2>
      <p style="margin:0">${privTexto(esc(x.texto))}</p>
      ${x.itens?.length ? `<ul class="lista" style="margin-top:6px">${x.itens.map((i) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${privTexto(esc(i.rotulo))}</div>${i.detalhe ? `<div class="meta">${privTexto(esc(i.detalhe))}</div>` : ""}</div><div class="valor num">${Rp(i.valor)}</div></li>`).join("")}</ul>` : ""}
      ${x.acao ? `<div class="botoes"><button class="botao peq sec" data-acao="acaoSugestao" data-destino="${esc(x.acao.destino)}" data-filtro="${esc(x.acao.filtro ?? "")}">${esc(x.acao.rotulo)}</button></div>` : ""}
    </div>`).join("")}
    <p class="nota-texto">As sugestões usam os seus lançamentos dos últimos 3 meses completos e o CDI de ${String(d.referencia.cdi_anual).replace(".", ",")}% ao ano (Banco Central). São orientações gerais, não recomendação de investimento.</p>`;
}

acoes.acaoSugestao = (el) => {
  const destino = el.dataset.destino, filtro = el.dataset.filtro;
  if (destino === "movimentacoes") {
    estado.filtroGastos = filtro === "sem-categoria" ? "sem-categoria" : "tudo";
    const cat = estado.categorias.find((c) => c.nome === filtro);
    estado.categoriaFiltro = cat ? cat.id : null;
    return irPara("gastos");
  }
  if (destino === "patrimonio_dividas") { estado.abaPatrimonio = "dividas"; return irPara("patrimonio"); }
  if (destino === "patrimonio_invest") { estado.abaPatrimonio = "investimentos"; return irPara("patrimonio"); }
  if (destino === "preferencias") return acoes.abrirPreferencias();
  if (destino === "escanear") return irPara("escanear");
};

acoes.abrirPreferencias = async () => {
  abrirFolha(carregando());
  const prefs = Object.fromEntries((await q(sb.from("preferencias").select("chave, valor"))).map((x) => [x.chave, x.valor]));
  abrirFolha(`<h2>Ajustar plano</h2>
    <label class="campo"><span>Renda mensal da casa (deixe vazio para o app calcular pelas receitas)</span>
      <input type="text" inputmode="decimal" id="prRenda" value="${esc(prefs.renda_mensal ?? "")}" placeholder="Ex.: 11300"></label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Meta para guardar (% da renda)</span><input type="text" inputmode="numeric" id="prPoup" value="${esc(prefs.meta_poupanca_pct ?? "20")}"></label>
      <label class="campo" style="flex:1"><span>Reserva de emergência (meses)</span><input type="text" inputmode="numeric" id="prReserva" value="${esc(prefs.reserva_meses ?? "6")}"></label>
    </div>
    <p class="nota-texto">A regra 50/30/20 separa a renda em 50% essencial, 30% estilo de vida e 20% para guardar ou quitar dívidas. Mudar a meta de guardar ajusta o estilo de vida.</p>
    <div class="botoes"><button class="botao cheio" data-acao="salvarPreferencias">Salvar</button></div>`);
};
acoes.salvarPreferencias = async (el) => {
  const renda = numeroDigitado($("#prRenda").value);
  const poup = Math.min(Math.max(parseInt($("#prPoup").value, 10) || 20, 0), 60);
  const reserva = Math.min(Math.max(parseInt($("#prReserva").value, 10) || 6, 1), 24);
  el.disabled = true;
  try {
    await q(sb.from("preferencias").upsert([
      { chave: "renda_mensal", valor: renda ? String(renda) : null },
      { chave: "meta_poupanca_pct", valor: String(poup) },
      { chave: "reserva_meses", valor: String(reserva) },
    ]));
    estado.prefs = { reserva_meses: reserva };
    cacheSugestoes = null;
    avisar("Plano atualizado");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ LOGIN
function telaLogin(modo = "entrar", msg = "") {
  abas.hidden = true;
  const titulos = { entrar: "Entrar", criar: "Criar conta", recuperar: "Recuperar senha", nova: "Nova senha" };
  app.innerHTML = `<div class="login">
    <div class="marca"><img src="icons/icon-192.png" alt=""><div><h1>Finanças da Casa</h1><div class="nota-texto">Open Finance + notas fiscais</div></div></div>
    <div class="cartao">
      <h2 style="margin-bottom:6px">${titulos[modo]}</h2>
      ${msg ? `<p class="nota-texto">${msg}</p>` : ""}
      ${modo === "entrar" ? `<div id="loginGoogle"></div>` : ""}
      <form id="formLogin">
        ${modo !== "nova" ? `<label class="campo"><span>E-mail</span><input type="email" id="email" autocomplete="email" required></label>` : ""}
        ${modo !== "recuperar" ? `<label class="campo"><span>Senha${modo !== "entrar" ? " (mínimo 8 caracteres)" : ""}</span><input type="password" id="senha" autocomplete="${modo === "entrar" ? "current-password" : "new-password"}" minlength="${modo === "entrar" ? 1 : 8}" required></label>` : ""}
        <button class="botao cheio" type="submit">${titulos[modo]}</button>
      </form>
      <div class="botoes" style="justify-content:space-between">
        ${modo === "entrar" ? `<button class="botao peq sec" data-acao="modoLogin" data-m="criar">Criar conta</button><button class="botao peq sec" data-acao="modoLogin" data-m="recuperar">Esqueci a senha</button>`
          : modo !== "nova" ? `<button class="botao peq sec" data-acao="modoLogin" data-m="entrar">Voltar</button>` : ""}
      </div>
    </div></div>`;
  $("#formLogin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bt = e.submitter; bt.disabled = true;
    const email = $("#email")?.value.trim(), senha = $("#senha")?.value;
    const volta = location.origin + location.pathname;
    try {
      if (modo === "entrar") {
        const { error } = await sb.auth.signInWithPassword({ email, password: senha });
        if (error) throw new Error(error.message === "Invalid login credentials" ? "E-mail ou senha incorretos" : error.message === "Email not confirmed" ? "Confirme seu e-mail pelo link que enviamos" : error.message);
        location.reload();
      } else if (modo === "criar") {
        const { data, error } = await sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: volta } });
        if (error) throw error;
        if (data.session) location.reload();
        else telaLogin("entrar", "Enviamos um e-mail de confirmação. Abra o link e depois entre aqui.");
      } else if (modo === "recuperar") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: volta });
        if (error) throw error;
        telaLogin("entrar", "Se o e-mail existir, você vai receber um link para criar uma nova senha.");
      } else if (modo === "nova") {
        const { error } = await sb.auth.updateUser({ password: senha });
        if (error) throw error;
        location.hash = ""; location.reload();
      }
    } catch (err) { avisar(err.message, true); bt.disabled = false; }
  });
  if (modo === "entrar") mostrarLoginGoogle();
}
acoes.modoLogin = (el) => telaLogin(el.dataset.m);

/** Mostra "Entrar com Google" só se o provedor Google estiver ligado no Supabase. */
async function mostrarLoginGoogle() {
  const el = $("#loginGoogle");
  if (!el || !navigator.onLine) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY } });
    const cfg = await r.json();
    if (!cfg?.external?.google || !$("#loginGoogle")) return;
    el.innerHTML = `<button class="botao sec cheio botao-google" type="button" data-acao="entrarGoogle">Entrar com Google</button>
      <div class="separador"><span>ou com e-mail e senha</span></div>`;
  } catch { /* sem Google: fica só e-mail e senha */ }
}
acoes.entrarGoogle = async (el) => {
  el.disabled = true;
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } },
  });
  if (error) { avisar(error.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ início do app
async function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (SUPABASE_URL.includes("SEU-PROJETO")) {
    app.innerHTML = `<div class="vazio"><strong>App ainda não configurado</strong>Preencha o endereço do Supabase em app/config.js.</div>`;
    return;
  }
  let recuperando = false;
  sb.auth.onAuthStateChange((evento) => {
    if (evento === "PASSWORD_RECOVERY") { recuperando = true; telaLogin("nova", "Escolha a nova senha."); }
  });
  let session = null;
  if (navigator.onLine) {
    const semResposta = new Promise((ok) => setTimeout(() => ok({ data: { session: null } }), 8000));
    ({ data: { session } } = await Promise.race([sb.auth.getSession().catch(() => ({ data: { session: null } })), semResposta]));
  }
  if (recuperando) return;
  if (session && HASH_INICIAL.includes("type=recovery")) return telaLogin("nova", "Escolha a nova senha.");
  if (!session && !navigator.onLine) {
    // Sem internet o login não pode ser renovado (e a biblioteca ficaria tentando): usa a sessão guardada só para abrir os dados salvos
    try {
      const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
      const salva = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`) ?? "null");
      if (salva?.user?.email) { session = salva; sessaoOffline = true; }
    } catch { /* sem sessão guardada */ }
  }
  if (!session) {
    // Volta do Google com erro (ex.: cancelou a escolha da conta)
    const erroOAuth = new URLSearchParams(HASH_INICIAL.slice(1) || location.search.slice(1)).get("error_description");
    if (erroOAuth) { history.replaceState(null, "", location.pathname); return telaLogin("entrar", `Não foi possível entrar com o Google: ${esc(erroOAuth)}`); }
    return telaLogin();
  }
  estado.email = session.user.email?.toLowerCase();

  let membros = [], erroRede = false;
  try { membros = await q(sb.from("membros").select("email")); }
  catch (e) { erroRede = !navigator.onLine || /fetch|network|rede|timeout|internet/i.test(String(e?.message ?? e)); }
  if (erroRede && !membros.length) {
    // Sem internet e sem cópia guardada: não confundir com "acesso pendente": não confundir com "acesso pendente"
    app.innerHTML = `<div class="login"><div class="cartao"><h2>Sem internet</h2>
      <p>O app precisa de conexão para buscar os dados. Assim que a internet voltar, ele carrega sozinho.</p>
      <button class="botao" data-acao="tentarDeNovo">Tentar de novo</button></div></div>`;
    window.addEventListener("online", () => location.reload(), { once: true });
    return;
  }
  if (!membros.length) {
    app.innerHTML = `<div class="login"><div class="cartao"><h2>Acesso pendente</h2>
      <p>Você entrou como <strong>${esc(estado.email)}</strong>, mas este e-mail ainda não tem acesso aos dados.</p>
      <p class="nota-texto">Peça para quem já usa o app ir em Mais → Quem tem acesso e adicionar este e-mail.</p>
      <button class="botao sec" data-acao="sair">Sair</button></div></div>`;
    return;
  }
  await carregarCategorias();
  abas.hidden = false;
  const inicial = location.hash.replace("#", "");
  await irPara(["inicio", "gastos", "escanear", "notas", "mais", "patrimonio", "sugestoes"].includes(inicial) ? inicial : "inicio");
  processarFila();
}
iniciar();
