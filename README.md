# Finanças da Casa

App (PWA) de controle financeiro da casa:

- **Open Finance** (Itaú e Nubank via Meu Pluggy) — lançamentos de conta e cartão sincronizados 2x por dia.
- **Notas fiscais por QR code** — itens lidos da SEFAZ, categorizados automaticamente e ligados ao gasto do banco
  (inclusive Pix de repasse e compras parceladas).
- **Categorização que aprende** — corrija uma vez e o app repete nas próximas.
- **Base consultável pelo Claude** — ver [docs/BASE.md](docs/BASE.md).

Instalação no Android: abra o endereço do app no Chrome → menu ⋮ → **Instalar app**.

Estrutura: `app/` (interface), `supabase/` (banco e servidor), `tests/`, `docs/`. Detalhes técnicos em [CLAUDE.md](CLAUDE.md).
