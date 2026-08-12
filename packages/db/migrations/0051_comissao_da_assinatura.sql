-- ============================================================================
-- 0051 — Comissão sobre assinatura (bloco 48, SPEC §3.4)
--
-- *"É o ponto que mais gera conflito na prática."* A frase é da SPEC, e o
-- conflito é aritmético: o assinante paga R$ 149 por mês e pode cortar quatro
-- vezes. Pagando comissão por uso sobre o preço de tabela, a casa entrega
-- R$ 240 de serviço, paga R$ 96 de comissão e recebe R$ 149.
--
-- Três modelos, e o produto não escolhe por ninguém:
--
-- 1. **Por uso** — comissão a cada atendimento, sobre o valor de referência do
--    serviço. Simples e justo com quem atende; pode custar mais que a
--    mensalidade.
-- 2. **Rateio da mensalidade** — a mensalidade é dividida entre quem atendeu no
--    mês, proporcional aos atendimentos. Protege a margem por construção: o
--    total nunca passa do que entrou.
-- 3. **Híbrido** — por uso, com teto numa fração da mensalidade.
--
-- ## O padrão é `por_uso`, e isso é regra deste código
--
-- É o **comportamento anterior**: desde o bloco 45 o item da comanda paga pelo
-- plano mantém o preço de tabela, e a comissão saiu por cima dele. Um padrão
-- `rateio` faria toda barbearia já instalada ver a comissão da equipe cair no
-- dia da migração, sem ninguém ter decidido nada — o mesmo raciocínio de
-- `fee_treatment` nascer `absorvida` no bloco 36.
--
-- ## Por que o lançamento ganha colunas em vez de o valor ser calculado agora
--
-- Rateio e híbrido **dependem do acumulado do período**: quantos atendimentos
-- aquela assinatura teve no mês, e qual era a mensalidade. Nenhum dos dois se
-- sabe na hora da venda — exatamente como a faixa progressiva, que este código
-- já resolve guardando **base + regra copiada** e derivando o valor na leitura.
--
-- Aqui é a mesma solução: o lançamento guarda de qual assinatura ele veio e por
-- quanto ela foi vendida, e quem aplica o modelo é `comissaoDoPeriodo`, em
-- `packages/core`, onde o teste alcança.
-- ============================================================================

CREATE TYPE subscription_commission_mode AS ENUM ('por_uso', 'rateio', 'hibrido');

ALTER TABLE tenants
  ADD COLUMN subscription_commission_mode subscription_commission_mode
    NOT NULL DEFAULT 'por_uso',
  /**
   * O teto do híbrido, em pontos-base da mensalidade.
   *
   * 6000 = a comissão de todos os atendimentos daquela assinatura no mês não
   * passa de 60% do que o assinante pagou. Pontos-base inteiros como toda
   * alíquota do produto — uma fração seria a porta para 0,6 virar 60.
   */
  ADD COLUMN subscription_commission_cap_bps integer NOT NULL DEFAULT 6000;

ALTER TABLE tenants ADD CONSTRAINT tenants_teto_da_assinatura_valido CHECK (
  subscription_commission_cap_bps BETWEEN 0 AND 10000
);

-- ---------------------------------------------------------------------------
-- De onde veio o lançamento
--
-- `SET NULL` na assinatura e **não** `CASCADE`: `commission_entries` é
-- append-only por `REVOKE` desde o bloco 19, e ação referencial roda com os
-- direitos do dono da tabela — ela não passa pela revogação. Um `CASCADE` aqui
-- seria a porta lateral que o bloco 43 já achou uma vez: apagar a assinatura
-- levaria junto a comissão de um período possivelmente fechado.
-- ---------------------------------------------------------------------------

ALTER TABLE commission_entries
  ADD COLUMN club_subscription_id uuid REFERENCES club_subscriptions(id) ON DELETE SET NULL,
  /**
   * A mensalidade **congelada no lançamento**.
   *
   * Não lida da assinatura na hora do relatório, pela mesma razão do custo do
   * insumo no bloco 44 e da taxa do adquirente no bloco 36: renegociar o plano
   * em maio não pode mudar a comissão de abril, e um período fechado tem que
   * responder sempre o mesmo número.
   */
  ADD COLUMN subscription_fee_cents integer;

ALTER TABLE commission_entries ADD CONSTRAINT commission_entries_assinatura_coerente CHECK (
  (club_subscription_id IS NULL) = (subscription_fee_cents IS NULL)
);

ALTER TABLE commission_entries ADD CONSTRAINT commission_entries_mensalidade_positiva CHECK (
  subscription_fee_cents IS NULL OR subscription_fee_cents > 0
);

/**
 * A leitura do rateio: "quais lançamentos desta assinatura caíram no período?".
 *
 * Índice parcial porque a esmagadora maioria dos lançamentos não é de
 * assinatura, e o rateio só precisa dos que são.
 */
CREATE INDEX commission_entries_da_assinatura_idx
  ON commission_entries (club_subscription_id, earned_on)
  WHERE club_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Qual **item** da comanda o plano cobriu
--
-- Casar por `service_id` seria casar por categoria, não por linha: uma comanda
-- com dois cortes e um deles pago pelo plano marcaria os dois como cobertos, e
-- a comissão do corte que o cliente pagou em dinheiro entraria no rateio da
-- mensalidade. É a mesma lição do `= ANY(ids)` do bloco 44 — teste de
-- pertinência não é teste de contagem.
--
-- `SET NULL` porque `club_uses` é append-only por `REVOKE`: ação referencial
-- roda com os direitos do dono e não passa pela revogação.
-- ---------------------------------------------------------------------------

ALTER TABLE club_uses
  ADD COLUMN order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL;

CREATE INDEX club_uses_do_item_idx ON club_uses (order_item_id)
  WHERE order_item_id IS NOT NULL;
