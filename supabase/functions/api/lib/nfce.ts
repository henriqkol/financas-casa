// Leitura do QR code da NFC-e e extração dos dados do portal da SEFAZ.
// O layout "Portal NFC-e" (div#u20, table#tabResult, div#totalNota) é o usado
// pela SVRS (RS e vários outros estados). Sem dependências externas.

import { numeroBR, soDigitos, textoDeHtml } from "./texto.ts";

export const UF_POR_CODIGO: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
  "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
  "41": "PR", "42": "SC", "43": "RS",
  "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

export interface InfoChave {
  chave: string;
  uf: string | null;
  anoMes: string;          // AAAA-MM da emissão
  cnpj: string;
  modelo: string;          // 65 = NFC-e
  serie: string;
  numero: string;
  tipoEmissao: string;     // 1 = normal, 9 = contingência offline
}

export function infoDaChave(chave: string): InfoChave | null {
  const c = soDigitos(chave);
  if (c.length !== 44) return null;
  return {
    chave: c,
    uf: UF_POR_CODIGO[c.slice(0, 2)] ?? null,
    anoMes: `20${c.slice(2, 4)}-${c.slice(4, 6)}`,
    cnpj: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: String(Number(c.slice(22, 25))),
    numero: String(Number(c.slice(25, 34))),
    tipoEmissao: c.slice(34, 35),
  };
}

export interface QrLido {
  urlOriginal: string;
  chave: string;
  p: string | null;
  /** Contingência offline e QR v1 trazem valor e dia da emissão no próprio QR. */
  valorNoQr: number | null;
  diaNoQr: string | null;
}

/** Interpreta o texto lido do QR code (normalmente uma URL da SEFAZ). */
export function lerQr(texto: string): QrLido {
  const bruto = (texto ?? "").trim();
  let url: URL | null = null;
  try {
    url = new URL(bruto.startsWith("http") ? bruto : `https://${bruto}`);
  } catch {
    url = null;
  }

  // Formato 2.0/3.0: ?p=CHAVE|versao|tpAmb|...
  let p: string | null = null;
  if (url) p = url.searchParams.get("p");
  if (!p) {
    const m = bruto.match(/[?&]p=([^&\s]+)/i);
    if (m) p = decodeURIComponent(m[1]);
  }
  let chave = "";
  let valorNoQr: number | null = null;
  let diaNoQr: string | null = null;

  if (p) {
    const partes = p.split("|");
    chave = soDigitos(partes[0]);
    // offline v2: chave|2|tpAmb|dia|vNF|digVal|idCSC|hash
    if (partes[1] === "2" && partes.length >= 8) {
      const dia = partes[3];
      const v = Number(partes[4]);
      if (/^\d{1,2}$/.test(dia)) diaNoQr = dia.padStart(2, "0");
      if (Number.isFinite(v)) valorNoQr = v;
    }
  } else if (url?.searchParams.get("chNFe")) {
    // Formato 1.0: ?chNFe=...&vNF=...&dhEmi=<hex>
    chave = soDigitos(url.searchParams.get("chNFe"));
    const v = Number(url.searchParams.get("vNF"));
    if (Number.isFinite(v)) valorNoQr = v;
    const dh = url.searchParams.get("dhEmi");
    if (dh && /^[0-9a-f]+$/i.test(dh)) {
      const txt = dh.match(/.{2}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join("");
      const d = txt.match(/^\d{4}-\d{2}-(\d{2})/);
      if (d) diaNoQr = d[1];
    }
  } else {
    // Às vezes o leitor entrega só a chave
    const m = bruto.replace(/\s/g, "").match(/\d{44}/);
    if (m) chave = m[0];
  }

  return { urlOriginal: bruto, chave, p, valorNoQr, diaNoQr };
}

/** Só consultamos portais oficiais (.gov.br) para evitar uso indevido. */
export function hostPermitido(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith(".gov.br");
  } catch {
    return false;
  }
}

