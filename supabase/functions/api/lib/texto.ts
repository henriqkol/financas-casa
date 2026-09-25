// Utilidades de texto e números (sem dependências, testáveis no Node e no Deno).

/** Maiúsculas, sem acentos e com espaços simples. */
export function normalizar(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chave usada para "aprender" categorias de lançamentos: só letras,
 * sem números (datas, parcelas, códigos mudam a cada lançamento).
 */
export function chaveAprendizado(s: string | null | undefined): string {
  return normalizar(s)
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function soDigitos(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** "1.234,56" → 1234.56 · "54,9" → 54.9 · "0,124" → 0.124 · "12" → 12 */
export function numeroBR(s: string | null | undefined): number | null {
  if (s == null) return null;
  let t = String(s).replace(/[^\d,.\-]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function arred2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const ENTIDADES: Record<string, string> = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
  aacute: "á", Aacute: "Á", agrave: "à", Agrave: "À", acirc: "â", Acirc: "Â", atilde: "ã", Atilde: "Ã",
  eacute: "é", Eacute: "É", ecirc: "ê", Ecirc: "Ê", iacute: "í", Iacute: "Í",
  oacute: "ó", Oacute: "Ó", ocirc: "ô", Ocirc: "Ô", otilde: "õ", Otilde: "Õ",
  uacute: "ú", Uacute: "Ú", uuml: "ü", Uuml: "Ü", ccedil: "ç", Ccedil: "Ç",
  ordm: "º", ordf: "ª", deg: "°",
};

export function decodificarEntidades(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, nome) => ENTIDADES[nome] ?? m);
}

/** Remove tags HTML e normaliza espaços. */
export function textoDeHtml(html: string | null | undefined): string {
  return decodificarEntidades((html ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Data (YYYY-MM-DD) no fuso de Brasília para um instante. */
export function dataBrasilia(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Date(dt.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Diferença em dias (b - a) entre duas datas YYYY-MM-DD. */
export function diasEntre(a: string, b: string): number {
  const ta = Date.parse(a + "T12:00:00Z");
  const tb = Date.parse(b + "T12:00:00Z");
  return Math.round((tb - ta) / 86400000);
}

const PALAVRAS_VAZIAS = new Set([
  "LTDA", "EIRELI", "ME", "EPP", "SA", "S/A", "CIA", "COMERCIO", "COMERCIAL", "IND", "INDUSTRIA",
  "DE", "DA", "DO", "DAS", "DOS", "E", "EM", "PARA", "COM", "LOJA", "FILIAL", "SERVICOS",
  "PRODUTOS", "ALIMENTOS", "GENEROS", "ALIMENTICIOS", "DISTRIBUIDORA", "BRASIL", "RS", "SP",
  "PIX", "TRANSF", "COMPRA", "CARTAO", "DEBITO", "CREDITO", "PAGAMENTO", "ENVIADA", "ENVIADO",
]);

/** Palavras relevantes (≥ 4 letras) de um nome de estabelecimento/descrição. */
export function tokensRelevantes(s: string | null | undefined): string[] {
  return chaveAprendizado(s)
    .split(" ")
    .filter((t) => t.length >= 4 && !PALAVRAS_VAZIAS.has(t));
}
