-- Conta PicPay própria usada só para pagar Anthropic + Google One (Google Play):
-- o Pix para ela é gasto de Assinaturas, não transferência entre contas.
alter table transacoes add column if not exists recebedor_ispb text;
comment on column transacoes.recebedor_ispb is 'Código (ISPB) do banco de destino do pagamento, quando informado. 22896431 = PicPay.';
update transacoes set recebedor_ispb = raw->'paymentData'->'receiver'->>'routingNumberISPB'
where recebedor_ispb is null and raw->'paymentData'->'receiver'->>'routingNumberISPB' is not null;

insert into preferencias (chave, valor)
values ('carteiras_despesa', '[{"ispb":"22896431","nome":"PICPAY","categoria":"Assinaturas"}]')
on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
comment on table preferencias is 'Preferências do casal: renda_mensal, meta_poupanca_pct, reserva_meses, carteiras_despesa (JSON: contas próprias em outros bancos que só pagam despesas — ex.: PicPay → Assinaturas), acordos_ultimo_atraso, plano_inicio.';
