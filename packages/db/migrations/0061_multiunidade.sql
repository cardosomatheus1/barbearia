-- ============================================================================
-- 0061 — multiunidade (bloco 58, SPEC §1.1 e §1.3)
--
-- O produto sempre teve `locations` e sempre operou como se houvesse uma. Vinte
-- rotas chamam `primaryLocation`, que devolve **a primeira** — e isso está
-- certo enquanto só existe uma. Este bloco troca "a primeira" por "a escolhida"
-- e escreve o que a escolha significa.
--
-- ## Três decisões que o schema carrega
--
-- **Unidade fecha, não some.** Uma barbearia que encerra uma loja continua
-- precisando do histórico dela: a venda, a comissão paga, a nota emitida. Por
-- isso `active`, e por isso toda chave estrangeira para `locations` continua
-- `RESTRICT` — apagar a unidade levaria junto o registro do dinheiro.
--
-- **Quem opera qual loja é dado, não papel.** A SPEC §1.3 descreve o gerente
-- que *"administra determinada unidade"*: é vínculo entre pessoa e loja, e não
-- cabe no papel — dois gerentes de lojas diferentes têm o mesmo papel e não
-- podem ver a mesma coisa.
--
-- **Lista vazia significa "todas".** É o caso do dono, e é o caso de toda
-- barbearia de uma unidade só — que é toda barbearia até aqui. A alternativa,
-- gravar uma linha por unidade para todo mundo, faria abrir a segunda loja
-- exigir uma migração de dados para não trancar a equipe inteira para fora.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A unidade que fecha
-- ----------------------------------------------------------------------------

ALTER TABLE locations
  ADD COLUMN active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN locations.active IS
  'Unidade em operação. Falso é loja fechada: some da seleção, o histórico fica.';

/** A seleção do balcão lê só as abertas, e ela é a consulta mais chamada. */
CREATE INDEX locations_ativas_idx ON locations (tenant_id) WHERE active;

-- ----------------------------------------------------------------------------
-- Quem opera qual loja
-- ----------------------------------------------------------------------------

/**
 * O vínculo entre a pessoa e as unidades que ela administra.
 *
 * **Ausência significa "todas"**, e é o contrário do padrão deste schema — que
 * costuma ser negar por omissão. A razão é migração: toda barbearia existente
 * tem uma unidade e nenhuma linha aqui, e negar por omissão trancaria a equipe
 * inteira para fora no dia em que esta migração rodasse.
 *
 * O risco do padrão permissivo é real e está contido em outro lugar: o que a
 * pessoa **pode fazer** continua saindo de `role_permissions`. Isto decide
 * apenas *onde*, e quem não tem `cashier.open` não abre caixa em loja nenhuma.
 */
CREATE TABLE staff_locations (
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  /**
   * `RESTRICT`, e não `CASCADE`.
   *
   * Apagar uma unidade levaria junto os vínculos dela — e como **ausência
   * significa todas**, cada operador escopado àquela loja viraria operador da
   * rede inteira em silêncio. Uma cascata que *amplia* acesso é o contrário do
   * que uma cascata costuma fazer, e é por isso que a regra deste schema é
   * `RESTRICT` em toda chave estrangeira para `locations`.
   */
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (staff_user_id, location_id)
);

ALTER TABLE staff_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_locations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX staff_locations_por_unidade_idx ON staff_locations (location_id);

-- ----------------------------------------------------------------------------
-- Em qual loja esta sessão está agora
--
-- Na **sessão**, e não num cabeçalho que a tela mandasse: é o mesmo desenho de
-- `staff_sessions.mfa_verified_at`, e pela mesma razão. A recepcionista escolhe
-- a loja uma vez ao chegar e trabalha nela o dia inteiro; um cabeçalho faria
-- cada tela do painel precisar lembrar de repassá-lo, e a que esquecesse abriria
-- o caixa da outra unidade sem nada ficar vermelho.
--
-- Nula significa "ainda não escolheu", e cai na primeira aberta — que é o
-- comportamento que o produto sempre teve com `primaryLocation`, e é o que faz
-- a barbearia de uma unidade só não notar que este bloco existiu.
--
-- `SET NULL` e não `CASCADE`: fechar uma loja não pode derrubar a sessão de
-- ninguém no meio de um atendimento.
-- ----------------------------------------------------------------------------

ALTER TABLE staff_sessions
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN staff_sessions.location_id IS
  'A unidade que esta sessão está operando. Nula é "ainda não escolheu".';

-- ----------------------------------------------------------------------------
-- A transferência de estoque
-- ----------------------------------------------------------------------------

/**
 * Mover produto de uma loja para outra.
 *
 * **Um fato com duas pontas**, não dois lançamentos avulsos — é a mesma decisão
 * da transferência entre contas do bloco 51. Partido em dois, "de onde veio
 * este shampoo?" ganharia duas respostas independentes que alguém
 * dessincroniza.
 *
 * Os dois movimentos de estoque continuam existindo, porque o saldo é derivado
 * da soma deles e sempre foi: esta tabela é quem **liga** os dois e explica.
 */
