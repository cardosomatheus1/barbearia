-- Bloco 10: o item da comanda também precisa sobreviver a resposta perdida.
--
-- O botão bloqueia o segundo toque enquanto a Server Action está pendente, mas
-- isso não cobre o caso mais caro: o INSERT confirma, a conexão cai antes do
-- redirect e a recepção tenta de novo. A chave nasce na renderização da tela e
-- viaja até esta tabela; o fingerprint impede reutilizar a mesma chave para um
-- item diferente.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS order_items_idempotency_idx
  ON order_items (tenant_id, order_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
