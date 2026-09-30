# Finanças da Casa — notas para o Claude

App de controle financeiro doméstico do Rique (e da esposa). Tudo em português.

## Arquitetura
- `app/` — PWA sem build (ES modules, supabase-js via jsdelivr). Publicado em https://henriqkol.github.io/financas-casa/ : o workflow `publicar-app.yml` copia `app/` para o ramo `gh-pages` a cada push em `main`.
- `supabase/migrations/` — esquema do Postgres (Supabase, projeto `hisraarbwhuhovommgqo`, região São Paulo). **Várias casas** (0011): toda tabela de dados tem `casa_id` (default `casa_atual()`) e RLS `casa_id = casa_atual()`. `casa_atual()` = casa aberta em `usuarios` pelo e-mail do JWT, desde que o e-mail esteja em `membros` daquela casa. RPC `entrar()` (chamada ao abrir o app) cria casa nova para quem não tem convite (copia `modelo_categorias`/`modelo_regras`) ou aceita convite pendente (`membros.aceito_em` nulo); `trocar_casa`, `sair_da_casa`, `minhas_casas`. `app_config` (global: cron_secret, functions_url, CDI) e `casa_config` (por casa: Pluggy, Anthropic, `robo_senha`) só o servidor lê. Casa 1 = dados originais do Henrique/Laynara. Em SQL como postgres não há filtro de RLS: **sempre filtrar `casa_id`** nas consultas.
- `supabase/functions/api/` — Edge Function única (Deno) com rotas `/nfce`, `/sync`, `/vincular`, `/categorizar-*`, `/config`… Deploy com `verify_jwt = false` (a função valida o JWT e o segredo do cron por conta própria).
- `tests/` — testes da lógica pura: `node --experimental-strip-types --test tests/logica.test.ts`.

## Como publicar mudanças
- App: commit + push em `main` (o GitHub Pages atualiza sozinho; o service worker usa rede primeiro).
- Banco: nova migração numerada em `supabase/migrations/` e aplicar pelo conector Supabase (`apply_migration`).
- Função: faça push em `main` e depois `deploy_edge_function` (nome `api`, `verify_jwt: false`) com um único `index.ts` que importa o código do GitHub fixado no commit: `import "https://raw.githubusercontent.com/henriqkol/financas-casa/<commit>/supabase/functions/api/index.ts";` (o repositório é público). Também funciona enviar `index.ts` + `lib/*.ts` diretamente.

## Fluxos principais
- **Open Finance**: Meu Pluggy (grátis, uso pessoal). Credenciais ficam em `casa_config` (uma Pluggy por casa) e IDs de Item em `pluggy_itens`, cadastrados na tela Mais. `pg_cron` chama `/api/sync` 2x/dia (`disparar_sync()` lê `functions_url` e `cron_secret` de `app_config`); a função sincroniza cada casa com Pluggy configurada logando como o robô da casa (`robo-casa-N@financas-casa.app`, membro só dela). A função `api` usa o JWT de quem chamou (cliente por requisição via AsyncLocalStorage, proxy `db`), então o RLS vale também no servidor; `adm` (service role) só para config/robôs. Rotas do agendamento aceitam `{"casa": N}` (padrão 1).
  IDs de transação da Pluggy mudam quando o banco reapresenta lançamentos: o sync marca os sumidos como `removida` e transfere vínculo/categoria manual para o substituto (`provider_id` ou valor+descrição+data).
- **NFC-e**: QR → `lib/nfce.ts` (RS usa `dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce?p=…`, layout "Portal NFC-e"). Se a leitura falhar, o HTML fica em `notas.html_bruto` para ajustar o parser.
- **Vínculo nota ↔ gasto**: `lib/vinculo.ts` — mesmo valor (ou parcela × n), janela −3/+10 dias, bônus por CNPJ/nome. Automático só quando há um candidato claramente melhor; senão a nota fica "confirmar".
- **Categorias**: regras regex (sistema) + exatas aprendidas das correções no app (prioridade 1) + IA opcional (Haiku) + tipo de loja. Nos resumos (`v_gastos`), gasto com nota é rateado pelas categorias dos itens.

## Patrimônio
- Investimentos: `/investments` da Pluggy a cada sync → `investimentos` + fotografia diária em `investimento_saldos`. Caixinhas do Nubank chegam como CDBs sem nome; o usuário associa cada aplicação a uma `caixinhas` no app.
- Dívidas: `/loans` (Open Finance) + cadastro manual (`dividas`, saldo recalculado por `recalcular_divida()` a cada pagamento — tabela Price quando há juros) + fatura/parcelas do cartão nas visões. Pagamentos são reconhecidos no extrato por `padrao_pagamento` (só depois do cadastro).

