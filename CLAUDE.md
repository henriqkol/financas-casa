# Finanças da Casa — notas para o Claude

App de controle financeiro doméstico do Rique (e da esposa). Tudo em português.

## Arquitetura
- `app/` — PWA sem build (ES modules, supabase-js via jsdelivr). Publicado em https://henriqkol.github.io/financas-casa/ : o workflow `publicar-app.yml` copia `app/` para o ramo `gh-pages` a cada push em `main`.
- `supabase/migrations/` — esquema do Postgres (Supabase, projeto `hisraarbwhuhovommgqo`, região São Paulo). RLS: só e-mails em `membros` veem dados; `app_config` só o servidor lê.
- `supabase/functions/api/` — Edge Function única (Deno) com rotas `/nfce`, `/sync`, `/vincular`, `/categorizar-*`, `/config`… Deploy com `verify_jwt = false` (a função valida o JWT e o segredo do cron por conta própria).
- `tests/` — testes da lógica pura: `node --experimental-strip-types --test tests/logica.test.ts`.

## Como publicar mudanças
- App: commit + push em `main` (o GitHub Pages atualiza sozinho; o service worker usa rede primeiro).
- Banco: nova migração numerada em `supabase/migrations/` e aplicar pelo conector Supabase (`apply_migration`).
- Função: `deploy_edge_function` pelo conector Supabase, nome `api`, enviando `index.ts` e `lib/*.ts`, `verify_jwt: false`.

## Fluxos principais
- **Open Finance**: Meu Pluggy (grátis, uso pessoal). Credenciais e IDs de Item ficam em `app_config`/`pluggy_itens`, cadastrados na tela Mais. `pg_cron` chama `/api/sync` 2x/dia (`disparar_sync()` lê `functions_url` e `cron_secret` de `app_config`).
  IDs de transação da Pluggy mudam quando o banco reapresenta lançamentos: o sync marca os sumidos como `removida` e transfere vínculo/categoria manual para o substituto (`provider_id` ou valor+descrição+data).
- **NFC-e**: QR → `lib/nfce.ts` (RS usa `dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce?p=…`, layout "Portal NFC-e"). Se a leitura falhar, o HTML fica em `notas.html_bruto` para ajustar o parser.
- **Vínculo nota ↔ gasto**: `lib/vinculo.ts` — mesmo valor (ou parcela × n), janela −3/+10 dias, bônus por CNPJ/nome. Automático só quando há um candidato claramente melhor; senão a nota fica "confirmar".
- **Categorias**: regras regex (sistema) + exatas aprendidas das correções no app (prioridade 1) + IA opcional (Haiku) + tipo de loja. Nos resumos (`v_gastos`), gasto com nota é rateado pelas categorias dos itens.

## Patrimônio
- Investimentos: `/investments` da Pluggy a cada sync → `investimentos` + fotografia diária em `investimento_saldos`. Caixinhas do Nubank chegam como CDBs sem nome; o usuário associa cada aplicação a uma `caixinhas` no app.
- Dívidas: `/loans` (Open Finance) + cadastro manual (`dividas`, saldo recalculado por `recalcular_divida()` a cada pagamento — tabela Price quando há juros) + fatura/parcelas do cartão nas visões. Pagamentos são reconhecidos no extrato por `padrao_pagamento` (só depois do cadastro).

## Análises
Ver `docs/BASE.md` para as visões e consultas prontas.
