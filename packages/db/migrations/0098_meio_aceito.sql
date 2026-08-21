-- Os meios de pagamento que a casa anuncia passam a ter lista no banco.
--
-- A coluna existe desde a 0013 e é gravada pelo onboarding, mas nada a
-- conferia: importação de base, correção manual e script antigo entravam por
-- fora, e a partir do bloco 127 a recepção automática **responde** com ela ao
-- cliente. Lista sem CHECK e sem constante é a que o banco aceita de qualquer
-- jeito — foi a lição de products.unit, na 0093.
--
-- A conferência é por operador de arranjo: CHECK não aceita subconsulta, e o
-- que se quer é "todo elemento está na lista". Arranjo vazio passa, e é o
-- estado normal de quem ainda não escolheu — a coluna nasceu com DEFAULT '{}'.
-- Reaplicável: toda migração depois da baseline do livro-caixa reencontra o
-- que ela mesma criou, e `ADD CONSTRAINT` não tem `IF NOT EXISTS` no Postgres.
-- Sem a guarda, o `preparar` do compose morre e a API não sobe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_meio_aceito_conhecido'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT locations_meio_aceito_conhecido
      CHECK (payment_methods <@ ARRAY['pix', 'card', 'cash', 'online']::text[]);
  END IF;
END $$;

COMMENT ON COLUMN locations.payment_methods IS
  'Meios que a casa aceita, anunciados na página e respondidos pela recepção automática. Lista fechada em packages/core/src/meio-de-pagamento.ts.';
