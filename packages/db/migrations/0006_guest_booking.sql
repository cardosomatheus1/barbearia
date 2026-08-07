-- ============================================================================
-- 0006 — Agendamento sem código
--
-- Correção de premissa. A análise inicial supôs que o sistema estudado exigia
-- validação por código para agendar, com base nas chaves de i18n. O código do
-- fluxo desmente: o payload leva `codigo: ""` fixo e a confirmação chega sem
-- nenhuma verificação. O código só existe no fluxo de ver/cancelar.
--
-- Exigir OTP para agendar seria atrito que o mercado não pratica. Mas há
-- barbearia que sofre com reserva falsa, então vira política da unidade — e o
-- default acompanha o mercado.
-- ============================================================================

ALTER TABLE locations
  ADD COLUMN require_otp_for_booking boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN locations.require_otp_for_booking IS
  'Quando falso (default), agendar exige apenas nome e celular. Ver, cancelar e '
  'remarcar sempre exigem sessão, independentemente deste valor.';
