-- ============================================================================
-- 0038 — A taxa do adquirente, e o que fazer com ela na comissão
--        (bloco 36, SPEC §3.4)
--
-- A lacuna declarada desde o bloco 19 dizia o essencial: a comissão já escolhia
-- entre líquido e bruto, e já tratava o desconto — mas a terceira escolha da
-- SPEC §3.4, a taxa do adquirente absorvida ou rateada, não existia. E o motivo
-- não era esquecimento: **a alíquota do adquirente não existia em lugar nenhum
-- do produto**. Oferecer "rateada" antes disto daria zero em toda comanda, que
-- é o defeito de campo que o motor aceita e ninguém preenche.
--
-- ## Por que a alíquota é por meio de pagamento, e não uma só
--
-- Porque é assim que o adquirente cobra, e a diferença é grande: crédito
-- parcelado custa múltiplas vezes o que custa débito, e Pix costuma custar quase
-- nada. Uma alíquota média produziria um número que não bate com nenhum extrato
-- — e o extrato é justamente o documento que o dono abre quando desconfia.
--
-- ## Por que ela cobre também o que não passa por nós
--
-- Hoje a maioria das barbearias ainda cobra na própria maquininha, e a comanda
-- só **registra** o que já aconteceu. A taxa existe nos dois casos, e o barbeiro
-- não tem como saber a diferença. Amarrar isto só à cobrança online faria a
-- configuração valer para uma fração das vendas — e a fração errada, porque a
-- online é a menor delas.
--
-- ## Congelada na venda, como a regra de comissão
--
-- `orders.fee_cents` guarda o que a taxa **era** quando a venda fechou. Mesma
-- decisão do preço do serviço (bloco 18) e da regra de comissão copiada no
-- lançamento (bloco 19): renegociar a maquininha em maio não pode mudar a
-- comissão que já foi paga em abril.
-- ============================================================================

CREATE TYPE commission_fee_treatment AS ENUM ('absorvida', 'rateada');

ALTER TABLE commission_settings
  ADD COLUMN fee_treatment commission_fee_treatment NOT NULL DEFAULT 'absorvida';

/**
 * `absorvida` como padrão, e é o que o produto sempre fez por omissão.
 *
 * Um padrão `rateada` faria toda barbearia que já usa o sistema ver a comissão
 * de todo mundo cair no dia da migração, sem ninguém ter decidido nada. Mudança
 * de dinheiro nunca entra por padrão novo.
 */

/**
 * A alíquota por meio de pagamento, em pontos-base inteiros.
 *
 * Inteiro como toda alíquota do produto (319 = 3,19%): dinheiro é inteiro em
 * todo o sistema, e a alíquota não podia ser a única porta de entrada de ponto
 * flutuante.
 *
 * Linha ausente é zero, e é de propósito: a barbearia cadastra só o que paga.
 * Obrigar a preencher `dinheiro = 0` seria pedir que ela declare o óbvio para
 * poder declarar o que importa.
 */
CREATE TABLE acquirer_fees (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  method     payment_method NOT NULL,
  bps        integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, method),
  -- Teto em 30%: acima disso é erro de digitação (3,19 virando 319), e o
  -- estrago seria a comissão do mês inteiro. Nenhum adquirente cobra isso.
  CONSTRAINT acquirer_fees_aliquota_plausivel CHECK (bps >= 0 AND bps <= 3000)
);

ALTER TABLE acquirer_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE acquirer_fees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON acquirer_fees
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * O que a venda custou de adquirente, congelado no fechamento.
 *
 * Anulável porque toda venda anterior a este bloco não tem resposta — e inventar
 * zero para elas seria afirmar que não houve taxa, que é diferente de "não
 * sabemos". A comissão trata nulo como zero, o que é o comportamento de antes.
 */
ALTER TABLE orders ADD COLUMN fee_cents integer;

ALTER TABLE orders
  ADD CONSTRAINT orders_taxa_non_negative CHECK (fee_cents IS NULL OR fee_cents >= 0);

-- Não existe coluna para o que o adquirente cobrou **de fato** na cobrança
-- online, e é decisão: ela nasceria vazia. Quem sabe o número exato é o
-- adquirente, na transação de saldo, e ler isso depende de conta contratada.
-- Campo que o motor aceita e ninguém preenche é mentira (CLAUDE.md §4) — a
-- coluna entra no bloco que tiver a origem do dado, e a lacuna está declarada.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON acquirer_fees TO barbearia_app;
  END IF;
END $$;
