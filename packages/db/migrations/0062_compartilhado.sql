-- ============================================================================
-- 0062 — cliente, fidelidade, clube e fiado entre unidades (bloco 59, SPEC §1.1)
--
-- > *"O mesmo cliente frequenta unidades diferentes da mesma empresa, com
-- > **histórico unificado**. Fidelidade, assinatura e crédito são configuráveis
-- > como `por empresa` ou `por unidade`."*
--
-- ## O que já estava certo, e por isso não muda
--
-- **O cadastro do cliente sempre foi da empresa.** `customers` tem `tenant_id` e
-- nunca teve `location_id`: o histórico unificado é um fato do schema desde o
-- bloco 1, não algo a construir. O que faltava era a tela dizer **em qual loja**
-- cada visita aconteceu — e isso é leitura, não coluna nova.
--
-- ## O que muda: três interruptores, e o padrão é o comportamento anterior
--
-- Fidelidade, clube e fiado ganham escopo. Os três nascem `empresa`, que é como
-- o produto sempre funcionou — a regra deste projeto para configuração que mexe
-- em dinheiro. Um padrão `unidade` faria toda barbearia já instalada ver o saldo
-- do cliente ser recortado no dia da migração, sem ninguém ter decidido nada.
--
-- ## O escopo é congelado no lançamento, como o modo
--
-- E é a decisão mais importante deste arquivo. Se o escopo fosse lido do
-- cadastro na hora do saldo, a barbearia que trocasse de `empresa` para
-- `unidade` em maio veria os 300 pontos de abril sumirem — eles não têm loja,
-- porque foram ganhos quando loja não importava.
--
-- Congelado, o saldo passa a ser a soma de **dois bolsos**: o compartilhado (o
-- que foi ganho sob `empresa`) e o da loja. O que a pessoa ganhou antes da
-- mudança continua valendo em qualquer unidade, que é o que ela ouviu no balcão.
-- ============================================================================

/**
 * `empresa` é a rede inteira; `unidade` é cada loja por si.
 *
 * Um tipo só para os três, e não três enums iguais: eles respondem exatamente a
 * mesma pergunta, e três tipos separados é como um ganha um valor que os outros
 * não têm e a tela passa a precisar saber qual é qual.
 */
CREATE TYPE escopo_multiunidade AS ENUM ('empresa', 'unidade');

-- ----------------------------------------------------------------------------
-- Fidelidade
-- ----------------------------------------------------------------------------

ALTER TABLE loyalty_programs
  ADD COLUMN scope escopo_multiunidade NOT NULL DEFAULT 'empresa';

COMMENT ON COLUMN loyalty_programs.scope IS
  'Onde o saldo vale: na rede (empresa) ou só na loja em que foi ganho (unidade).';

/**
 * Em qual loja o lançamento aconteceu, e sob qual regra.
 *
 * As duas colunas andam juntas e o `CHECK` abaixo obriga: um lançamento de
 * escopo `unidade` sem unidade é uma linha sem bolso — ela não entraria em saldo
 * nenhum, e o cliente veria pontos sumirem sem explicação no extrato.
 *
 * O contrário é legítimo: escopo `empresa` **com** unidade guarda onde a pessoa
 * estava, que é o que a ficha unificada mostra, sem que isso recorte o saldo.
 */
ALTER TABLE loyalty_entries
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN scope escopo_multiunidade NOT NULL DEFAULT 'empresa';

ALTER TABLE loyalty_entries
  ADD CONSTRAINT loyalty_entries_bolso_coerente CHECK (
    scope <> 'unidade' OR location_id IS NOT NULL
  );

/** O saldo por bolso é a consulta do balcão, e ela filtra pelas duas colunas. */
CREATE INDEX loyalty_entries_por_bolso_idx
  ON loyalty_entries (customer_id, scope, location_id);

-- ----------------------------------------------------------------------------
-- Clube de assinatura
-- ----------------------------------------------------------------------------

/**
 * O plano vale na rede ou só onde a pessoa assinou.
 *
 * A unidade da adesão já existe desde o bloco 58 (`club_subscriptions
 * .location_id`), congelada. Este interruptor decide se ela **restringe** ou só
 * informa — e o padrão é só informar, que é como o produto vinha funcionando.
 *
 * Fica no **plano** e não na barbearia porque é assim que a barbearia vende: o
 * "Clube Barba" da Pituba pode ser da loja e o "Clube Premium" pode valer na
 * rede toda, e um interruptor único obrigaria a escolher pelo pior dos dois.
 */
ALTER TABLE club_plans
  ADD COLUMN scope escopo_multiunidade NOT NULL DEFAULT 'empresa';

COMMENT ON COLUMN club_plans.scope IS
  'Onde o plano cobre: na rede (empresa) ou só na unidade da adesão (unidade).';

-- ----------------------------------------------------------------------------
-- Fiado
-- ----------------------------------------------------------------------------

/**
 * O escopo do fiado é da **barbearia**, não da conta do cliente.
 *
 * Ao contrário do clube, aqui não há dois produtos a distinguir: "o senhor pode
 * levar sem pagar" é uma política da casa, e uma barbearia que a decidisse por
 * cliente estaria decidindo caso a caso — que é o que o limite já faz.
 */
ALTER TABLE tenants
  ADD COLUMN credit_scope escopo_multiunidade NOT NULL DEFAULT 'empresa';

/**
 * Em qual loja a dívida nasceu.
 *
 * `SET NULL` e não `RESTRICT`: `customer_ledger` é append-only por `REVOKE`
 * desde o bloco 18, e numa tabela que ninguém apaga toda chave estrangeira é
 * `SET NULL` — senão apagar a loja vira o caminho de destruição que a revogação
 * existia para fechar.
 *
 * Nulo é lançamento anterior a este bloco, e ele conta para **todas** as
 * leituras: a dívida é com a barbearia, e sumir de todas seria pior que aparecer
 * em cada uma. É a mesma decisão da mensalidade do clube no bloco 58.
 */
ALTER TABLE customer_ledger
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX customer_ledger_por_unidade_idx
  ON customer_ledger (customer_id, location_id);

-- ----------------------------------------------------------------------------
-- A permissão de mexer nos três interruptores
--
-- Nenhuma nova: os três já têm dono. O programa de fidelidade é
-- `settings.manage`, o plano do clube é `finance.subscription_manage` e o fiado
-- é `finance.credit_limit`. Criar uma quarta permissão "escopo" faria a mesma
-- decisão ter dois guardiões, e o segundo seria o que ninguém concede.
-- ----------------------------------------------------------------------------
