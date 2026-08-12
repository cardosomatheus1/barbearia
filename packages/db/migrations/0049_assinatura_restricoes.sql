-- ============================================================================
-- 0049 — Assinatura: restrição de horário, dependentes e prioridade
--        (bloco 46, SPEC §4.6)
--
-- Três benefícios que a SPEC descreve e que o bloco 45 deixou de fora porque
-- cada um mexe num lugar diferente do produto:
--
-- - **restrição de horário** entra no motor de disponibilidade (Parte 2 §2.4);
-- - **dependentes** criam clientes próprios consumindo da mesma cota;
-- - **prioridade** já existe na fila desde o bloco 45; aqui vem a janela de
--   antecedência maior, que é o outro lado do mesmo benefício.
--
-- ## A restrição protege o pico, e é por isso que ela existe
--
-- *"Assinante do plano Essencial pode não ter acesso a sábado 09:00–13:00, o
-- horário mais disputado."* Sem ela, o plano barato ocupa a hora que a casa
-- vende cheia — e o clube passa a **substituir** receita em vez de somar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A janela em que o plano NÃO vale
--
-- Guardar o que é proibido e não o que é permitido: a barbearia abre 70 horas
-- por semana e bloqueia quatro. Guardar o permitido faria toda mudança de
-- horário de funcionamento exigir reescrever o plano — e um plano que esqueceu
-- de liberar a terça-feira nova é um plano que some da grade sem ninguém saber.
-- ---------------------------------------------------------------------------

CREATE TABLE club_plan_blackouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES club_plans(id) ON DELETE CASCADE,

  -- 0 = domingo, como `schedules`. Nulo é todo dia.
  weekday        smallint,
  -- Minutos locais desde a meia-noite, semiaberto [início, fim).
  start_minute   smallint NOT NULL,
  end_minute     smallint NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_plan_blackouts_dia_valido CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  CONSTRAINT club_plan_blackouts_janela_valida CHECK (
    start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute
  )
);

ALTER TABLE club_plan_blackouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_plan_blackouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_plan_blackouts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX club_plan_blackouts_do_plano_idx ON club_plan_blackouts (plan_id, weekday);

-- ---------------------------------------------------------------------------
-- A antecedência maior
--
-- O outro lado da prioridade: o assinante enxerga a grade mais longe que o
-- visitante, e por isso pega o sábado antes. É benefício vendável e é o que a
-- SPEC §4.6 chama de "janela de antecedência maior".
-- ---------------------------------------------------------------------------

ALTER TABLE club_plans
  ADD COLUMN booking_window_days smallint NOT NULL DEFAULT 0;

ALTER TABLE club_plans ADD CONSTRAINT club_plans_janela_valida CHECK (
  booking_window_days BETWEEN 0 AND 180
);

-- ---------------------------------------------------------------------------
-- Dependentes
--
-- *"Plano família — o assinante inclui filhos. Cada dependente é cliente
-- próprio, com agenda e histórico, consumindo da mesma cota."*
--
-- Cliente próprio é literal: `customers` inteiro, com telefone, ficha e
-- avaliação. O que muda é de onde vem a cota — e é por isso que o vínculo mora
-- numa tabela e não numa coluna em `customers`: um dependente pode virar titular
-- de plano próprio no ano seguinte, e o histórico dele não muda de dono.
-- ---------------------------------------------------------------------------

CREATE TABLE club_dependents (
  subscription_id  uuid NOT NULL REFERENCES club_subscriptions(id) ON DELETE CASCADE,
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  created_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (subscription_id, customer_id)
);

ALTER TABLE club_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_dependents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_dependents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma pessoa é dependente de uma assinatura só.
 *
 * Duas fariam a mesma cota ser descontada de dois lugares — e no balcão ninguém
 * saberia de qual plano o corte saiu.
 */
CREATE UNIQUE INDEX club_dependents_um_titular ON club_dependents (customer_id);

/**
 * O titular não é dependente de si mesmo.
 *
 * Sem isto, ele apareceria duas vezes na lista de quem usa a cota, e a tela do
 * balcão mostraria "Carlos (titular)" e "Carlos (dependente)" lado a lado.
 */
CREATE OR REPLACE FUNCTION club_dependents_nao_e_o_titular() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM club_subscriptions s
     WHERE s.id = NEW.subscription_id AND s.customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'o titular da assinatura não é dependente dela'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER club_dependents_nao_e_o_titular
  BEFORE INSERT OR UPDATE ON club_dependents
  FOR EACH ROW EXECUTE FUNCTION club_dependents_nao_e_o_titular();

/**
 * Quem usou a cota, para o extrato.
 *
 * A SPEC pede que cada dependente tenha agenda e histórico próprios, e o uso é
 * o que fecha isso: sem saber **quem** cortou, "3 de 5 usados" numa família de
 * quatro é um número que ninguém consegue conferir.
 */
ALTER TABLE club_uses
  ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX club_uses_de_quem_idx ON club_uses (customer_id)
  WHERE customer_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, DELETE ON club_plan_blackouts TO barbearia_app;
    GRANT SELECT, INSERT, DELETE ON club_dependents TO barbearia_app;
  END IF;
END $$;
