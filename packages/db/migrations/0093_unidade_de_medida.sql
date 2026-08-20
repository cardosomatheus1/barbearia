-- A unidade de medida do produto passa a ser uma lista fechada no banco.
--
-- `products.unit` nasceu `text NOT NULL DEFAULT 'un'` com os três valores
-- escritos **num comentário** e sem `CHECK`. A borda tinha um `z.enum` e a tela
-- tinha três `<option>` — três lugares, nenhum autoritativo, e o banco aceitando
-- qualquer texto.
--
-- O que a `CHECK` protege é o que não passa pela borda: importação de base,
-- correção manual, script de migração de um sistema antigo. A ficha técnica
-- consome `unit` para ratear insumo por serviço, e uma unidade desconhecida ali
-- não é recusada em lugar nenhum — ela vira um rateio que ninguém confere.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa: um banco
-- que já a tenha aplicado reencontra a constraint pelo nome.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_unit_conhecida'
  ) THEN
    -- Linhas anteriores com unidade fora da lista viram 'un', que é o padrão
    -- da coluna desde a 0047: é o valor que a barbearia já veria na tela.
    UPDATE products SET unit = 'un' WHERE unit NOT IN ('un', 'ml', 'g');

    ALTER TABLE products
      ADD CONSTRAINT products_unit_conhecida CHECK (unit IN ('un', 'ml', 'g'));
  END IF;
END $$;
