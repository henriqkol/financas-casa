// Sistema de metas: orçamento do mês, contas do dia 5, acordos e objetivos do plano financeiro.
import { normalizar } from "./texto.ts";

export interface ItemOrcamento {
  id: number; nome: string; valor: number; periodicidade_meses: number; tipo: "conta" | "envelope";
  dia_vencimento: number | null; forma_pagamento: string | null; padrao: string | null; observacao: string | null;
}
export interface GrupoOrcamento { id: number; nome: string; ordem: number; categorias: number[]; observacao: string | null; itens: ItemOrcamento[] }
export interface Acordo {
  id: number; nome: string; credor: string | null; parcela_valor: number; parcelas_total: number; parcelas_pagas: number;
  saldo_devedor: number | null; vencimentos: string[]; observacao: string | null;
}
export interface Objetivo {
  id: number; grupo: string; titulo: string; descricao: string | null; tipo: "valor" | "habito" | "tarefa" | "monitor";
  fonte: string | null; valor_alvo: number | null; valor_atual: number | null; inverso: boolean; data_alvo: string | null;
  concluido_em: string | null; ordem: number;
}
export interface DadosMetas {
  hoje: string;                                                   // YYYY-MM-DD (Brasília)
  renda_plano: number;                                            // líquido esperado por mês
  receitas_mes: number;                                           // receitas reais do mês até hoje
  grupos: GrupoOrcamento[];
  gastos_mes: { categoria_id: number | null; categoria: string; valor: number }[];   // v_gastos do mês (só gasto real)
  pix_esposa_categoria_id: number | null;
  saidas_mes: { id: string; data: string; valor: number; texto: string }[];          // para achar as contas pagas
  acordos: Acordo[];
  pagamentos: { divida_id: number; data: string; valor: number }[];
  fluxo: { mes: string; sobra: number }[];
  colchao: number;
  objetivos: Objetivo[];
  inicio_relogio: string;                                         // último atraso ou 28/09/2026
  inicio_plano?: string;                                          // antes disso, conta não paga não é "atrasada"
}

const arred = (v: number) => Math.round(v * 100) / 100;

/** Texto do extrato digitado no app: regex (ex.: "(BONIFACIO|\\bIVAN\\b)") ou texto simples.
 *  Versões antigas do app passavam tudo para maiúsculas e viravam \\b em \\B: aqui isso é desfeito. */
