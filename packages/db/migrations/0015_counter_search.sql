-- ============================================================================
-- 0015 — Achar o cliente no balcão
--
-- A recepção não digita o nome inteiro nem o telefone inteiro. Ela digita
-- "silva" ou os quatro últimos dígitos, com o cliente parado na frente dela.
-- Sem índice para isso a busca vira varredura da base de clientes a cada tecla
-- — na tela que mais é usada, e justamente quando a barbearia cresce.
--
-- Três decisões, cada uma por um jeito de perguntar:
--
--   trecho de nome — trigrama, porque `ILIKE '%silva%'` casa no meio da string
--                    e nenhum índice B-tree serve para isso.
--   sem acento     — porque no Brasil ninguém digita "João" com til na pressa,
--                    e uma busca que exige o acento não acha o cliente que
--                    está de pé na frente da recepcionista.
--   telefone       — sufixo, porque ninguém dita o DDI. `reverse()` transforma
--                    sufixo em prefixo, que é o que um B-tree sabe fazer.
--
-- `pg_trgm` e `unaccent` são dependências novas. Motivo: sem trigrama a única
-- alternativa para busca por trecho é varredura sequencial; sem unaccent a
-- busca falha em metade dos nomes brasileiros.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- `unaccent()` é STABLE (depende do dicionário configurado) e por isso não pode
-- entrar num índice. Fixar o dicionário pelo nome a torna IMMUTABLE — é a
-- receita da própria documentação do Postgres. Os nomes vêm qualificados por
-- schema para que um `search_path` hostil não troque a função por outra.
CREATE FUNCTION sem_acento(texto text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
  $$ SELECT public.unaccent('public.unaccent'::regdictionary, texto) $$;

COMMENT ON FUNCTION sem_acento(text) IS
  'unaccent com dicionário fixo, para poder ser indexada.';

-- Sem `tenant_id` na frente: o índice GIN de trigrama não compõe com coluna
-- escalar, e a RLS já restringe as linhas visíveis antes de o filtro rodar.
CREATE INDEX customers_name_trgm_idx
  ON customers USING gin (sem_acento(lower(name)) gin_trgm_ops);

-- `reverse` é IMMUTABLE, então serve de expressão indexada. A consulta compara
-- `reverse(phone_e164) LIKE reverse(digitos) || '%'`.
--
-- Sem `tenant_id` na frente, pela mesma razão do índice de nome: a consulta não
-- filtra por tenant (a RLS faz isso), e uma coluna líder sem predicado
-- inutiliza o B-tree. Medido em 40 mil clientes: com `(tenant_id, ...)` o plano
-- era Seq Scan em 11,3 ms; sem ela, Index Scan em 0,12 ms.
CREATE INDEX customers_phone_tail_idx
  ON customers (reverse(phone_e164) text_pattern_ops);

COMMENT ON INDEX customers_name_trgm_idx IS
  'Busca por trecho de nome no balcão, sem acento e sem caixa.';
COMMENT ON INDEX customers_phone_tail_idx IS
  'Busca pelos últimos dígitos do celular no balcão.';
