-- recalcular_divida roda como dono do banco (security definer); com várias casas,
-- só os gatilhos das próprias dívidas podem chamá-la, nunca o app diretamente.
revoke execute on function recalcular_divida(bigint) from public, anon, authenticated;
