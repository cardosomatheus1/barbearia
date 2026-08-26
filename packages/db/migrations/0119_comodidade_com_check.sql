-- `locations.amenities` ganha a trava que a coluna vizinha já tinha.
--
-- Ela é `text[] NOT NULL DEFAULT '{}'` desde a 0007, com a lista fechada escrita
-- num COMMENT e validada só na aplicação. A 0098 pôs `CHECK` em
-- `locations.payment_methods` citando o precedente de `products.unit`, e passou
-- ao lado desta.
--
-- O que um COMMENT não impede: importação de base, correção manual e script
-- antigo entram por fora. E aqui a lista chegou a divergir dentro do próprio
-- produto — a tela desenhava três comodidades e a borda aceitava seis.
--
-- Reaplicável, como toda migração depois da baseline: a guarda de `pg_constraint`
-- reencontra a constraint que ela mesma criou.
--
-- `NOT VALID`, e é decisão, não descuido.
--
-- Sem ele o Postgres varre a tabela inteira ao criar a constraint e **aborta a
-- migração** se uma linha antiga violar. `deploy/atualizar.sh` para na migração
-- e nada sobe: uma comodidade legada desconhecida em uma barbearia derrubaria a
-- atualização de todas. A borda sempre validou contra `AMENITIES`, então o dado
-- deve estar limpo — mas "deve estar" é suposição sobre banco de produção, e o
-- custo de estar errado é o deploy travado.
--
-- `NOT VALID` protege **toda escrita nova** desde já; o que ele não faz é
-- afirmar nada sobre o passado. Validar é `ALTER TABLE ... VALIDATE CONSTRAINT`
-- numa migração posterior, depois de conferir o que existe — a mesma operação
-- em duas fases que este repositório já usa para `SET NOT NULL`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_amenities_conhecidas'
  ) THEN
    ALTER TABLE public.locations
      ADD CONSTRAINT locations_amenities_conhecidas
      CHECK (amenities <@ ARRAY['wifi','card','pix','cash','parking','accessible']::text[])
      NOT VALID;
  END IF;
END $$;
