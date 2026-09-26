// Motor de sugestões financeiras. Recebe dados já agregados e devolve um diagnóstico:
// renda, plano de gastos (50/30/20), reserva de emergência, plano de dívidas e sugestões.
// Sem acesso a banco: testável no Node.

export interface DadosSugestoes {
  hoje: string;                                   // YYYY-MM-DD (Brasília)
  gastos: { mes: string; categoria: string; classe: string | null; valor: number; n: number }[];
  receitas: { mes: string; categoria: string; valor: number }[];
  pagamentosDivida: { mes: string; valor: number }[];
  juros: { mes: string; tipo: string; valor: number }[];   // tipo: cheque_especial | atraso | cartao | iof | tarifas | outros
  recorrentes: { descricao: string; categoria: string | null; valor_medio: number; meses: number }[];
  contas: { nome: string; tipo: string; saldo: number }[];
  dividas: { nome: string; tipo: string; saldo: number; taxa_mensal: number | null; parcela: number | null; origem: string }[];
  cartao: { fatura: number; parcelas_futuras: number };
  investido: number;
  repasse: { total: number; com_nota: number };
  prefs: { renda_mensal: number | null; meta_poupanca_pct: number; reserva_meses: number };
  cdi_anual: number;
  pendencias: { notas: number; sem_categoria: number };
  ufs_notas: string[];
}

export interface Sugestao {
  id: string;
  tipo: "alerta" | "economia" | "divida" | "meta" | "dica";
  prioridade: number;                             // 1 = mais urgente
  titulo: string;
  texto: string;
  economia_mensal?: number;
  itens?: { rotulo: string; valor: number; detalhe?: string }[];
  acao?: { rotulo: string; destino: string; filtro?: string };
}