/** URLs a tentar, em ordem, para obter a página da nota. */
export function urlsDeConsulta(qr: QrLido): string[] {
  const urls: string[] = [];
  const uf = infoDaChave(qr.chave)?.uf;
  if (qr.p && (uf === "RS" || /sefaz\.rs\.gov\.br|svrs\.rs\.gov\.br/i.test(qr.urlOriginal))) {
    urls.push(`https://dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce?p=${qr.p}`);
  }
  if (/^https?:\/\//i.test(qr.urlOriginal) && hostPermitido(qr.urlOriginal)) {
    urls.push(qr.urlOriginal.replace(/^http:\/\//i, "https://"));
  }
  return [...new Set(urls)];
}

export interface ItemNota {
  ordem: number;
  codigo: string | null;
  descricao: string;
  quantidade: number | null;
  unidade: string | null;
  valor_unitario: number | null;
  valor_total: number;
}

export interface NotaExtraida {
  nome_emitente: string | null;
  cnpj_emitente: string | null;
  endereco: string | null;
  numero: string | null;
  serie: string | null;
  emissao: string | null;        // ISO 8601 com fuso
  chave: string | null;
  valor_total: number | null;
  desconto: number;
  valor_pago: number | null;
  forma_pagamento: string | null;
  qtd_itens: number | null;
  itens: ItemNota[];
}

function primeiro(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

function spanPorClasse(bloco: string, classe: string): string | null {
  const re = new RegExp(`<span[^>]*class=["'][^"']*\\b${classe}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i");
  return primeiro(bloco, re);
}

function removerRotulo(txt: string): string {
  return txt.replace(/^[^:]*:\s*/, "").trim();
}

/** Extrai os dados do HTML do portal NFC-e. Retorna itens vazios se o layout não bater. */
export function extrairDoPortal(html: string): NotaExtraida {
  const nome = textoDeHtml(primeiro(html, /<div[^>]*id=["']u20["'][^>]*>([\s\S]*?)<\/div>/i)) || null;

  // Bloco do emitente: div.txtCenter com as divs .text (CNPJ e endereço)
  const blocoTopo = primeiro(html, /<div[^>]*class=["'][^"']*txtCenter[^"']*["'][^>]*>([\s\S]*?)<\/table>/i) ?? html;
  const textos = [...blocoTopo.matchAll(/<div[^>]*class=["']text["'][^>]*>([\s\S]*?)<\/div>/gi)].map((m) => textoDeHtml(m[1]));
  const cnpjTxt = textos.find((t) => /CNPJ/i.test(t)) ?? (html.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)?.[0] ?? "");
  const cnpj = soDigitos(cnpjTxt).slice(0, 14) || null;
  const endereco = textos.find((t) => !/CNPJ/i.test(t)) ?? null;

  // Itens
  const linhas = [...html.matchAll(/<tr[^>]*id=["']Item\s*\+\s*\d+["'][^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const itens: ItemNota[] = [];
  linhas.forEach((bloco, i) => {
    let descricao = textoDeHtml(spanPorClasse(bloco, "txtTit"));
    let codigo: string | null = null;
    const codSpan = textoDeHtml(spanPorClasse(bloco, "RCod"));
    const codMatch = (codSpan || descricao).match(/\(\s*C[óo]digo:\s*([^)]*?)\s*\)/i);
    if (codMatch) codigo = codMatch[1].trim() || null;
    descricao = descricao.replace(/\(\s*C[óo]digo:[^)]*\)/i, "").trim();
    if (!descricao) return;
    const qtd = numeroBR(removerRotulo(textoDeHtml(spanPorClasse(bloco, "Rqtd"))));
    const un = removerRotulo(textoDeHtml(spanPorClasse(bloco, "RUN"))) || null;
    const vUnit = numeroBR(removerRotulo(textoDeHtml(spanPorClasse(bloco, "RvlUnit"))));
    let vTot = numeroBR(textoDeHtml(spanPorClasse(bloco, "valor")));
    if (vTot == null && qtd != null && vUnit != null) vTot = Math.round(qtd * vUnit * 100) / 100;
    itens.push({
      ordem: i + 1,
      codigo,
      descricao,
      quantidade: qtd,
      unidade: un ? un.toUpperCase() : null,
      valor_unitario: vUnit,
      valor_total: vTot ?? 0,
    });
  });

  // Totais: pares <label>…</label><span class="totalNumb">…</span>
  const iTot = html.search(/id=["']totalNota["']/i);
  const iInf = html.search(/id=["']infos["']/i);
  const blocoTotal = iTot >= 0 ? html.slice(iTot, iInf > iTot ? iInf : undefined) : "";
  const pares = [...blocoTotal.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>\s*<span[^>]*class=["'][^"']*totalNumb[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => ({ rotulo: textoDeHtml(m[2]), attrs: m[1], valor: textoDeHtml(m[3]) }));

  let valorTotal: number | null = null, desconto = 0, valorPago: number | null = null, qtdItens: number | null = null;
  const formas: string[] = [];
  let depoisDeForma = false;
  for (const par of pares) {
    const r = par.rotulo.toLowerCase();
    if (/qtd\.? total de itens/.test(r)) qtdItens = numeroBR(par.valor);
    else if (/valor total/.test(r)) valorTotal = numeroBR(par.valor);
    else if (/desconto/.test(r)) desconto = numeroBR(par.valor) ?? 0;
    else if (/valor a pagar/.test(r)) valorPago = numeroBR(par.valor);
    else if (/forma de pagamento/.test(r)) depoisDeForma = true;
    else if (/troco/.test(r)) { /* ignora */ }
    else if (/class=["']tx["']/.test(par.attrs) || (depoisDeForma && !/class=/.test(par.attrs))) {
      if ((numeroBR(par.valor) ?? 0) > 0) formas.push(par.rotulo);
    }
  }
  if (valorPago == null) {
    const txMax = primeiro(html, /<span[^>]*class=["'][^"']*totalNumb[^"']*txtMax[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    valorPago = numeroBR(textoDeHtml(txMax));
  }
  if (valorTotal == null && itens.length) valorTotal = Math.round(itens.reduce((s, i) => s + i.valor_total, 0) * 100) / 100;
  if (valorPago == null && valorTotal != null) valorPago = Math.round((valorTotal - desconto) * 100) / 100;

  // Informações gerais
  const plano = textoDeHtml(html);
  const numero = plano.match(/N[úu]mero:\s*(\d+)/i)?.[1] ?? null;
  const serie = plano.match(/S[ée]rie:\s*(\d+)/i)?.[1] ?? null;
  let emissao: string | null = null;
  const em = plano.match(/Emiss[ãa]o:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}:\d{2})?/i);
  if (em) {
    const hora = em[4].length === 5 ? `${em[4]}:00` : em[4];
    emissao = `${em[3]}-${em[2]}-${em[1]}T${hora}${em[5] ?? "-03:00"}`;
  }
  const chaveSpan = spanPorClasse(html, "chave");
  const chave = chaveSpan ? soDigitos(textoDeHtml(chaveSpan)) : null;

  return {
    nome_emitente: nome,
    cnpj_emitente: cnpj,
    endereco,
    numero,
    serie,
    emissao,
    chave: chave && chave.length === 44 ? chave : null,
    valor_total: valorTotal,
    desconto,
    valor_pago: valorPago,
    forma_pagamento: formas.length ? [...new Set(formas)].join(", ") : null,
    qtd_itens: qtdItens ?? (itens.length || null),
    itens,
  };
}

/** Decodifica a resposta respeitando o charset (alguns portais usam ISO-8859-1). */
export function decodificarHtml(buf: ArrayBuffer, contentType: string | null): string {
  const cs = contentType?.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (cs && cs !== "utf-8" && cs !== "utf8") {
    try { return new TextDecoder(cs).decode(buf); } catch { /* segue */ }
  }
  const meta = utf8.match(/<meta[^>]*charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if ((meta && meta !== "utf-8") || utf8.includes("\uFFFD")) {
    try { return new TextDecoder(meta && meta !== "utf-8" ? meta : "windows-1252").decode(buf); } catch { /* segue */ }
  }
  return utf8;
}