CREATE TABLE stock_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  from_location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  quantity        integer NOT NULL,
  /**
   * O custo unitário que viaja junto.
   *
   * Congelado, como todo custo que alimenta relatório fechado desde o bloco 47:
   * o produto sai de uma loja pelo custo que ele tinha lá e entra na outra pelo
   * mesmo. Sem isso, transferir mudaria a margem das duas — a de origem
   * ganharia e a de destino perderia, sem ninguém ter comprado nada.
   */
  unit_cost_cents integer NOT NULL,

  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,

  CONSTRAINT stock_transfers_quantidade_positiva CHECK (quantity > 0),
  CONSTRAINT stock_transfers_custo_nao_negativo CHECK (unit_cost_cents >= 0),
  /**
   * Da loja para ela mesma não é transferência.
   *
   * Aceitar produziria dois movimentos que se anulam e uma linha de histórico
   * que não explica nada — e, pior, um caminho para "acertar" saldo sem passar
   * pelo ajuste, que exige motivo escrito desde o bloco 47.
   */
  CONSTRAINT stock_transfers_lojas_diferentes CHECK (from_location_id <> to_location_id)
);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_transfers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX stock_transfers_por_produto_idx ON stock_transfers (product_id, created_at DESC);

/**
 * A transferência não se desfaz.
 *
 * `REVOKE DELETE` pela mesma razão do movimento de estoque, que ela cria dois:
 * corrigir é lançar `ajuste` com motivo escrito ao lado do erro, nunca
 * reescrever a linha. Uma transferência apagada deixaria os dois movimentos
 * órfãos e o saldo das duas lojas sem explicação.
 */
REVOKE DELETE ON stock_transfers FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON stock_transfers TO barbearia_app;
    GRANT SELECT, INSERT, DELETE ON staff_locations TO barbearia_app;
    REVOKE DELETE ON stock_transfers FROM barbearia_app;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- A mensalidade do clube ganha unidade
--
-- Era a lacuna declarada do DRE por unidade, e o motivo escrito era honesto:
-- *"`club_invoices` não tem unidade, porque a assinatura é do cliente com a
-- barbearia e não com uma loja. Atribuí-la a uma delas hoje seria inventar o
-- dado."*
--
-- Continua sendo verdade que a assinatura é da barbearia. O que muda é que
-- agora existe uma resposta que não é inventada: **a unidade onde a pessoa se
-- atende**. Ela é gravada na adesão e congelada — recalculá-la na leitura faria
-- o DRE de março mudar quando o cliente trocasse de loja em maio.
--
-- Nulo continua sendo válido e significa "assinatura anterior a este bloco":
-- a linha existe, o dinheiro é da barbearia, e nenhuma loja leva crédito por
-- ele. Inventar um rateio retroativo seria pior que a lacuna.
-- ----------------------------------------------------------------------------

ALTER TABLE club_subscriptions
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE RESTRICT;

COMMENT ON COLUMN club_subscriptions.location_id IS
  'Unidade onde a adesão aconteceu, congelada. Nula em assinatura anterior ao bloco 58.';

CREATE INDEX club_subscriptions_por_unidade_idx ON club_subscriptions (location_id)
  WHERE location_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- O movimento de estoque que não sabia de onde era
--
-- `stock_movements.location_id` existe desde o bloco 47 e venda, consumo e
-- estorno sempre o preencheram. **A entrada não** — e a entrada é por onde o
-- produto chega. O resultado é que o saldo por loja somava zero em toda parte,
-- e a transferência entre lojas não teria de onde tirar nada.
--
-- Toda barbearia até aqui tem uma unidade só, então a resposta não é inventada:
-- o que entrou, entrou nela. A atribuição é feita uma vez, na migração, e só
-- para quem tem exatamente uma — com duas, "qual delas" é palpite, e um palpite
-- aqui move estoque de lugar num relatório fechado.
-- ----------------------------------------------------------------------------

UPDATE stock_movements m
   SET location_id = unica.id
  FROM (
    SELECT tenant_id, min(id::text)::uuid AS id
      FROM locations
     GROUP BY tenant_id
    HAVING count(*) = 1
  ) AS unica
 WHERE m.location_id IS NULL
   AND m.tenant_id = unica.tenant_id;

/**
 * O saldo por loja é a consulta que a transferência faz, e ela filtra pelas
 * duas colunas. O índice do bloco 47 é `(product_id, created_at DESC)`, e a
 * soma por unidade varreria todo o histórico do produto na rede inteira.
 */
CREATE INDEX stock_movements_por_unidade_idx
  ON stock_movements (product_id, location_id);
