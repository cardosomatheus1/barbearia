-- Cobrança `pago` que foi integralmente devolvida não é mais dinheiro vivo.
--
-- A migração 0100 passou a bloquear `aguardando` + `pago` para impedir uma
-- segunda cobrança enquanto a primeira já tinha recebido dinheiro. Depois do
-- refund automático de uma divergência, manter a linha no índice deixaria a
-- comanda presa para sempre. O refund persistido é a prova de que o dinheiro
-- saiu do adquirente; só então a nova emissão fica liberada.

DROP INDEX order_charges_uma_viva_por_comanda;
CREATE UNIQUE INDEX order_charges_uma_viva_por_comanda
  ON order_charges (order_id)
  WHERE status IN ('aguardando', 'pago') AND refunded_at IS NULL;
