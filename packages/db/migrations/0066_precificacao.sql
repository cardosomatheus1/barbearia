-- ============================================================================
-- 0066 — preço por faixa de horário, com aprovação humana (bloco 68, SPEC §4.20)
--
-- > *"A IA **recomenda**, o administrador **aprova**."*
-- > *"**Nunca alterar preço automaticamente** sem autorização configurada
-- > explicitamente."*
--
-- É a regra que decide o schema inteiro: não existe coluna onde um algoritmo
-- escreva preço. O que existe é uma **regra cadastrada por gente**, com dia da
-- semana, faixa de horário e variação — e um interruptor por unidade que nasce
-- desligado. A recomendação não mora aqui: ela é derivada da ocupação medida,
-- como o DRE e o segmento, e some no instante em que deixa de ser verdade.
--
-- ## Faixas não se sobrepõem, e quem garante é o banco
--
-- Duas regras valendo às 14h de terça — uma de −10% e outra de +5% — exigiriam
-- uma regra de desempate, e regra de desempate sobre preço é como o cliente vê
-- um valor na tela e outro na hora de pagar. A constraint de exclusão recusa a
-- segunda, e a tela mostra o erro na hora de cadastrar.
--
-- ## O teto é da barbearia, não da regra
--
-- *"Variação máxima configurável (default ±15%) — evita que o algoritmo produza
-- preço que destrói a percepção da marca."* Ele mora em `tenants` porque é
-- política de marca, e vale sobre **toda** regra: cadastrar −40% não derruba o
-- preço em 40%, derruba no teto. Guardar o teto dentro da regra deixaria cada
-- linha decidir o próprio limite, que é o mesmo que não ter limite.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN max_price_variation_bps integer NOT NULL DEFAULT 1500
    CHECK (max_price_variation_bps BETWEEN 0 AND 5000);

COMMENT ON COLUMN tenants.max_price_variation_bps IS
  'Teto de variação de preço por faixa de horário, em pontos-base (1500 = 15%). '
  'SPEC §4.20. Vale sobre toda regra; a regra que passar dele é aparada.';

/**
 * O interruptor, e ele nasce **desligado**.
 *
 * Regra que mexe no que o cliente paga é a segunda coisa mais cara que este
 * produto faz, depois de recusar um cliente — e a convenção do bloco 60 já está
 * escrita: regra que cobra mais nasce desligada. Ligada por padrão, a barbearia
 * descobriria pelo cliente que reclamou do preço de sábado.
 */
ALTER TABLE locations
  ADD COLUMN dynamic_pricing_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN locations.dynamic_pricing_enabled IS
  'Se as regras de preço por faixa valem nesta unidade (bloco 68). Nasce '
  'desligado: nenhuma barbearia passa a cobrar diferente sem alguém decidir.';

CREATE TABLE pricing_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- Minutos locais desde a meia-noite, como toda janela deste produto.
  start_minute  smallint NOT NULL,
  end_minute    smallint NOT NULL,

  /**
   * A variação, em pontos-base inteiros: −1000 é −10%, +1000 é +10%.
   *
   * Pontos-base e não fração, como toda alíquota deste código. E o sinal é a
   * informação: desconto e acréscimo são a mesma regra em direções opostas, e
   * duas tabelas fariam "o que vale às 14h de terça?" ter duas respostas.
   */
  delta_bps     integer NOT NULL CHECK (delta_bps BETWEEN -5000 AND 5000),

  /** Quem aprovou. A SPEC exige aprovação humana; isto é o registro dela. */
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pricing_rules_janela CHECK (
    start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute
  ),
  CONSTRAINT pricing_rules_sem_efeito CHECK (delta_bps <> 0)
);

/**
 * Nenhuma faixa encosta na outra no mesmo dia.
 *
 * `[início, fim)` semiaberto, como todo intervalo deste produto: uma regra que
 * termina às 16h e outra que começa às 16h não se sobrepõem. Sem isto seria
 * preciso inventar precedência entre regras de preço — e o cliente veria um
 * valor na tela e outro na hora de pagar.
 */
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_sem_sobreposicao
  EXCLUDE USING gist (
    location_id WITH =,
    weekday WITH =,
    int4range(start_minute, end_minute) WITH &&
  );

CREATE INDEX pricing_rules_por_unidade ON pricing_rules (tenant_id, location_id, weekday);

ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pricing_rules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON pricing_rules TO barbearia_app;

COMMENT ON TABLE pricing_rules IS
  'Faixas de horário com variação de preço, cadastradas por gente (bloco 68, '
  'SPEC §4.20). Não existe coluna onde um algoritmo escreva preço: a IA '
  'recomenda e o administrador aprova. O preço cobrado é congelado em '
  'appointments.price_cents no momento da reserva.';