## Receitas, plano e sugestões
- Categorias têm `natureza` (despesa/receita/neutro) e `classe` (essencial_variavel/essencial_fixo/emergencial/estilo_vida), com `meta_valor` e `periodicidade_meses`. Plano: essenciais (fixo+variável) vs 50%, estilo de vida vs 30%, imprevistos à parte (reserva = gasto emergencial em 12 meses), provisões para viagens e contas anuais. Repasse família = mães (fixo); Pix para a esposa = "Pix para esposa (sem nota)". Regras podem ter `sentido` (só entrada ou só saída); regras aprendidas guardam o sentido do lançamento.
- Tela Movimentações (aba `gastos` no código) mostra despesas e receitas; itens neutros em cinza, fora das somas.
- `lib/sugestoes.ts` (`gerarDiagnostico`) é pura e testada; `index.ts/montarSugestoes` só junta os dados. Economia total não soma alertas de ritmo nem conta duas vezes os juros do cheque especial.
- Olho no topo das telas: oculta saldos, receitas, investimentos e dívidas (`Rp()` no app.js, classe `body.oculto`, lembrado no aparelho). Com o olho fechado também somem: total gasto e totais por categoria no Início, textos das sugestões no cartão do Início, todos os valores da tela Sugestões e o total de despesas em Movimentações. Valores de cada gasto e das notas continuam visíveis (`R()`).

## Gráfico de evolução (Início)
- `graficoEvolucao`/`baldesEvolucao` no app.js: despesas (`v_gastos`, só `conta_como_gasto`), receitas (`v_receitas`) e saldo investido (`v_investimentos_historico`). 1 ano/6 meses = totais por mês; 3 meses = por semana; 1 mês = acumulado diário. Um só eixo (tudo em R$). Cores validadas para daltonismo (laranja/verde-água/azul; investimentos tracejado). Some com o olho fechado.

## Metas (plano de 28/09/2026)
- Tela Metas (abas Mês · Acordos · Objetivos) + cartão no Início. Dados de `api/metas` (`lib/metas.ts`, pura e testada).
- Orçamento = `orcamento_grupos`/`orcamento_itens` (editáveis no app). Acordos = `dividas` tipo `acordo` com `vencimentos`. Objetivos/tarefas = `objetivos`. Detalhes em docs/BASE.md.
- Metas por categoria (0008) foram removidas: a meta vive no orçamento.

## Login com Google
- Botão "Entrar com Google" aparece só se o provedor Google estiver ligado no Supabase (`/auth/v1/settings`). `signInWithOAuth` volta para a URL do app; qualquer login novo ganha uma casa própria, vazia; convite (Mais → Casa e convites) põe o e-mail em `membros` da casa. Mesmo e-mail de uma conta com senha = mesmo usuário (o Supabase liga as identidades).

## Bloqueio com biometria
- Mais → "Bloqueio com biometria" cria uma credencial WebAuthn de plataforma (digital/rosto/PIN do aparelho) e guarda só o id em `localStorage.bloqueioBiometria`. Com ele ativo, `iniciar()` chama `exigirDesbloqueio()` antes de mostrar qualquer dado; ao voltar ao app depois de 1 min fora, pede de novo. É uma trava local (não substitui o login do Supabase). `Sair` remove o bloqueio.

## Offline
- Toda leitura via `q()` (GET do PostgREST) e `fn("/sugestoes" | "/config")` é guardada no IndexedDB `financas-cache` (chave = URL da consulta). Sem internet (`navigator.onLine === false` ou erro de rede) o app usa a cópia e mostra a faixa `#offline` com a data. Telas nunca abertas no aparelho mostram "Sem internet".
- Sem internet o login não é renovado: `iniciar()` usa a sessão guardada no localStorage só para abrir os dados salvos. `Sair` apaga a cópia local.
- Notas escaneadas offline vão para a fila `filaNotas` (localStorage) e são enviadas a `/nfce` quando a conexão volta (evento `online`, ao abrir o app e ao voltar para ele). Chave repetida não entra duas vezes; o servidor também ignora duplicadas.
- O service worker guarda os arquivos do app, `vendor/jsQR.min.js` (leitor de QR local) e a biblioteca do Supabase.

## Visual (redesign 30/09/2026, v1.10.0)
- Tokens em `estilo.css` (`--hero`, `--ouro`, `--b1..b4`, `--fonte-titulo`); fontes Bricolage Grotesque (títulos/valores) + Plus Jakarta Sans (Google Fonts, guardadas pelo service worker).
- `.topo` é a faixa verde de cima. Se logo depois vierem `.seg` (abas) e/ou um `.cartao.destaque` como primeiro filho de `#conteudo`, eles entram na faixa sozinhos (CSS `:has`), sem mudar o JS das telas.
- Barra inferior: Início · Extrato (aba `gastos`) · Escanear · Metas · Mais. Notas fiscais saiu da barra e ficou nos atalhos de Mais (`irNotas`).
- Início tem blocos coloridos (Sugestões, Sem categoria, Dívidas, Investido) no lugar dos cartões "Precisa de atenção" e "Patrimônio". Extrato mostra avatar colorido por categoria e separa "Tipo|Nome" da descrição do banco (`partesDescricao`).

## Análises
Ver `docs/BASE.md` para as visões e consultas prontas.
