-- Regra "sem categoria": categoria_id vazio. Quando casa, o lançamento fica sem categoria
-- (para classificar à mão), vence todas as outras regras e o app não aprende com ele.
alter table regras_categoria alter column categoria_id drop not null;
comment on column regras_categoria.categoria_id is 'Categoria aplicada; vazio = regra "sem categoria": quando casa, o lançamento fica sem categoria (para classificar à mão) e nenhuma outra regra é aplicada.';
