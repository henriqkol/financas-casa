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
/** Mesma regra do servidor (chaveAprendizado): só letras, sem números nem símbolos. */
function chaveTexto(s) { return normalizar(s).replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim(); }
/** "1 lançamento", "3 lançamentos" */
const pl = (n, um, varios) => `${Number(n).toLocaleString("pt-BR")} ${Number(n) === 1 ? um : varios}`;
function hojeISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// ---------- Nomes legíveis para o que vem cru do banco
const SIGLAS = new Set(["PIX", "TED", "DOC", "IOF", "CPF", "CNPJ", "NFC", "TV", "USB", "ATM", "IPVA", "IPTU", "DARF", "GRU", "CDB", "RDB", "LCI", "LCA", "CDI", "FGTS", "INSS", "TIM", "OI", "BB", "XP", "RS", "SP", "SC", "PR", "MG", "RJ", "BR", "EGR", "MP", "NU", "C6", "PJ", "PF", "CEEE", "RGE", "DMAE", "CIA"]);
const MINUSCULAS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "EM", "NO", "NA", "NOS", "NAS", "PARA", "POR", "COM", "A", "O", "AS", "OS"]);
const PALAVRAS = {
  INSTITUICAO: "instituição", SERVICOS: "serviços", SERVICO: "serviço", CREDIARIO: "crediário", SAIDA: "saída", AUTOM: "automática",
  DIFERENCI: "diferenciada", TRANSF: "transferência", TRANSFERENCIA: "transferência", PAGTO: "pagamento", PGTO: "pagamento", COMERCIO: "comércio",
  DISTRIBUICAO: "distribuição", FARMACIA: "farmácia", ACOUGUE: "açougue", SAO: "São", JOAO: "João", GAUCHA: "gaúcha", GAUCHO: "gaúcho",
  ELETRONICOS: "eletrônicos", INFORMATICA: "informática", COMUNICACAO: "comunicação", ADMINISTRACAO: "administração", PARTICIPACOES: "participações",
  SOLUCOES: "soluções", ALIMENTACAO: "alimentação", MEDICOS: "médicos", CONDOMINIO: "condomínio", AGUA: "água", COMPANHIA: "companhia",
  ANUIDADE: "anuidade", TARIFA: "tarifa", PAGAMENTOS: "pagamentos", PAGAMENTO: "pagamento", CARTAO: "cartão", CREDITO: "crédito", DEBITO: "débito",
};
const tradutorEntidades = document.createElement("textarea");
function decodificar(s) { if (!/&[#a-z0-9]+;/i.test(s)) return s; tradutorEntidades.innerHTML = s; return tradutorEntidades.value; }
/** "ANUIDADE DIFERENCI04/07" → "Anuidade diferenciada" · "PAY2ALL INSTITUICAO DE PAGAMENTO LTDA." → "Pay2all Instituição de Pagamento" */
function nomeLimpo(bruto) {
  let n = decodificar(String(bruto ?? "")).trim();
  n = n.replace(/\s*(PARC(ELA)?\.?\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*$/i, "")              // parcela no fim (o "4/7" já aparece ao lado)
    .replace(/[\s.,*-]+(LTDA|S\.?\s?\/?A|ME|EPP|EIRELI|MEI)\.?$/i, "")                     // sufixo de empresa
    .replace(/[\s*.-]+$/, "").replace(/\s{2,}/g, " ").trim();
  if (!n) return String(bruto ?? "");
  if (/[a-zà-ÿ]/.test(n)) return n;                                                      // já tem minúsculas: deixa como veio
  return n.split(" ").map((p, i) => {
    const base = normalizar(p).replace(/[^A-Z0-9]/g, "");
    if (SIGLAS.has(base) || (/\d/.test(p) && p.length <= 4)) return p;
    if (PALAVRAS[base]) { const w = PALAVRAS[base]; return i === 0 ? maiuscula(w) : w; }
    if (i > 0 && MINUSCULAS.has(base)) return p.toLowerCase();
    return p.charAt(0) + p.slice(1).toLowerCase();
  }).join(" ");
}
/** Chave do estabelecimento para o apelido: o nome (parte depois do "|") sem números. */
function chaveNome(descricao) { const d = String(descricao ?? ""); const i = d.indexOf("|"); return chaveTexto(i > 0 ? d.slice(i + 1) : d); }
const TIPOS_OPERACAO = {
  BOLETO: "Boleto", CARTAO: "Compra no cartão", CONVENIO_ARRECADACAO: "Conta de consumo / convênio", DEPOSITO: "Depósito",
  ENCARGOS_JUROS_CHEQUE_ESPECIAL: "Juros do cheque especial", ESTORNO: "Estorno", FOLHA_PAGAMENTO: "Salário (folha de pagamento)",
  OPERACAO_CREDITO: "Operação de crédito", OPERACOES_CREDITO_CONTRATADAS_CARTAO: "Crédito contratado no cartão", OUTROS: "Outros",
  PAGAMENTO: "Pagamento", PAGAMENTO_FATURA: "Pagamento de fatura", PIX: "Pix", PORTABILIDADE_SALARIO: "Portabilidade de salário",
  RENDIMENTO_APLIC_FINANCEIRA: "Rendimento de aplicação", RESGATE_APLIC_FINANCEIRA: "Resgate de aplicação", TARIFA: "Tarifa bancária",
  TRANSFERENCIA_MESMA_INSTITUICAO: "Transferência no mesmo banco", TED: "TED", DOC: "DOC", MANUAL: "Lançado à mão",
};
const tipoOperacaoTexto = (t) => TIPOS_OPERACAO[t] ?? maiuscula(String(t ?? "").toLowerCase().replace(/_/g, " "));

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

/** Prefixo das cópias offline: cada casa tem as suas. */
const chaveCasa = (p) => p + (estado.casa?.casa_id ?? "") + ":";
async function q(consulta) {
  const leitura = consulta?.method === "GET" && consulta?.url;
  const chave = leitura ? chaveCasa("q") + consulta.url.toString() : null;
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
/** Busca todas as linhas paginando de 1000 em 1000. Sem ordem as páginas podem repetir ou pular linhas,
 *  então ordena por `chave` (colunas separadas por vírgula) quando a consulta não tem ordem. */
const CHAVE_VG = "transacao_id,categoria_id";
async function todas(fabrica, chave = "id") {
  const out = [];
  for (let de = 0; ; de += 1000) {
    let c = fabrica();
    if (!String(c.url ?? "").includes("order=")) for (const k of chave.split(",")) c = c.order(k, { ascending: true, nullsFirst: true });
    const lote = await q(c.range(de, de + 999));
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

/** Chama a função do servidor. */
async function fn(rota, corpo, metodo = "POST") {
  // Leituras do servidor (sem corpo) também ficam guardadas para uso offline
  const chave = !corpo && ["/sugestoes", "/config"].includes(rota) ? chaveCasa("fn") + rota : null;
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
  if (e.target.closest("#botaoAdicionar")) return abrirMenuAdicionar();
  const b = e.target.closest("button[data-aba]");
  if (b) irPara(b.dataset.aba);
});

function pararLeitor() { estado.leitor?.parar(); estado.leitor = null; }

async function irPara(aba, manterRolagem = false) {
  pararLeitor();
  if (aba !== estado.aba && estado.aba !== "escanear") estado.abaAnterior = estado.aba;
  estado.aba = aba;
  document.body.dataset.aba = aba;
  history.replaceState(null, "", `#${aba}`);
  abas.querySelectorAll("button").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  if (!manterRolagem) window.scrollTo(0, 0);
  const tela = { inicio: telaInicio, gastos: telaGastos, escanear: telaEscanear, notas: telaNotas, mais: telaMais, patrimonio: telaPatrimonio, sugestoes: telaSugestoes, metas: telaMetas }[aba] ?? telaInicio;
  try { await tela(); } catch (e) {
    const semRede = /^Sem internet/.test(e.message);
    const alvo = $("#conteudo") ?? app;
    alvo.innerHTML = semRede
      ? `<div class="vazio"><strong>Sem internet</strong>Esta tela ainda não tinha sido aberta neste aparelho, então não há dados guardados. Com internet, abra-a uma vez e ela passa a funcionar offline.</div>`
      : `<div class="vazio"><strong>Algo deu errado</strong>${esc(e.message)}</div>`;
  }
}
function recarregar() { return irPara(estado.aba); }
/** Atualiza a tela depois de uma edição sem perder o lugar: mantém a rolagem, os grupos abertos
 *  e destaca o lançamento que acabou de ser alterado. */
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
async function recarregarNoLugar() {
  const seletorTx = estado.ultimaTx ? `[data-acao="abrirTransacao"][data-id="${CSS.escape(estado.ultimaTx)}"]` : null;
  const y = estado.ancoraTx?.y ?? window.scrollY;
  const topoAntes = estado.ancoraTx?.topo ?? null;
  const abertos = [...document.querySelectorAll("details[data-k][open]")].map((d) => d.dataset.k);
  if (estado.aba === "gastos" && $("#conteudo")) await carregarMovimentacoes();
  else await irPara(estado.aba, true);
  for (const k of abertos) { const d = document.querySelector(`details[data-k="${CSS.escape(k)}"]`); if (d) d.open = true; }
  window.scrollTo(0, y);
  const li = seletorTx ? document.querySelector(seletorTx) : null;
  if (li) {
    // o lançamento editado volta exatamente para onde estava na tela
    if (topoAntes != null) window.scrollBy(0, li.getBoundingClientRect().top - topoAntes);
    li.classList.add("destacado"); setTimeout(() => li.classList.remove("destacado"), 1600);
  }
  estado.ancoraTx = null;
}

// Folha inferior (detalhes). O botão "voltar" do Android fecha a folha.
let folhaAberta = false;
function abrirFolha(html) {
  folha.innerHTML = `<div class="painel" role="dialog"><div class="alca"></div><button class="fechar" data-acao="fecharFolha" aria-label="Fechar">×</button>${html}</div>`;
  folha.hidden = false;
  if (!folhaAberta) { history.pushState({ folha: 1 }, ""); folhaAberta = true; }
}
function fecharFolha(viaHistorico = false) {
  if (!folhaAberta) return;
  // Campo com foco salva ao perder o foco: dispara antes de fechar
  if (folha.contains(document.activeElement)) document.activeElement.blur();
  folhaAberta = false;
  folha.hidden = true;
  folha.innerHTML = "";
  if (!viaHistorico) history.back();
  // Algo mudou dentro da folha (categoria, observação…): atualiza a tela de trás
  if (estado.folhaSujou) { estado.folhaSujou = false; setTimeout(recarregarNoLugar, 50); }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && folhaAberta) fecharFolha(); });
window.addEventListener("popstate", () => { if (folhaAberta) fecharFolha(true); });
folha.addEventListener("click", (e) => { if (e.target === folha) fecharFolha(); });
acoes.fecharFolha = () => fecharFolha();

/** Esqueleto dos cartões enquanto os dados chegam (no lugar de um spinner solto). */
function carregando() { return `<div class="esqueleto" aria-busy="true" aria-label="Carregando"><div class="sk sk-grande"></div><div class="sk"></div><div class="sk"></div><div class="sk sk-curto"></div></div>`; }

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
  if (!estado.apelidos) carregarApelidos();
  estado.categorias = await q(sb.from("categorias").select("*").order("ordem").order("nome"));
  estado.catPorId = Object.fromEntries(estado.categorias.map((c) => [c.id, c]));
}

// ------------------------------------------------------------------ INÍCIO
const ICONE = {
  ideia: `<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>`,
  etiqueta: `<svg viewBox="0 0 24 24"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`,
  cartao: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M7 15h4"/></svg>`,
  cofre: `<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>`,
  banco: `<svg viewBox="0 0 24 24"><path d="M3 10 12 4l9 6M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18"/></svg>`,
  nota: `<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/></svg>`,
};
async function telaInicio() {
  app.innerHTML = topoMes("Resumo") + `<div id="conteudo">${carregando()}</div>`;
  const ant = somarMes(estado.mes, -1);
  const [linhas, anteriores, pend, ultimo, invs, divs, receitas, receitasAnt, contasSaldo] = await Promise.all([
    todas(() => sb.from("v_gastos").select("transacao_id, data, categoria_id, categoria, valor, conta_como_gasto, via_nota").eq("mes", estado.mes), CHAVE_VG),
    todas(() => sb.from("v_gastos").select("data, valor").eq("mes", ant).eq("conta_como_gasto", true), CHAVE_VG),
    q(sb.from("v_pendencias").select("tipo")),
    q(sb.from("sync_log").select("inicio, fim, ok, mensagem").order("inicio", { ascending: false }).limit(1)),
    q(sb.from("investimentos").select("saldo_liquido, status")).catch(() => []),
    q(sb.from("v_dividas").select("saldo_devedor, fonte, tipo")).catch(() => []),
    todas(() => sb.from("v_receitas").select("categoria_id, categoria, valor, data").eq("mes", estado.mes), "transacao_id").catch(() => []),
    todas(() => sb.from("v_receitas").select("valor, data, categoria").eq("mes", ant), "transacao_id").catch(() => []),
    q(sb.from("contas").select("id, nome, apelido, tipo, saldo, atualizado_em, negativo_em_acordo").eq("ativa", true).order("tipo").order("saldo", { ascending: false })).catch(() => []),
  ]);
  const hoje = hojeISO();
  const ehMesAtual = estado.mes === mesAtual();
  const mesFuturo = estado.mes > mesAtual();
  const nomeM = nomeMes(estado.mes).split(" ")[0];
  const nomeAnt = nomeMes(ant).split(" ")[0];
  const diaHoje = new Date().getDate();

  // ---------- Números do mês (só o que já aconteceu: data até hoje)
  const receitasAteHoje = receitas.filter((r) => String(r.data ?? "") <= hoje);
  const totalReceitas = receitasAteHoje.reduce((s, r) => s + Number(r.valor), 0);
  const totalReceitasAnt = receitasAnt.reduce((s, r) => s + Number(r.valor), 0);
  const gastos = linhas.filter((l) => l.conta_como_gasto && l.data <= hoje);
  const total = gastos.reduce((s, l) => s + Number(l.valor), 0);
  const agendado = linhas.filter((l) => l.conta_como_gasto && l.data > hoje).reduce((s, l) => s + Number(l.valor), 0);
  const pagoDividas = linhas.filter((l) => l.categoria === "Pagamento de dívida" && l.data <= hoje).reduce((s, l) => s + Number(l.valor), 0);
  const resultado = totalReceitas - total - pagoDividas;
  const totalAnt = anteriores.reduce((s, l) => s + Number(l.valor), 0);
  const antAteHoje = anteriores.filter((l) => Number(l.data.slice(8, 10)) <= diaHoje).reduce((s, l) => s + Number(l.valor), 0);
  const base = ehMesAtual ? antAteHoje : totalAnt;
  const variacao = base > 0 ? (total - base) / base : null;
  const comNota = gastos.filter((l) => l.via_nota).reduce((s, l) => s + Number(l.valor), 0);

  const recPorCat = new Map();
  for (const r of receitasAteHoje) recPorCat.set(r.categoria_id ?? 0, { id: r.categoria_id, nome: r.categoria, valor: (recPorCat.get(r.categoria_id ?? 0)?.valor ?? 0) + Number(r.valor) });
  const recCats = [...recPorCat.values()].sort((a, b) => b.valor - a.valor);
  const bancos = contasSaldo.filter((c) => c.tipo === "BANK");
  const cartoes = contasSaldo.filter((c) => c.tipo === "CREDIT" && Math.abs(Number(c.saldo || 0)) > 0);
  const saldoTotal = bancos.reduce((s, c) => s + Number(c.saldo || 0), 0);
  const investido = invs.filter((i) => i.status !== "TOTAL_WITHDRAWAL").reduce((s, i) => s + Number(i.saldo_liquido || 0), 0);
  const devido = divs.reduce((s, d) => s + Number(d.saldo_devedor || 0), 0);
  const devidoCartoes = divs.filter((d) => d.fonte === "fatura" || d.fonte === "parcelas").reduce((s, d) => s + Number(d.saldo_devedor || 0), 0);
  const devidoAcordos = divs.filter((d) => d.tipo === "acordo").reduce((s, d) => s + Number(d.saldo_devedor || 0), 0);

  const porCat = new Map();
  for (const l of gastos) {
    const k = l.categoria_id ?? 0;
    const atual = porCat.get(k) ?? { id: l.categoria_id, nome: l.categoria, valor: 0 };
    atual.valor += Number(l.valor);
    porCat.set(k, atual);
  }
  const cats = [...porCat.values()].sort((a, b) => b.valor - a.valor);
  const max = cats[0]?.valor || 1;
  const semClassificacao = cats.filter((c) => c.id == null || c.nome === "Outros").reduce((s, c) => s + c.valor, 0);
  const nNotas = pend.filter((p) => p.tipo === "nota_sem_gasto").length;
  const inicioCtrl = await inicioControle();
  const nSemCat = await contarSemCategoria().catch(() => pend.filter((p) => p.tipo === "gasto_sem_categoria").length);
  const nSemCatMes = linhas.filter((l) => l.categoria_id == null && l.data <= hoje).length;   // (mês na tela)
  const sync = ultimo[0];
  const salarioAnt = receitasAnt.filter((r) => r.categoria === "Salário").map((r) => Number(String(r.data).slice(8, 10)));
  const diaSalario = salarioAnt.length ? Math.min(...salarioAnt) : null;

  const barraCat = (c, total, cor) => `<div class="barra-cat" data-acao="verCategoria" data-id="${c.id ?? ""}">
      <div class="nome"><span>${esc(c.nome)}</span>${c.id == null || c.nome === "Outros" ? `<span class="chip alerta chip-mini">sem classificação</span>` : ""}</div>
      <div class="num">${Rp(c.valor)}<span class="pct">${Math.round((c.valor / (total || 1)) * 100)}%</span></div>
      <div class="trilho"><i style="width:${(c.valor / max) * 100}%;background:${cor}"></i></div></div>`;
  const corBarra = (c) => (c.id == null || c.nome === "Outros" ? "var(--alerta)" : "var(--barra)");
  const TOP = 6;

  // Comparação em palavras (gastar mais é ruim): sem setas ambíguas
  const comparacao = variacao == null ? "" : Math.abs(variacao) < 0.01 ? `Gastos iguais a ${nomeAnt}${ehMesAtual ? ` no mesmo período` : ""}`
    : `Gastos <strong class="${variacao > 0 ? "sobe" : "desce"}">${Math.abs(variacao * 100).toFixed(0)}% ${variacao > 0 ? "acima" : "abaixo"}</strong> de ${nomeAnt}${ehMesAtual ? ` até o dia ${diaHoje}` : ""} (${Rp(base)})`;

  $("#conteudo").innerHTML = `
    <div class="cartao destaque hero-resultado">
      <div class="nota-texto">${mesFuturo ? `${maiuscula(nomeM)} ainda não começou` : `Resultado de ${nomeM}${ehMesAtual ? " até hoje" : ""}`}</div>
      <div class="linha-resultado"><div class="valor num ${resultado < 0 ? "sobe" : "desce"}">${Rp(Math.abs(resultado), resultado < 0 ? "−" : "+")}</div>
        ${mesFuturo || (totalReceitas === 0 && total === 0) ? "" : `<span class="selo-resultado ${resultado < 0 ? "ruim" : "bom"}">${resultado < 0 ? "no vermelho" : "no azul"}</span>`}</div>
      <div class="compara">Entradas − gastos − dívidas pagas${ehMesAtual ? ", só o que já aconteceu" : " no mês"}</div>
      <div class="hero-stats tres">
        <div><span>Entrou</span><strong class="num">${Rp(totalReceitas)}</strong></div>
        <div><span>Gastos</span><strong class="num">${Rp(total)}</strong></div>
        <div><span>Dívidas pagas</span><strong class="num">${Rp(pagoDividas)}</strong></div>
      </div>
      ${comparacao ? `<div class="compara" style="margin-top:10px">${comparacao}</div>` : ""}
      ${agendado > 0 ? `<div class="compara">+ ${R(agendado)} agendado para os próximos dias (ainda não conta)</div>` : ""}
    </div>

    ${nSemCat || nNotas ? `<div class="cartao a-fazer"><h3>A fazer</h3>
      ${nSemCat ? `<button class="acao-linha" data-acao="abrirTriagem">${ICONE.etiqueta}<span class="corpo"><strong>Categorizar ${pl(nSemCat, "lançamento", "lançamentos")}</strong><small>${estado.mes >= inicioCtrl && nSemCatMes ? `${nSemCatMes} em ${nomeM} · ` : ""}desde ${nomeMesAno(inicioCtrl)}, quando vocês começaram a controlar · iguais vêm agrupados</small></span><span class="seta">›</span></button>` : ""}
      ${nNotas ? `<button class="acao-linha" data-acao="verNotasPendentes">${ICONE.nota}<span class="corpo"><strong>Confirmar ${pl(nNotas, "nota fiscal", "notas fiscais")}</strong><small>sem gasto ligado${total > 0 ? ` · ${Math.round((comNota / total) * 100)}% dos gastos de ${nomeM} têm nota` : ""}</small></span><span class="seta">›</span></button>` : ""}
    </div>` : ""}

    <div class="grade-inicio">
      <div class="coluna">
        <div class="cartao cartao-async" id="cartaoMetas" data-acao="irMetas" style="cursor:pointer">${carregandoCartao("Plano do mês")}</div>
        <div class="cartao cartao-async" id="cartaoSugestoes" data-acao="irSugestoes" style="cursor:pointer">${carregandoCartao("Sugestões")}</div>
        <div class="cartao cartao-async" id="cartaoEvolucao">
          <h3>Evolução</h3>
          <div class="seg seg-peq">${PERIODOS_EVO.map(([k, n]) => `<button data-acao="periodoEvo" data-p="${k}">${n}</button>`).join("")}</div>
          <p class="nota-texto priv-aviso">Gráfico oculto. Toque no olho para ver.</p>
          <div class="corpo-evo priv-bloco"><div class="sk-grafico"></div></div>
        </div>
      </div>
      <div class="coluna">
        <div class="blocos">
          <button class="bloco neutro" data-acao="irPatrimonio" data-s="dividas">${ICONE.cartao}<span>Dívidas (tudo)</span><strong class="num ${devido > 0 ? "sobe" : ""}">${Rp(devido)}</strong>
            ${devidoCartoes > 0 ? `<small class="bloco-sub">acordos ${Rp(devidoAcordos)} + cartões ${Rp(devidoCartoes)}</small>` : ""}</button>
          <button class="bloco neutro" data-acao="irPatrimonio" data-s="investimentos">${ICONE.cofre}<span>Investido</span><strong class="num">${Rp(investido)}</strong><small class="bloco-sub">reserva e aplicações</small></button>
        </div>
        <div class="cartao">
          <h3>Gastos por categoria <span class="sub-h">${nomeM}</span></h3>
          ${cats.length ? `${cats.slice(0, TOP).map((c) => barraCat(c, total, corBarra(c))).join("")}
            ${cats.length > TOP ? `<details class="mais-cats"><summary>ver todas as ${cats.length} categorias</summary>${cats.slice(TOP).map((c) => barraCat(c, total, corBarra(c))).join("")}</details>` : ""}
            ${total > 0 && semClassificacao / total >= 0.1 ? `<p class="nota-texto alerta-texto">${Math.round((semClassificacao / total) * 100)}% dos gastos estão sem classificação real (Sem categoria + Outros). <a href="#" data-acao="abrirTriagem">Categorizar</a></p>` : ""}`
            : `<div class="vazio"><strong>Nenhum gasto neste mês</strong>Sincronize o Open Finance em Mais, ou escaneie uma nota.</div>`}
        </div>
        ${totalReceitas === 0 ? (ehMesAtual && diaSalario ? `<div class="cartao cartao-compacto"><div class="linha" style="cursor:default;border-top:0;padding:0"><div class="corpo">
          <div class="titulo">Nenhuma receita ainda em ${nomeM}</div><div class="meta">${diaSalario >= diaHoje ? `Salário previsto: dia ${diaSalario}` : `No mês passado o salário caiu no dia ${diaSalario}`}</div></div></div></div>` : "") : `<div class="cartao">
          <h3>Receitas <span class="sub-h">${nomeM}</span></h3>
          <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="titulo num entrada" style="font-size:20px">${Rp(totalReceitas)}</div>
            <div class="meta">${totalReceitasAnt ? `${nomeAnt} inteiro: ${Rp(totalReceitasAnt)}` : "Salário, Pix recebidos, reembolsos"}</div></div></div>
          ${recCats.map((c) => `<div class="barra-cat" data-acao="verReceita" data-id="${c.id ?? ""}">
              <div class="nome"><span>${esc(c.nome)}</span></div>
              <div class="num">${Rp(c.valor)}<span class="pct">${Math.round((c.valor / (totalReceitas || 1)) * 100)}%</span></div>
              <div class="trilho"><i style="width:${(c.valor / (recCats[0]?.valor || 1)) * 100}%;background:var(--ok)"></i></div></div>`).join("")}
        </div>`}
        ${bancos.length ? `<div class="cartao">
          <h3>Saldo nas contas <span class="sub-h">agora</span></h3>
          <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="titulo num ${saldoTotal < 0 ? "sobe" : ""}" style="font-size:20px">${Rp(Math.abs(saldoTotal), saldoTotal < 0 ? "−" : "")}</div>
            <div class="meta">Soma das contas correntes · atualizado ${haQuanto(bancos[0].atualizado_em)}</div></div></div>
          ${bancos.map((c) => `<div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(c.apelido || c.nome)}</div>
            ${Number(c.saldo) < 0 ? `<div class="meta"><span class="chip ${c.negativo_em_acordo ? "" : "alerta"}">${c.negativo_em_acordo ? "negativo em acordo" : "usando cheque especial"}</span></div>` : ""}</div>
            <div class="valor num ${Number(c.saldo) < 0 ? "sobe" : ""}">${Rp(Math.abs(Number(c.saldo)), Number(c.saldo) < 0 ? "−" : "")}</div></div>`).join("")}
          ${cartoes.map((c) => `<div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(c.apelido || c.nome)}</div><div class="meta">fatura do cartão · a pagar</div></div>
            <div class="valor num devido">${Rp(Math.abs(Number(c.saldo)), "−")}</div></div>`).join("")}
        </div>` : ""}
      </div>
    </div>
    <p class="nota-texto rodape-sync">${sync ? `Dados do banco atualizados ${haQuanto(sync.fim ?? sync.inicio)}${sync.ok === false ? ` · <span class="erro-texto">a última sincronização falhou</span>` : ""}` : "Banco ainda não sincronizado"} · <a href="#mais" data-acao="irOpenFinance">Open Finance</a></p>`;
  carregarResumoMetas();
  carregarEvolucao();
  carregarResumoSugestoes();
}
/** Esqueleto de um cartão que carrega depois (mantém a altura e evita "buracos" ao rolar). */
function carregandoCartao(titulo) { return `<h3>${esc(titulo)}</h3><div class="sk-linhas"><i></i><i></i><i></i></div>`; }
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
    todas(() => sb.from("v_gastos").select("data, valor").eq("conta_como_gasto", true).gte("data", inicio), CHAVE_VG),
    todas(() => sb.from("v_receitas").select("data, valor").gte("data", inicio), "transacao_id").catch(() => []),
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
    // Só meses completos: o mês corrente, recém-começado, pareceria uma queda
    const n = periodo === "12m" ? 12 : 6;
    baldes = Array.from({ length: n }, (_, i) => {
      const m = somarMes(mesAtual(), i - n);
      const fim = somarDias(somarMes(m, 1) + "-01", -1);
      return { ini: m + "-01", fim, rot: maiuscula(nomeMes(m).split(" ")[0].slice(0, 3)), dica: maiuscula(nomeMes(m)) };
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
  // Investimentos muito pequenos perto das despesas só fariam uma linha colada no zero
  const maxFluxo = Math.max(...desp, ...rec, 1);
  const maxInv = Math.max(0, ...inv.filter((v) => v != null));
  const semInvest = maxInv < maxFluxo * 0.03;
  return { baldes, acumulado, semInvest, maxInv, series: { despesas: desp, receitas: rec, invest: semInvest ? inv.map(() => null) : inv } };
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
    <div class="legenda-evo">${SERIES_EVO.filter((s) => !(s.k === "invest" && ev.semInvest)).map((s) => `<span><i class="${s.cls}"></i>${s.nome}</span>`).join("")}</div>
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
    <p class="nota-texto" style="margin:6px 0 0">${ev.acumulado ? "Despesas e receitas somadas desde o início do período (últimos 30 dias)." : n === 13 ? "Despesas e receitas somadas por semana." : "Despesas e receitas por mês, só meses completos (o mês atual fica de fora até terminar)."}
      ${ev.semInvest ? `Investimentos (${R(ev.maxInv)}) ficam fora: perto das despesas seriam uma linha no zero.` : `Investimentos: saldo no fim de cada ${ev.acumulado ? "dia" : n === 13 ? "semana" : "mês"}${ev.series.invest.some((v) => v == null) ? " (o histórico começa na primeira sincronização)" : ""}.`}</p>`;
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
    const comp = d.economia_composicao ?? [];
    const mesesRef = (d.referencia?.meses ?? []).map((m) => nomeMes(m).split(" ")[0].slice(0, 3)).join(", ");
    el.innerHTML = `<div class="cab-cartao"><h3>Sugestões <span class="sub-h">média de ${esc(mesesRef || "3 meses")}</span></h3><span class="chip acao">ver todas ›</span></div>
      ${d.economia_potencial > 0 ? `<div class="valor num desce" style="font-size:22px;font-weight:700;margin-top:6px">${Rp(d.economia_potencial)}<span class="nota-texto" style="font-weight:400"> por mês de economia possível</span></div>
      ${comp.length ? `<div class="nota-texto priv-bloco">= ${comp.map((c, i) => `${i ? (c.valor < 0 ? " − " : " + ") : ""}${esc(c.titulo)} (${R(Math.abs(c.valor))})`).join("")}</div>` : ""}` : ""}
      <p class="nota-texto priv-aviso">Sugestões ocultas. Toque no olho para ver.</p><ul class="lista priv-bloco">${top.map((x) => `<li class="linha" style="cursor:pointer"><span class="icone-sug ${x.tipo}">${ICONES_SUG[x.tipo]}</span><div class="corpo"><div class="titulo">${esc(x.titulo)}</div>${chipValorSugestao(x, true)}</div></li>`).join("")}</ul>`;
  } catch (e) {
    el.innerHTML = `<h3>Sugestões</h3><p class="nota-texto">Não consegui analisar agora (${esc(e.message)}).</p>`;
  }
}
acoes.irSugestoes = () => irPara("sugestoes");
acoes.irOpenFinance = () => { estado.abrirOpenFinance = true; irPara("mais"); };
/** Valor ao lado de uma sugestão: verde só para economia que entra no total; laranja para o tamanho de um problema. */
function chipValorSugestao(x, compacto = false) {
  if (x.economia_mensal && x.no_total) return compacto ? `<div class="meta num desce">economia de ${Rp(x.economia_mensal)}/mês</div>` : `<span class="chip ok" style="margin-left:auto">economia ${Rp(x.economia_mensal)}/mês</span>`;
  if (x.impacto_mensal) {
    const rot = x.id === "deficit" ? "faltam na média" : x.id === "acima-ideal" ? "acima do ideal" : "a mais";
    return compacto ? `<div class="meta num sobe">${rot} ${Rp(x.impacto_mensal)}/mês</div>` : `<span class="chip alerta" style="margin-left:auto">${rot} ${Rp(x.impacto_mensal)}/mês</span>`;
  }
  return "";
}
acoes.irNotas = () => irPara("notas");
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
    avisar(`${pl(r.novas, "lançamento novo", "lançamentos novos")}, ${pl(r.vinculadas, "nota ligada", "notas ligadas")}${r.avisos?.length ? " · " + r.avisos[0] : ""}`, !!r.avisos?.length);
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
/** "Transferência enviada|FULANO" → ["Transferência enviada", "FULANO"]; sem "|" → ["", descrição]. */
function partesDescricao(d = "") {
  const i = d.indexOf("|");
  return i > 0 ? [d.slice(0, i).trim(), d.slice(i + 1).trim() || d] : ["", d];
}
function inicial(t = "") { return (t.match(/[A-Za-zÀ-ÿ0-9]/)?.[0] ?? "•").toUpperCase(); }
/** Nome exibido do lançamento: apelido da casa > loja da nota > nome do banco, limpo. */
function tituloTx(t) {
  const ap = estado.apelidos?.[chaveNome(t.descricao)];
  if (ap) return ap;
  const nota = t.nota_transacao?.[0]?.notas?.nome_emitente;
  return nomeLimpo(nota || partesDescricao(t.descricao)[1]);
}
const ehPagamentoDivida = (t) => t.sentido === "saida" && estado.catPorId[t.categoria_id]?.nome === "Pagamento de dívida";

async function telaGastos() {
  inicioControle().catch(() => {});
  const f = estado.filtroGastos;
  const catF = estado.categoriaFiltro;
  const nomeCat = catF === "nula" ? "Sem categoria" : estado.catPorId[catF]?.nome;
  app.innerHTML = topoMes("Extrato") + `
    <div class="filtros">
      ${catF != null ? `<button class="filtro ativo" data-acao="limparCategoria">${esc(nomeCat)} ✕</button>` : ""}
      ${[["tudo", "Tudo"], ["despesas", "Despesas"], ["receitas", "Receitas"], ["dividas", "Dívidas"], ["sem-nota", "Sem nota"], ["sem-categoria", "Sem categoria"]]
        .map(([k, n]) => `<button class="filtro ${f === k ? "ativo" : ""}" data-acao="filtroGastos" data-f="${k}">${n}</button>`).join("")}
    </div>
    <div class="busca"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" id="buscaMov" placeholder="Buscar nome, loja, item da nota ou valor" value="${esc(estado.busca ?? "")}" autocomplete="off" enterkeyhint="search">
      <button class="limpar-busca" data-acao="limparBusca" aria-label="Limpar busca" ${estado.busca ? "" : "hidden"}>✕</button></div>
    <div class="filtros-extra">
      <label><span class="sr">Conta</span><select data-muda="contaFiltro" id="contaFiltro"><option value="">Todas as contas e cartões</option></select></label>
      <label><span class="sr">Ordem</span><select data-muda="ordemExtrato">
        <option value="data" ${estado.ordemExtrato !== "valor" ? "selected" : ""}>Mais recentes</option>
        <option value="valor" ${estado.ordemExtrato === "valor" ? "selected" : ""}>Maior valor</option></select></label>
    </div>
    <div id="conteudo">${carregando()}</div>`;
  const campo = $("#buscaMov");
  let timerBusca;
  campo.addEventListener("input", () => {
    $(".limpar-busca").hidden = !campo.value;
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => { estado.busca = campo.value.trim(); carregarMovimentacoes(); }, 250);
  });
  q(sb.from("contas").select("id, nome, apelido, tipo").eq("ativa", true).order("tipo").order("nome")).then((contas) => {
    const sel = $("#contaFiltro");
    if (!sel) return;
    estado.contasLista = contas;
    sel.innerHTML = `<option value="">Todas as contas e cartões</option>` + contas.map((c) =>
      `<option value="${esc(c.id)}" ${estado.contaFiltro === c.id ? "selected" : ""}>${esc(c.apelido || c.nome)}${c.tipo === "CREDIT" ? " (cartão)" : ""}</option>`).join("");
  }).catch(() => {});
  await carregarMovimentacoes();
}
acoes.limparBusca = () => { estado.busca = ""; const c = $("#buscaMov"); if (c) { c.value = ""; c.focus(); } $(".limpar-busca").hidden = true; carregarMovimentacoes(); };
mudancas.contaFiltro = (el) => { estado.contaFiltro = el.value || null; carregarMovimentacoes(); };
mudancas.ordemExtrato = (el) => { estado.ordemExtrato = el.value; carregarMovimentacoes(); };

/** Transforma a busca em palavras (sem acento) e valores: "açaí 36,75" → texto ["ACAI"], valores [36.75]. */
function interpretarBusca(texto) {
  const termos = normalizar(texto).replace(/R\$\s*/g, "").split(" ").filter(Boolean);
  const palavras = [], valores = [];
  for (const t of termos) {
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(t)) {
      const limpo = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : (/^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t);
      valores.push({ valor: Number(limpo), exato: /[.,]\d{1,2}$/.test(t) && !/^\d{1,3}(\.\d{3})+$/.test(t), texto: t });
    } else palavras.push(t);
  }
  return { palavras, valores };
}
function bateValor(v, alvo) {
  return alvo.exato ? Math.abs(v - alvo.valor) < 0.005 : Math.floor(v) === Math.floor(alvo.valor);
}

let cacheBusca = null;
async function carregarMovimentacoes() {
  const f = estado.filtroGastos;
  const catF = estado.categoriaFiltro;
  const nomeCat = catF === "nula" ? "Sem categoria" : estado.catPorId[catF]?.nome;
  const busca = (estado.busca ?? "").trim();
  const buscando = busca.length > 0;
  const cont = $("#conteudo");
  if (!cont) return;
  if (buscando && !cont.querySelector(".linha")) cont.innerHTML = carregando();
  const campos = "id, data, descricao, recebedor_nome, valor, sentido, status, categoria_id, parcela_numero, parcelas_total, observacao, conta_id, contas(apelido, nome, tipo), nota_transacao(nota_id, notas(nome_emitente))";

  let txs, itensQueBatem = new Map();
  if (buscando) {
    // Busca em todos os meses (a lista completa fica guardada por 2 minutos para a digitação ficar rápida)
    if (!cacheBusca || Date.now() - cacheBusca.em > 120000) {
      cacheBusca = { em: Date.now(), txs: await todas(() => sb.from("transacoes").select(campos).eq("removida", false)
        .order("data", { ascending: false }).order("valor", { ascending: false }).order("id")) };
    }
    const { palavras, valores } = interpretarBusca(busca);
    // Itens de nota fiscal (já guardados sem acento) que contêm todas as palavras
    if (palavras.length) {
      const maior = [...palavras].sort((a, b) => b.length - a.length)[0];
      if (maior.length >= 3) {
        const itens = await q(sb.from("nota_itens").select("nota_id, descricao, descricao_norm").ilike("descricao_norm", `%${maior}%`).limit(500)).catch(() => []);
        for (const i of itens) if (palavras.every((p) => (i.descricao_norm ?? normalizar(i.descricao)).includes(p))) {
          if (!itensQueBatem.has(i.nota_id)) itensQueBatem.set(i.nota_id, i.descricao);
        }
      }
    }
    txs = cacheBusca.txs.filter((t) => {
      if (valores.length && !valores.every((v) => bateValor(Number(t.valor), v))) return false;
      if (!palavras.length) return true;
      const texto = normalizar([t.descricao, tituloTx(t), t.observacao, t.contas?.apelido, t.contas?.nome, estado.catPorId[t.categoria_id]?.nome,
        ...t.nota_transacao.map((v) => v.notas?.nome_emitente)].filter(Boolean).join(" "));
      if (palavras.every((p) => texto.includes(p))) return true;
      return t.nota_transacao.some((v) => itensQueBatem.has(v.nota_id));
    });
  } else {
    const [ini, fim] = limites(estado.mes);
    txs = await todas(() => sb.from("transacoes").select(campos)
      .eq("removida", false).gte("data", ini).lt("data", fim)
      .order("data", { ascending: false }).order("valor", { ascending: false }).order("id"));
  }
  if ((estado.busca ?? "").trim() !== busca) return;   // chegou outra busca enquanto esta carregava

  let valorNaCategoria = null;
  if (catF != null && natureza(catF) === "despesa" || catF === "nula") {
    // Despesas com nota são divididas pelas categorias dos itens
    const alocado = await todas(() => {
      let c = sb.from("v_gastos").select("transacao_id, valor");
      if (!buscando) c = c.eq("mes", estado.mes);
      return catF === "nula" ? c.is("categoria_id", null) : c.eq("categoria_id", catF);
    }, CHAVE_VG);
    valorNaCategoria = new Map();
    for (const a of alocado) valorNaCategoria.set(a.transacao_id, (valorNaCategoria.get(a.transacao_id) ?? 0) + Number(a.valor));
    txs = txs.filter((t) => valorNaCategoria.has(t.id) || (catF === "nula" && t.categoria_id == null));
  } else if (catF != null) {
    txs = txs.filter((t) => t.categoria_id === catF);
  }
  if (estado.contaFiltro) txs = txs.filter((t) => t.conta_id === estado.contaFiltro);
  if (f === "despesas") txs = txs.filter((t) => tipoLancamento(t) === "despesa");
  if (f === "receitas") txs = txs.filter((t) => tipoLancamento(t) === "receita");
  if (f === "dividas") txs = txs.filter(ehPagamentoDivida);
  if (f === "sem-nota") txs = txs.filter((t) => tipoLancamento(t) === "despesa" && !t.nota_transacao.length);
  if (f === "sem-categoria") txs = txs.filter((t) => t.categoria_id == null);

  const antesDoControle = !buscando && estado.inicioControle && estado.mes < estado.inicioControle;
  const botaoTriagem = f === "sem-categoria" && antesDoControle ? `<div class="cartao cartao-compacto"><p class="nota-texto" style="margin:0">${nomeMes(estado.mes)} é anterior a ${nomeMesAno(estado.inicioControle)}, quando vocês começaram a controlar: estes lançamentos não entram na lista do que falta categorizar. <a href="#" data-acao="abrirPreferencias">Mudar o mês de início</a></p></div>`
    : f === "sem-categoria" ? `<div class="cartao cartao-triagem"><div class="linha" style="border-top:0;padding:0;cursor:default"><div class="corpo">
      <div class="titulo">Categorizar em sequência</div><div class="meta">Lançamentos iguais agrupados, um grupo por vez, com as categorias mais prováveis.</div></div>
      <button class="botao peq" data-acao="abrirTriagem">Começar</button></div></div>` : "";
  if (!txs.length) {
    $("#conteudo").innerHTML = buscando
      ? `<div class="vazio"><strong>Nada encontrado</strong>Nenhum lançamento com “${esc(busca)}” em nenhum mês${f !== "tudo" || catF != null || estado.contaFiltro ? " (com os filtros escolhidos)" : ""}.</div>`
      : `<div class="vazio"><strong>Nada por aqui</strong>Nenhum lançamento com este filtro em ${nomeMes(estado.mes)}.</div>`;
    return;
  }
  const totalEncontrado = txs.length;
  if (buscando && txs.length > 300) txs = txs.slice(0, 300);
  if (estado.ordemExtrato === "valor") txs = [...txs].sort((a, b) => Number(b.valor) - Number(a.valor));

  // Lançamentos com data futura (ex.: parcela que vence dia 5) ainda não aconteceram: ficam à parte e fora das somas
  const hoje = hojeISO();
  const futuros = buscando ? [] : txs.filter((t) => t.data > hoje);
  const atuais = buscando ? txs : txs.filter((t) => t.data <= hoje);
  const valorDe = (t) => Number(valorNaCategoria?.get(t.id) ?? t.valor);
  const somaTipo = (lista, tipo) => lista.filter((t) => tipoLancamento(t) === tipo).reduce((s, t) => s + valorDe(t), 0);
  const somaDividas = (lista) => lista.filter(ehPagamentoDivida).reduce((s, t) => s + Number(t.valor), 0);
  const entradas = somaTipo(atuais, "receita"), saidas = somaTipo(atuais, "despesa"), dividas = somaDividas(atuais);
  const diaADia = entradas - saidas, depois = diaADia - dividas;
  const sinalV = (v) => (v >= 0 ? "+" : "−");

  const linhaTx = (t) => {
    const tipo = tipoLancamento(t);
    const divida = ehPagamentoDivida(t);
    const temNota = t.nota_transacao.length > 0;
    const vCat = valorNaCategoria?.get(t.id);
    const [tipoTx] = partesDescricao(t.descricao);
    const titulo = tituloTx(t);
    const corAv = tipo === "neutro" && !divida ? "#8a8f98" : divida ? "#4e47a6" : (estado.catPorId[t.categoria_id]?.cor ?? "#8a8f98");
    const futuro = t.data > hoje;
    const marca = futuro ? `<span class="chip">agendado</span>` : divida ? `<span class="chip chip-divida">dívida · fora do dia a dia</span>` : tipo === "neutro" ? `<span class="chip chip-interno">não conta nas somas</span>` : "";
    return `<li class="linha ${tipo === "neutro" && !divida ? "tx-interna" : ""} ${futuro ? "tx-futura" : ""}" data-acao="abrirTransacao" data-id="${esc(t.id)}">
      <span class="avatar" style="background:${esc(corAv)}" aria-hidden="true">${esc(inicial(titulo))}</span>
      <div class="corpo">
        <div class="titulo">${temNota ? ICONE_NOTA + " " : ""}${esc(titulo)}</div>
        <div class="meta">${estado.ordemExtrato === "valor" || buscando ? dataCurta(t.data).slice(0, 5) + " · " : ""}${tipoTx ? esc(tipoTx) + " · " : ""}${esc(t.contas?.apelido || t.contas?.nome || "")}${t.parcelas_total > 1 ? ` · parcela ${t.parcela_numero}/${t.parcelas_total}` : ""}${t.status === "PENDING" && !futuro ? " · pendente" : ""}</div>
        <div class="meta">${tipo === "neutro" || divida ? marca : `${chipCategoria(t.categoria_id)} ${marca}`}</div>
        ${buscando && t.nota_transacao.some((v) => itensQueBatem.has(v.nota_id)) ? `<div class="meta item-achado">na nota: ${esc(itensQueBatem.get(t.nota_transacao.find((v) => itensQueBatem.has(v.nota_id)).nota_id))}</div>` : ""}
      </div>
      <div class="valor num ${tipo === "receita" ? "entrada" : tipo === "neutro" && !divida ? "neutro" : ""}">${t.sentido === "entrada" ? Rp(t.valor, "+") : `−${R(t.valor)}`}${vCat != null && Math.abs(vCat - t.valor) > 0.01 ? `<div class="nota-texto" style="text-align:right">${R(vCat)} aqui</div>` : ""}</div>
    </li>`;
  };
  const lista = (ts) => `<div class="cartao" style="padding:2px 14px"><ul class="lista">${ts.map(linhaTx).join("")}</ul></div>`;
  const porDia = new Map();
  for (const t of atuais) porDia.set(t.data, [...(porDia.get(t.data) ?? []), t]);
  const contaEscolhida = estado.contaFiltro ? (estado.contasLista ?? []).find((c) => c.id === estado.contaFiltro) : null;

  $("#conteudo").innerHTML = `
    ${botaoTriagem}
    <div class="cartao resumo-mov">
      <div><span class="nota-texto">Receitas</span><strong class="num entrada">${Rp(entradas, "+")}</strong></div>
      <div><span class="nota-texto">Despesas</span><strong class="num">${Rp(saidas, "−")}</strong></div>
      <div><span class="nota-texto">Dia a dia</span><strong class="num ${diaADia >= 0 ? "entrada" : "sobe"}">${Rp(Math.abs(diaADia), sinalV(diaADia))}</strong></div>
      ${dividas > 0 ? `<div class="resumo-divida"><span class="nota-texto">Pagamento de dívidas</span><strong class="num">${Rp(dividas, "−")}</strong></div>
      <div class="resumo-divida resumo-final"><span class="nota-texto">Depois das dívidas</span><strong class="num ${depois >= 0 ? "entrada" : "sobe"}">${Rp(Math.abs(depois), sinalV(depois))}</strong></div>` : ""}
    </div>
    <div class="nota-texto" style="margin:0 2px 4px">${buscando ? `${pl(totalEncontrado, "resultado", "resultados")} para “${esc(busca)}” em todos os meses${totalEncontrado > txs.length ? ` (mostrando os ${txs.length} mais recentes)` : ""}` : pl(atuais.length, "lançamento", "lançamentos")}${contaEscolhida ? ` em ${esc(contaEscolhida.apelido || contaEscolhida.nome)}` : ""}${valorNaCategoria && catF !== "nula" ? ` · ${R(saidas)} em ${esc(nomeCat)}` : ""}.
      Dia a dia = receitas − despesas de consumo. Pagamentos de dívida aparecem marcados e entram só em “depois das dívidas”; transferências entre contas, faturas e investimentos não contam.</div>
    ${futuros.length ? `<details class="secao-futuros" data-k="futuros"><summary>${pl(futuros.length, "lançamento agendado", "lançamentos agendados")} · ${R(futuros.reduce((s, t) => s + Number(t.valor), 0))} · ainda não aconteceram</summary>${lista(futuros)}</details>` : ""}
    ${estado.ordemExtrato === "valor" ? lista(atuais) : [...porDia.entries()].map(([dia, ts]) => {
      const e = somaTipo(ts, "receita"), sd = somaTipo(ts, "despesa"), dv = somaDividas(ts);
      const contados = ts.filter((t) => tipoLancamento(t) !== "neutro" || ehPagamentoDivida(t));
      const internos = ts.filter((t) => tipoLancamento(t) === "neutro" && !ehPagamentoDivida(t));
      return `<div class="dia"><span>${dataLonga(dia)}</span><span class="num">${e ? `<span class="entrada">${Rp(e, "+")}</span>` : ""}${e && sd ? " · " : ""}${sd ? `−${R(sd)}` : ""}${dv ? `${e || sd ? " · " : ""}<span class="dia-divida">dívidas −${R(dv)}</span>` : ""}</span></div>
      ${contados.length ? lista(contados) : ""}
      ${internos.length ? `<details class="internos" data-k="int-${dia}"><summary>${pl(internos.length, "movimentação interna", "movimentações internas")} · não entram nas somas</summary>${lista(internos)}</details>` : ""}`;
    }).join("")}`;
}
acoes.filtroGastos = (el) => { estado.filtroGastos = el.dataset.f; recarregar(); };
acoes.limparCategoria = () => { estado.categoriaFiltro = null; recarregar(); };

acoes.abrirTransacao = (el) => {
  // guarda onde a linha estava na tela para voltar ao mesmo lugar depois de editar
  estado.ultimaTx = el.dataset.id; estado.ancoraTx = { y: window.scrollY, topo: el.getBoundingClientRect().top };
  abrirTransacao(el.dataset.id);
};
/** Mostra "Salvo ✓" ao lado de um campo salvo automaticamente. */
function marcarSalvo(id, texto = "Salvo ✓", erro = false) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = texto;
  el.className = `salvo ${erro ? "erro-texto" : ""}`;
  clearTimeout(el._t);
  if (!erro) el._t = setTimeout(() => { el.textContent = ""; }, 2500);
}
async function abrirTransacao(id) {
  abrirFolha(carregando());
  const t = await q(sb.from("transacoes")
    .select("*, contas(apelido, nome, tipo), nota_transacao(nota_id, origem, notas(id, nome_emitente, valor_pago, emissao))")
    .eq("id", id).single());
  const d0 = new Date(t.data + "T12:00:00");
  const de = new Date(d0.getTime() - 15 * 86400000).toISOString();
  const ate = new Date(d0.getTime() + 4 * 86400000).toISOString();
  const notasLivres = t.sentido === "saida" ? await q(sb.from("notas").select("id, nome_emitente, valor_pago, emissao")
    .in("vinculo_status", ["pendente", "confirmar"]).gte("emissao", de).lte("emissao", ate).order("emissao", { ascending: false }).limit(30)).catch(() => []) : [];
  notasLivres.sort((a, b) => Math.abs(a.valor_pago - t.valor) - Math.abs(b.valor_pago - t.valor));
  const [dividasAtivas, pagamentoDivida] = t.sentido === "saida" ? await Promise.all([
    q(sb.from("dividas").select("id, nome").eq("ativa", true).eq("origem", "manual").order("nome")).catch(() => []),
    q(sb.from("divida_pagamentos").select("id, dividas(nome)").eq("transacao_id", t.id).maybeSingle()).catch(() => null),
  ]) : [[], null];
  const manual = String(t.id).startsWith("manual-");
  const nomeBanco = partesDescricao(t.descricao)[1];
  const chave = chaveNome(t.descricao);
  const futuro = t.data > hojeISO();
  estado.txAberta = t;
  await carregarRegrasNulas();
  const umAUm = bateRegraNula(t);

  abrirFolha(`
    <h2 style="margin-right:40px">${esc(tituloTx(t))}</h2>
    ${tituloTx(t) !== t.descricao ? `<div class="nota-texto">No banco: ${esc(t.descricao)}</div>` : ""}
    <div class="destaque" style="margin:8px 0 12px"><div class="valor num">${t.sentido === "entrada" ? Rp(t.valor, "+") : R(t.valor)}</div></div>
    <dl class="kv">
      <dt>Data</dt><dd>${dataCurta(t.data)}${futuro ? " (agendado — ainda não aconteceu)" : t.status === "PENDING" ? " (pendente)" : ""}</dd>
      <dt>Conta</dt><dd>${esc(t.contas?.apelido || t.contas?.nome)}</dd>
      ${t.parcelas_total > 1 ? `<dt>Parcela</dt><dd>${t.parcela_numero} de ${t.parcelas_total}</dd>` : ""}
      ${t.tipo_operacao ? `<dt>Tipo</dt><dd>${esc(tipoOperacaoTexto(t.tipo_operacao))}</dd>` : ""}
      ${t.recebedor_nome ? `<dt>Para</dt><dd>${esc(nomeLimpo(t.recebedor_nome))}</dd>` : ""}
    </dl>
    <p class="nota-texto" style="margin:10px 0 0">As alterações abaixo são salvas sozinhas.</p>
    <div class="cartao" style="margin-top:8px">
      <h3>Categoria <span class="salvo" id="salvoCat"></span></h3>
      ${seletorCategoria(t.categoria_id, `id="catTx" data-muda="categoriaTx" data-id="${esc(t.id)}"`, t.sentido)}
      ${umAUm ? `<p class="nota-texto">Há uma regra “sem categoria” para este texto: a categoria vale só para este lançamento e o app não aprende com ela.</p>`
        : `<label class="check"><input type="checkbox" id="aprenderTx" checked> Usar também nos lançamentos parecidos (mesma descrição)</label>`}
      ${t.nota_transacao.length ? `<p class="nota-texto">Este gasto tem nota fiscal: nos resumos, o valor é dividido pelas categorias dos itens.</p>` : ""}
    </div>
    ${chave ? `<div class="cartao">
      <h3>Nome exibido <span class="salvo" id="salvoApelido"></span></h3>
      <input type="text" id="apelidoTx" data-chave="${esc(chave)}" value="${esc(estado.apelidos?.[chave] ?? "")}" placeholder="${esc(nomeLimpo(nomeBanco))}" maxlength="60">
      <p class="nota-texto">Um apelido para “${esc(nomeLimpo(nomeBanco))}”. Vale para todos os lançamentos deste estabelecimento.</p>
    </div>` : ""}
    <div class="cartao">
      <h3>Nota fiscal</h3>
      ${t.nota_transacao.length ? t.nota_transacao.map((v) => `
        <div class="linha" style="cursor:default"><div class="corpo" data-acao="abrirNota" data-id="${v.nota_id}" style="cursor:pointer">
          <div class="titulo">${ICONE_NOTA} ${esc(v.notas?.nome_emitente ?? "Nota")}</div>
          <div class="meta">${dataHora(v.notas?.emissao)} · ${R(v.notas?.valor_pago)}${v.origem === "parcela" ? " · parcela" : ""}</div></div>
          <button class="botao peq sec" data-acao="desvincular" data-nota="${v.nota_id}" data-tx="${esc(t.id)}">Desligar</button></div>`).join("")
        : t.sentido === "saida" ? `<div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="meta">Nenhuma nota ligada${notasLivres.length ? ` · ${pl(notasLivres.length, "nota escaneada perto desta data", "notas escaneadas perto desta data")}` : ""}.</div></div>
          ${notasLivres.length ? `<button class="botao peq" data-acao="mostrarNotasLivres">Ligar nota</button>` : `<button class="botao peq sec" data-acao="irEscanear">Escanear nota</button>`}</div>`
        : `<p class="nota-texto">Receitas não têm nota fiscal.</p>`}
      ${notasLivres.length ? `<div id="notasLivres" ${t.nota_transacao.length ? "" : "hidden"}>${t.nota_transacao.length ? `<p class="nota-texto" style="margin:10px 0 4px">Ligar outra nota:</p>` : ""}
        ${notasLivres.map((n) => `<div class="candidato"><div class="corpo"><div class="titulo">${esc(n.nome_emitente ?? "Nota")}</div>
          <div class="meta nota-texto">${dataHora(n.emissao)} · ${R(n.valor_pago)}</div></div>
          <button class="botao peq" data-acao="vincular" data-nota="${n.id}" data-tx="${esc(t.id)}">Ligar</button></div>`).join("")}</div>` : ""}
    </div>
    ${pagamentoDivida ? `<div class="cartao"><h3>Dívida</h3><p class="nota-texto">Este lançamento é pagamento de <strong>${esc(pagamentoDivida.dividas?.nome)}</strong>.</p></div>`
      : dividasAtivas.length ? `<div class="cartao">
      <label class="interruptor"><span><strong>É pagamento de dívida?</strong><br><span class="nota-texto">Liga este lançamento a um acordo ou empréstimo</span></span>
        <input type="checkbox" role="switch" data-muda="alternarDivida"><i aria-hidden="true"></i></label>
      <div id="blocoDivida" hidden>
        <label class="campo"><span>Dívida</span><select id="dvLigar"><option value="">Escolha…</option>${dividasAtivas.map((d) => `<option value="${d.id}">${esc(d.nome)}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" id="dvAprender" checked> Reconhecer sozinho os próximos pagamentos com esta descrição</label>
        <button class="botao peq" data-acao="ligarDivida" data-tx="${esc(t.id)}">Registrar pagamento</button>
      </div></div>` : ""}
    <div class="cartao">
      <h3>Observação <span class="salvo" id="salvoObs"></span></h3>
      <textarea id="obsTx" rows="2" placeholder="Ex.: presente de aniversário" data-id="${esc(t.id)}">${esc(t.observacao ?? "")}</textarea>
    </div>
    ${manual ? `<div class="botoes"><button class="botao peq perigo" data-acao="excluirManual" data-id="${esc(t.id)}">Excluir lançamento</button></div>` : ""}`);

  // Observação e apelido: salvam sozinhos (ao parar de digitar e ao sair do campo)
  const obs = $("#obsTx");
  let timerObs;
  const salvarObs = async () => {
    clearTimeout(timerObs);
    const valor = obs.value.trim() || null;
    if (valor === (estado.txAberta?.observacao ?? null)) return;
    try {
      await q(sb.from("transacoes").update({ observacao: valor }).eq("id", t.id));
      estado.txAberta.observacao = valor; estado.folhaSujou = true; marcarSalvo("salvoObs");
    } catch (e) { marcarSalvo("salvoObs", e.message, true); }
  };
  obs.addEventListener("input", () => { clearTimeout(timerObs); timerObs = setTimeout(salvarObs, 900); });
  obs.addEventListener("blur", salvarObs);
  const ap = $("#apelidoTx");
  if (ap) {
    let timerAp;
    const salvarAp = async () => {
      clearTimeout(timerAp);
      const v = ap.value.trim();
      if (v === (estado.apelidos?.[chave] ?? "")) return;
      try { await salvarApelido(chave, v); estado.folhaSujou = true; marcarSalvo("salvoApelido"); }
      catch (e) { marcarSalvo("salvoApelido", e.message, true); }
    };
    ap.addEventListener("input", () => { clearTimeout(timerAp); timerAp = setTimeout(salvarAp, 900); });
    ap.addEventListener("blur", salvarAp);
  }
}
mudancas.categoriaTx = async (el) => {
  const cat = el.value ? Number(el.value) : null;
  marcarSalvo("salvoCat", "Salvando…");
  try {
    if (cat == null) {
      await q(sb.from("transacoes").update({ categoria_id: null, categoria_origem: null }).eq("id", el.dataset.id));
      marcarSalvo("salvoCat", "Categoria removida ✓");
    } else {
      const r = await fn("/categorizar-transacao", { transacao_id: el.dataset.id, categoria_id: cat, aprender: $("#aprenderTx")?.checked ?? false });
      marcarSalvo("salvoCat", r.outros_atualizados ? `Salvo ✓ · mais ${pl(r.outros_atualizados, "parecido", "parecidos")}` : "Salvo ✓");
    }
    estado.folhaSujou = true; cacheBusca = null; cacheSugestoes = null; cacheMetas = null;
  } catch (e) { marcarSalvo("salvoCat", e.message, true); }
};
mudancas.alternarDivida = (el) => { $("#blocoDivida").hidden = !el.checked; };
acoes.mostrarNotasLivres = (el) => { const b = $("#notasLivres"); if (b) { b.hidden = false; b.scrollIntoView({ block: "nearest", behavior: "smooth" }); } el.remove(); };
acoes.excluirManual = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Confirmar exclusão"; return; }
  try { await q(sb.from("transacoes").delete().eq("id", el.dataset.id)); avisar("Lançamento excluído"); estado.folhaSujou = true; fecharFolha(); }
  catch (e) { avisar(e.message, true); }
};
acoes.vincular = async (el) => {
  el.disabled = true;
  try {
    await fn("/vincular", { nota_id: el.dataset.nota, transacao_id: el.dataset.tx });
    avisar("Nota ligada ao gasto");
    estado.folhaSujou = true;
    fecharFolha();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.desvincular = async (el) => {
  el.disabled = true;
  try {
    await fn("/desvincular", { nota_id: el.dataset.nota, transacao_id: el.dataset.tx });
    avisar("Nota desligada");
    estado.folhaSujou = true;
    fecharFolha();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ---------- Apelidos de estabelecimentos (guardados nas preferências da casa)
async function carregarApelidos() {
  try {
    const r = await q(sb.from("preferencias").select("valor").eq("chave", "apelidos").maybeSingle());
    estado.apelidos = r?.valor ? JSON.parse(r.valor) : {};
  } catch { estado.apelidos = estado.apelidos ?? {}; }
}
async function salvarApelido(chave, apelido) {
  await carregarApelidos();                      // pega o que outra pessoa da casa possa ter salvo
  const mapa = { ...(estado.apelidos ?? {}) };
  if (apelido) mapa[chave] = apelido; else delete mapa[chave];
  await q(sb.from("preferencias").upsert({ chave: "apelidos", valor: JSON.stringify(mapa), atualizado_em: new Date().toISOString() }));
  estado.apelidos = mapa;
}

// ------------------------------------------------------------------ INÍCIO DO CONTROLE
// Lançamentos sem categoria só contam a partir do mês em que a casa começou a controlar
// (preferência controle_inicio, "AAAA-MM"; sem ela, o mês em que a casa foi criada).
async function inicioControle() {
  if (estado.inicioControle) return estado.inicioControle;
  let mes = null;
  try { mes = (await q(sb.from("preferencias").select("valor").eq("chave", "controle_inicio").maybeSingle()))?.valor ?? null; } catch { /* sem preferência */ }
  if (!/^\d{4}-\d{2}$/.test(mes ?? "")) {
    try { mes = String((await q(sb.from("casas").select("criado_em").eq("id", estado.casa?.casa_id).maybeSingle()))?.criado_em ?? "").slice(0, 7) || null; } catch { /* offline */ }
  }
  estado.inicioControle = /^\d{4}-\d{2}$/.test(mes ?? "") ? mes : mesAtual();
  return estado.inicioControle;
}
const nomeMesAno = (m) => { const [a, mm] = m.split("-"); return `${nomeMes(m).split(" ")[0]}/${a}`; };
/** Quantos lançamentos sem categoria desde o início do controle (até hoje). */
async function contarSemCategoria() {
  const ini = await inicioControle();
  const { count, error } = await sb.from("transacoes").select("id", { count: "exact", head: true })
    .eq("removida", false).is("categoria_id", null).gte("data", `${ini}-01`).lte("data", hojeISO());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// ------------------------------------------------------------------ REGRAS "SEM CATEGORIA"
// Estabelecimentos/pessoas que o usuário quer classificar um a um (sem aprender nem aplicar aos parecidos).
async function carregarRegrasNulas() {
  if (estado.regrasNulas) return estado.regrasNulas;
  const lista = await q(sb.from("regras_categoria").select("tipo, padrao, sentido").is("categoria_id", null).eq("alvo", "transacao")).catch(() => []);
  estado.regrasNulas = lista.map((r) => { let re = null; if (r.tipo === "regex") { try { re = new RegExp(r.padrao); } catch { /* inválida */ } } return { ...r, re }; });
  return estado.regrasNulas;
}
function bateRegraNula(t) {
  const texto = [t.descricao, t.recebedor_nome].filter(Boolean).join(" ");
  return (estado.regrasNulas ?? []).some((r) => (!r.sentido || r.sentido === t.sentido) && (r.tipo === "exato" ? chaveTexto(texto) === r.padrao : r.re?.test(normalizar(texto))));
}

// ------------------------------------------------------------------ TRIAGEM (categorizar em sequência)
// Lançamentos sem categoria agrupados pela descrição (a mesma chave que o servidor usa para aprender),
// um grupo por vez, com as categorias mais prováveis como botões.
const PALAVRAS_GENERICAS = new Set(["TRANSFERENCIA", "ENVIADA", "RECEBIDA", "COMPRA", "NO", "DEBITO", "CREDITO", "VIA", "PIX", "LTDA", "INSTITUICAO",
  "DE", "DA", "DO", "DOS", "DAS", "E", "PAGAMENTO", "PAGAMENTOS", "SERVICOS", "NUPAY", "CIA", "SA", "ME", "EIRELI", "COMERCIO", "BRASIL"]);
const palavrasChave = (k) => k.split(" ").filter((p) => p.length >= 3 && !PALAVRAS_GENERICAS.has(p));

acoes.abrirTriagem = async () => {
  abrirFolha(`<h2>Categorizar em sequência</h2>${carregando()}`);
  try {
    const campos = "id, data, descricao, recebedor_nome, valor, sentido, categoria_id, contas(apelido, nome)";
    const ini = await inicioControle();
    const [semCat, comCat] = await Promise.all([
      todas(() => sb.from("transacoes").select(campos).eq("removida", false).is("categoria_id", null).gte("data", `${ini}-01`).lte("data", hojeISO()).order("data", { ascending: false }).order("id")),
      todas(() => sb.from("transacoes").select("descricao, recebedor_nome, sentido, categoria_id").eq("removida", false).not("categoria_id", "is", null)
        .gte("data", somarMes(mesAtual(), -12) + "-01")),
    ]);
    await carregarRegrasNulas();
    const grupos = new Map();
    for (const t of semCat) {
      const umAUm = bateRegraNula(t);
      const k = umAUm ? `${t.sentido}|um:${t.id}` : `${t.sentido}|${chaveTexto([t.descricao, t.recebedor_nome].filter(Boolean).join(" "))}`;
      const g = grupos.get(k) ?? { chave: k, sentido: t.sentido, txs: [], total: 0, umAUm };
      g.txs.push(t); g.total += Number(t.valor);
      grupos.set(k, g);
    }
    // Histórico: categoria por palavra (para sugerir) e categorias mais usadas por sentido (reserva)
    const porPalavra = new Map(), usoPorSentido = { entrada: new Map(), saida: new Map() };
    for (const t of comCat) {
      const k = chaveTexto([t.descricao, t.recebedor_nome].filter(Boolean).join(" "));
      for (const p of new Set(palavrasChave(k))) {
        const m = porPalavra.get(`${t.sentido}|${p}`) ?? new Map();
        m.set(t.categoria_id, (m.get(t.categoria_id) ?? 0) + 1);
        porPalavra.set(`${t.sentido}|${p}`, m);
      }
      const u = usoPorSentido[t.sentido];
      u.set(t.categoria_id, (u.get(t.categoria_id) ?? 0) + 1);
    }
    estado.triagem = {
      grupos: [...grupos.values()].sort((a, b) => b.txs.length - a.txs.length || b.total - a.total),
      porPalavra, usoPorSentido, feitos: 0, lancamentos: 0, i: 0, total: semCat.length,
    };
    mostrarGrupoTriagem();
  } catch (e) { abrirFolha(`<h2>Categorizar em sequência</h2><div class="vazio"><strong>Não consegui carregar</strong>${esc(e.message)}</div>`); }
};

function sugestoesTriagem(g) {
  const tr = estado.triagem;
  const t0 = g.txs[0];
  const k = g.umAUm ? chaveTexto([t0.descricao, t0.recebedor_nome].filter(Boolean).join(" ")) : g.chave.slice(g.chave.indexOf("|") + 1);
  const pontos = new Map();
  for (const p of palavrasChave(k)) {
    const m = tr.porPalavra.get(`${g.sentido}|${p}`);
    if (m) for (const [cat, n] of m) pontos.set(cat, (pontos.get(cat) ?? 0) + n * 10);
  }
  const natOk = (c) => c && c.ativa && (g.sentido === "entrada" ? c.natureza !== "despesa" : c.natureza !== "receita");
  const lista = [...pontos.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => estado.catPorId[id]).filter(natOk);
  for (const [id] of [...tr.usoPorSentido[g.sentido].entries()].sort((a, b) => b[1] - a[1])) {
    const c = estado.catPorId[id];
    if (natOk(c) && !lista.includes(c)) lista.push(c);
    if (lista.length >= 6) break;
  }
  return { lista: lista.slice(0, 6), comBase: pontos.size > 0 };
}

function mostrarGrupoTriagem() {
  const tr = estado.triagem;
  const g = tr.grupos[tr.i];
  if (!g) {
    abrirFolha(`<h2>Pronto!</h2><div class="vazio"><strong>${tr.feitos ? `${pl(tr.lancamentos, "lançamento categorizado", "lançamentos categorizados")}` : "Nada para categorizar"}</strong>
      ${tr.grupos.length ? "Você passou por todos os grupos." : `Não há lançamentos sem categoria desde ${nomeMesAno(estado.inicioControle ?? mesAtual())}.`}</div>
      <div class="botoes"><button class="botao cheio" data-acao="fecharFolha">Fechar</button></div>`);
    return;
  }
  const t0 = g.txs[0];
  const { lista, comBase } = sugestoesTriagem(g);
  const n = g.txs.length;
  abrirFolha(`
    <div class="nota-texto" style="padding-right:48px">Grupo ${tr.i + 1} de ${tr.grupos.length} · ${pl(tr.total - tr.lancamentos, "lançamento sem categoria", "lançamentos sem categoria")} desde ${nomeMesAno(estado.inicioControle ?? mesAtual())} · <a href="#" data-acao="abrirPreferencias">mudar</a></div>
    <div class="plano-trilho" style="margin:6px 0 14px"><i style="width:${(tr.i / Math.max(tr.grupos.length, 1)) * 100}%;background:var(--acento)"></i></div>
    <h2>${esc(tituloTx(t0))}${n > 1 ? ` <span class="chip">×${n}</span>` : ""}</h2>
    <div class="nota-texto">${esc(t0.descricao)}</div>
    <div class="destaque" style="margin:8px 0 6px"><div class="valor num">${t0.sentido === "entrada" ? "+" : "−"}${R(g.total)}</div>
      <div class="compara">${g.sentido === "entrada" ? "entrada" : "saída"}${n > 1 ? ` · ${n} vezes` : ""}</div></div>
    <ul class="lista triagem-exemplos">${g.txs.slice(0, 4).map((t) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="meta">${dataCurta(t.data)} · ${esc(t.contas?.apelido || t.contas?.nome || "")}</div></div><div class="valor num">${R(t.valor)}</div></li>`).join("")}
      ${n > 4 ? `<li class="nota-texto" style="padding:6px 0">e mais ${n - 4}…</li>` : ""}</ul>
    <h3 style="margin:14px 0 8px">${comBase ? "Categorias mais prováveis" : "Categorias mais usadas"}</h3>
    <div class="botoes-cat">${lista.map((c) => `<button class="botao-cat" data-acao="aplicarTriagem" data-cat="${c.id}"><span class="ponto" style="background:${esc(c.cor)}"></span>${esc(c.nome)}</button>`).join("")}</div>
    <label class="campo" style="margin-top:10px"><span>Outra categoria</span>${seletorCategoria(null, `id="triagemOutra" data-muda="triagemOutra"`, g.sentido)}</label>
    ${g.umAUm ? `<p class="nota-texto">Regra “sem categoria”: este é classificado sozinho, sem mudar os outros nem aprender.</p>` : `${n > 1 ? `<label class="check"><input type="checkbox" id="triagemTodos" checked> Aplicar aos ${n} lançamentos deste grupo</label>` : ""}
    <label class="check"><input type="checkbox" id="triagemAprender" checked> Aprender para os próximos lançamentos parecidos</label>`}
    <div class="botoes"><button class="botao sec" data-acao="pularTriagem">Pular</button>${tr.i > 0 ? `<button class="botao sec" data-acao="voltarTriagem">Voltar</button>` : ""}</div>`);
}
async function aplicarTriagem(cat) {
  const tr = estado.triagem;
  const g = tr.grupos[tr.i];
  const todos = $("#triagemTodos")?.checked ?? true;
  const ids = todos ? g.txs.map((t) => t.id) : [g.txs[0].id];
  $("#folha .painel")?.classList.add("ocupado");
  try {
    const r = await fn("/categorizar-lote", { transacao_ids: ids, categoria_id: cat, aprender: g.umAUm ? false : ($("#triagemAprender")?.checked ?? true) });
    tr.feitos++; tr.lancamentos += ids.length;
    estado.folhaSujou = true; cacheBusca = null; cacheSugestoes = null; cacheMetas = null;
    avisar(`${estado.catPorId[cat]?.nome}: ${pl(ids.length, "lançamento", "lançamentos")}${r.outros_atualizados ? ` + ${pl(r.outros_atualizados, "parecido", "parecidos")}` : ""}`);
    if (todos) tr.grupos.splice(tr.i, 1);
    else { const feito = g.txs.shift(); g.total -= Number(feito.valor); if (!g.txs.length) tr.grupos.splice(tr.i, 1); }
    mostrarGrupoTriagem();
  } catch (e) { avisar(e.message, true); $("#folha .painel")?.classList.remove("ocupado"); }
}
acoes.aplicarTriagem = (el) => aplicarTriagem(Number(el.dataset.cat));
mudancas.triagemOutra = (el) => { if (el.value) aplicarTriagem(Number(el.value)); };
acoes.pularTriagem = () => { estado.triagem.i++; mostrarGrupoTriagem(); };
acoes.voltarTriagem = () => { estado.triagem.i = Math.max(0, estado.triagem.i - 1); mostrarGrupoTriagem(); };

// ------------------------------------------------------------------ ESCANEAR
/** Cada casa tem a sua fila (a casa 1 mantém o nome antigo). */
const chaveFila = () => ((estado.casa?.casa_id ?? 1) === 1 ? "filaNotas" : `filaNotas:${estado.casa.casa_id}`);
/** Fila de notas escaneadas sem internet: [{texto, em}] (versões antigas guardavam só o texto). */
function lerFila() {
  try { return JSON.parse(localStorage.getItem(chaveFila()) ?? "[]").map((x) => (typeof x === "string" ? { texto: x, em: Date.now() } : x)); }
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
    <div class="titulo">${pl(fila.length, "nota aguardando", "notas aguardando")} internet</div>
    <div class="meta">Serão enviadas à SEFAZ assim que a conexão voltar</div></div>
    ${navigator.onLine ? `<button class="botao peq" data-acao="enviarFila">Enviar agora</button>` : `<span class="chip alerta">offline</span>`}</div>
    <ul class="lista">${fila.map((x) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${numeroDaChave(x.texto) ? `Nota nº ${esc(numeroDaChave(x.texto))}` : "Nota fiscal"}</div>
      <div class="meta">escaneada ${dataHora(new Date(x.em).toISOString())}</div></div></li>`).join("")}</ul></div>`;
}
function gravarFila(f) { try { localStorage.setItem(chaveFila(), JSON.stringify(f)); } catch { /* sem armazenamento */ } }

async function telaEscanear() {
  const fila = lerFila();
  app.innerHTML = `
    <div class="topo"><h1>Escanear nota</h1><button class="botao peq sec" data-acao="fecharEscanear" aria-label="Fechar a câmera e voltar">✕ Fechar</button></div>
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
acoes.fecharEscanear = () => irPara(estado.abaAnterior && estado.abaAnterior !== "escanear" ? estado.abaAnterior : "inicio");

// ---------- Botão "+": escanear nota, lançar gasto ou receita à mão
function abrirMenuAdicionar() {
  abrirFolha(`<h2>Adicionar</h2>
    <div class="menu-adicionar">
      <button data-acao="menuEscanear"><span class="icone-bloco b1">${ICONE.nota}</span><span><strong>Escanear nota fiscal</strong><small>QR code da NFC-e: itens e categorias automáticos</small></span></button>
      <button data-acao="lancarManual" data-sentido="saida"><span class="icone-bloco b2">${ICONE.cartao}</span><span><strong>Lançar gasto</strong><small>Dinheiro vivo ou algo que o banco não mostra</small></span></button>
      <button data-acao="lancarManual" data-sentido="entrada"><span class="icone-bloco b4">${ICONE.cofre}</span><span><strong>Lançar receita</strong><small>Dinheiro recebido fora das contas conectadas</small></span></button>
    </div>`);
}
acoes.menuEscanear = () => { fecharFolha(); setTimeout(() => irPara("escanear"), 60); };
acoes.lancarManual = async (el) => {
  const sentido = el.dataset.sentido;
  const contas = await q(sb.from("contas").select("id, nome, apelido, tipo").eq("ativa", true).order("tipo").order("nome")).catch(() => []);
  const idDinheiro = `manual-dinheiro-${estado.casa?.casa_id ?? 0}`;
  const opcoes = [{ id: idDinheiro, nome: "Dinheiro" }, ...contas.filter((c) => c.id !== idDinheiro)];
  abrirFolha(`<h2>${sentido === "saida" ? "Lançar gasto" : "Lançar receita"}</h2>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Valor (R$)</span><input type="text" inputmode="decimal" id="mnValor" placeholder="0,00" autocomplete="off"></label>
      <label class="campo" style="flex:1"><span>Data</span><input type="date" id="mnData" value="${hojeISO()}" max="${hojeISO()}"></label>
    </div>
    <label class="campo"><span>Descrição</span><input type="text" id="mnDesc" placeholder="${sentido === "saida" ? "Ex.: feira, pastel, estacionamento" : "Ex.: venda, presente"}" maxlength="80"></label>
    <label class="campo"><span>Categoria</span>${seletorCategoria(null, `id="mnCat"`, sentido)}</label>
    <label class="campo"><span>${sentido === "saida" ? "Pago com" : "Recebido em"}</span><select id="mnConta">${opcoes.map((c) => `<option value="${esc(c.id)}">${esc(c.apelido || c.nome)}${c.tipo === "CREDIT" ? " (cartão)" : ""}</option>`).join("")}</select></label>
    <p class="nota-texto" style="margin-top:-4px">Use para o que não aparece no extrato do banco (dinheiro vivo, por exemplo). Se escolher uma conta conectada, o banco também vai mostrar o lançamento e ele aparecerá duas vezes.</p>
    <label class="campo"><span>Observação (opcional)</span><input type="text" id="mnObs" maxlength="120"></label>
    <div class="botoes"><button class="botao cheio" data-acao="salvarManual" data-sentido="${sentido}" data-dinheiro="${esc(idDinheiro)}">Salvar</button></div>`);
  setTimeout(() => $("#mnValor")?.focus(), 60);
};
acoes.salvarManual = async (el) => {
  const valor = numeroDigitado($("#mnValor").value);
  const desc = $("#mnDesc").value.trim();
  const data = $("#mnData").value;
  if (!(valor > 0)) return avisar("Informe o valor", true);
  if (!desc) return avisar("Escreva uma descrição", true);
  if (!data) return avisar("Informe a data", true);
  const conta = $("#mnConta").value;
  const cat = $("#mnCat").value ? Number($("#mnCat").value) : null;
  el.disabled = true;
  try {
    if (conta === el.dataset.dinheiro) {
      await q(sb.from("contas").upsert({ id: conta, tipo: "CASH", nome: "Dinheiro", ativa: true }, { onConflict: "id", ignoreDuplicates: true }));
    }
    await q(sb.from("transacoes").insert({
      id: `manual-${crypto.randomUUID()}`, conta_id: conta, data, descricao: `Lançamento manual|${desc}`, valor, sentido: el.dataset.sentido,
      status: "POSTED", tipo_operacao: "MANUAL", categoria_id: cat, categoria_origem: cat ? "manual" : null, observacao: $("#mnObs").value.trim() || null,
    }));
    cacheBusca = null; cacheSugestoes = null; cacheMetas = null; estado.evo = null;
    avisar(el.dataset.sentido === "saida" ? "Gasto lançado" : "Receita lançada");
    estado.folhaSujou = true;
    fecharFolha();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
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
  if (enviadas) avisar(enviadas === 1 ? "A nota guardada offline foi processada" : `${enviadas} notas guardadas offline foram processadas`);
  if (falhas.length) avisar(`${pl(falhas.length, "nota da fila não pôde ser lida", "notas da fila não puderam ser lidas")}: ${falhas[0]}`, true);
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
// ------------------------------------------------------------------ bloqueio com biometria (WebAuthn)
// Usa o leitor do próprio aparelho (digital, rosto ou PIN/padrão da tela). A credencial fica no
// aparelho; o app só guarda o identificador dela. É uma trava local: o login (Supabase) continua valendo.
const CHAVE_BLOQUEIO = "bloqueioBiometria";
const TEMPO_FORA = 60 * 1000;               // fora do app por mais de 1 min → pede de novo
function bloqueioSalvo() { try { return JSON.parse(localStorage.getItem(CHAVE_BLOQUEIO) ?? "null"); } catch { return null; } }
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));
async function biometriaDisponivel() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}
async function verificarBiometria() {
  const salvo = bloqueioSalvo();
  if (!salvo) return true;
  const r = await navigator.credentials.get({ publicKey: {
    challenge: aleatorio(32), timeout: 60000, userVerification: "required", rpId: location.hostname,
    allowCredentials: [{ type: "public-key", id: deB64(salvo.id), transports: ["internal", "hybrid"] }],
  } });
  return !!r && r.response?.authenticatorData && (new Uint8Array(r.response.authenticatorData)[32] & 0x04) !== 0; // bit UV: o usuário foi verificado
}
let desbloqueado = false, escondidoEm = null, aoDesbloquear = null;
function telaBloqueio(msg = "") {
  abas.hidden = true;
  document.body.classList.add("bloqueado");
  let el = $("#telaBloqueio");
  if (!el) { el = document.createElement("div"); el.id = "telaBloqueio"; document.body.appendChild(el); }
  el.innerHTML = `<div class="login"><div class="marca"><img src="icons/dolar-192.png" alt=""><div><h1>Finanças da Casa</h1><div class="nota-texto">App bloqueado</div></div></div>
    <div class="cartao" style="text-align:center">
      <div class="icone-cadeado"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
      <p style="margin:6px 0 14px">Use a digital, o rosto ou o PIN do aparelho para entrar.</p>
      ${msg ? `<p class="erro-texto" style="margin:-6px 0 12px">${esc(msg)}</p>` : ""}
      <button class="botao cheio" data-acao="desbloquear">Desbloquear</button>
      <button class="botao peq sec" style="margin-top:12px" data-acao="sair">Sair da conta</button>
    </div></div>`;
}
function exigirDesbloqueio() {
  return new Promise((ok) => {
    aoDesbloquear = ok;
    telaBloqueio();
    acoes.desbloquear();   // tenta abrir o leitor na hora (alguns aparelhos pedem um toque no botão)
  });
}
acoes.desbloquear = async () => {
  try {
    if (!(await verificarBiometria())) throw new Error("Não foi possível confirmar");
    desbloqueado = true;
    document.body.classList.remove("bloqueado", "fundo-privado");
    $("#telaBloqueio")?.remove();
    const f = aoDesbloquear; aoDesbloquear = null;
    if (f) f(); else abas.hidden = false;
  } catch (e) {
    if ($("#telaBloqueio")) telaBloqueio(e?.name === "NotAllowedError" ? "" : "Não deu certo. Tente de novo.");
  }
};
document.addEventListener("visibilitychange", () => {
  if (!bloqueioSalvo() || !desbloqueado) return;
  if (document.hidden) {
    escondidoEm = Date.now();
    document.body.classList.add("fundo-privado");     // esconde os valores na lista de apps recentes
  } else {
    document.body.classList.remove("fundo-privado");
    if (escondidoEm && Date.now() - escondidoEm > TEMPO_FORA) {
      desbloqueado = false;
      exigirDesbloqueio().then(() => { abas.hidden = false; });
    }
    escondidoEm = null;
  }
});
async function montarCartaoBloqueio() {
  const el = $("#cartaoBloqueio");
  if (!el) return;
  if (!(await biometriaDisponivel())) {
    el.outerHTML = `<div class="cartao"><h2 style="margin:0">Bloqueio com biometria</h2><p class="nota-texto" style="margin:4px 0 0">Este aparelho ou navegador não oferece leitura de digital/rosto para sites. No celular Android com Chrome ela costuma estar disponível.</p></div>`;
    return;
  }
  const ativo = !!bloqueioSalvo();
  el.outerHTML = `<div class="cartao" id="cartaoBloqueio"><div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo">
    <div class="titulo">Bloqueio com biometria</div>
    <div class="meta">${ativo ? "Ativo neste aparelho: o app pede digital, rosto ou PIN ao abrir e ao voltar depois de 1 minuto." : "Pede digital, rosto ou o PIN do aparelho toda vez que o app abrir."}</div></div>
    <button class="botao peq ${ativo ? "sec" : ""}" data-acao="${ativo ? "desativarBloqueio" : "ativarBloqueio"}">${ativo ? "Desativar" : "Ativar"}</button></div></div>`;
}
acoes.ativarBloqueio = async (el) => {
  el.disabled = true;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: aleatorio(32),
      rp: { name: "Finanças da Casa", id: location.hostname },
      user: { id: aleatorio(16), name: estado.email ?? "usuario", displayName: estado.email ?? "Finanças da Casa" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000, attestation: "none",
    } });
    localStorage.setItem(CHAVE_BLOQUEIO, JSON.stringify({ id: b64(cred.rawId), em: Date.now() }));
    desbloqueado = true;
    avisar("Bloqueio ativado neste aparelho");
  } catch (e) {
    avisar(e?.name === "NotAllowedError" ? "Ativação cancelada" : `Não consegui ativar: ${e?.message ?? e}`, e?.name !== "NotAllowedError");
  }
  montarCartaoBloqueio();
};
acoes.desativarBloqueio = async (el) => {
  el.disabled = true;
  try {
    if (!(await verificarBiometria())) throw new Error();
    localStorage.removeItem(CHAVE_BLOQUEIO);
    avisar("Bloqueio desativado neste aparelho");
  } catch { avisar("Confirme com a biometria para desativar", true); }
  montarCartaoBloqueio();
};

// ------------------------------------------------------------------ instalar o app
// O Chrome avisa (beforeinstallprompt) quando o app pode ser instalado; guardamos o aviso para o botão.
let pedidoInstalar = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  pedidoInstalar = e;
  if (estado.aba === "mais") atualizarCartaoInstalar();
});
window.addEventListener("appinstalled", () => { pedidoInstalar = null; atualizarCartaoInstalar(); avisar("App instalado"); });
const appInstalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function cartaoInstalar() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let corpo;
  if (appInstalado()) {
    return "";   // já está aberto como app: nada a oferecer
  } else if (pedidoInstalar) {
    corpo = `<p class="nota-texto" style="margin:4px 0 12px">Com o app instalado ele abre em tela cheia, com ícone próprio, e funciona sem internet.</p>
      <button class="botao cheio" data-acao="instalarApp">Instalar app</button>`;
  } else if (ios) {
    corpo = `<p class="nota-texto" style="margin:4px 0 0">No Safari, toque em <strong>Compartilhar</strong> (quadrado com seta) e depois em <strong>Adicionar à Tela de Início</strong>.</p>`;
  } else {
    corpo = `<p class="nota-texto" style="margin:4px 0 0">No Chrome, abra o menu <strong>⋮</strong> e toque em <strong>Instalar app</strong> (ou <strong>Adicionar à tela inicial</strong>). No computador, use o ícone de instalar na barra de endereço.</p>`;
  }
  return `<div class="cartao" id="cartaoInstalar"><h2 style="margin:0">Instalar no celular</h2>${corpo}</div>`;
}
function atualizarCartaoInstalar() {
  const el = $("#cartaoInstalar");
  if (!el) return;
  const novo = cartaoInstalar();
  if (novo) el.outerHTML = novo; else el.remove();
}
acoes.instalarApp = async () => {
  if (!pedidoInstalar) return atualizarCartaoInstalar();
  pedidoInstalar.prompt();
  const { outcome } = await pedidoInstalar.userChoice.catch(() => ({}));
  pedidoInstalar = null;
  if (outcome !== "accepted") avisar("Instalação cancelada. Você pode instalar depois pelo menu do Chrome.");
  atualizarCartaoInstalar();
};

