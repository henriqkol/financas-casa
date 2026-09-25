// Motor de regras de categorização (itens de nota e lançamentos).
import { chaveAprendizado, normalizar, soDigitos } from "./texto.ts";

export interface Regra {
  id: number;
  alvo: "item" | "transacao";
  tipo: "regex" | "exato";
  padrao: string;
  categoria_id: number;
  prioridade: number;
}

export interface RegraCompilada extends Regra {
  re: RegExp | null;
}

export interface Resultado {
  categoria_id: number;
  regra_id: number | null;
  origem: string;
}

export function compilarRegras(regras: Regra[]): RegraCompilada[] {
  return regras
    .map((r) => {
      let re: RegExp | null = null;
      if (r.tipo === "regex") {
        try { re = new RegExp(r.padrao); } catch { re = null; }
      }
      return { ...r, re };
    })
    .filter((r) => r.tipo === "exato" || r.re)
    .sort((a, b) => a.prioridade - b.prioridade || a.id - b.id);
}

/** Aplica as regras de um alvo ao texto; a de menor prioridade que casar vence. */
export function aplicarRegras(texto: string, regras: RegraCompilada[], alvo: "item" | "transacao"): Resultado | null {
  const norm = normalizar(texto);
  const chave = alvo === "item" ? norm : chaveAprendizado(texto);
  for (const r of regras) {
    if (r.alvo !== alvo) continue;
    const casou = r.tipo === "exato" ? r.padrao === chave : r.re!.test(norm);
    if (casou) {
      return { categoria_id: r.categoria_id, regra_id: r.id, origem: r.tipo === "exato" ? "aprendida" : "regra" };
    }
  }
  return null;
}

export interface TxParaCategorizar {
  descricao: string;
  recebedor_nome?: string | null;
  sentido: "saida" | "entrada";
  tipo_operacao?: string | null;
  pagador_doc?: string | null;
  recebedor_doc?: string | null;
  conta_tipo?: string | null;
}

/** Categoria de um lançamento a partir das regras e de alguns sinais fixos. */
export function categorizarTransacao(
  tx: TxParaCategorizar,
  regras: RegraCompilada[],
  cat: Record<string, number>,
): Resultado | null {
  const op = (tx.tipo_operacao ?? "").toUpperCase();
  if (op === "PAGAMENTO_FATURA" && cat["Pagamento de fatura"]) {
    return { categoria_id: cat["Pagamento de fatura"], regra_id: null, origem: "padrao" };
  }
  const pag = soDigitos(tx.pagador_doc), rec = soDigitos(tx.recebedor_doc);
  if (pag && rec && pag === rec && cat["Transferência entre contas"]) {
    return { categoria_id: cat["Transferência entre contas"], regra_id: null, origem: "padrao" };
  }
  const texto = [tx.descricao, tx.recebedor_nome].filter(Boolean).join(" ");
  const r = aplicarRegras(texto, regras, "transacao");
  if (r) return r;
  if (tx.sentido === "entrada") {
    // No cartão, entrada é pagamento da fatura ou estorno; na conta, é receita.
    const nome = tx.conta_tipo === "CREDIT" ? "Pagamento de fatura" : "Receitas";
    if (cat[nome]) return { categoria_id: cat[nome], regra_id: null, origem: "padrao" };
  }
  return null;
}

/** Categoria dominante (maior valor) entre itens já categorizados. */
export function categoriaDominante(itens: { categoria_id: number | null; valor_total: number }[]): number | null {
  const soma = new Map<number, number>();
  for (const i of itens) {
    if (i.categoria_id == null) continue;
    soma.set(i.categoria_id, (soma.get(i.categoria_id) ?? 0) + Number(i.valor_total || 0));
  }
  let melhor: number | null = null, max = -1;
  for (const [id, v] of soma) if (v > max) { max = v; melhor = id; }
  return melhor;
}
