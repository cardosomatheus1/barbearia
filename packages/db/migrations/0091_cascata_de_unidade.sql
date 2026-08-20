-- ---------------------------------------------------------------------------
-- Nenhuma chave para `locations` cascateia (bloco 117)
--
-- A regra esta escrita desde o bloco 51 — *chave estrangeira para `locations`
-- em tabela de dinheiro e `RESTRICT`, nunca `CASCADE`* — e o comentario de
-- `packages/catalog/src/unidades.ts` afirma que **toda** chave para `locations`
-- e `RESTRICT`, "justamente para que apaga-la nao leve o registro do dinheiro
-- junto".
--
-- Dez nao eram, entre elas `orders` e `cash_sessions`. O fecho transitivo
-- alcancava vinte e duas tabelas, incluindo `order_items`, `order_payments`,
-- `appointment_services`, `commission_rules` e `work_schedules`.
--
-- ## Latente, e por que consertar mesmo assim
--
-- Nenhum caminho do produto faz `DELETE FROM locations` — "fechar unidade" e
-- `active = false`. O dia em que alguem acrescentar "excluir unidade", a
-- operacao leva a venda junto **passando por cima do `REVOKE DELETE`**, porque
-- acao referencial roda com os direitos do dono da tabela. Nao ha erro, nao ha
-- trilha, e o registro do dinheiro que saiu para terceiro some.
--
-- E cascata para `locations` e pior que a media, pela razao que
-- `staff_locations` ja mostrou no bloco 58: como ausencia significa "todas as
-- lojas", apagar uma unidade promoveria em silencio todo operador escopado a
-- ela a operador da rede inteira. Cascata que amplia acesso e o contrario do
-- que uma cascata parece fazer.
--
-- `tenant_id` continua sendo a unica excecao: apagar a barbearia leva tudo dela
-- junto, e esse e o unico caminho pelo qual isso deve acontecer.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  alvo record;
BEGIN
  FOR alvo IN
    SELECT c.conname,
           c.conrelid::regclass AS tabela,
           a.attname
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'locations'::regclass
       AND c.confdeltype = 'c'
       AND a.attname <> 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', alvo.tabela, alvo.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES locations(id) ON DELETE RESTRICT',
      alvo.tabela, alvo.conname, alvo.attname
    );
  END LOOP;
END $$;
