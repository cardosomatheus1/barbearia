-- Uma cobrança confirmada pode ficar `pago` com a comanda ainda aberta quando
-- não existe caixa aberto. Nesse intervalo o cliente já pagou: permitir uma
-- segunda emissão é cobrança duplicada. A regra anterior protegia apenas
-- `aguardando`. O domínio também verifica, mas o banco fecha a corrida e toda
-- futura porta de escrita.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM order_charges
     WHERE status IN ('aguardando', 'pago')
     GROUP BY order_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'há comandas com mais de uma cobrança aguardando/paga; concilie antes da migração 0100';
  END IF;
END $$;

DROP INDEX order_charges_uma_viva_por_comanda;
CREATE UNIQUE INDEX order_charges_uma_viva_por_comanda
  ON order_charges (order_id) WHERE status IN ('aguardando', 'pago');
