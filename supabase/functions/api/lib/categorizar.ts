// Motor de regras de categorização (itens de nota e lançamentos).
import { chaveAprendizado, normalizar, soDigitos } from "./texto.ts";

export interface Regra {
  id: number;
  alvo: "item" | "transacao";
  tipo: "regex" | "exato";
  padrao: string;
  categoria_id: number;
  prioridade: number;
  sentido?: "saida" | "entrada" | null;
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
export function aplicarRegras(
  texto: string, regras: RegraCompilada[], alvo: "item" | "transacao", sentido?: "saida" | "entrada",
): Resultado | null {
  const norm = normalizar(texto);
  const chave = alvo === "item" ? norm : chaveAprendizado(texto);
  for (const r of regras) {
    if (r.alvo !== alvo) continue;
    if (r.sentido && sentido && r.sentido !== sentido) continue;
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
  const fixo = (nome: string): Resultado | null => cat[nome] ? { categoria_id: cat[nome], regra_id: null, origem: "padrao" } : null;
  // Tipo de operação informado pelo banco (Open Finance) é o sinal mais confiável
  if (op === "PAGAMENTO_FATURA") return fixo("Pagamento de fatura");
  if (op === "RESGATE_APLIC_FINANCEIRA") return fixo("Investimentos");
  if (tx.sentido === "entrada") {
    if (op === "PORTABILIDADE_SALARIO" || op === "FOLHA_PAGAMENTO") return fixo("Salário");
    if (op === "RENDIMENTO_APLIC_FINANCEIRA") return fixo("Rendimentos");
    if (op === "OPERACOES_CREDITO_CONTRATADAS_CARTAO" || op === "OPERACAO_CREDITO") return fixo("Crédito contratado");
    if (op === "ESTORNO" || op === "CASHBACK") return fixo("Reembolsos e estornos");
  } else if (op === "ENCARGOS_JUROS_CHEQUE_ESPECIAL" || op === "TARIFA" || op === "TARIFA_SERVICOS_AVULSOS" || op === "PACOTE_TARIFA_SERVICOS") {
    return fixo("Tarifas e juros");
  }
  const pag = soDigitos(tx.pagador_doc), rec = soDigitos(tx.recebedor_doc);
  if (pag && rec && pag === rec && cat["Transferência entre contas"]) {
    return { categoria_id: cat["Transferência entre contas"], regra_id: null, origem: "padrao" };
  }
  const texto = [tx.descricao, tx.recebedor_nome].filter(Boolean).join(" ");
  const r = aplicarRegras(texto, regras, "transacao", tx.sentido);
  if (r) return r;
  if (tx.sentido === "entrada") {
    // No cartão, entrada sem outra explicação é pagamento da fatura; na conta, é receita.
    return fixo(tx.conta_tipo === "CREDIT" ? "Pagamento de fatura" : "Outras receitas") ?? fixo("Receitas");
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
