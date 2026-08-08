-- ============================================================================
-- 0011 — O combo do cardápio ligado aos serviços que ele substitui
--
-- Na Domari, "Cabelo (Tesoura) + Barba" escolhidos avulsos somam R$ 84,00 em 45
-- minutos. O cardápio vende exatamente isso, na categoria COMBO, por R$ 74,00.
-- Nada ligava as duas coisas, então o cliente que montava a escolha à mão
-- pagava R$ 10,00 a mais sem nunca saber. O sistema tinha a informação e não
-- usava.
--
-- `service_combos` já sabia agrupar serviços — mas só para declarar **duração**
-- ("juntos levam 45 min, não 20+25"). Faltava dizer que aquele grupo é vendido
-- como um item do cardápio, e por quanto.
--
-- Coluna e não tabela nova: o conjunto de serviços já está em
-- `service_combo_components`, e duplicá-lo criaria duas verdades sobre o mesmo
-- agrupamento.
-- ============================================================================

ALTER TABLE service_combos
  ADD COLUMN sold_as_service_id uuid REFERENCES services(id) ON DELETE SET NULL;

COMMENT ON COLUMN service_combos.sold_as_service_id IS
  'Serviço do cardápio que vende este conjunto. Quando presente e mais barato que a soma, a tela sugere a troca.';

-- A consulta é "todos os combos vendáveis desta unidade", feita ao montar o
-- cardápio. Parcial porque a maioria dos combos existe só para declarar duração.
CREATE INDEX service_combos_sold_as_idx
  ON service_combos (sold_as_service_id)
  WHERE sold_as_service_id IS NOT NULL;
