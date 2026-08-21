-- A gorjeta ganha dono.
--
-- SPEC §3.6, em três linhas: "vinculada ao profissional que executou", "nunca
-- entra na base de comissão nem no faturamento da casa (é repasse)", "aparece
-- separada no DRE e no extrato do barbeiro".
--
-- `orders.tip_cents` era gravada e sempre subtraída — do faturamento, do painel,
-- do DRE, da base de comissão — e nunca atribuída. Na base de demonstração são
-- R$ 2.628,33 em 447 comandas: dinheiro de terceiro entrando na conta da casa
-- sem nenhum registro de quem é. O único lugar em que ela aparecia positiva era
-- o total do dia no caixa, sem nome.
--
-- Nula é o caso comum e significa **rateada entre quem atendeu**, por peso da
-- receita dos itens — a mesma regra da taxa do adquirente, que já é rateada
-- assim. Preenchida é o cliente que disse a quem: "os dez são do João".
--
-- ON DELETE SET NULL, como `reviews.professional_id`: o profissional sai da
-- casa e a comanda continua existindo com o valor intacto. Reapontar seria
-- mover o repasse de uma pessoa para outra.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tip_professional_id uuid
  REFERENCES professionals(id) ON DELETE SET NULL;

-- O extrato do barbeiro pergunta "quanto de gorjeta eu recebi neste período", e
-- a resposta varre as comandas pagas do dia dele.
CREATE INDEX IF NOT EXISTS orders_gorjeta_idx
  ON orders (tip_professional_id, business_day)
  WHERE tip_cents > 0;
