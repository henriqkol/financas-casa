// Cliente mínimo da API da Pluggy (Meu Pluggy / Open Finance).
import { dataBrasilia, soDigitos } from "./texto.ts";

const BASE = "https://api.pluggy.ai";

export class ErroPluggy extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export async function autenticar(clientId: string, clientSecret: string): Promise<string> {
  const r = await fetch(`${BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!r.ok) throw new ErroPluggy(r.status, `Pluggy recusou as credenciais (${r.status}). Confira Client ID e Client Secret.`);
  const j = await r.json();
  return j.apiKey;
}

export async function pluggyGet(apiKey: string, caminho: string): Promise<any> {
  const r = await fetch(`${BASE}${caminho}`, { headers: { "X-API-KEY": apiKey, Accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new ErroPluggy(r.status, `Pluggy ${caminho.split("?")[0]} → ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

/** Lista os Items da aplicação (endpoint opcional; pode responder 403). */
export async function listarItens(apiKey: string): Promise<any[]> {
  const out: any[] = [];
  let caminho: string | null = "/v2/items";
  while (caminho) {
    const j = await pluggyGet(apiKey, caminho);
    out.push(...(j.results ?? []));
    caminho = j.next ? `/v2/items${j.next}` : null;
  }
  return out;
}

export async function obterItem(apiKey: string, id: string): Promise<any> {
  return pluggyGet(apiKey, `/items/${encodeURIComponent(id)}`);
}

export async function listarContas(apiKey: string, itemId: string): Promise<any[]> {
  const j = await pluggyGet(apiKey, `/accounts?itemId=${encodeURIComponent(itemId)}`);
  return j.results ?? [];
}

export async function listarTransacoes(apiKey: string, contaId: string, desde: Date): Promise<any[]> {
  const out: any[] = [];
  let caminho: string | null =
    `/v2/transactions?accountId=${encodeURIComponent(contaId)}&dateFrom=${encodeURIComponent(desde.toISOString())}`;
  let guarda = 0;
  while (caminho && guarda++ < 100) {
    const j = await pluggyGet(apiKey, caminho);
    out.push(...(j.results ?? []));
    caminho = j.next ? `/v2/transactions${j.next}` : null;
  }
  return out;
}

/** Data do lançamento: datas "puras" vêm como T00:00:00.000Z e não devem ser deslocadas. */
export function dataDoLancamento(iso: string): string {
  if (/T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10);
  return dataBrasilia(iso);
}

export interface LinhaTransacao {
  id: string;
  conta_id: string;
  data: string;
  descricao: string;
  descricao_raw: string | null;
  valor: number;
  sentido: "saida" | "entrada";
  valor_original: number;
  status: string | null;
  tipo_operacao: string | null;
  provider_id: string | null;
  parcela_numero: number | null;
  parcelas_total: number | null;
  data_compra: string | null;
  pagador_doc: string | null;
  recebedor_doc: string | null;
  recebedor_nome: string | null;
  removida: boolean;
  raw: any;
  atualizado_em: string;
}

export function normalizarTransacao(t: any, contaTipo: string): LinhaTransacao {
  const amount = Number(t.amount);
  const valorConta = t.amountInAccountCurrency != null ? Number(t.amountInAccountCurrency) : amount;
  let sentido: "saida" | "entrada";
  if (t.type === "DEBIT" || t.type === "CREDIT") {
    sentido = t.type === "DEBIT" ? "saida" : "entrada";
  } else if (contaTipo === "CREDIT") {
    sentido = amount > 0 ? "saida" : "entrada";
  } else {
    sentido = amount < 0 ? "saida" : "entrada";
  }
  const pd = t.paymentData ?? {};
  const cc = t.creditCardMetadata ?? {};
  return {
    id: t.id,
    conta_id: t.accountId,
    data: dataDoLancamento(t.date),
    descricao: (t.description ?? t.descriptionRaw ?? "").trim() || "(sem descrição)",
    descricao_raw: t.descriptionRaw ?? null,
    valor: Math.abs(valorConta),
    sentido,
    valor_original: amount,
    status: t.status ?? null,
    tipo_operacao: t.operationType ?? null,
    provider_id: t.providerId ?? null,
    parcela_numero: cc.installmentNumber ?? null,
    parcelas_total: cc.totalInstallments ?? null,
    data_compra: cc.purchaseDate ? dataDoLancamento(cc.purchaseDate) : null,
    pagador_doc: soDigitos(pd.payer?.documentNumber?.value) || null,
    recebedor_doc: soDigitos(pd.receiver?.documentNumber?.value) || null,
    recebedor_nome: pd.receiver?.name ?? null,
    removida: false,
    raw: t,
    atualizado_em: new Date().toISOString(),
  };
}
