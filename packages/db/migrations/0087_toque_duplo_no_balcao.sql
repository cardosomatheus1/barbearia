-- Bloco 103 — o toque duplo nas duas rotas de dinheiro mais usadas do balcão.
--
-- ## O defeito, reproduzido contra a API viva
--
-- `POST cash/movements` e `POST debts/receive` moviam dinheiro sem chave de
-- idempotência e sem estado que distinguisse a repetição do caso legítimo.
-- Dois envios do mesmo formulário produziram:
--
--   cliente devia R$ 200, entregou R$ 50, e a dívida caiu R$ 100
--   duas sangrias de R$ 100 com 23 ms de diferença
--
-- `cash_movements` é append-only por REVOKE desde o bloco 18: **não há
-- desfazer**. No fechamento cego o operador conta a gaveta, aparece uma
-- divergência com o nome dele e sem causa encontrável — que é exatamente a
-- divergência sem dono que o módulo inteiro existe para evitar.
--
-- ## Por que chave e não estado
--
-- É a convenção do bloco 51, escrita: o toque duplo é barrado por **estado**
-- quando existe um, e por **chave** quando não existe. Duas sangrias de R$ 100
-- no mesmo dia são caso legítimo, e dois pagamentos parciais de fiado também —
-- não há estado que os distinga da repetição. Pagar a dívida **inteira** já era
-- barrado pelo estado (o segundo toque cai em "não tem dívida em aberto"), e é
-- por isso que o defeito passou despercebido: o formulário vem pré-preenchido
-- com a dívida cheia, e quem recebe parcial é que perde.
--
-- O `FOR UPDATE` que as duas funções já usam serializa chamadas **concorrentes**
-- e não faz nada contra duas chamadas **sequenciais**, que é o que um duplo
-- clique produz.
--
-- ## Onde a chave mora
--
-- Na tabela que registra o fato, como em `appointments`, `orders`,
-- `order_charges`, `invoices` e `account_transfers` — não existe tabela
-- genérica de idempotência aqui, e criar uma agora seria uma sexta forma de
-- responder a mesma pergunta.
--
-- `cash_movements` cobre a sangria e o suprimento. O pagamento de fiado precisa
-- de `customer_ledger`, e **não** de `cash_movements`: só a forma `cash` toca a
-- gaveta, e um pagamento em pix ou débito não deixaria linha nenhuma lá para
-- carregar a chave.

ALTER TABLE cash_movements  ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE customer_ledger ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Escopo por tenant, como em `appointments` e `invoices`. A escopagem por
-- operador é feita na borda, prefixando a chave com o id de quem opera: ela vem
-- do cliente e é livre, e duas recepcionistas mandando "1" fariam a segunda
-- receber a operação da primeira de volta em vez de fazer a dela.
CREATE UNIQUE INDEX IF NOT EXISTS cash_movements_idempotency_idx
  ON cash_movements (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Um pagamento de fiado pode virar **várias** linhas de extrato, uma por loja
-- onde a dívida está (bloco 59). A chave marca só a primeira: ela existe para
-- reencontrar o pagamento, não para descrever cada parte dele — e um índice
-- único sobre todas as partes recusaria a segunda linha do mesmo pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS customer_ledger_idempotency_idx
  ON customer_ledger (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
