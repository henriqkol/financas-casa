// Investimentos e dívidas: normalização dos dados da Pluggy e reconhecimento de pagamentos.
import { chaveAprendizado, dataBrasilia } from "./texto.ts";

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function dia(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  return dataBrasilia(v);
}

export interface LinhaInvestimento {
  id: string;
  item_id: string;
  nome: string | null;
  tipo: string | null;
  subtipo: string | null;
  emissor: string | null;
  taxa: number | null;
  indexador: string | null;
  taxa_anual_fixa: number | null;
  data_aplicacao: string | null;
  vencimento: string | null;
  status: string | null;
  valor_aplicado: number | null;
  saldo_bruto: number | null;
  saldo_liquido: number | null;
  saldo_resgatavel: number | null;
  atualizado_em: string;
  raw: unknown;
}

export function normalizarInvestimento(inv: any, itemId: string): LinhaInvestimento {
  return {
    id: inv.id,
    item_id: itemId,
    nome: inv.name ?? null,
    tipo: inv.type ?? null,
    subtipo: inv.subtype ?? null,
    emissor: inv.issuer ?? inv.institution?.name ?? null,
    taxa: inv.rate != null ? Number(inv.rate) : null,
    indexador: inv.rateType ?? null,
    taxa_anual_fixa: inv.fixedAnnualRate != null ? Number(inv.fixedAnnualRate) : null,
    data_aplicacao: dia(inv.issueDate ?? inv.purchaseDate),
    vencimento: dia(inv.dueDate),
    status: inv.status ?? null,
    valor_aplicado: num(inv.amountOriginal),
    saldo_bruto: num(inv.amount),
    saldo_liquido: num(inv.balance),
    saldo_resgatavel: num(inv.amountWithdrawal),
    atualizado_em: new Date().toISOString(),
    raw: inv,
  };
}

const TIPO_EMPRESTIMO: Record<string, string> = {
  FINANCING: "financiamento",
  UNARRANGED_ACCOUNT_OVERDRAFT: "cheque_especial",
  INVOICE_FINANCING: "cartao",
};

export function normalizarEmprestimo(l: any) {
  const total = l.totalNumberOfInstallments != null ? Number(l.totalNumberOfInstallments) : null;
  const restantes = l.contractRemainingNumber != null ? Number(l.contractRemainingNumber) : null;
  const saldo = num(l.contractOutstandingBalance);
  const pagas = l.paidInstallments != null ? Number(l.paidInstallments)
    : total != null && restantes != null ? total - restantes : 0;
  return {
    pluggy_id: l.id,
    nome: l.productName || l.productType || l.type || "Empréstimo",
    credor: l.institution?.name ?? l.institutionName ?? null,
    tipo: TIPO_EMPRESTIMO[l.kind] ?? "emprestimo",
    origem: "open_finance" as const,
    valor_original: num(l.contractAmount),
    saldo_devedor: saldo,
    cet_anual: l.CET != null ? Number(l.CET) : null,
    parcela_valor: saldo != null && restantes ? Math.round((saldo / restantes) * 100) / 100 : null,
    parcelas_total: total,
    parcelas_pagas: Math.max(0, pagas || 0),
    data_inicio: dia(l.contractDate ?? l.disbursementDates?.[0]),
    ativa: saldo == null || saldo > 0,
    atualizado_em: new Date().toISOString(),
    raw: l,
  };
}

export interface DividaComPadrao { id: number; padrao_pagamento: string | null }
export interface TxParaPagamento { id: string; data: string; valor: number; descricao: string; recebedor_nome?: string | null }

/** Lançamentos de saída cuja descrição contém o padrão de pagamento de alguma dívida. */
export function reconhecerPagamentos(dividas: DividaComPadrao[], txs: TxParaPagamento[], jaUsadas: Set<string>) {
  const out: { divida_id: number; transacao_id: string; data: string; valor: number }[] = [];
  const padroes = dividas
    .filter((d) => d.padrao_pagamento && chaveAprendizado(d.padrao_pagamento).length >= 3)
    .map((d) => ({ id: d.id, p: ` ${chaveAprendizado(d.padrao_pagamento)} ` }));
  for (const t of txs) {
    if (jaUsadas.has(t.id)) continue;
    const texto = ` ${chaveAprendizado([t.descricao, t.recebedor_nome].filter(Boolean).join(" "))} `;
    const d = padroes.find((x) => texto.includes(x.p));
    if (d) {
      out.push({ divida_id: d.id, transacao_id: t.id, data: t.data, valor: t.valor });
      jaUsadas.add(t.id);
    }
  }
  return out;
}
