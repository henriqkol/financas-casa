// Encontra o gasto (lançamento de saída) que corresponde a uma nota fiscal.
import { dataBrasilia, diasEntre, soDigitos, tokensRelevantes } from "./texto.ts";

export interface NotaParaVincular {
  id: string;
  valor: number;              // valor pago (o que saiu da conta)
  emissao: string;            // ISO
  cnpj?: string | null;
  nome?: string | null;
}

export interface TxCandidata {
  id: string;
  valor: number;
  data: string;               // YYYY-MM-DD
  descricao: string;
  recebedor_doc?: string | null;
  recebedor_nome?: string | null;
  parcela_numero?: number | null;
  parcelas_total?: number | null;
  conta_tipo?: string | null;
  ja_vinculada?: boolean;
}

export interface Candidato {
  transacao_id: string;
  pontos: number;
  motivos: string[];
  dias: number;
}

/** Janela de busca: de 3 dias antes a 10 dias depois da compra. */
export const JANELA = { antes: 3, depois: 10 };

export function pontuar(nota: NotaParaVincular, tx: TxCandidata): Candidato | null {
  const motivos: string[] = [];
  const diaNota = dataBrasilia(nota.emissao);
  const dias = diasEntre(diaNota, tx.data);
  if (dias < -JANELA.antes || dias > JANELA.depois) return null;

  let pontos = 0;
  if (Math.abs(tx.valor - nota.valor) <= 0.01) {
    pontos = 60;
    motivos.push("mesmo valor");
  } else if ((tx.parcelas_total ?? 0) > 1 &&
    Math.abs(tx.valor * tx.parcelas_total! - nota.valor) <= 0.02 * tx.parcelas_total!) {
    pontos = 50;
    motivos.push(`parcelado em ${tx.parcelas_total}x`);
  } else {
    return null;
  }

  // Proximidade de datas (gasto antes da compra é menos provável)
  pontos -= dias >= 0 ? dias * 3 : Math.abs(dias) * 8;
  motivos.push(dias === 0 ? "mesmo dia" : dias > 0 ? `${dias} dia(s) depois` : `${-dias} dia(s) antes`);

  // Estabelecimento
  const cnpjNota = soDigitos(nota.cnpj);
  if (cnpjNota && soDigitos(tx.recebedor_doc) === cnpjNota) {
    pontos += 35;
    motivos.push("mesmo CNPJ");
  } else {
    const tokNota = tokensRelevantes(nota.nome);
    const txt = ` ${tokensRelevantes(`${tx.descricao} ${tx.recebedor_nome ?? ""}`).join(" ")} `;
    const comuns = tokNota.filter((t) => txt.includes(` ${t} `) || (t.length >= 6 && txt.includes(t.slice(0, 6))));
    if (comuns.length) {
      pontos += 25;
      motivos.push("nome do estabelecimento");
    }
  }
  if (tx.conta_tipo === "CREDIT" && dias >= 0 && dias <= 1) pontos += 5;
  if (tx.ja_vinculada) {
    pontos -= 40;
    motivos.push("já ligado a outra nota");
  }
  return { transacao_id: tx.id, pontos, motivos, dias };
}

export function candidatos(nota: NotaParaVincular, txs: TxCandidata[]): Candidato[] {
  return txs
    .map((t) => pontuar(nota, t))
    .filter((c): c is Candidato => c !== null)
    .sort((a, b) => b.pontos - a.pontos || Math.abs(a.dias) - Math.abs(b.dias));
}

/** Vincula sozinho só quando há um candidato claramente melhor. */
export function escolhaAutomatica(cs: Candidato[]): Candidato | null {
  const livres = cs.filter((c) => !c.motivos.includes("já ligado a outra nota"));
  if (!livres.length) return null;
  const [a, b] = livres;
  if (a.pontos < 40) return null;
  if (b && a.pontos - b.pontos < 15) return null;
  return a;
}