// ------------------------------------------------------------------ NOTIFICAÇÕES
// Cada aparelho se inscreve (Web Push). O servidor avisa a cada lançamento novo depois da sincronização.
const notifSuportada = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** Service worker pronto (ou null se não ficar pronto em 4 s, ex.: primeira abertura). */
function registroSW() { return Promise.race([navigator.serviceWorker.ready, new Promise((ok) => setTimeout(() => ok(null), 4000))]); }
async function assinaturaPush() { const reg = await registroSW(); return reg ? reg.pushManager.getSubscription() : null; }
function bytesDeB64u(s) { const p = "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + p), (c) => c.charCodeAt(0)); }
function prefsNotifDaTela() {
  return { despesas: $("#ntDespesas")?.checked ?? true, receitas: $("#ntReceitas")?.checked ?? true, valores: $("#ntValores")?.checked ?? true };
}
async function montarCartaoNotificacoes() {
  const el = $("#cartaoNotificacoes"), resumo = $("#resumoNotif");
  if (!el) return;
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!notifSuportada()) {
    resumo.textContent = "· indisponível";
    el.innerHTML = `<p class="nota-texto">${iOS && !instalado ? "No iPhone, as notificações só funcionam com o app instalado na tela de início (Compartilhar → Adicionar à Tela de Início). Depois abra por lá e volte aqui." : "Este navegador não permite notificações de apps da web."}</p>`;
    return;
  }
  if (Notification.permission === "denied") {
    resumo.textContent = "· bloqueadas";
    el.innerHTML = `<p class="nota-texto">As notificações estão bloqueadas para este site nas configurações do navegador. Para ligar: toque no cadeado ao lado do endereço (ou em Configurações do site) → Notificações → Permitir, e volte aqui.</p>`;
    return;
  }
  let estadoServ = { inscrito: false, prefs: null };
  const sub = await assinaturaPush().catch(() => null);
  if (sub && navigator.onLine) estadoServ = await fn("/notificacoes", { acao: "estado", endpoint: sub.endpoint }).catch(() => estadoServ);
  const ligado = !!sub && estadoServ.inscrito && Notification.permission === "granted";
  const p = estadoServ.prefs ?? { despesas: true, receitas: true, valores: true };
  resumo.textContent = ligado ? "· ligadas neste aparelho" : "· desligadas";
  el.innerHTML = `
    <label class="interruptor"><span><strong>Avisar lançamentos novos</strong><br><span class="nota-texto">Uma notificação para cada despesa ou receita que chegar do banco${ligado ? "" : ". Desligado: o app não notifica neste aparelho."}</span></span>
      <input type="checkbox" role="switch" data-muda="alternarNotificacoes" ${ligado ? "checked" : ""}><i aria-hidden="true"></i></label>
    <div id="opcoesNotif" ${ligado ? "" : "hidden"} style="margin-top:12px">
      <label class="check"><input type="checkbox" id="ntDespesas" data-muda="prefsNotificacoes" ${p.despesas !== false ? "checked" : ""}> Despesas</label>
      <label class="check"><input type="checkbox" id="ntReceitas" data-muda="prefsNotificacoes" ${p.receitas !== false ? "checked" : ""}> Receitas</label>
      <label class="check"><input type="checkbox" id="ntValores" data-muda="prefsNotificacoes" ${p.valores !== false ? "checked" : ""}> Mostrar o valor na notificação (desmarque para aparecer só “Nova despesa”)</label>
      <div class="botoes" style="margin-top:4px"><button class="botao peq sec" data-acao="testarNotificacao">Enviar notificação de teste</button></div>
    </div>
    <p class="nota-texto">Vale só para este aparelho: cada pessoa liga no próprio celular. Transferências entre contas, faturas e investimentos não geram aviso. O app procura dados novos na Pluggy a cada 30 minutos.</p>`;
}
mudancas.alternarNotificacoes = async (el) => {
  el.disabled = true;
  try {
    if (el.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Sem permissão para notificar. Permita as notificações quando o navegador perguntar.");
      const { publica } = await fn("/notificacoes", { acao: "chave" });
      const reg = await registroSW();
      if (!reg) throw new Error("O app ainda está terminando de se instalar neste aparelho. Recarregue a página e tente de novo.");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDeB64u(publica) });
      await fn("/notificacoes", { acao: "assinar", subscription: sub.toJSON(), ...prefsNotifDaTela() });
      avisar("Notificações ligadas neste aparelho");
    } else {
      const sub = await assinaturaPush();
      if (sub) { await fn("/notificacoes", { acao: "cancelar", endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
      avisar("Notificações desligadas neste aparelho");
    }
  } catch (e) {
    avisar(/permission|denied|not allowed/i.test(e.message) ? "O navegador não deixou ligar as notificações. Confira a permissão de notificações deste site nas configurações do navegador." : e.message, true);
  }
  el.disabled = false;
  montarCartaoNotificacoes();
};
mudancas.prefsNotificacoes = async () => {
  try {
    const sub = await assinaturaPush();
    if (!sub) return;
    await fn("/notificacoes", { acao: "assinar", subscription: sub.toJSON(), ...prefsNotifDaTela() });
    avisar("Preferência salva");
  } catch (e) { avisar(e.message, true); }
};
acoes.testarNotificacao = async (el) => {
  el.disabled = true;
  try {
    const sub = await assinaturaPush();
    if (!sub) throw new Error("Este aparelho não está inscrito");
    await fn("/notificacoes", { acao: "testar", endpoint: sub.endpoint });
    avisar("Notificação de teste enviada");
  } catch (e) { avisar(e.message, true); montarCartaoNotificacoes(); }
  el.disabled = false;
};

// ---------- Tema (claro, escuro ou o do aparelho). Vale só para este aparelho.
const TEMAS = [["auto", "Seguir o aparelho"], ["claro", "Claro"], ["escuro", "Escuro"]];
function temaAtual() { try { const t = localStorage.getItem("tema"); return t === "claro" || t === "escuro" ? t : "auto"; } catch { return "auto"; } }
function aplicarTema(t) {
  const h = document.documentElement;
  if (t === "claro") h.dataset.theme = "light"; else if (t === "escuro") h.dataset.theme = "dark"; else delete h.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = t === "claro" ? "#F4F3EF" : t === "escuro" ? "#0B0B0C" : m.dataset.padrao; });
}
function htmlEscolhaTema() {
  const atual = temaAtual();
  return `<div class="seg" role="radiogroup" aria-label="Tema">${TEMAS.map(([k, n]) => `<button role="radio" aria-checked="${k === atual}" class="${k === atual ? "ativo" : ""}" data-acao="escolherTema" data-tema="${k}">${k === "auto" ? "Automático" : n}</button>`).join("")}</div>
    <p class="nota-texto" style="margin-bottom:0">Automático segue o modo claro/escuro do celular. A escolha vale só para este aparelho.</p>`;
}
acoes.escolherTema = (el) => {
  const t = el.dataset.tema;
  try { if (t === "auto") localStorage.removeItem("tema"); else localStorage.setItem("tema", t); } catch { /* sem armazenamento: vale até fechar */ }
  aplicarTema(t);
  el.parentElement.querySelectorAll("button").forEach((b) => { const sim = b === el; b.classList.toggle("ativo", sim); b.setAttribute("aria-checked", String(sim)); });
  const r = $("#resumoTema"); if (r) r.textContent = `· ${TEMAS.find(([k]) => k === t)[1].toLowerCase()}`;
};

