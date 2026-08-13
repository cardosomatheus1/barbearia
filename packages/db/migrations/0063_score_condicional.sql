-- ============================================================================
-- 0063 — o que o score decide (bloco 60, SPEC §2.13)
--
-- A SPEC §2.13 termina com três consequências, e só a primeira estava
-- construída:
--
--   score < 60  → sinal obrigatório                    (bloco 39)
--   score < 40  → sem agendamento online em horário de pico, só recepção
--   score ≥ 85  → prioridade na fila de espera; dispensa de sinal
--
-- A dispensa de sinal do terceiro já existe desde o bloco 39. Faltavam os dois
-- que este bloco entrega: **recusar a marcação online** de quem falta muito nas
-- horas cheias, e **priorizar na lista de espera** quem sempre aparece.
--
-- O horário de pico deixou de ser lacuna no bloco 57: ele é derivado do
-- movimento medido, não de uma caixa que o dono preenche. É o que torna estes
-- dois usos possíveis sem inventar parâmetro.
--
-- ## Os dois interruptores não nascem iguais, e a assimetria é a decisão
--
-- **Recusar nasce desligado.** Recusar um cliente é a coisa mais cara que este
-- produto faz: a pessoa está com o telefone na mão, escolheu o horário, e a
-- tela diz não. Ligado por padrão, a barbearia descobriria a regra pelo cliente
-- que ligou reclamando — e nenhuma barbearia já instalada decidiu isso.
--
-- **Beneficiar nasce ligado**, no 85 da SPEC. Um benefício ligado por padrão não
-- surpreende ninguém mal: o pior caso é a casa dar prioridade a quem nunca
-- faltou sem ter pedido, que é o que ela faria de qualquer jeito.
-- ============================================================================

/**
 * Abaixo deste score, o cliente não marca online **em horário de pico**.
 *
 * Nulo é desligado, e é o padrão. O número da SPEC (40) entra como sugestão na
 * tela, não como valor gravado — a diferença é que uma sugestão é uma decisão
 * que alguém toma, e um padrão é uma que ninguém tomou.
 *
 * Fora do pico ele marca normalmente. A restrição existe porque a hora cheia é
 * a que a casa vende inteira: uma falta ali custa o horário de quem viria, e é
 * exatamente o que a SPEC §2.13 separa da hora vazia — onde a mesma falta custa
 * uma cadeira que estaria parada de qualquer forma.
 */
ALTER TABLE locations
  ADD COLUMN online_block_score smallint;

ALTER TABLE locations
  ADD CONSTRAINT locations_bloqueio_online_valido CHECK (
    online_block_score IS NULL OR online_block_score BETWEEN 0 AND 100
  );

COMMENT ON COLUMN locations.online_block_score IS
  'Abaixo disso não marca online em hora de pico. Nulo é desligado (padrão).';

/**
 * A partir deste score, o cliente tem prioridade na lista de espera.
 *
 * `waitlist_entries` ordena por compatibilidade com a vaga desde o bloco 38, e
 * dentro de um mesmo grau de compatibilidade a ordem era a de chegada. Continua
 * sendo — este número só decide quem passa na frente **entre iguais**.
 *
 * Ele não cria fila preferencial: quem tem score alto e não cabe na vaga
 * continua não cabendo. Ordenar por confiabilidade antes de compatibilidade
 * ofereceria a vaga a quem não pode usá-la, e a oferta viraria ligação inútil —
 * que é o defeito que o `contains` do bloco 38 existe para fechar.
 */
ALTER TABLE locations
  ADD COLUMN waitlist_trusted_score smallint NOT NULL DEFAULT 85;

ALTER TABLE locations
  ADD CONSTRAINT locations_espera_confiavel_valido CHECK (
    waitlist_trusted_score BETWEEN 0 AND 100
  );

COMMENT ON COLUMN locations.waitlist_trusted_score IS
  'A partir daqui, passa na frente entre iguais na lista de espera. 85 é a SPEC §2.13.';

-- ----------------------------------------------------------------------------
-- A recusa registrada
--
-- Sem isto o bloco entrega uma recusa que ninguém consegue medir: o dono liga o
-- interruptor e não tem como saber se ele barrou dois clientes ou duzentos, nem
-- quais. Um mecanismo que recusa e não deixa rastro é um mecanismo que só é
-- descoberto pela reclamação.
--
-- Guarda o **score do momento**, congelado. Recalculá-lo na leitura faria a
-- lista de recusados mudar conforme as pessoas fossem voltando a comparecer —
-- e a pergunta que a tela responde é "quem eu recusei", não "quem eu recusaria
-- hoje".
-- ----------------------------------------------------------------------------

CREATE TABLE online_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,

  score         smallint NOT NULL,
  /** O limiar que valia na hora, para a linha explicar a si mesma. */
  threshold     smallint NOT NULL,
  /** O horário que a pessoa tentou marcar. */
  wanted_at     timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT online_blocks_score_valido CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT online_blocks_limiar_valido CHECK (threshold BETWEEN 0 AND 100)
);

ALTER TABLE online_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON online_blocks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX online_blocks_recentes_idx ON online_blocks (created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON online_blocks TO barbearia_app;
  END IF;
END $$;
