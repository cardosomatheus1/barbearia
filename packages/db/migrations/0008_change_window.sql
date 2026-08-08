-- ============================================================================
-- 0008 — Janela de cancelamento e remarcação
--
-- A Parte 2 §2.7 da SPEC pede três regras configuráveis: antecedência mínima
-- (default 2h) e limite de remarcações por agendamento (default 2). Nenhuma
-- existia.
--
-- A ausência era visível para o cliente: a página de confirmação já exibia
-- "Cancele com pelo menos 2 horas de antecedência" a partir do texto livre em
-- `cancellation_policy`, e nada impedia o cancelamento um minuto antes. Texto
-- que promete e código que não cumpre é pior que silêncio.
--
-- São colunas, não constantes: a regra é de negócio e muda por unidade — uma
-- barbearia de bairro tolera cancelamento em cima da hora, uma com sinal pago
-- não (CLAUDE.md §4).
-- ============================================================================

ALTER TABLE locations
  -- Zero é válido e significa "pode cancelar até a hora do corte". É a política
  -- de quem prefere a vaga livre na fila a um cliente irritado.
  ADD COLUMN cancel_min_hours smallint NOT NULL DEFAULT 2,
  -- Separado do cancelamento de propósito: remarcar preserva a receita, então a
  -- barbearia costuma tolerar remarcação mais tarde do que toleraria a perda do
  -- horário. Mesmo default, liberdade diferente.
  ADD COLUMN reschedule_min_hours smallint NOT NULL DEFAULT 2,
  -- Sem teto, remarcação vira ocupação rotativa de agenda sem nunca comparecer.
  ADD COLUMN max_reschedules smallint NOT NULL DEFAULT 2,
  ADD CONSTRAINT locations_change_window_sane
    CHECK (cancel_min_hours >= 0 AND cancel_min_hours <= 720
           AND reschedule_min_hours >= 0 AND reschedule_min_hours <= 720
           AND max_reschedules >= 0 AND max_reschedules <= 50);

COMMENT ON COLUMN locations.cancel_min_hours IS
  'Horas mínimas entre o cancelamento pelo cliente e o início do serviço.';
COMMENT ON COLUMN locations.reschedule_min_hours IS
  'Horas mínimas entre a remarcação pelo cliente e o início do serviço.';
COMMENT ON COLUMN locations.max_reschedules IS
  'Quantas vezes o cliente pode remarcar a mesma visita.';

-- Sem índice novo aqui de propósito: contar remarcações percorre a corrente
-- `rescheduled_from` para trás, e cada passo é uma busca por `id` — chave
-- primária. Um índice em `rescheduled_from` serviria à direção oposta, que
-- nenhuma consulta faz (CLAUDE.md §3: índice entra junto com a query que o
-- exige, não antes).