export function compilarPadrao(p: string | null | undefined): RegExp | null {
  if (!p || !p.trim()) return null;
  const fonte = p.trim().replace(/\\([BDSW])/g, (_, c: string) => "\\" + c.toLowerCase());
  try { return new RegExp(fonte, "i"); } catch { /* não é regex válida: procura o texto literal */ }
  try { return new RegExp(normalizar(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); } catch { return null; }
}
const mesDe = (d: string) => d.slice(0, 7);
function addDias(dia: string, n: number) { const d = new Date(dia + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mesesEntre(de: string, ate: string) {
  const [a1, m1, d1] = de.split("-").map(Number), [a2, m2, d2] = ate.split("-").map(Number);
  return Math.max(0, (a2 - a1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

/** Situação de cada acordo hoje. */
export function situacaoAcordos(acordos: Acordo[], pagamentos: DadosMetas["pagamentos"], hoje: string) {
  return acordos.map((a) => {
    const venc = [...(a.vencimentos ?? [])].sort();
    const esperadas = venc.filter((v) => v < hoje).length;          // já deveriam estar pagas (vencidas antes de hoje)
    const atrasadas = Math.max(0, esperadas - a.parcelas_pagas);
    const proxN = Math.min(a.parcelas_pagas + 1, venc.length);
    const proxima = a.parcelas_pagas < venc.length ? { numero: proxN, data: venc[proxN - 1] } : null;
    return {
      id: a.id, nome: a.nome, credor: a.credor, parcela: a.parcela_valor, pagas: a.parcelas_pagas, total: a.parcelas_total,
      saldo: a.saldo_devedor ?? arred(a.parcela_valor * Math.max(a.parcelas_total - a.parcelas_pagas, 0)),
      proxima, atrasadas, em_dia: atrasadas === 0, fim: venc.at(-1) ?? null, observacao: a.observacao,
      ultimo_pagamento: pagamentos.filter((p) => p.divida_id === a.id).map((p) => p.data).sort().at(-1) ?? null,
    };
  });
}

export function montarMetas(d: DadosMetas) {
  const mes = mesDe(d.hoje);
  const dia = Number(d.hoje.slice(8, 10));

  // ---------- Orçamento por grupo
  const noPlano = new Set(d.grupos.flatMap((g) => g.categorias));
  const gastoCat = (ids: number[]) => d.gastos_mes.filter((g) => g.categoria_id != null && ids.includes(g.categoria_id)).reduce((s, g) => s + g.valor, 0);
  const grupos = [...d.grupos].sort((a, b) => a.ordem - b.ordem).map((g) => {
    const itens = g.itens.map((i) => ({ ...i, meta_mensal: arred(i.valor / (i.periodicidade_meses || 1)) }));
    const meta = arred(itens.reduce((s, i) => s + i.meta_mensal, 0));
    const gasto = arred(gastoCat(g.categorias));
    return { id: g.id, nome: g.nome, meta, gasto, pct: meta > 0 ? gasto / meta : (gasto > 0 ? Infinity : 0), observacao: g.observacao, itens };
  });
  const pixEsposa = arred(d.gastos_mes.filter((g) => g.categoria_id === d.pix_esposa_categoria_id).reduce((s, g) => s + g.valor, 0));
  const foraMap = new Map<string, number>();
  for (const g of d.gastos_mes) {
    if (g.categoria_id != null && (noPlano.has(g.categoria_id) || g.categoria_id === d.pix_esposa_categoria_id)) continue;
    foraMap.set(g.categoria, (foraMap.get(g.categoria) ?? 0) + g.valor);
  }
  const fora = [...foraMap.entries()].map(([nome, valor]) => ({ nome, valor: arred(valor) })).sort((a, b) => b.valor - a.valor);

  // ---------- Acordos
  const acordos = situacaoAcordos(d.acordos, d.pagamentos, d.hoje);

  // ---------- Contas do mês (checklist do dia 5)
  const usadas = new Set<string>();
  const contas: {
    tipo: "conta" | "acordo"; nome: string; valor: number; dia: number | null; data: string | null;
    status: "pago" | "parcial" | "atrasado" | "hoje" | "pendente"; pago_em: string | null; pago_valor?: number; forma: string | null; ref: number;
  }[] = [];
  for (const g of d.grupos) for (const i of g.itens) {
    if (i.tipo !== "conta" || (i.periodicidade_meses ?? 1) !== 1 || !(i.valor > 0)) continue;
    const re = compilarPadrao(i.padrao);
    const candidatos = re ? d.saidas_mes.filter((t) => !usadas.has(t.id) && re.test(normalizar(t.texto))) : [];
    // 1) um pagamento com valor parecido; 2) vários pagamentos que somados cobrem a conta (ex.: Pix para duas pessoas)
    const unico = candidatos.find((t) => Math.abs(t.valor - i.valor) <= Math.max(i.valor * 0.3, 10));
    // soma muito acima da conta (mais de 1,5×) indica outro pagamento ao mesmo favorecido: não conta
    const somaTodos = arred(candidatos.reduce((s, t) => s + t.valor, 0));
    const usados = unico ? [unico] : somaTodos <= i.valor * 1.5 ? candidatos : [];
    const pagoTotal = arred(usados.reduce((s, t) => s + t.valor, 0));
    const quitada = !!unico || (usados.length > 0 && pagoTotal >= i.valor * 0.9);
    if (quitada) usados.forEach((t) => usadas.add(t.id));
    const data = i.dia_vencimento ? `${mes}-${String(Math.min(i.dia_vencimento, 28)).padStart(2, "0")}` : null;
    const antesDoPlano = !!d.inicio_plano && mes < mesDe(d.inicio_plano);
    const ultimo = usados.map((t) => t.data).sort().at(-1) ?? null;
    contas.push({
      tipo: "conta", nome: i.nome, valor: i.valor, dia: i.dia_vencimento, data,
      status: quitada ? "pago" : pagoTotal > 0 ? "parcial" : data && data < d.hoje && !antesDoPlano ? "atrasado" : data === d.hoje ? "hoje" : "pendente",
      pago_em: quitada || pagoTotal > 0 ? ultimo : null, pago_valor: pagoTotal, forma: i.forma_pagamento, ref: i.id,
    });
  }
  for (const a of d.acordos) {
    const venc = (a.vencimentos ?? []).filter((v) => mesDe(v) === mes);
    if (!venc.length) continue;
    const v = venc[0];
    const numero = (a.vencimentos ?? []).indexOf(v) + 1;
    // Paga se a parcela deste mês já está entre as pagas (inclui as pagas antes do cadastro) ou se há pagamento perto do vencimento
    const pagoAntes = numero > 0 && numero <= a.parcelas_pagas;
    const pagamento = d.pagamentos.find((p) => p.divida_id === a.id && p.data >= addDias(v, -25) && p.data <= addDias(v, 20));
    const pago = pagamento ?? (pagoAntes ? { data: null as string | null } : undefined);
    const s = acordos.find((x) => x.id === a.id)!;
    contas.push({
      tipo: "acordo", nome: a.nome, valor: a.parcela_valor, dia: Number(v.slice(8, 10)), data: v,
      status: pago ? "pago" : v < d.hoje ? "atrasado" : v === d.hoje ? "hoje" : "pendente",
      pago_em: pago?.data ?? null, forma: `parcela ${numero}/${s.total}`, ref: a.id,
    });
  }
  const ordemStatus = { atrasado: 0, hoje: 1, parcial: 2, pendente: 3, pago: 4 };
  contas.sort((a, b) => ordemStatus[a.status] - ordemStatus[b.status] || (a.data ?? "9999").localeCompare(b.data ?? "9999"));

  // ---------- Resultado do mês
  const metasTotal = arred(grupos.reduce((s, g) => s + g.meta, 0));
  const acordosMes = arred(d.acordos.reduce((s, a) => s + ((a.vencimentos ?? []).some((v) => mesDe(v) === mes) ? a.parcela_valor : 0), 0));
  const gastoReal = arred(d.gastos_mes.reduce((s, g) => s + g.valor, 0));
  const acordosPagos = arred(d.pagamentos.filter((p) => mesDe(p.data) === mes).reduce((s, p) => s + p.valor, 0));
  const resultado = {
    renda_plano: d.renda_plano, metas_total: metasTotal, acordos_mes: acordosMes,
    previsto: arred(d.renda_plano - metasTotal - acordosMes),
    receitas_real: arred(d.receitas_mes), gasto_real: gastoReal, acordos_pagos: acordosPagos,
    real_ate_hoje: arred(d.receitas_mes - gastoReal - acordosPagos),
    gasto_fora_do_plano: arred(fora.reduce((s, f) => s + f.valor, 0)),
    pix_esposa_sem_nota: pixEsposa,
    // quanto ainda pode sair no mês sem estourar a meta (envelopes + contas ainda não pagas)
    livre_no_mes: arred(Math.max(metasTotal - gastoReal, 0)),
    dia,
  };

  // ---------- Objetivos
  const atrasoAgora = acordos.some((a) => a.atrasadas > 0);
  const mesesEmDia = atrasoAgora ? 0 : mesesEntre(d.inicio_relogio, d.hoje);
  const fechados = d.fluxo.filter((f) => f.mes >= "2026-11" && f.mes < mes).sort((a, b) => a.mes.localeCompare(b.mes));
  let seqAzul = 0;
  for (const f of [...fechados].reverse()) { if (f.sobra >= 0) seqAzul++; else break; }
  const objetivos = [...d.objetivos].sort((a, b) => a.ordem - b.ordem).map((o) => {
    let atual = o.valor_atual;
    let detalhe: string | null = null;
    if (o.fonte === "colchao") atual = arred(d.colchao);
    if (o.fonte === "acordos_em_dia") {
      atual = mesesEmDia;
      detalhe = atrasoAgora ? "Há parcela atrasada: pague para não quebrar o acordo." : `Sem atrasos desde ${d.inicio_relogio.split("-").reverse().join("/")}.`;
    }
    if (o.fonte === "resultado_mensal") {
      atual = seqAzul;
      detalhe = fechados.length ? `Últimos meses: ${fechados.slice(-4).map((f) => `${f.mes.slice(5)}/${f.mes.slice(2, 4)} ${f.sobra >= 0 ? "+" : "−"}R$ ${Math.abs(Math.round(f.sobra)).toLocaleString("pt-BR")}`).join(" · ")}` : "A contagem começa com novembro/2026, o primeiro mês típico do plano.";
    }
    const alvo = o.valor_alvo;
    const progresso = o.tipo === "tarefa" ? (o.concluido_em ? 1 : 0)
      : alvo && atual != null ? (o.inverso ? (atual <= alvo ? 1 : alvo / atual) : Math.min(atual / alvo, 1)) : 0;
    const atingido = o.tipo === "tarefa" ? !!o.concluido_em : o.inverso ? (atual ?? Infinity) <= (alvo ?? 0) : alvo != null && atual != null && atual >= alvo;
    return { ...o, valor_atual: atual, progresso: Math.round(progresso * 1000) / 1000, atingido, detalhe,
      vencida: o.tipo === "tarefa" && !o.concluido_em && !!o.data_alvo && o.data_alvo < d.hoje };
  });

  return { mes, hoje: d.hoje, resultado, grupos, fora_do_plano: fora, contas, acordos, objetivos, atraso_acordo: atrasoAgora };
}