// ---------- Procura dados novos ao abrir o app (no máximo a cada 10 minutos por aparelho)
async function verificarAoAbrir() {
  if (!navigator.onLine || sessaoOffline || !estado.casa) return;
  const chave = `ultimaVerificacao:${estado.casa.casa_id}`;
  try {
    if (Date.now() - Number(localStorage.getItem(chave) || 0) < 10 * 60000) return;
    localStorage.setItem(chave, String(Date.now()));
  } catch { /* sem armazenamento: verifica mesmo assim */ }
  try {
    const r = await fn("/verificar", {});
    if (!r.sincronizou) return;
    cacheBusca = null; cacheSugestoes = null; cacheMetas = null; estado.evo = null;
    if (r.novas) avisar(`Chegaram ${pl(r.novas, "lançamento novo", "lançamentos novos")} do banco`);
    if (folha.hidden && ["inicio", "gastos", "metas"].includes(estado.aba)) recarregarNoLugar();
  } catch { /* tenta de novo na próxima abertura */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) verificarAoAbrir(); });

// ------------------------------------------------------------------ CASA
// Cada casa tem os próprios dados. A casa aberta fica guardada para abrir offline.
const CHAVE_CASA = "casaAberta";
function lerCasaSalva() {
  try {
    const c = JSON.parse(localStorage.getItem(CHAVE_CASA) ?? "null");
    return c && c.email === estado.email ? c : null;
  } catch { return null; }
}
function guardarCasa(c) {
  estado.casa = { ...c, email: estado.email };
  try { localStorage.setItem(CHAVE_CASA, JSON.stringify(estado.casa)); } catch { /* sem armazenamento */ }
}
const ehRobo = (email) => /^robo-casa-/.test(email ?? "");

