-- ============================================================================
-- 0014 — Quando cada coisa aconteceu no atendimento
--
-- `appointments.status` guardava o estado, e nada guardava a **hora** de cada
-- transição. Sem isso o painel do balcão não consegue dizer "chegou 14:03,
-- está esperando há 12 minutos" — que é a informação pela qual a recepção olha
-- a tela.
--
-- E não é só exibição. A SPEC (Parte 2 §2.10) exige que a estimativa de espera
-- da fila presencial venha da **duração real média, não da cadastrada**. Sem
-- `started_at` e `completed_at` esse número não existe, e a fila do bloco 14
-- nasceria chutando.
--
-- Nulo é o normal: só preenche quando o evento ocorre.
-- ============================================================================

ALTER TABLE appointments
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN started_at    timestamptz,
  ADD COLUMN completed_at  timestamptz,
  -- Ordem cronológica é invariante do banco, não convenção: um atendimento que
  -- termina antes de começar zeraria ou inverteria toda média de duração real.
  ADD CONSTRAINT appointments_attendance_order
    CHECK (
      (started_at IS NULL OR checked_in_at IS NULL OR started_at >= checked_in_at)
      AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    );

ALTER TABLE locations
  -- Minutos de tolerância antes de o horário virar falta. Default 20, como a
  -- SPEC §2.11. Zero significa "não marca falta sozinho".
  ADD COLUMN no_show_after_minutes smallint NOT NULL DEFAULT 20,
  ADD CONSTRAINT locations_no_show_sane
    CHECK (no_show_after_minutes >= 0 AND no_show_after_minutes <= 480);

COMMENT ON COLUMN appointments.checked_in_at IS 'Quando o cliente chegou.';
COMMENT ON COLUMN appointments.started_at IS 'Quando o atendimento começou — base da duração real.';
COMMENT ON COLUMN appointments.completed_at IS 'Quando terminou.';

-- O painel do dia lê uma faixa de um dia inteiro de uma unidade, ordenada por
-- horário. `appointments_location_window_idx` já cobre (location_id, starts_at)
-- e é exatamente essa consulta — nenhum índice novo aqui.
