-- ============================================================================
-- 0009 — Bloqueio pontual de parte do dia
--
-- `schedule_exceptions` sabia dizer "não trabalha" (day_off, holiday, vacation)
-- e "trabalha em outro horário" (custom_hours). Faltava o caso mais corriqueiro
-- de todos: **o barbeiro que atende o dia inteiro menos das 14h às 15h**, porque
-- tem dentista.
--
-- `custom_hours` não resolve: ela substitui a jornada por uma faixa contínua e
-- não abre buraco no meio. Sem isso, a recepção só tinha duas saídas — tirar o
-- barbeiro do dia inteiro, jogando fora a manhã e o fim da tarde, ou criar um
-- agendamento falso, que suja faturamento e comissão.
--
-- O motor (`packages/core`) já aceita `blocks` e tem teste desde o bloco 1. O
-- que não existia era de onde os dados viriam: o repositório passava lista
-- vazia. Esta migração fecha essa lacuna.
-- ============================================================================

ALTER TYPE schedule_exception_type ADD VALUE IF NOT EXISTS 'block';
