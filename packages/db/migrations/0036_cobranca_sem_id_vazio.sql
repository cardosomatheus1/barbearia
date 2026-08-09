-- ============================================================================
-- 0036 — A amarração da cobrança não aceita string vazia
--        (bloco 34, achado da `/security-review`)
--
-- `invoices.psp_charge_id` é como o webhook do adquirente reencontra a fatura,
-- e `amarrarCobranca` só escreve nele enquanto ele é nulo — de propósito: uma
-- segunda tentativa não pode roubar a amarração da primeira, senão o webhook da
-- primeira chegaria sem dono.
--
-- O provedor de verdade mostrou o buraco desse desenho. A Stripe recusa um
-- cartão sem devolver id de cobrança, e a primeira versão do
-- `StripePspProvider` traduziu isso para string vazia. Vazio não é nulo: a
-- fatura ficava amarrada a "" **para sempre**, nenhuma tentativa posterior
-- conseguia amarrar a cobrança que desse certo, e o webhook dela procuraria a
-- fatura por um id que ninguém guardou. A barbearia seria suspensa por uma
-- fatura que pagou.
--
-- O código já não escreve mais vazio (a guarda está em `PspCobrancaProvider`).
-- Esta constraint é a outra metade: garantia do banco em vez de convenção de
-- revisão, que é a diferença que o CLAUDE.md §2 cobra.
--
-- Aditiva e segura de rodar: o `UPDATE` de saneamento roda antes, e devolve ao
-- estado nulo — que é "ainda não amarrada" — as faturas que já carregam o
-- rastro.
-- ============================================================================

UPDATE invoices SET psp_charge_id = NULL WHERE psp_charge_id = '';

ALTER TABLE invoices
  ADD CONSTRAINT invoices_charge_id_nao_vazio
  CHECK (psp_charge_id IS NULL OR length(btrim(psp_charge_id)) > 0);

-- Mesmo raciocínio para o estorno: `psp_refund_id` vazio seria um estorno
-- marcado como confirmado sem nada a que se referir.
UPDATE refunds SET psp_refund_id = NULL WHERE psp_refund_id = '';

ALTER TABLE refunds
  ADD CONSTRAINT refunds_refund_id_nao_vazio
  CHECK (psp_refund_id IS NULL OR length(btrim(psp_refund_id)) > 0);
