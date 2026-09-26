-- Regras para favorecidos frequentes que ficavam sem categoria (Pix/débito com nome do recebedor).
insert into regras_categoria (alvo, tipo, padrao, categoria_id, prioridade, origem, sentido)
select 'transacao', 'regex', r.padrao, c.id, r.prioridade, 'sistema', 'saida'
from (values
  ('(TELEFONICA|\bVIVO\b|\bCLARO\b|\bTIM S\.?A|OI S\.?A|NET SERVICOS|INTERNET|CEEE|RGE SUL|EQUATORIAL|CORSAN|DMAE|SULGAS|COMGAS)', 'Contas da casa', 20),
  ('(SEGURADORA|SEGUROS|PORTO SEGURO|\bSEGURO\b)', 'Contas da casa', 21),
  ('(SECRETARIA (DE ESTADO )?DA FAZENDA|GOVERNO DO|DETRAN|\bIPVA\b|\bIPTU\b|PREFEITURA|RECEITA FEDERAL|\bDARF\b|\bGRU\b)', 'Impostos', 20),
  ('(\bSUPER |SUPERMERC|MERCADO(?! ?(PAGO|LIVRE|LIVR))|ATACAD|ASSAI|ZAFFARI|CARREFOUR|BOURBON|UNIDASUL|\bBIG\b)', 'Mercado', 22),
  ('(PNEU|AUTO ?PECAS|OFICINA|MECANICA|ESTACIONAMENTO|PEDAGIO|SEM PARAR|CONECTCAR|VELOE)', 'Transporte', 22),
  ('(AGRO |AGROPECUARIA|PET ?SHOP|COBASI|PETZ|VETERINAR)', 'Pet', 22),
  ('(CAPITALIZACAO|CAP PIC)', 'Investimentos', 20)
) as r(padrao, categoria, prioridade)
join categorias c on c.nome = r.categoria
on conflict (alvo, tipo, padrao) do nothing;