const R = (v: number) => "R$ " + (Math.round(v * 100) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const arred = (v: number) => Math.round(v * 100) / 100;

export function mesesAnteriores(hoje: string, n: number): string[] {
  const [a, m] = hoje.split("-").map(Number);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(a, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Taxa mensal estimada de uma dívida quando o banco não informa. */
export function taxaEstimada(tipo: string, taxa: number | null): { taxa: number; estimada: boolean } {
  if (taxa != null && taxa > 0) return { taxa, estimada: false };
  if (tipo === "cheque_especial") return { taxa: 8, estimada: true };      // teto legal: 8% ao mês
  if (tipo === "cartao") return { taxa: 7, estimada: true };               // rotativo/financiamento de fatura
  if (tipo === "emprestimo") return { taxa: 4, estimada: true };
  if (tipo === "financiamento") return { taxa: 1.5, estimada: true };
  if (tipo === "pessoa") return { taxa: 0, estimada: true };
  return { taxa: 3, estimada: true };
}

export function gerarDiagnostico(d: DadosSugestoes) {
  const ref = mesesAnteriores(d.hoje, 3);
  const mesAtual = d.hoje.slice(0, 7);
  const dia = Number(d.hoje.slice(8, 10));
  const [ano, mes] = mesAtual.split("-").map(Number);
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();

  const mesesComDados = ref.filter((m) => d.gastos.some((g) => g.mes === m) || d.receitas.some((r) => r.mes === m));
  const nMeses = Math.max(mesesComDados.length, 1);
  const somaRef = <T extends { mes: string; valor: number }>(xs: T[], f: (x: T) => boolean = () => true) =>
    xs.filter((x) => ref.includes(x.mes) && f(x)).reduce((s, x) => s + x.valor, 0);
  const mediaRef = <T extends { mes: string; valor: number }>(xs: T[], f?: (x: T) => boolean) => somaRef(xs, f) / nMeses;

  // ---------- Renda
  const RENDA = ["Salário", "Renda extra", "Rendimentos", "Outras receitas"];
  let renda = d.prefs.renda_mensal ?? 0;
  let origemRenda = "informada";
  if (!renda) {
    renda = mediaRef(d.receitas, (r) => RENDA.includes(r.categoria));
    origemRenda = renda ? "estimada pelas receitas" : "";
    if (!renda) { renda = mediaRef(d.receitas); origemRenda = renda ? "estimada por todas as entradas" : "desconhecida"; }
  }
  renda = arred(renda);

  // ---------- Plano 50/30/20
  const poupPct = Math.min(Math.max(d.prefs.meta_poupanca_pct, 0), 60) / 100;
  const essPct = 0.5, estiloPct = Math.max(1 - essPct - poupPct, 0);
  const despesas = arred(mediaRef(d.gastos));
  const essencial = arred(mediaRef(d.gastos, (g) => g.classe === "essencial"));
  const estilo = arred(despesas - essencial);
  const dividasMes = arred(mediaRef(d.pagamentosDivida));
  const sobra = arred(renda - despesas - dividasMes);
  const plano = {
    renda, origem_renda: origemRenda, meses: mesesComDados,
    gasto_ideal: arred(renda * (1 - poupPct)),
    despesas_media: despesas, dividas_media: dividasMes, sobra_media: sobra,
    essencial: { ideal: arred(renda * essPct), atual: essencial },
    estilo_vida: { ideal: arred(renda * estiloPct), atual: estilo },
    poupanca: { ideal: arred(renda * poupPct), atual: sobra },
    pct: { essencial: essPct, estilo_vida: estiloPct, poupanca: poupPct },
  };

  const S: Sugestao[] = [];
  const cdiMensal = Math.pow(1 + d.cdi_anual / 100, 1 / 12) - 1;
  const cdiMensalLiq = cdiMensal * 0.825; // IR médio ~17,5%

  // ---------- Dívidas: cheque especial primeiro
  const negativas = d.contas.filter((c) => c.tipo === "BANK" && c.saldo < 0);
  const positivas = d.contas.filter((c) => c.tipo === "BANK" && c.saldo > 0).sort((a, b) => b.saldo - a.saldo);
  const jurosPorTipo = (tipo: string) => mediaRef(d.juros, (j) => j.tipo === tipo);
  const jurosChequeMes = jurosPorTipo("cheque_especial");
  for (const c of negativas) {
    const usado = Math.abs(c.saldo);
    const disponivel = positivas.reduce((s, p) => s + p.saldo, 0);
    const cobrir = Math.min(usado, disponivel);
    const taxaReal = jurosChequeMes > 0 ? Math.min(jurosChequeMes / usado, 0.08) : 0.08;
    const economia = arred(cobrir * taxaReal);
    let texto = `Você está usando ${R(usado)} do limite da conta (cheque especial) em ${c.nome}. É o crédito mais caro do mercado: os juros chegam a 8% ao mês (cerca de 150% ao ano)`;
    texto += jurosChequeMes > 0 ? `, e custaram em média ${R(jurosChequeMes)} por mês nos últimos meses.` : ".";
    if (cobrir > 0) {
      texto += ` Há ${R(disponivel)} parados em ${positivas.map((p) => p.nome).join(", ")}: transferir ${R(cobrir)} para cobrir o limite economiza cerca de ${R(economia)} por mês em juros.`;
    } else {
      texto += ` Se não der para quitar agora, troque por um empréstimo pessoal ou consignado mais barato: com metade dos juros, a economia seria de cerca de ${R(usado * 0.04)} por mês. A portabilidade de crédito é um direito seu.`;
    }
    S.push({
      id: `cheque-${c.nome}`, tipo: "divida", prioridade: 1, titulo: "Saia do cheque especial", texto,
      economia_mensal: economia || arred(usado * 0.04),
      acao: { rotulo: "Ver dívidas", destino: "patrimonio_dividas" },
    });
  }

  // ---------- Juros, multas e tarifas pagos
  const jurosTotalMes = arred(mediaRef(d.juros));
  if (jurosTotalMes >= 30) {
    const tipos: Record<string, string> = {
      cheque_especial: "Cheque especial", atraso: "Atraso e multas", cartao: "Financiamento/parcelamento de fatura",
      iof: "IOF", tarifas: "Tarifas e anuidades", outros: "Outros juros",
    };
    const itens = Object.keys(tipos).map((t) => ({ rotulo: tipos[t], valor: arred(jurosPorTipo(t)) })).filter((i) => i.valor >= 1)
      .sort((a, b) => b.valor - a.valor);
    const dicas: string[] = [];
    if (jurosPorTipo("atraso") > 0) dicas.push("coloque as contas em débito automático ou com lembrete no dia do salário para zerar juros de atraso");
    if (jurosPorTipo("tarifas") > 0) dicas.push("peça isenção de anuidade e tarifas, ou migre para conta e cartão sem tarifa");
    if (jurosPorTipo("cartao") > 0) dicas.push("evite pagar só o mínimo ou parcelar a fatura: é uma das linhas mais caras");
    S.push({
      id: "juros", tipo: "economia", prioridade: 2, titulo: "Dinheiro perdido com juros e tarifas",
      texto: `Nos últimos ${nMeses} meses você pagou em média ${R(jurosTotalMes)} por mês (${R(jurosTotalMes * nMeses)} no total) em juros, multas e tarifas — dinheiro que não compra nada.${dicas.length ? " Para reduzir: " + dicas.join("; ") + "." : ""}`,
      economia_mensal: jurosTotalMes, itens,
      acao: { rotulo: "Ver lançamentos", destino: "movimentacoes", filtro: "Tarifas e juros" },
    });
  }

  // ---------- Fluxo do mês
  if (renda > 0 && sobra < 0) {
    S.push({
      id: "deficit", tipo: "alerta", prioridade: 1, titulo: "Está saindo mais do que entra",
      texto: `Na média dos últimos ${nMeses} meses, a renda foi ${R(renda)}, mas saíram ${R(despesas)} em despesas e ${R(dividasMes)} em pagamentos de dívidas: um déficit de ${R(-sobra)} por mês, coberto com crédito (cheque especial, fatura). Cortar esse valor é o passo mais importante.`,
      economia_mensal: arred(-sobra),
    });
  }

  // ---------- Gasto total e estilo de vida acima do ideal
  if (renda > 0 && despesas > plano.gasto_ideal) {
    S.push({
      id: "acima-ideal", tipo: "economia", prioridade: 2, titulo: "Gasto mensal acima do ideal para a sua renda",
      texto: `Para guardar ${pct(poupPct)} da renda, o ideal é gastar até ${R(plano.gasto_ideal)} por mês. A média recente foi ${R(despesas)}: ${R(despesas - plano.gasto_ideal)} acima.`,
      economia_mensal: arred(despesas - plano.gasto_ideal),
    });
  }
  const porCategoria = new Map<string, { classe: string | null; media: number; n: number; ultimo: number; anteriores: number; atual: number }>();
  for (const g of d.gastos) {
    const c = porCategoria.get(g.categoria) ?? { classe: g.classe, media: 0, n: 0, ultimo: 0, anteriores: 0, atual: 0 };
    if (ref.includes(g.mes)) { c.media += g.valor / nMeses; c.n += g.n / nMeses; }
    if (g.mes === ref[2]) c.ultimo += g.valor;
    if (g.mes === ref[0] || g.mes === ref[1]) c.anteriores += g.valor / 2;
    if (g.mes === mesAtual) c.atual += g.valor;
    porCategoria.set(g.categoria, c);
  }
  if (renda > 0 && estilo > plano.estilo_vida.ideal) {
    const top = [...porCategoria.entries()].filter(([, c]) => c.classe === "estilo_vida" && c.media >= 50)
      .sort((a, b) => b[1].media - a[1].media).slice(0, 4);
    S.push({
      id: "estilo-vida", tipo: "economia", prioridade: 3, titulo: "Gastos de estilo de vida acima do planejado",
      texto: `O plano reserva ${pct(estiloPct)} da renda (${R(plano.estilo_vida.ideal)}) para restaurantes, lazer, compras e assinaturas. A média foi ${R(estilo)}. Os maiores itens estão abaixo; cortar 20% deles já ajuda.`,
      economia_mensal: arred(estilo - plano.estilo_vida.ideal),
      itens: top.map(([nome, c]) => ({ rotulo: nome, valor: arred(c.media), detalhe: `−20% = ${R(c.media * 0.2)}/mês` })),
      acao: { rotulo: "Ver gastos", destino: "movimentacoes" },
    });
  }

  // ---------- Categorias em alta
  if (dia >= 10) {
    const fracao = dia / diasNoMes;
    const altas: Sugestao[] = [];
    for (const [nome, c] of porCategoria) {
      if (c.media < 100 || nome === "Outros") continue;
      const projecao = c.atual / fracao;
      if (projecao > c.media * 1.3 && projecao - c.media >= 100) {
        altas.push({
          id: `alta-${nome}`, tipo: "alerta", prioridade: 3, titulo: `${nome}: ritmo acima do normal este mês`,
          texto: `Até o dia ${dia} já foram ${R(c.atual)}. Nesse ritmo o mês fecha em ${R(projecao)}, ${pct(projecao / c.media - 1)} acima da média de ${R(c.media)}.`,
          economia_mensal: arred(projecao - c.media),
          acao: { rotulo: "Ver lançamentos", destino: "movimentacoes", filtro: nome },
        });
      }
    }
    // Só as 3 maiores, para não virar uma lista de alarmes
    S.push(...altas.sort((a, b) => (b.economia_mensal ?? 0) - (a.economia_mensal ?? 0)).slice(0, 3));
  }
  const subidas: { dif: number; s: Sugestao }[] = [];
  for (const [nome, c] of porCategoria) {
    if (nome === "Outros" || S.some((x) => x.id === `alta-${nome}`)) continue;
    if (c.anteriores >= 100 && c.ultimo > c.anteriores * 1.3 && c.ultimo - c.anteriores >= 150) {
      subidas.push({ dif: c.ultimo - c.anteriores, s: {
        id: `subiu-${nome}`, tipo: "alerta", prioridade: 4, titulo: `${nome} subiu no último mês`,
        texto: `Foram ${R(c.ultimo)} no último mês, contra ${R(c.anteriores)} em média nos dois meses anteriores (+${pct(c.ultimo / c.anteriores - 1)}). Vale ver o que mudou.`,
        acao: { rotulo: "Ver lançamentos", destino: "movimentacoes", filtro: nome },
      } });
    }
  }
  S.push(...subidas.sort((a, b) => b.dif - a.dif).slice(0, 2).map((x) => x.s));

  // ---------- Delivery e restaurantes
  const rest = porCategoria.get("Restaurante e delivery");
  if (rest && rest.media >= 300 && rest.n >= 6) {
    S.push({
      id: "delivery", tipo: "economia", prioridade: 3, titulo: "Restaurantes e delivery",
      texto: `São cerca de ${Math.round(rest.n)} pedidos/refeições fora por mês, somando ${R(rest.media)}. Trocar 1 em cada 3 por comida feita em casa economiza perto de ${R(rest.media / 3)} por mês.`,
      economia_mensal: arred(rest.media / 3),
      acao: { rotulo: "Ver lançamentos", destino: "movimentacoes", filtro: "Restaurante e delivery" },
    });
  }

  // ---------- Assinaturas e pagamentos recorrentes
  const recorr = d.recorrentes.filter((r) => r.meses >= 2).sort((a, b) => b.valor_medio - a.valor_medio);
  if (recorr.length) {
    const total = recorr.reduce((s, r) => s + r.valor_medio, 0);
    S.push({
      id: "recorrentes", tipo: "economia", prioridade: 4, titulo: "Pagamentos que se repetem todo mês",
      texto: `Encontrei ${recorr.length} cobranças recorrentes que somam ${R(total)} por mês. Cancele o que não usa e renegocie planos (celular, internet, seguros) uma vez por ano.`,
      itens: recorr.slice(0, 8).map((r) => ({ rotulo: r.descricao, valor: arred(r.valor_medio), detalhe: `${r.meses} meses${r.categoria ? " · " + r.categoria : ""}` })),
    });
  }

  // ---------- Repasses para a família sem nota
  if (d.repasse.total / nMeses >= 300) {
    const semNota = d.repasse.total - d.repasse.com_nota;
    const cobertura = d.repasse.total ? d.repasse.com_nota / d.repasse.total : 0;
    if (cobertura < 0.6) {
      S.push({
        id: "repasse", tipo: "dica", prioridade: 4, titulo: "Repasses sem nota fiscal",
        texto: `Dos ${R(d.repasse.total)} em repasses dos últimos ${nMeses} meses, só ${pct(cobertura)} têm nota escaneada. ${R(semNota)} ficam sem explicação: escanear as notas das compras mostra onde esse dinheiro vai.`,
        acao: { rotulo: "Escanear nota", destino: "escanear" },
      });
    }
  }

  // ---------- Comprometimento com dívidas e ordem de quitação
  const dividasLista = [
    ...d.dividas.map((x) => ({ ...x })),
    ...negativas.filter((c) => !d.dividas.some((x) => x.tipo === "cheque_especial" && x.nome.includes(c.nome)))
      .map((c) => ({ nome: `Cheque especial · ${c.nome}`, tipo: "cheque_especial", saldo: Math.abs(c.saldo), taxa_mensal: null, parcela: null, origem: "open_finance" })),
  ];
  if (d.cartao.fatura > 0) dividasLista.push({ nome: "Fatura do cartão", tipo: "fatura", saldo: d.cartao.fatura, taxa_mensal: 0, parcela: null, origem: "open_finance" });
  const ordem = dividasLista.filter((x) => x.saldo > 0).map((x) => {
    const t = x.tipo === "fatura" ? { taxa: 0, estimada: false } : taxaEstimada(x.tipo, x.taxa_mensal);
    return { nome: x.nome, saldo: arred(x.saldo), taxa_mensal: t.taxa, estimada: t.estimada, juros_mes: arred(x.saldo * t.taxa / 100) };
  }).sort((a, b) => b.taxa_mensal - a.taxa_mensal || a.saldo - b.saldo);
  const totalDividas = arred(ordem.reduce((s, x) => s + x.saldo, 0));
  const parcelasMes = arred(d.dividas.reduce((s, x) => s + (x.parcela ?? 0), 0));
  const comprometido = renda > 0 ? (Math.max(parcelasMes, dividasMes)) / renda : 0;
  if (comprometido > 0.3) {
    S.push({
      id: "comprometimento", tipo: "alerta", prioridade: comprometido > 0.5 ? 1 : 2, titulo: "Renda muito comprometida com dívidas",
      texto: `${pct(comprometido)} da renda vai para pagar dívidas todo mês. O recomendado é até 30%. Evite novas parcelas e crédito até baixar esse número.`,
    });
  }
  const caras = ordem.filter((x) => x.taxa_mensal > cdiMensalLiq * 100 && x.taxa_mensal > 0);
  if (caras.length) {
    S.push({
      id: "ordem-dividas", tipo: "divida", prioridade: 2, titulo: "Plano para quitar as dívidas",
      texto: `Método avalanche: pague o mínimo de todas e coloque cada real que sobrar na primeira da lista (a de maior juro); quando ela acabar, passe para a próxima. Qualquer juro acima de ${(cdiMensalLiq * 100).toFixed(2).replace(".", ",")}% ao mês (o que uma caixinha rende) custa mais do que o dinheiro guardado rende — por isso quitar dívida cara vem antes de investir.${caras.some((x) => x.estimada) ? " Taxas marcadas com ~ são estimativas: confira no contrato." : ""}`,
      itens: caras.map((x) => ({ rotulo: x.nome, valor: x.saldo, detalhe: `${x.estimada ? "~" : ""}${x.taxa_mensal.toString().replace(".", ",")}% a.m. ≈ ${R(x.juros_mes)} de juros/mês` })),
      acao: { rotulo: "Ver dívidas", destino: "patrimonio_dividas" },
    });
  }
  const portaveis = d.dividas.filter((x) => (x.tipo === "emprestimo" || x.tipo === "financiamento") && (x.taxa_mensal ?? 0) >= 2);
  if (portaveis.length) {
    S.push({
      id: "portabilidade", tipo: "divida", prioridade: 3, titulo: "Peça portabilidade ou renegociação",
      texto: `${portaveis.map((x) => x.nome).join(", ")} ${portaveis.length > 1 ? "têm" : "tem"} juros de 2% ao mês ou mais. Simule em outros bancos: pela portabilidade de crédito o novo banco quita a dívida e você passa a pagar juros menores, sem custo de transferência.`,
    });
  }
  if (renda > 0 && d.cartao.parcelas_futuras > renda * 0.2) {
    S.push({
      id: "parcelas", tipo: "alerta", prioridade: 3, titulo: "Muitas parcelas futuras no cartão",
      texto: `Já há ${R(d.cartao.parcelas_futuras)} em parcelas para os próximos meses (${pct(d.cartao.parcelas_futuras / renda)} de uma renda mensal). Segure novas compras parceladas até esse valor baixar.`,
      acao: { rotulo: "Ver parcelas", destino: "patrimonio_dividas" },
    });
  }

  // ---------- Reserva de emergência e dinheiro parado
  const baseReserva = essencial + dividasMes;
  const reserva = {
    meta: arred(baseReserva * d.prefs.reserva_meses), atual: arred(d.investido),
    meses_cobertos: baseReserva > 0 ? Math.round((d.investido / baseReserva) * 10) / 10 : 0,
  };
  if (baseReserva > 0 && reserva.atual < reserva.meta) {
    const guardar = Math.max(plano.poupanca.ideal, 100);
    const faltam = reserva.meta - reserva.atual;
    const temDividaCara = caras.length > 0;
    S.push({
      id: "reserva", tipo: "meta", prioridade: temDividaCara ? 4 : 2, titulo: "Reserva de emergência",
      texto: temDividaCara
        ? `A meta é ${R(reserva.meta)} (${d.prefs.reserva_meses} meses do essencial). Como há dívidas caras, comece por uma reserva pequena de 1 mês (${R(baseReserva)}) e priorize quitar as dívidas; depois complete a reserva.`
        : `A meta é ${R(reserva.meta)} (${d.prefs.reserva_meses} meses de gastos essenciais). Hoje há ${R(reserva.atual)} investidos (${reserva.meses_cobertos} meses). Guardando ${R(guardar)} por mês numa caixinha, você chega lá em cerca de ${Math.ceil(faltam / guardar)} meses.`,
      acao: { rotulo: "Ver caixinhas", destino: "patrimonio_invest" },
    });
  }
  if (!negativas.length) {
    const colchao = Math.max(1000, despesas * 0.5);
    const conta = positivas[0];
    if (conta && conta.saldo > colchao * 1.5) {
      const excedente = conta.saldo - colchao;
      S.push({
        id: "saldo-parado", tipo: "economia", prioridade: 3, titulo: "Dinheiro parado na conta",
        texto: `${conta.nome} tem ${R(conta.saldo)}. Deixando ${R(colchao)} para o dia a dia e movendo ${R(excedente)} para uma caixinha (≈100% do CDI, liquidez diária), o rendimento seria de cerca de ${R(excedente * cdiMensalLiq)} por mês.`,
        economia_mensal: arred(excedente * cdiMensalLiq),
        acao: { rotulo: "Ver caixinhas", destino: "patrimonio_invest" },
      });
    }
  }

  // ---------- Dados e dicas
  if (!d.prefs.renda_mensal && origemRenda !== "estimada pelas receitas") {
    S.push({ id: "renda", tipo: "dica", prioridade: 5, titulo: "Informe a renda mensal", texto: "Não identifiquei um salário nas entradas. Informe a renda da casa para o plano de gastos ficar preciso.", acao: { rotulo: "Ajustar plano", destino: "preferencias" } });
  }
  if (d.pendencias.sem_categoria > 0) {
    S.push({ id: "sem-categoria", tipo: "dica", prioridade: 5, titulo: `${d.pendencias.sem_categoria} lançamento(s) sem categoria`, texto: "Categorizar deixa as sugestões mais certeiras — e o app aprende para as próximas vezes.", acao: { rotulo: "Categorizar", destino: "movimentacoes", filtro: "sem-categoria" } });
  }
  if (d.ufs_notas.includes("RS")) {
    S.push({ id: "nfg", tipo: "dica", prioridade: 6, titulo: "Nota Fiscal Gaúcha", texto: "Já que vocês escaneiam as notas: cadastre o CPF no programa Nota Fiscal Gaúcha e peça CPF na nota. Cada compra vira chance nos sorteios mensais e pode dar desconto no IPVA." });
  }
  S.push(
    { id: "pague-se-primeiro", tipo: "dica", prioridade: 7, titulo: "Pague-se primeiro", texto: "Programe uma transferência automática para uma caixinha no dia em que o salário cai. O que não fica na conta não é gasto sem perceber." },
    { id: "48h", tipo: "dica", prioridade: 7, titulo: "Regra das 48 horas", texto: "Para compras não planejadas acima de R$ 200, espere 48 horas. Metade das vontades passa sozinha." },
  );

  S.sort((a, b) => a.prioridade - b.prioridade || (b.economia_mensal ?? 0) - (a.economia_mensal ?? 0));
  // Total sem contar duas vezes: alertas de ritmo e metas globais ficam de fora, e os juros de cheque especial
  // já aparecem na sugestão de sair do cheque especial.
  const foraDoTotal = (id: string) => id === "acima-ideal" || id === "deficit" || id.startsWith("alta-") || id.startsWith("subiu-");
  const somaCheque = S.filter((x) => x.id.startsWith("cheque-")).reduce((a, x) => a + (x.economia_mensal ?? 0), 0);
  const sobreposicao = Math.min(somaCheque, S.some((x) => x.id === "juros") ? jurosPorTipo("cheque_especial") : 0);
  const economiaTotal = arred(Math.max(0, S.filter((x) => !foraDoTotal(x.id)).reduce((a, x) => a + (x.economia_mensal ?? 0), 0) - sobreposicao));

  return {
    referencia: { meses: ref, mes_atual: mesAtual, cdi_anual: d.cdi_anual },
    plano, reserva,
    dividas: { total: totalDividas, parcelas_mes: parcelasMes, comprometimento: Math.round(comprometido * 1000) / 1000, ordem },
    economia_potencial: economiaTotal,
    sugestoes: S,
  };
}

/** Classifica um lançamento de juros/tarifas pelo texto do extrato. */
export function tipoDeJuros(descricao: string, tipoOperacao?: string | null): string {
  const t = descricao.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  if ((tipoOperacao ?? "").toUpperCase() === "ENCARGOS_JUROS_CHEQUE_ESPECIAL" || /LIMITE|LIM CONTA|CHEQUE ESP|ADIANT DEPOSIT/.test(t)) return "cheque_especial";
  if (/ATRASO|MORA|MULTA/.test(t)) return "atraso";
  if (/FINANC|PARCEL|ROTATIVO|FATURA|REFINANC/.test(t)) return "cartao";
  if (/\bIOF\b/.test(t)) return "iof";
  if (/TARIFA|ANUIDADE|CESTA|PACOTE|MENSALIDADE/.test(t)) return "tarifas";
  return "outros";
}
