-- ============================================================================
-- 0010 — Bloqueio sem faixa é bloqueio do dia inteiro por engano
--
-- Migração separada da 0009 de propósito: o Postgres não deixa usar um valor de
-- enum recém-criado dentro da mesma transação que o criou. Juntas, a CHECK
-- falharia com "unsafe use of new value of enum type".
--
-- A regra: `block` exige início e fim, como `custom_hours`. Um bloqueio sem
-- faixa passaria pelo banco e chegaria ao motor como intervalo vazio — o
-- barbeiro continuaria recebendo agendamento no horário que pediu para fechar,
-- e ninguém descobriria até o cliente aparecer.
-- ============================================================================

ALTER TABLE schedule_exceptions
  DROP CONSTRAINT schedule_exceptions_custom_hours_needs_range,
  ADD CONSTRAINT schedule_exceptions_range_when_partial
    CHECK (
      kind NOT IN ('custom_hours', 'block')
      OR (start_minute IS NOT NULL AND end_minute IS NOT NULL)
    );

COMMENT ON TYPE schedule_exception_type IS
  'day_off/holiday/vacation encerram o dia; custom_hours substitui a jornada; block recorta uma faixa dela.';