acoes.renomearCasa = async () => {
  const nome = $("#nomeCasa").value.trim();
  if (!nome) return avisar("Dê um nome para a casa", true);
  try {
    await q(sb.from("casas").update({ nome }).eq("id", estado.casa.casa_id));
    guardarCasa({ ...estado.casa, nome, casas: (estado.casa.casas ?? []).map((c) => (c.id === estado.casa.casa_id ? { ...c, nome } : c)) });
    avisar("Nome salvo");
    recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.abrirCasa = async (el) => {
  try {
    const sub = notifSuportada() ? await assinaturaPush().catch(() => null) : null;
    if (sub) { await fn("/notificacoes", { acao: "cancelar", endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    const r = await q(sb.rpc("trocar_casa", { p_casa: Number(el.dataset.id) }));
    guardarCasa(r);
    location.hash = "";
    location.reload();
  } catch (e) { avisar(e.message, true); }
};
acoes.sairDaCasa = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Confirmar saída"; return; }
  try {
    const r = await q(sb.rpc("sair_da_casa", { p_casa: estado.casa.casa_id }));
    guardarCasa(r);
    location.hash = "";
    location.reload();
  } catch (e) { avisar(e.message, true); }
};

async function telaMais() {
  app.innerHTML = `<div class="topo"><h1>Mais</h1></div><div id="conteudo">${carregando()}</div>`;
  const [cfg, itens, contas, logs, membros, regras] = await Promise.all([
    fn("/config", null, "GET").catch((e) => ({ erro: e.message })),
    q(sb.from("pluggy_itens").select("*").order("criado_em")),
    q(sb.from("contas").select("*").order("tipo").order("nome")),
    q(sb.from("sync_log").select("*").order("inicio", { ascending: false }).limit(8)),
    q(sb.from("membros").select("*").order("criado_em")).then((l) => l.filter((m) => !ehRobo(m.email))),
    todas(() => sb.from("regras_categoria").select("id, alvo, tipo, padrao, origem, categoria_id, criado_em").order("criado_em", { ascending: false }).order("id")),
  ]);
  const ultimo = logs[0];
  estado.regrasLista = regras;
  if (navigator.onLine) {
    const casas = await q(sb.rpc("minhas_casas")).catch(() => null);
    if (casas) guardarCasa({ ...estado.casa, casas, nome: casas.find((c) => c.id === estado.casa.casa_id)?.nome ?? estado.casa.nome });
  }
  const casas = estado.casa.casas ?? [];

  $("#conteudo").innerHTML = `
    ${cartaoInstalar()}
    <div id="cartaoBloqueio"></div>
    <details class="secao" id="secaoAparencia"><summary>Aparência <span class="resumo-secao" id="resumoTema">· ${TEMAS.find(([k]) => k === temaAtual())[1].toLowerCase()}</span></summary><div class="conteudo">${htmlEscolhaTema()}</div></details>
    <details class="secao" id="secaoNotificacoes"><summary>Notificações <span class="resumo-secao" id="resumoNotif"></span></summary><div class="conteudo" id="cartaoNotificacoes"><p class="nota-texto">Verificando…</p></div></details>
    <div class="atalhos">
      <button class="atalho" data-acao="irPatrimonio" data-s="investimentos"><span class="icone-bloco b3">${ICONE.banco}</span><span>Patrimônio</span></button>
      <button class="atalho" data-acao="irSugestoes"><span class="icone-bloco b1">${ICONE.ideia}</span><span>Sugestões</span></button>
      <button class="atalho" data-acao="irNotas"><span class="icone-bloco b2">${ICONE.nota}</span><span>Notas fiscais</span></button>
    </div>

    <details class="secao" id="secaoOpenFinance" ${!cfg.pluggy_configurado || !itens.length || estado.abrirOpenFinance ? "open" : ""}><summary>Open Finance <span class="resumo-secao">${ultimo ? (ultimo.ok === false ? "· última sincronização falhou" : `· atualizado ${haQuanto(ultimo.fim ?? ultimo.inicio)}`) : "· não configurado"}</span></summary><div class="conteudo">
      <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="titulo">Sincronização</div>
        <div class="meta">${ultimo ? `Última: ${haQuanto(ultimo.fim ?? ultimo.inicio)}${ultimo.ok === false ? ` · <span class="erro-texto">${esc(ultimo.mensagem ?? "")}</span>` : ""}` : "Nunca sincronizado"} · automática às 6h15 e 18h15</div></div>
        <button class="botao peq" data-acao="sincronizar">Sincronizar agora</button></div>
      <h3 style="margin-top:18px">Credenciais da Pluggy</h3>
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
      <details style="margin-top:14px"><summary class="nota-texto" style="cursor:pointer">Histórico de sincronização</summary><ul class="lista">
      ${logs.map((l) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${dataHora(l.inicio)} · ${esc(l.origem ?? "")}</div>
        <div class="meta">${l.ok ? `${pl(l.novas, "novo", "novos")} · ${pl(l.vinculadas, "nota ligada", "notas ligadas")}` : `<span class="erro-texto">${esc(l.mensagem ?? "em andamento")}</span>`}</div></div></li>`).join("") || "<li class='nota-texto'>Nada ainda.</li>"}
      </ul></details>
    </div></details>

    <details class="secao"><summary>Apelidos das contas e cartões (${contas.length})</summary><div class="conteudo">
      ${contas.length ? contas.map((c) => `<label class="campo"><span>${esc(c.nome)} · ${c.tipo === "CREDIT" ? "cartão" : "conta"}${c.numero ? ` ${esc(c.numero)}` : ""}${c.saldo != null ? ` · ${c.tipo === "CREDIT" ? "fatura" : "saldo"} ${R(Math.abs(c.saldo))}` : ""}</span>
        <input type="text" value="${esc(c.apelido ?? "")}" placeholder="Apelido (ex.: Itaú, Nubank cartão)" data-muda="apelidoConta" data-id="${esc(c.id)}"></label>`).join("")
        : `<p class="nota-texto">As contas aparecem depois da primeira sincronização.</p>`}
    </div></details>

    <details class="secao" id="secaoCategorias" ${estado.abrirCategorias ? "open" : ""}><summary>Categorias</summary><div class="conteudo">
      <p class="nota-texto" style="margin-top:0">As categorias em que os gastos se dividem. Toque numa para mudar nome, grupo ou classe. As metas de valor ficam no orçamento, em Metas. Para o app escolher a categoria sozinho, use “Regras automáticas”.</p>
      ${Object.entries(CLASSES).map(([k, rot]) => {
        const cs = estado.categorias.filter((c) => c.classe === k && c.ativa);
        return `<h3 style="margin:14px 0 4px">${rot}</h3><ul class="lista">${cs.map((c) => `<li class="linha" data-acao="editarCategoria" data-id="${c.id}">
          <div class="corpo"><div class="titulo"><span class="ponto" style="background:${esc(c.cor)}"></span> ${esc(c.nome)}</div>
          <div class="meta">${esc(c.grupo)}${k === "emergencial" ? " · forma a reserva para imprevistos" : ""}</div></div>
          <span class="chip">editar</span></li>`).join("")}</ul>`;
      }).join("")}
      <h3 style="margin:14px 0 4px">Receitas e movimentos</h3>
      <p class="nota-texto" style="margin:0">${estado.categorias.filter((c) => c.natureza !== "despesa").map((c) => esc(c.nome)).join(" · ")}</p>
      <h3 style="margin-top:18px">Nova categoria</h3>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label class="campo" style="flex:2"><span>Nome</span><input type="text" id="catNome" placeholder="Ex.: Filhos"></label>
        <label class="campo" style="flex:1"><span>Grupo</span><input type="text" id="catGrupo" placeholder="Família"></label>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label class="campo" style="flex:2"><span>Classe</span><select id="catClasse">${Object.entries(CLASSES).map(([k, r]) => `<option value="${k}">${r}</option>`).join("")}</select></label>
        <label class="campo" style="flex:0 0 52px"><span>Cor</span><input type="color" id="catCor" value="#4b8f8c" style="height:44px;width:52px;padding:2px;border-radius:10px;border:1px solid var(--borda)"></label>
      </div>
      <button class="botao peq" data-acao="criarCategoria">Adicionar categoria</button>
    </div></details>

    <details class="secao"><summary>Regras automáticas</summary><div class="conteudo">
      <p class="nota-texto">Regras dizem ao app qual categoria usar quando a descrição do banco ou o item da nota contém um texto. Já vêm regras para mercados, farmácias, combustível, apps de transporte etc.; crie as suas para o que for só de vocês. Ao categorizar um lançamento com “usar nos parecidos”, o app também cria uma regra aprendida.</p>
      <label class="campo"><span>Quando a descrição contém</span><input type="text" id="regraTexto" placeholder="Ex.: PIX TRANSF MARIA"></label>
      <div style="display:flex;gap:8px">
        <label class="campo" style="flex:1"><span>Em</span><select id="regraAlvo"><option value="transacao">Lançamentos do banco</option><option value="item">Itens de nota</option></select></label>
        <label class="campo" style="flex:1"><span>Categoria</span>${seletorCategoria(null, `id="regraCat"`).replace(`<option value="">Sem categoria</option>`, `<option value="">Sem categoria (classificar à mão)</option>`)}</label>
      </div>
      <p class="nota-texto" style="margin-top:-4px">Com <strong>Sem categoria</strong>, o que tiver esse texto nunca é classificado sozinho: fica no “A fazer” para você escolher a categoria de cada um, e o app não aprende com essas escolhas.</p>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="criarRegra">Criar regra</button>
      <button class="botao peq sec" data-acao="reaplicarRegras">Reaplicar regras a tudo</button></div>
      <div class="busca" style="margin-top:16px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" id="buscaRegra" placeholder="Buscar regra por texto ou categoria" autocomplete="off"></div>
      <div id="listaRegras">${htmlListaRegras("")}</div>
    </div></details>

    <details class="secao"><summary>Categorização com IA (opcional)</summary><div class="conteudo">
      <p class="nota-texto">Itens que nenhuma regra reconhece podem ser classificados pelo Claude (custa centavos por mês). Crie uma chave em console.anthropic.com.</p>
      <p class="nota-texto">${cfg.anthropic_configurado ? "✓ Chave configurada." : "Nenhuma chave configurada."}</p>
      <label class="campo"><span>Chave da API Anthropic</span><input type="password" id="chaveIA" autocomplete="off" placeholder="sk-ant-…"></label>
      <div class="botoes" style="margin-top:0"><button class="botao peq" data-acao="salvarIA">Salvar</button>
      ${cfg.anthropic_configurado ? `<button class="botao peq perigo" data-acao="removerIA">Remover</button>` : ""}</div>
    </div></details>

    <details class="secao" id="secaoCasa"><summary>Casa e convites · ${esc(estado.casa.nome ?? "")}</summary><div class="conteudo">
      <label class="campo"><span>Nome da casa</span><input type="text" id="nomeCasa" value="${esc(estado.casa.nome ?? "")}" maxlength="60"></label>
      <button class="botao peq" data-acao="renomearCasa">Salvar nome</button>
      ${casas.length > 1 ? `<h3 style="margin:16px 0 4px">Suas casas</h3>
      <ul class="lista">${casas.map((c) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(c.nome)}</div>
        <div class="meta">${pl(c.membros, "pessoa", "pessoas")}</div></div>
        ${c.id === estado.casa.casa_id ? `<span class="chip">aberta</span>` : `<button class="botao peq" data-acao="abrirCasa" data-id="${c.id}">Abrir</button>`}</li>`).join("")}</ul>` : ""}
      <h3 style="margin:16px 0 4px">Quem tem acesso (${membros.length})</h3>
      <ul class="lista">${membros.map((m) => `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(m.email)}</div>
        ${m.aceito_em ? "" : `<div class="meta">convite ainda não aceito</div>`}</div>
        ${m.email !== estado.email ? `<button class="botao peq perigo" data-acao="removerMembro" data-email="${esc(m.email)}">Remover</button>` : `<span class="chip">você</span>`}</li>`).join("")}</ul>
      <label class="campo"><span>Convidar por e-mail</span><input type="email" id="novoMembro" placeholder="email@exemplo.com"></label>
      <button class="botao peq" data-acao="adicionarMembro">Convidar</button>
      <p class="nota-texto">A pessoa entra no app com este e-mail (Google ou e-mail e senha) e passa a ver os dados desta casa. Quem entra sem convite ganha uma casa própria, vazia, com a Pluggy dela.</p>
      ${membros.length > 1 ? `<button class="botao peq perigo" data-acao="sairDaCasa">Sair desta casa</button>` : ""}
    </div></details>

    <div class="cartao plano"><div class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(estado.email)}</div><div class="meta">Versão ${VERSAO}</div></div>
      <button class="botao peq sec" data-acao="sair">Sair</button></div></div>`;
  montarCartaoBloqueio();
  montarCartaoNotificacoes();
  const campoRegra = $("#buscaRegra");
  if (campoRegra) { let t; campoRegra.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { $("#listaRegras").innerHTML = htmlListaRegras(campoRegra.value); }, 150); }); }
  if (estado.abrirCategorias) { estado.abrirCategorias = false; $("#secaoCategorias")?.scrollIntoView({ block: "start" }); }
  if (estado.abrirOpenFinance) { estado.abrirOpenFinance = false; $("#secaoOpenFinance")?.scrollIntoView({ block: "start" }); }
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
  try { const r = await fn("/descobrir-itens"); avisar(r.encontrados ? pl(r.encontrados, "conexão encontrada", "conexões encontradas") : (r.aviso ?? "Nenhuma encontrada"), !r.encontrados); recarregar(); }
  catch (e) { avisar(e.message, true); el.disabled = false; }
};
mudancas.apelidoConta = async (el) => {
  try { await q(sb.from("contas").update({ apelido: el.value.trim() || null }).eq("id", el.dataset.id)); avisar("Apelido salvo"); }
  catch (e) { avisar(e.message, true); }
};
const ORIGENS_REGRA = { sistema: "do app", usuario: "sua", aprendida: "aprendida", ia: "pela IA" };
/** Lista de regras: sem busca, as suas e as aprendidas; com busca, todas (inclusive as que vêm com o app). */
function htmlListaRegras(busca) {
  const todasRegras = estado.regrasLista ?? [];
  const termos = normalizar(busca).split(" ").filter(Boolean);
  const texto = (r) => r.tipo === "exato" ? r.padrao : r.padrao.replace(/\\b/g, "").replace(/\\(.)/g, "$1");
  const lista = termos.length
    ? todasRegras.filter((r) => { const t = normalizar([texto(r), r.categoria_id == null ? "sem categoria" : estado.catPorId[r.categoria_id]?.nome, ORIGENS_REGRA[r.origem]].join(" ")); return termos.every((p) => t.includes(p)); })
    : todasRegras.filter((r) => r.origem !== "sistema");
  const MAX = 300;
  if (!lista.length) return `<p class="nota-texto">${termos.length ? `Nenhuma regra com “${esc(busca)}”.` : "Você ainda não criou regras (as do app aparecem ao buscar)."}</p>`;
  return `<h3 style="margin-top:14px">${termos.length ? `${pl(lista.length, "regra encontrada", "regras encontradas")}` : `Regras suas e aprendidas (${lista.length})`}</h3>
    <ul class="lista">${lista.slice(0, MAX).map((r) => `
      <li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">${esc(texto(r))}</div>
      <div class="meta">${r.alvo === "item" ? "item de nota" : "lançamento"} · ${ORIGENS_REGRA[r.origem] ?? esc(r.origem)} ${r.categoria_id == null ? `<span class="chip alerta">fica sem categoria</span>` : chipCategoria(r.categoria_id)}</div></div>
      <button class="botao peq sec" data-acao="apagarRegra" data-id="${r.id}" aria-label="Apagar regra">✕</button></li>`).join("")}</ul>
    ${lista.length > MAX ? `<p class="nota-texto">Mostrando ${MAX} de ${lista.length}. Refine a busca.</p>` : ""}`;
}
acoes.criarRegra = async () => {
  const texto = normalizar($("#regraTexto").value);
  const cat = $("#regraCat").value ? Number($("#regraCat").value) : null;   // vazio = regra "sem categoria"
  if (!texto) return avisar("Preencha o texto da regra", true);
  const padrao = texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const nat = cat != null ? estado.categorias.find((c) => c.id === cat)?.natureza : null;
    const sentido = $("#regraAlvo").value === "transacao" ? (nat === "receita" ? "entrada" : nat === "despesa" ? "saida" : null) : null;
    await q(sb.from("regras_categoria").insert({ alvo: $("#regraAlvo").value, tipo: "regex", padrao, categoria_id: cat, prioridade: cat == null ? 0 : 2, origem: "usuario", sentido }));
    estado.regrasNulas = null; cacheBusca = null; cacheSugestoes = null; cacheMetas = null;
    const r = await fn("/recategorizar");
    avisar(cat == null
      ? `Regra criada: “${texto}” fica sem categoria · ${pl(r.gastos_alterados, "lançamento voltou", "lançamentos voltaram")} para classificar (os que você classificou à mão não mudam)`
      : `Regra criada · ${pl(r.gastos_alterados, "lançamento", "lançamentos")} e ${pl(r.itens_alterados, "item", "itens")} atualizados`);
    recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.reaplicarRegras = async (el) => {
  el.disabled = true;
  try { const r = await fn("/recategorizar"); avisar(`${pl(r.gastos_alterados, "lançamento", "lançamentos")} e ${pl(r.itens_alterados, "item", "itens")} atualizados`); }
  catch (e) { avisar(e.message, true); }
  el.disabled = false;
};
acoes.apagarRegra = async (el) => {
  try {
    await q(sb.from("regras_categoria").delete().eq("id", Number(el.dataset.id)));
    estado.regrasLista = (estado.regrasLista ?? []).filter((r) => r.id !== Number(el.dataset.id));
    estado.regrasNulas = null;
    el.closest("li").remove(); avisar("Regra apagada (use “Reaplicar regras a tudo” para refazer as categorias)");
  }
  catch (e) { avisar(e.message, true); }
};
acoes.editarCategoria = (el) => {
  const c = estado.catPorId[Number(el.dataset.id)];
  if (!c) return;
  abrirFolha(`<h2>${esc(c.nome)}</h2>
    <label class="campo"><span>Nome</span><input type="text" id="ecNome" value="${esc(c.nome)}"></label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Grupo</span><input type="text" id="ecGrupo" value="${esc(c.grupo)}"></label>
      <label class="campo" style="flex:0 0 52px"><span>Cor</span><input type="color" id="ecCor" value="${esc(c.cor)}" style="height:44px;width:52px;padding:2px;border-radius:10px;border:1px solid var(--borda)"></label>
    </div>
    <label class="campo"><span>Classe</span><select id="ecClasse">${Object.entries(CLASSES).map(([k, r]) => `<option value="${k}" ${c.classe === k ? "selected" : ""}>${r}</option>`).join("")}</select></label>
    <p class="nota-texto">Emergenciais não têm meta: o quanto gastam por ano vira a meta da reserva para imprevistos.</p>
    <div class="botoes"><button class="botao cheio" data-acao="salvarCategoria" data-id="${c.id}">Salvar</button></div>
    <div class="botoes"><button class="botao peq sec" data-acao="arquivarCategoria" data-id="${c.id}">Ocultar categoria</button></div>`);
};
acoes.salvarCategoria = async (el) => {
  const nome = $("#ecNome").value.trim();
  if (!nome) return avisar("Dê um nome à categoria", true);
  el.disabled = true;
  try {
    await q(sb.from("categorias").update({
      nome, grupo: $("#ecGrupo").value.trim() || "Outros", cor: $("#ecCor").value, classe: $("#ecClasse").value,
    }).eq("id", Number(el.dataset.id)));
    await carregarCategorias();
    cacheSugestoes = null; cacheMetas = null;
    avisar("Categoria salva");
    fecharFolha();
    estado.abrirCategorias = true;
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.arquivarCategoria = async (el) => {
  try {
    await q(sb.from("categorias").update({ ativa: false }).eq("id", Number(el.dataset.id)));
    await carregarCategorias();
    avisar("Categoria ocultada (lançamentos antigos continuam com ela)");
    fecharFolha(); estado.abrirCategorias = true; recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.criarCategoria = async () => {
  const nome = $("#catNome").value.trim();
  if (!nome) return avisar("Dê um nome à categoria", true);
  try {
    const classe = $("#catClasse").value;
    const ordem = { essencial_variavel: 39, essencial_fixo: 59, emergencial: 69, estilo_vida: 89 }[classe] ?? 89;
    await q(sb.from("categorias").insert({ nome, grupo: $("#catGrupo").value.trim() || "Outros", cor: $("#catCor").value, ordem, classe, natureza: "despesa" }));
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
  try { await q(sb.from("membros").insert({ email })); avisar("Convite registrado: é só a pessoa entrar no app com este e-mail"); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.removerMembro = async (el) => {
  if (el.dataset.confirmar !== "1") { el.dataset.confirmar = "1"; el.textContent = "Confirmar"; return; }
  try { await q(sb.from("membros").delete().eq("email", el.dataset.email)); recarregar(); } catch (e) { avisar(e.message, true); }
};
acoes.sair = async () => { await apagarLocal(); try { localStorage.removeItem(CHAVE_BLOQUEIO); localStorage.removeItem(CHAVE_CASA); } catch { /* ok */ } await sb.auth.signOut().catch(() => {}); location.hash = ""; location.reload(); };

// ------------------------------------------------------------------ PATRIMÔNIO
// Investimentos (aplicações agrupadas em caixinhas) e dívidas.
const TIPOS_DIVIDA = { acordo: "Acordo", emprestimo: "Empréstimo", financiamento: "Financiamento", cartao: "Cartão", cheque_especial: "Cheque especial", pessoa: "Pessoa", outro: "Outro" };
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
    avisar(r.outros_reconhecidos ? `Registrado. Mais ${pl(r.outros_reconhecidos, "pagamento reconhecido", "pagamentos reconhecidos")} no extrato.` : "Pagamento registrado na dívida");
    estado.folhaSujou = true;
    fecharFolha();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ METAS (plano financeiro)
let cacheMetas = null;
async function obterMetas(forcar = false, mes = mesAtual()) {
  if (!forcar && cacheMetas && cacheMetas.mes === mes && Date.now() - cacheMetas.em < 2 * 60000) return cacheMetas.dados;
  const dados = await fn("/metas", { mes });
  cacheMetas = { em: Date.now(), mes, dados };
  return dados;
}
const ICONE_STATUS = { pago: "✓", parcial: "½", atrasado: "!", hoje: "•", pendente: "○" };
const NOME_STATUS = { pago: "pago", parcial: "pago em parte", atrasado: "atrasado", hoje: "vence hoje", pendente: "a pagar" };
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const sinal = (v) => (v < 0 ? "−" : "+");
const mesAno = (d) => { const [a, m] = d.split("-"); return `${m}/${a}`; };

async function telaMetas() {
  const aba = estado.abaMetas ?? "mes";
  const mes = estado.mes > mesAtual() ? mesAtual() : estado.mes;   // o mesmo mês do Início (o plano vai até o mês atual)
  const seletor = aba === "mes" ? `<div class="seletor-mes"><button data-acao="mesMetasAnterior" aria-label="Mês anterior">‹</button><span>${mesCurto(mes)}</span><button data-acao="mesMetasSeguinte" aria-label="Próximo mês" ${mes >= mesAtual() ? "disabled" : ""}>›</button></div>` : "";
  app.innerHTML = `<div class="topo"><h1>Metas</h1>${botaoOlho()}${seletor}</div>
    <div class="seg">${[["mes", "Mês"], ["acordos", "Acordos"], ["objetivos", "Objetivos"]].map(([k, n]) =>
      `<button class="${aba === k ? "ativo" : ""}" data-acao="abaMetas" data-s="${k}">${n}</button>`).join("")}</div>
    <div id="conteudo">${carregando()}</div>`;
  let d, vdiv = [];
  try {
    [d, vdiv] = await Promise.all([
      obterMetas(true, aba === "mes" ? mes : mesAtual()),
      aba === "acordos" ? q(sb.from("v_dividas").select("saldo_devedor, fonte, tipo")).catch(() => []) : [],
    ]);
  } catch (e) { $("#conteudo").innerHTML = `<div class="vazio"><strong>Não consegui carregar as metas</strong>${esc(e.message)}</div>`; return; }
  estado.metas = d;
  $("#conteudo").innerHTML = aba === "acordos" ? htmlAcordos(d, vdiv) : aba === "objetivos" ? htmlObjetivos(d) : htmlMes(d);
}
acoes.abaMetas = (el) => { estado.abaMetas = el.dataset.s; recarregar(); };
acoes.irMetas = (el) => { estado.abaMetas = el?.dataset?.s || estado.abaMetas || "mes"; irPara("metas"); };
acoes.mesMetasAnterior = () => { estado.mes = somarMes(estado.mes > mesAtual() ? mesAtual() : estado.mes, -1); recarregar(); };
acoes.mesMetasSeguinte = () => { const m = somarMes(estado.mes, 1); if (m <= mesAtual()) { estado.mes = m; recarregar(); } };

function linhaConta(c) {
  const difere = c.status === "pago" && c.pago_valor && Math.abs(c.pago_valor - c.valor) > c.valor * 0.05;
  const quando = c.status === "pago" ? (c.pago_em ? `pago em ${dataCurta(c.pago_em).slice(0, 5)}` : "pago") + (difere ? ` · ${R(c.pago_valor)} (${c.pago_valor < c.valor ? "abaixo" : "acima"} do previsto)` : "")
    : c.status === "parcial" ? `pago ${R(c.pago_valor)} de ${R(c.valor)}` : c.data ? NOME_STATUS[c.status] : "a pagar · sem dia de vencimento";
  const [, mm, dd] = (c.data ?? "").split("-");
  const selo = c.data ? `<span class="data-conta ${c.status}" aria-label="vence dia ${Number(dd)}"><b>${Number(dd)}</b><small>${MESES_CURTOS[Number(mm) - 1]}</small></span>`
    : `<span class="data-conta sem-dia" aria-label="sem dia de vencimento"><b>?</b><small>dia</small></span>`;
  return `<li class="linha conta-mes ${c.status}" ${c.tipo === "acordo" ? `data-acao="abrirDivida" data-id="${c.ref}"` : `data-acao="editarItemOrcamento" data-id="${c.ref}"`}>
    ${selo}
    <div class="corpo"><div class="titulo">${esc(c.nome)}</div><div class="meta"><span class="status-txt ${c.status}">${ICONE_STATUS[c.status]} ${quando}</span>${c.forma ? ` · ${esc(c.forma)}` : ""}</div></div>
    <div class="valor num">${c.tipo === "acordo" ? Rp(c.valor) : R(c.valor)}</div><span class="seta" aria-hidden="true">›</span></li>`;
}

function htmlMes(d) {
  const r = d.resultado;
  const pend = d.contas.filter((c) => c.status !== "pago");
  const pagas = d.contas.filter((c) => c.status === "pago");
  const semDia = d.contas.filter((c) => !c.data && c.tipo !== "acordo");
  const nomeM = nomeMes(d.mes).split(" ")[0];
  return `
    <div class="cartao destaque">
      <div class="nota-texto">${d.historico ? `Resultado planejado para ${nomeMes(d.mes)}` : `Previsão do plano para o fim de ${nomeMes(d.mes)}`}</div>
      <div class="valor num ${r.previsto < 0 ? "sobe" : "desce"}">${Rp(Math.abs(r.previsto), sinal(r.previsto))}</div>
      <div class="compara">Renda planejada ${Rp(r.renda_plano)} − orçamento ${R(r.metas_total)} − acordos ${Rp(r.acordos_mes)}. É a meta do mês; o resultado do que já aconteceu fica no Início.</div>
      <div class="compara">${d.historico ? `No mês todo` : "Até hoje"}: entrou ${Rp(r.receitas_real)} · gastos ${R(r.gasto_real)} · acordos pagos ${Rp(r.acordos_pagos)}</div>
    </div>
    <div class="cartao cartao-compacto">
      <p class="nota-texto" style="margin:0"><strong>De onde vem a renda planejada?</strong> É o salário líquido previsto (${Rp(r.renda_plano)}), que você define em <a href="#" data-acao="abrirPreferencias">Ajustar plano</a>. As entradas reais de ${nomeM} (${Rp(r.receitas_real)}) incluem também Pix recebidos, reembolsos e outras entradas, por isso podem ser maiores.</p>
    </div>
    ${!d.historico && semDia.length ? `<div class="cartao aviso-cartao" data-acao="editarItemOrcamento" data-id="${semDia[0].ref}">
      <strong>${pl(semDia.length, "conta está", "contas estão")} sem dia de vencimento</strong>
      <div class="nota-texto">${semDia.map((c) => esc(c.nome)).join(", ")}. Sem o dia, o app não consegue avisar quando vence nem marcar atraso. Toque para preencher.</div></div>` : ""}

    <div class="cartao">
      <h3>Contas do mês <span class="nota-texto" style="font-weight:400;text-transform:none;letter-spacing:0">· ${pagas.length} de ${d.contas.length} pagas</span></h3>
      <ul class="lista">${pend.map(linhaConta).join("")}</ul>
      ${pagas.length ? `<details class="pagas"><summary class="nota-texto">Já pagas (${pagas.length})</summary><ul class="lista">${pagas.map(linhaConta).join("")}</ul></details>` : ""}
      <p class="nota-texto">Você não precisa marcar nada: o app reconhece o pagamento no extrato (sincroniza 2x por dia). Tocar numa conta abre os detalhes para ajustar valor, dia de vencimento ou o texto que aparece no extrato.</p>
    </div>

    <div class="cartao">
      <h3>Orçamento</h3>
      ${barraPlano("Total do mês", r.gasto_real, r.metas_total, "var(--acento)", false, false, "meta")}
      ${d.grupos.map((g) => `<div class="grupo-orc" data-acao="abrirGrupoOrcamento" data-id="${g.id}">
        ${barraPlano(esc(g.nome), g.gasto, g.meta, g.meta > 0 && g.gasto > g.meta ? "var(--alerta)" : "var(--acento)", false, false, "meta")}</div>`).join("")}
      <p class="nota-texto">Gasto ${d.historico ? `de ${nomeM}` : "deste mês até hoje"} contra a meta mensal (contas trimestrais e anuais entram pelo valor por mês). Toque num grupo para ver e ajustar os itens.</p>
    </div>

    ${r.pix_esposa_sem_nota > 0 ? `<div class="cartao">
      <h3>Pix para a Laynara sem nota</h3>
      <div class="linha" style="cursor:default;border-top:0;padding-top:0"><div class="corpo"><div class="meta">Ainda não se sabe em qual grupo entra (mercado, ração, remédios…). Escaneie as notas: o valor passa para as categorias dos itens.</div></div><div class="valor num">${R(r.pix_esposa_sem_nota)}</div></div>
      <div class="botoes" style="margin-top:4px"><button class="botao peq sec" data-acao="irEscanear">Escanear nota</button></div>
    </div>` : ""}

    ${d.fora_do_plano.length ? `<div class="cartao">
      <h3>Fora do plano</h3>
      <p class="nota-texto" style="margin-top:0">Gastos em categorias que não estão no orçamento: cada real aqui aumenta o déficit.</p>
      <ul class="lista">${d.fora_do_plano.map((f) => `<li class="linha" data-acao="verCategoriaNome" data-nome="${esc(f.nome)}"><div class="corpo"><div class="titulo">${esc(f.nome)}</div></div><div class="valor num">${R(f.valor)}</div></li>`).join("")}</ul>
    </div>` : ""}`;
}

function htmlAcordos(d, vdiv = []) {
  if (!d.acordos.length) return `<div class="vazio"><strong>Nenhum acordo cadastrado</strong>Cadastre em Patrimônio → Dívidas.</div>`;
  const total = d.acordos.reduce((s, a) => s + a.parcela, 0);
  const saldo = d.acordos.reduce((s, a) => s + a.saldo, 0);
  const tudo = vdiv.reduce((s, v) => s + Number(v.saldo_devedor || 0), 0);
  const cartoes = vdiv.filter((v) => v.fonte === "fatura" || v.fonte === "parcelas").reduce((s, v) => s + Number(v.saldo_devedor || 0), 0);
  const outras = tudo - cartoes - saldo;
  return `
    <div class="cartao destaque">
      <div class="nota-texto">Acordos · ${d.atraso_acordo ? `<span class="sobe">há parcela atrasada</span>` : "todos em dia"}</div>
      <div class="valor num">${Rp(total)}<span class="nota-texto" style="font-size:15px;font-weight:400"> por mês</span></div>
      <div class="compara">Saldo a pagar dos acordos ${Rp(saldo)}</div>
    </div>
    ${tudo > saldo + 1 ? `<div class="cartao cartao-compacto"><p class="nota-texto" style="margin:0">O total de dívidas do Início (${Rp(tudo)}) é maior porque soma também ${cartoes > 0 ? `faturas e parcelas futuras dos cartões (${Rp(cartoes)})` : ""}${cartoes > 0 && outras > 1 ? " e " : ""}${outras > 1 ? `outras dívidas (${Rp(outras)})` : ""}. Aqui ficam só os acordos.</p></div>` : ""}
    ${d.acordos.map((a) => `<div class="cartao acordo ${a.em_dia ? "" : "atrasado"}">
      <div data-acao="abrirDivida" data-id="${a.id}" style="cursor:pointer">
        <div class="sug-topo"><span class="chip ${a.em_dia ? "ok" : "alerta"}">${a.em_dia ? "em dia" : `${a.atrasadas} atrasada${a.atrasadas > 1 ? "s" : ""}`}</span>
          <span class="nota-texto" style="margin-left:auto">termina ${a.fim ? mesAno(a.fim) : "—"}</span></div>
        <h2 style="margin:8px 0 2px">${esc(a.nome)}</h2>
        <p class="proxima-acao">${a.proxima ? `${a.proxima.data < d.hoje ? `<span class="sobe">Pagar a parcela atrasada</span> ${a.proxima.numero}, vencida em` : `Próxima: parcela ${a.proxima.numero} de ${Rp(a.parcela)} em`} <strong>${dataCurta(a.proxima.data)}</strong>` : "Todas as parcelas pagas"}</p>
        <div class="plano-rotulo"><span class="nota-texto">${a.pagas} de ${a.total} parcelas pagas</span><span class="num">${Rp(a.saldo)}</span></div>
        <div class="plano-trilho"><i style="width:${(a.pagas / a.total) * 100}%;background:var(--acento)"></i></div>
      </div>
      ${a.observacao ? `<details class="detalhes"><summary>ver detalhes</summary><p class="nota-texto">${privTexto(esc(a.observacao))}</p></details>` : ""}
    </div>`).join("")}
    <p class="nota-texto">Pagamentos são reconhecidos no extrato pelo texto e pelo valor da parcela. Se algum não for reconhecido, toque no acordo e registre o pagamento.</p>`;
}

function htmlObjetivos(d) {
  const grupos = {};
  for (const o of d.objetivos) (grupos[o.grupo] ??= []).push(o);
  const fmtValor = (o, v) => (o.tipo === "habito" ? `${v ?? 0} ${o.fonte === "acordos_em_dia" ? "meses" : "meses no azul"}` : Rp(v ?? 0));
  const cartaoObj = (o) => {
    if (o.tipo === "tarefa") {
      return `<li class="linha tarefa ${o.concluido_em ? "feita" : ""} ${o.vencida ? "vencida" : ""}" data-acao="alternarTarefa" data-id="${o.id}">
        <span class="caixa" role="checkbox" aria-checked="${o.concluido_em ? "true" : "false"}">${o.concluido_em ? "✓" : ""}</span>
        <div class="corpo"><div class="titulo">${esc(o.titulo)}</div>${o.data_alvo ? `<div class="meta">${o.vencida ? "atrasada · " : ""}até ${dataCurta(o.data_alvo)}</div>` : ""}
        ${o.descricao ? `<details class="detalhes" onclick="event.stopPropagation()"><summary>ver detalhes</summary><div class="meta">${esc(o.descricao)}</div></details>` : ""}</div></li>`;
    }
    const manual = !o.fonte;
    const extra = [o.detalhe, o.descricao].filter(Boolean);
    return `<div class="cartao objetivo ${o.atingido ? "atingido" : ""}">
      <div class="sug-topo"><span class="chip ${o.atingido ? "ok" : ""}">${o.atingido ? "atingido" : o.tipo === "habito" ? "hábito" : o.tipo === "monitor" ? "acompanhar" : "meta"}</span>
        ${o.data_alvo ? `<span class="nota-texto" style="margin-left:auto">até ${dataCurta(o.data_alvo)}</span>` : ""}</div>
      <h2 style="margin:8px 0 4px">${esc(o.titulo)}</h2>
      <div class="plano-rotulo"><span class="num"><strong>${fmtValor(o, o.valor_atual)}</strong> <span class="nota-texto">${o.inverso ? "limite" : "de"} ${fmtValor(o, o.valor_alvo)}</span></span><span class="nota-texto">${Math.round(o.progresso * 100)}%</span></div>
      <div class="plano-trilho"><i style="width:${Math.min(o.progresso, 1) * 100}%;background:${o.inverso ? (o.atingido ? "var(--acento)" : "var(--alerta)") : "var(--acento)"}"></i></div>
      ${extra.length ? `<details class="detalhes"><summary>ver detalhes</summary>${extra.map((t) => `<p class="nota-texto">${privTexto(esc(t))}</p>`).join("")}</details>` : ""}
      ${manual ? `<div class="botoes"><button class="botao peq sec" data-acao="atualizarObjetivo" data-id="${o.id}">Atualizar valor</button></div>` : ""}
    </div>`;
  };
  return Object.entries(grupos).map(([g, os]) => `<h3 style="margin:18px 2px 8px">${esc(g)}</h3>${
    g === "Tarefas" ? `<div class="cartao" style="padding:2px 14px"><ul class="lista">${os.sort((a, b) => (!!a.concluido_em - !!b.concluido_em) || String(a.data_alvo ?? "9").localeCompare(String(b.data_alvo ?? "9"))).map(cartaoObj).join("")}</ul></div>`
      : os.map(cartaoObj).join("")}`).join("")
    + `<p class="nota-texto">Colchão, acordos em dia e déficit se atualizam sozinhos pelo extrato. Os outros você atualiza quando tiver o número (ex.: saldo do FGTS no app). Nas tarefas, toque para marcar como feita.</p>`;
}

// ---------- Ações
acoes.irEscanear = () => irPara("escanear");
acoes.verCategoriaNome = (el) => {
  const c = estado.categorias.find((x) => x.nome === el.dataset.nome);
  estado.categoriaFiltro = c ? c.id : "nula"; estado.filtroGastos = "tudo"; irPara("gastos");
};
acoes.alternarTarefa = async (el) => {
  const o = estado.metas?.objetivos.find((x) => x.id === Number(el.dataset.id));
  if (!o) return;
  try {
    await q(sb.from("objetivos").update({ concluido_em: o.concluido_em ? null : new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq("id", o.id));
    cacheMetas = null; recarregar();
  } catch (e) { avisar(e.message, true); }
};
acoes.atualizarObjetivo = (el) => {
  const o = estado.metas?.objetivos.find((x) => x.id === Number(el.dataset.id));
  if (!o) return;
  abrirFolha(`<h2>${esc(o.titulo)}</h2>
    <label class="campo"><span>Valor atual (R$)</span><input type="text" inputmode="decimal" id="objAtual" value="${o.valor_atual ?? ""}"></label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>${o.inverso ? "Limite" : "Meta"} (R$)</span><input type="text" inputmode="decimal" id="objAlvo" value="${o.valor_alvo ?? ""}"></label>
      <label class="campo" style="flex:1"><span>Até</span><input type="date" id="objData" value="${o.data_alvo ?? ""}"></label>
    </div>
    <div class="botoes"><button class="botao cheio" data-acao="salvarObjetivo" data-id="${o.id}">Salvar</button></div>`);
};
acoes.salvarObjetivo = async (el) => {
  el.disabled = true;
  try {
    const atual = numeroDigitado($("#objAtual").value), alvo = numeroDigitado($("#objAlvo").value);
    await q(sb.from("objetivos").update({
      valor_atual: Number.isFinite(atual) ? atual : null, valor_alvo: Number.isFinite(alvo) && alvo > 0 ? alvo : null,
      data_alvo: $("#objData").value || null, atualizado_em: new Date().toISOString(),
    }).eq("id", Number(el.dataset.id)));
    cacheMetas = null; fecharFolha(); avisar("Objetivo atualizado"); recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.abrirGrupoOrcamento = (el) => {
  const g = estado.metas?.grupos.find((x) => x.id === Number(el.dataset.id));
  if (!g) return;
  abrirFolha(`<h2>${esc(g.nome)}</h2>
    <p class="nota-texto" style="margin-top:0">${R(g.gasto)} gastos este mês · meta ${R(g.meta)}${g.observacao ? ` · ${esc(g.observacao)}` : ""}</p>
    <ul class="lista">${g.itens.map((i) => `<li class="linha" data-acao="editarItemOrcamento" data-id="${i.id}">
      <div class="corpo"><div class="titulo">${esc(i.nome)}</div><div class="meta">${i.tipo === "conta" ? "conta" : "separar"} · ${PERIODOS[i.periodicidade_meses] ?? ""}${i.periodicidade_meses > 1 ? ` (${R(i.meta_mensal)}/mês)` : ""}${i.dia_vencimento ? ` · dia ${i.dia_vencimento}` : ""}</div></div>
      <div class="valor num">${R(i.valor)}</div></li>`).join("")}</ul>
    <div class="botoes"><button class="botao peq sec" data-acao="novoItemOrcamento" data-grupo="${g.id}">+ Item</button></div>`);
};
function formItemOrcamento(i, grupoId) {
  return `<h2>${i ? esc(i.nome) : "Novo item"}</h2>
    <label class="campo"><span>Nome</span><input type="text" id="oiNome" value="${esc(i?.nome ?? "")}"></label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Valor (R$)</span><input type="text" inputmode="decimal" id="oiValor" value="${i?.valor ?? ""}"></label>
      <label class="campo" style="flex:1"><span>Frequência</span><select id="oiPer">${Object.entries(PERIODOS).map(([k, r]) => `<option value="${k}" ${Number(i?.periodicidade_meses ?? 1) === Number(k) ? "selected" : ""}>${r}</option>`).join("")}</select></label>
    </div>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Tipo</span><select id="oiTipo"><option value="envelope" ${i?.tipo !== "conta" ? "selected" : ""}>Separar (envelope)</option><option value="conta" ${i?.tipo === "conta" ? "selected" : ""}>Conta a pagar</option></select></label>
      <label class="campo" style="flex:0 0 90px"><span>Dia</span><input type="text" inputmode="numeric" id="oiDia" value="${i?.dia_vencimento ?? ""}" placeholder="—"></label>
    </div>
    <label class="campo"><span>Forma de pagamento</span><input type="text" id="oiForma" value="${esc(i?.forma_pagamento ?? "")}"></label>
    <label class="campo"><span>Texto no extrato (para marcar como paga)</span><input type="text" id="oiPadrao" value="${esc(i?.padrao ?? "")}" placeholder="Ex.: PETLOVE"></label>
    <p class="nota-texto" style="margin-top:-6px">Um nome que aparece no extrato, a observação do lançamento ou o nome da categoria (ex.: <code>ASSINATURAS</code>). Para mais de um, separe com | (ex.: <code>BONIFACIO|IVAN KOLLING</code>). Se forem vários pagamentos no mês, o app soma todos.</p>
    <div class="botoes"><button class="botao cheio" data-acao="salvarItemOrcamento" data-id="${i?.id ?? ""}" data-grupo="${grupoId ?? i?.grupo_id ?? ""}">Salvar</button></div>
    ${i ? `<div class="botoes"><button class="botao peq sec" data-acao="removerItemOrcamento" data-id="${i.id}">Remover item</button></div>` : ""}`;
}
acoes.editarItemOrcamento = (el) => {
  const i = estado.metas?.grupos.flatMap((g) => g.itens.map((x) => ({ ...x, grupo_id: g.id }))).find((x) => x.id === Number(el.dataset.id));
  if (i) abrirFolha(formItemOrcamento(i));
};
acoes.novoItemOrcamento = (el) => abrirFolha(formItemOrcamento(null, Number(el.dataset.grupo)));
acoes.salvarItemOrcamento = async (el) => {
  const nome = $("#oiNome").value.trim();
  const valor = numeroDigitado($("#oiValor").value);
  if (!nome || !(valor >= 0)) return avisar("Preencha nome e valor", true);
  const dia = parseInt($("#oiDia").value, 10);
  // Sem acento e em maiúsculas, mas sem mexer nos códigos de regex (\b, \d…)
  const padrao = $("#oiPadrao").value.trim().split(/(\\.)/).map((p, k) => (k % 2 ? p : p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase())).join("");
  const dados = {
    nome, valor, periodicidade_meses: Number($("#oiPer").value), tipo: $("#oiTipo").value,
    dia_vencimento: dia >= 1 && dia <= 31 ? dia : null, forma_pagamento: $("#oiForma").value.trim() || null, padrao: padrao || null,
  };
  el.disabled = true;
  try {
    if (el.dataset.id) await q(sb.from("orcamento_itens").update(dados).eq("id", Number(el.dataset.id)));
    else await q(sb.from("orcamento_itens").insert({ ...dados, grupo_id: Number(el.dataset.grupo), ordem: 90 }));
    cacheMetas = null; cacheSugestoes = null; fecharFolha(); avisar("Orçamento atualizado"); recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};
acoes.removerItemOrcamento = async (el) => {
  try {
    await q(sb.from("orcamento_itens").update({ ativo: false }).eq("id", Number(el.dataset.id)));
    cacheMetas = null; fecharFolha(); avisar("Item removido"); recarregar();
  } catch (e) { avisar(e.message, true); }
};

/** Resumo das metas no Início: sempre do mês escolhido no topo (o plano só existe até o mês atual). */
const ICONE_LINHA = {
  ok: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>`,
  alerta: `<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/></svg>`,
  calendario: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  tarefa: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12h8M8 8h8M8 16h5"/></svg>`,
};
async function carregarResumoMetas() {
  const el = $("#cartaoMetas");
  if (!el) return;
  const mesPedido = estado.mes > mesAtual() ? mesAtual() : estado.mes;
  try {
    const d = await obterMetas(false, mesPedido);
    if (!$("#cartaoMetas")) return;
    estado.metas = d;
    const r = d.resultado;
    const nomeM = nomeMes(d.mes).split(" ")[0];
    const pend = d.contas.filter((c) => c.status !== "pago");
    const atrasadas = d.contas.filter((c) => c.status === "atrasado");
    const prox = pend.filter((c) => c.data).sort((a, b) => a.data.localeCompare(b.data))[0];
    const tarefas = d.historico ? [] : d.objetivos.filter((o) => o.tipo === "tarefa" && !o.concluido_em && o.data_alvo && o.data_alvo <= somarDiasISO(d.hoje, 7));
    el.innerHTML = `<div class="cab-cartao"><h3>Plano de ${nomeM}${d.mes !== estado.mes ? ` <span class="sub-h">(${nomeM} é o mês atual)</span>` : ""}</h3><span class="chip acao">abrir ›</span></div>
      <div class="plano-rotulo" style="margin-top:8px"><span>${d.historico ? "Resultado planejado" : "Previsão do plano no fim do mês"}</span><span class="num"><strong class="${r.previsto < 0 ? "sobe" : "desce"}">${Rp(Math.abs(r.previsto), sinal(r.previsto))}</strong></span></div>
      <p class="nota-texto" style="margin:2px 0 8px">Renda planejada − orçamento − parcelas dos acordos. É uma meta, não o que já aconteceu (isso está no topo).</p>
      ${barraPlano(`Orçamento usado${d.historico ? "" : " até hoje"}`, r.gasto_real, r.metas_total, r.gasto_real > r.metas_total ? "var(--alerta)" : "var(--acento)", false, true, "meta")}
      <ul class="lista resumo-plano">
        ${atrasadas.length ? `<li class="linha"><span class="icone-linha ruim">${ICONE_LINHA.alerta}</span><div class="corpo"><div class="titulo">${pl(atrasadas.length, "conta atrasada", "contas atrasadas")}</div><div class="meta priv-bloco">${atrasadas.map((c) => esc(c.nome)).join(", ")}</div></div></li>` : ""}
        <li class="linha"><span class="icone-linha ${pend.length ? "" : "bom"}">${pend.length ? ICONE_LINHA.calendario : ICONE_LINHA.ok}</span><div class="corpo"><div class="titulo">${pend.length ? `${pl(pend.length, "conta a pagar", "contas a pagar")}` : `Todas as contas de ${nomeM} pagas`}</div>${prox ? `<div class="meta priv-bloco">próxima: ${esc(prox.nome)} · ${dataCurta(prox.data).slice(0, 5)}</div>` : ""}</div></li>
        ${tarefas.length ? `<li class="linha"><span class="icone-linha">${ICONE_LINHA.tarefa}</span><div class="corpo"><div class="titulo">${pl(tarefas.length, "tarefa", "tarefas")} para esta semana</div><div class="meta priv-bloco">${esc(tarefas[0].titulo)}</div></div></li>` : ""}
      </ul>`;
  } catch (e) {
    el.innerHTML = `<h3>Plano do mês</h3><p class="nota-texto">Não consegui carregar (${esc(e.message)}).</p>`;
  }
}
function somarDiasISO(dia, n) { const d = new Date(dia + "T12:00:00"); d.setDate(d.getDate() + n); return isoDia(d); }
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

function barraPlano(rotulo, atual, ideal, cor, inverso = false, privado = false, nomeIdeal = "ideal") {
  const V = privado ? Rp : R;
  // inverso: para poupança, ficar abaixo do ideal é o problema
  const max = Math.max(atual, ideal, 1) * 1.1;
  const ruim = inverso ? atual < ideal : atual > ideal;
  return `<div class="plano-linha">
    <div class="plano-rotulo"><span>${rotulo}</span><span class="num"><strong class="${ruim ? "sobe" : "desce"}">${V(Math.abs(atual), atual < 0 ? "−" : "")}</strong> <span class="nota-texto">/ ${nomeIdeal} ${V(ideal)}</span></span></div>
    <div class="plano-trilho"><i style="width:${Math.max(0, (atual / max) * 100)}%;background:${cor}"></i><b style="left:${(ideal / max) * 100}%" title="ideal"></b></div>
  </div>`;
}

const CLASSES = {
  essencial_variavel: "Essencial · valor variável",
  essencial_fixo: "Essencial · valor fixo",
  emergencial: "Emergencial · imprevistos",
  estilo_vida: "Estilo de vida",
};
const CORES_CLASSE = { essencial_variavel: "var(--fg)", essencial_fixo: "var(--fg-dim)", emergencial: "var(--signal-2)", estilo_vida: "var(--fg-mute)" };
const PERIODOS = { 1: "por mês", 2: "a cada 2 meses", 3: "por trimestre", 6: "por semestre", 12: "por ano" };
acoes.irCategorias = (el, e) => { e?.preventDefault?.(); estado.abrirCategorias = true; irPara("mais"); };

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
      <div class="compara">${Rp(d.economia_potencial * 12)} em um ano</div>
      ${(d.economia_composicao ?? []).length ? `<div class="composicao priv-bloco">${d.economia_composicao.map((c, i) => `<div><span>${i ? (c.valor < 0 ? "− " : "+ ") : ""}${esc(c.titulo)}</span><strong class="num">${R(Math.abs(c.valor))}</strong></div>`).join("")}</div>
      <div class="compara">O déficit e o “gasto acima do ideal” mostram o tamanho do problema e não somam aqui, para não contar o mesmo dinheiro duas vezes.</div>` : ""}</div>` : ""}

    <div class="cartao">
      <h3>Plano de gastos</h3>
      <p class="nota-texto" style="margin-top:0">${p.origem_renda === "informada" ? `Renda planejada ${Rp(p.renda)} por mês: o salário líquido previsto, que você define em “Ajustar plano”` : `Renda ${Rp(p.renda)} por mês (${esc(p.origem_renda || "não identificada")})`}${p.receitas_media != null && Math.abs(p.receitas_media - p.renda) >= 1 ? `. Entradas reais na média dos meses analisados: ${Rp(p.receitas_media)} (inclui Pix recebidos e reembolsos)` : ""}. Pela regra ${Math.round(p.pct.essencial * 100)}/${Math.round(p.pct.estilo_vida * 100)}/${Math.round(p.pct.poupanca * 100)}, o <strong>gasto ideal é até ${Rp(p.gasto_ideal)}</strong>. Valores atuais: ${mesesTxt}.</p>
      ${barraPlano("Essenciais", p.essencial.atual, p.essencial.ideal, "var(--acento)", false, true)}
      ${p.essencial.fixo != null ? `<div class="plano-sub nota-texto">fixos ${Rp(p.essencial.fixo)} · variáveis ${Rp(p.essencial.variavel)}</div>` : ""}
      ${barraPlano("Estilo de vida", p.estilo_vida.atual, p.estilo_vida.ideal, "var(--fg-dim)", false, true)}
      ${barraPlano("Sobra para guardar/quitar", p.poupanca.atual, p.poupanca.ideal, "var(--fg-dim)", true, true)}
      <ul class="lista" style="margin-top:6px">
        ${p.imprevistos ? `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">Imprevistos</div><div class="meta">Pagos pela reserva, fora das metas</div></div><div class="valor num">${Rp(p.imprevistos.atual)}</div></li>` : ""}
        ${p.dividas_media ? `<li class="linha" style="cursor:default"><div class="corpo"><div class="titulo">Parcelas de dívidas</div><div class="meta">Compromisso fixo; a compra já contou quando foi feita</div></div><div class="valor num">${Rp(p.dividas_media)}</div></li>` : ""}
        ${p.sem_categoria > 1 ? `<li class="linha" data-acao="acaoSugestao" data-destino="movimentacoes" data-filtro="sem-categoria"><div class="corpo"><div class="titulo">Sem categoria</div><div class="meta">Categorize para o plano ficar certo</div></div><div class="valor num">${Rp(p.sem_categoria)}</div></li>` : ""}
      </ul>
    </div>

    <div class="cartao" data-acao="irMetas" style="cursor:pointer"><div class="linha" style="cursor:inherit;border-top:0;padding-top:0"><div class="corpo"><div class="titulo">Metas do mês</div>
      <div class="meta">Orçamento por grupo, contas do dia 5, acordos e objetivos</div></div><span class="chip">abrir ›</span></div></div>

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
        ${chipValorSugestao(x)}</div>
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
  if (destino === "triagem") return acoes.abrirTriagem();
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
    <label class="campo"><span>Começamos a controlar em (mês)</span><input type="month" id="prInicio" value="${esc(await inicioControle())}" max="${mesAtual()}"></label>
    <p class="nota-texto" style="margin-top:-6px">Lançamentos sem categoria de antes deste mês não aparecem no “A fazer” nem na triagem (continuam no extrato e nos totais).</p>
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
      ...(/^\d{4}-\d{2}$/.test($("#prInicio")?.value ?? "") ? [{ chave: "controle_inicio", valor: $("#prInicio").value }] : []),
    ]));
    if (/^\d{4}-\d{2}$/.test($("#prInicio")?.value ?? "")) estado.inicioControle = $("#prInicio").value;
    estado.prefs = { reserva_meses: reserva };
    cacheSugestoes = null;
    avisar("Plano atualizado");
    fecharFolha();
    recarregar();
  } catch (e) { avisar(e.message, true); el.disabled = false; }
};

// ------------------------------------------------------------------ LOGIN
function telaLogin(msg = "") {
  abas.hidden = true;
  app.innerHTML = `<div class="login">
    <div class="marca"><img src="icons/dolar-192.png" alt=""><div><h1>Finanças da Casa</h1><div class="nota-texto">Open Finance + notas fiscais</div></div></div>
    <div class="cartao">
      <h2 style="margin-bottom:6px">Entrar</h2>
      ${msg ? `<p class="nota-texto">${msg}</p>` : ""}
      <button class="botao cheio botao-google" type="button" data-acao="entrarGoogle"><svg class="logo-google" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Entrar com Google</button>
      <p class="nota-texto" style="margin-bottom:0">Por segurança, o acesso é só pela sua conta Google. Quem entra pela primeira vez ganha uma casa própria, a não ser que tenha recebido convite para uma casa.</p>
    </div></div>`;
}

acoes.entrarGoogle = async (el) => {
  el.disabled = true;
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } },
  });
  if (error) { avisar(error.message, true); el.disabled = false; }
};

/** A sessão foi aberta pelo Google? (método de login gravado no token) */
function sessaoPeloGoogle(session) {
  try {
    const p = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const amr = JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))).amr ?? [];
    return amr.some((a) => a.method === "oauth");
  } catch { return true; }  // token ilegível: o servidor decide
}

// ------------------------------------------------------------------ início do app
async function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (SUPABASE_URL.includes("SEU-PROJETO")) {
    app.innerHTML = `<div class="vazio"><strong>App ainda não configurado</strong>Preencha o endereço do Supabase em app/config.js.</div>`;
    return;
  }
  let session = null;
  if (navigator.onLine) {
    const semResposta = new Promise((ok) => setTimeout(() => ok({ data: { session: null } }), 8000));
    ({ data: { session } } = await Promise.race([sb.auth.getSession().catch(() => ({ data: { session: null } })), semResposta]));
  }
  if (session && !sessaoPeloGoogle(session)) {
    // Sessão antiga aberta com e-mail e senha: o app agora só aceita Google
    await sb.auth.signOut().catch(() => {});
    return telaLogin("O acesso agora é só pelo Google. Entre de novo com a sua conta Google.");
  }
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
    if (erroOAuth) { history.replaceState(null, "", location.pathname); return telaLogin(`Não foi possível entrar com o Google: ${esc(erroOAuth)}`); }
    return telaLogin();
  }
  estado.email = session.user.email?.toLowerCase();
  if (bloqueioSalvo() && !desbloqueado) await exigirDesbloqueio();
  desbloqueado = true;

  // Casa aberta: quem entra pela primeira vez ganha uma casa própria; quem foi convidado entra na casa de quem convidou
  let casa = null, erroRede = !navigator.onLine || sessaoOffline, erroMsg = "";
  if (!erroRede) {
    try { casa = await q(sb.rpc("entrar")); }
    catch (e) { erroMsg = String(e?.message ?? e); erroRede = ehErroDeRede(erroMsg) || /fetch|network|timeout|internet/i.test(erroMsg); }
  }
  if (!casa) {
    const salva = lerCasaSalva();
    if (salva && (erroRede || !erroMsg)) casa = salva;
  }
  if (!casa) {
    app.innerHTML = erroRede
      ? `<div class="login"><div class="cartao"><h2>Sem internet</h2>
        <p>O app precisa de conexão para buscar os dados. Assim que a internet voltar, ele carrega sozinho.</p>
        <button class="botao" data-acao="tentarDeNovo">Tentar de novo</button></div></div>`
      : `<div class="login"><div class="cartao"><h2>Não foi possível abrir sua casa</h2>
        <p class="nota-texto">${esc(erroMsg)}</p>
        <button class="botao" data-acao="tentarDeNovo">Tentar de novo</button> <button class="botao sec" data-acao="sair">Sair</button></div></div>`;
    if (erroRede) window.addEventListener("online", () => location.reload(), { once: true });
    return;
  }
  guardarCasa(casa);
  if (casa.convite_aceito) setTimeout(() => avisar(`Você agora participa da casa "${casa.nome}" (convite)`), 800);
  await carregarCategorias();
  abas.hidden = false;
  const inicial = location.hash.replace("#", "");
  await irPara(["inicio", "gastos", "escanear", "notas", "mais", "patrimonio", "sugestoes", "metas"].includes(inicial) ? inicial : "inicio");
  processarFila();
  verificarAoAbrir();
}
iniciar();
