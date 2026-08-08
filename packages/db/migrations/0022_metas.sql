-- ============================================================================
-- 0022 — Metas do profissional
--
-- A SPEC §4.21 pede indicadores e metas para o barbeiro. Os indicadores já são
-- deriváveis: `orders`, `order_items` e `appointments` guardam tudo desde os
-- blocos 18 e 11. **Meta não é derivável** — ela é um número que alguém
-- escolhe, e é a única coisa desta parte da SPEC que precisa de tabela.
--
-- Uma linha por profissional e por mês, e não uma coluna em `professionals`:
--
-- 1. **Meta é do mês, não da pessoa.** Dezembro não tem a meta de fevereiro, e
--    comparar o realizado de março contra um número que mudou em abril é como
--    se perde a confiança no indicador.
-- 2. **O histórico é o que dá sentido ao número.** "Bateu a meta em 4 dos
--    últimos 6 meses" é uma frase; "a meta é R$ 15.000" não é.
--
-- Não há carregamento automático de um mês para o outro, de propósito: meta que
-- se renova sozinha vira número que ninguém escolheu e que todo mundo ignora. A
-- tela oferece o mês anterior como sugestão preenchida — sugerir é diferente de
-- decidir por alguém.
-- ============================================================================

CREATE TABLE professional_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,

  /**
   * O mês, guardado como o primeiro dia dele.
   *
   * `date` e não `text`: comparar, ordenar e somar mês vira aritmética de data
   * em vez de manipulação de string — e `'2026-9'` nunca entra por engano.
   * A CHECK garante que é sempre dia 1, senão dois registros do mesmo mês
   * conviveriam com dias diferentes e o índice único não os veria como iguais.
   */
  month           date NOT NULL,

  -- Centavos inteiros, como todo dinheiro deste produto.
  revenue_cents   integer NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT professional_goals_mes_no_dia_um CHECK (date_trunc('month', month) = month),
  /**
   * Meta positiva, e com teto.
   *
   * Zero significaria "sem meta", que é o mesmo que não ter linha — e duas
   * formas de dizer a mesma coisa é como uma tela acaba mostrando "0% de R$
   * 0,00". O teto é grosseiro de propósito: existe contra o dedo escorregando
   * no teclado, não para julgar a ambição de ninguém.
   */
  CONSTRAINT professional_goals_valor_sano
    CHECK (revenue_cents > 0 AND revenue_cents <= 100000000)
);

-- Uma meta por pessoa e por mês.
CREATE UNIQUE INDEX professional_goals_unica
  ON professional_goals (professional_id, month);

-- A consulta da tela do barbeiro: a minha meta deste mês.
CREATE INDEX professional_goals_do_mes_idx
  ON professional_goals (tenant_id, month DESC);

ALTER TABLE professional_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON professional_goals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * O índice que faltava para os indicadores do barbeiro.
 *
 * "Quantos clientes atendi este mês" e "quantos saíram com o próximo horário
 * marcado" varrem `appointments` por profissional e por período. O índice
 * existente é por `service_starts_at` sem profissional, o que obriga a ler o
 * dia inteiro da casa para responder sobre uma cadeira.
 *
 * Parcial em `completed` porque é o único status que essas perguntas usam — e
 * `completed` é minoria das linhas durante o dia, maioria depois de uma semana.
 */
CREATE INDEX appointments_desempenho_idx
  ON appointments (professional_id, service_starts_at)
  WHERE status = 'completed';
