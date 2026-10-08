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

## UX v1.12 (01/10/2026)
- Extrato: "Dia a dia" (receitas − despesas de consumo) e "Depois das dívidas" (− categoria "Pagamento de dívida"). Lançamentos com data futura ficam em "agendados", fora das somas (Início, Extrato e `/metas` usam `data <= hoje`).
- Nomes: `nomeLimpo()` no app (tira parcela, sufixo LTDA, caixa alta → normal). Apelidos de estabelecimento ficam em `preferencias.apelidos` (JSON `{chaveNome: apelido}`, chave = nome sem números como `chaveAprendizado`).
- Triagem de "sem categoria": agrupa por `chaveAprendizado(descricao + recebedor)` e chama `POST /categorizar-lote {transacao_ids, categoria_id, aprender}`.
- Lançamento manual: botão "+" → transação `id = manual-<uuid>`, `tipo_operacao = MANUAL`, conta "Dinheiro" `manual-dinheiro-<casa>` (tipo CASH, sem item da Pluggy).
- `/metas {mes}` aceita mês passado (calcula como no último dia dele; `historico: true`).
- Sugestões: `economia_mensal` + `no_total` = entra no "economia possível" (lista em `economia_composicao`); déficit e "acima do ideal" usam `impacto_mensal` (laranja, não somam).
- `todos()`/`todas()` sempre ordenam ao paginar (sem ORDER BY as páginas podem repetir/pular linhas).
- Robô: sessão reaproveitada por casa (pedidos simultâneos) e nova tentativa em "JWT issued at future".

## Verificação e notificações (v1.14, 01/10/2026)
- `POST /verificar`: pergunta à Pluggy o `lastUpdatedAt` de cada conexão e só sincroniza se mudou desde o último marcador (`casa_config` `pluggy_visto:<item>`, gravado a cada sincronização). pg_cron `verificar-pluggy` a cada 30 min (todas as casas, pelo robô); o app chama ao abrir/voltar ao primeiro plano (no máximo a cada 10 min por aparelho). Não roda se houver sincronização começada há < 5 min sem fim.
- Notificações: Web Push próprio (`lib/webpush.ts`, aes128gcm + VAPID, sem dependências). Chaves VAPID em `app_config` (`vapid_publica`, `vapid_privada`). Inscrições por aparelho em `casa_config` `push:<sha256(endpoint)>` = `{sub, prefs: {despesas, receitas, valores, email}}`. Depois de cada sincronização, um aviso por lançamento novo (despesa/receita, de conta que já existia, data nos últimos 7 dias; máx. 8 + resumo). 404/410 apaga a inscrição. Mais → Notificações liga/desliga por aparelho.
- Início do controle: `preferencias.controle_inicio` ("AAAA-MM"; sem ela, mês de criação da casa). "A fazer", triagem e a sugestão "sem categoria" só contam lançamentos sem categoria desse mês em diante (até hoje). Ajustável em Sugestões → Ajustar plano. Casa 1 = 2026-09.
- Regra "sem categoria" (`regras_categoria.categoria_id` nulo, prioridade 0): vence todas as regras e sinais do banco; o lançamento fica sem categoria para classificar à mão; `/categorizar-transacao` e `/categorizar-lote` não aprendem nem propagam para quem casa com ela; na triagem esses lançamentos vêm um a um. Itens de nota que casam ficam sem categoria (sem IA/loja/"Outros"). Mais → Regras automáticas tem busca (com busca mostra também as regras do app).

## Login só pelo Google (v1.18, 04/10/2026)
- App: tela de login só tem "Entrar com Google"; sessões abertas por senha (amr ≠ oauth) são encerradas ao abrir.
- Banco (0015_so_google.sql, aplicada): trigger em auth.users bloqueia cadastro por e-mail e definir senha; trigger em auth.mfa_amr_claims bloqueia login por senha/OTP/link mágico. Exceção: public.e_robo(email) = robo-casa-N@financas-casa.app (robôs do agendamento entram com senha). O provedor de e-mail precisa continuar ligado por causa dos robôs.

## Conta paga fora do mês (v1.19, 07/10/2026)
- Ligação manual pagamento → conta do plano em preferencias "pagamentos_conta" = {transacao_id: {item, mes}}.
- metas.ts: ligados (deste mês, com dados da transação de qualquer data) quitam a conta; ligados_ids (todos) saem do reconhecimento automático.
- App: detalhe do lançamento → cartão "Conta do plano" (Ligar/Trocar/Desligar); Metas → Mês → "Já paguei" nas contas em aberto.
