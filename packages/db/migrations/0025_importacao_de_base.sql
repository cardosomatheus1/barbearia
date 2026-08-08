-- ============================================================================
-- 0025 — Importação de base (SPEC §5.8)
--
-- "Sem importador, a venda morre na objeção 'vou perder meus clientes'."
--
-- A SPEC pede quatro coisas desta tabela, e cada uma vira uma coluna ou um
-- índice aqui: preview antes de aplicar, deduplicação por telefone,
-- **reversível** e **idempotente**.
-- ============================================================================

CREATE TYPE import_status AS ENUM ('previewed', 'applied', 'reverted');

CREATE TABLE imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  file_name     text NOT NULL,
  /**
   * SHA-256 do conteúdo, não do nome.
   *
   * É o que torna a importação idempotente como a SPEC exige. Nome de arquivo
   * não serve: `clientes.csv` é o nome que o exportador dá toda vez, e duas
   * exportações diferentes chegam com ele. O conteúdo é o que de fato identifica
   * a remessa — e reexportar a mesma base no dia seguinte produz o mesmo hash
   * apenas se nada mudou, que é exatamente quando reimportar não deve fazer
   * nada.
   */
  file_sha256   text NOT NULL,
  separator     text NOT NULL,

  status        import_status NOT NULL DEFAULT 'previewed',
  /** O resumo por veredito, como a tela mostrou. Fica para a conferência depois. */
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,

  /**
   * As linhas que serão gravadas, entre o preview e o "aplicar".
   *
   * A alternativa era pedir o arquivo de novo no segundo passo, e o navegador
   * não repovoa um `<input type="file">` — a pessoa teria que escolher o mesmo
   * arquivo duas vezes, e qualquer engano entre um passo e outro aplicaria algo
   * diferente do que ela aprovou.
   *
   * Guarda **só os quatro campos que viram cliente**, nunca o CSV inteiro: o
   * arquivo do sistema antigo costuma trazer CPF, endereço e nome da mãe, e
   * reter isso seria coletar o que não se pediu. É esvaziado ao aplicar e ao
   * desfazer, porque a partir daí o dado mora em `customers` e esta cópia só
   * seria uma segunda base de dado pessoal para vazar.
   */
  payload       jsonb,

  /** Quem mandou. `staff_users` não tem RLS própria por tenant aqui — é só quem. */
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  reverted_at   timestamptz,

  CONSTRAINT imports_sha_formato CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT imports_nome_nao_vazio CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  /**
   * O carimbo tem que combinar com o estado.
   *
   * Uma linha `applied` sem `applied_at` faria a reversão não saber o que
   * desfazer, e uma `reverted` sem `reverted_at` esconderia que a barbearia
   * desfez a migração — que é justamente o que se quer ver depois.
   */
  CONSTRAINT imports_carimbo_coerente CHECK (
    (status = 'previewed' AND applied_at IS NULL AND reverted_at IS NULL)
    OR (status = 'applied' AND applied_at IS NOT NULL AND reverted_at IS NULL)
    OR (status = 'reverted' AND applied_at IS NOT NULL AND reverted_at IS NOT NULL)
  ),
  /**
   * Importação que já saiu do preview não guarda mais dado pessoal em `payload`.
   *
   * É a regra de retenção escrita onde ela não pode ser esquecida: um `UPDATE`
   * que marque `applied` sem limpar a cópia é recusado pelo banco, não por
   * disciplina de quem escreveu o repositório.
   */
  CONSTRAINT imports_payload_efemero CHECK (status = 'previewed' OR payload IS NULL)
);

/**
 * Idempotência: o mesmo arquivo não entra duas vezes.
 *
 * Parcial em `status <> 'reverted'` de propósito. Desfazer uma importação é
 * dizer "isto não era o que eu queria"; reimportar o mesmo arquivo depois disso
 * é uma decisão consciente de quem já viu o resultado, e travá-la obrigaria a
 * pessoa a editar o CSV só para mudar o hash.
 */
CREATE UNIQUE INDEX imports_arquivo_unico
  ON imports (tenant_id, file_sha256)
  WHERE status <> 'reverted';

CREATE INDEX imports_tenant_idx ON imports (tenant_id, created_at DESC);

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- O que a importação criou
-- ----------------------------------------------------------------------------

/**
 * Reversível quer dizer saber o que foi criado — e o que só foi tocado.
 *
 * `ON DELETE SET NULL`, não `CASCADE`: apagar o registro da importação não pode
 * levar junto os clientes dela. Quem desfaz é a reversão, com regra própria e
 * com uma pergunta que o `CASCADE` não faz — "este cliente já voltou?".
 *
 * Cliente que já existia e foi apenas completado pela importação **não** recebe
 * a marca. Ele não foi criado por ela, e desfazer não pode apagá-lo: ele é
 * cliente da barbearia desde antes.
 */
ALTER TABLE customers
  ADD COLUMN import_id uuid REFERENCES imports(id) ON DELETE SET NULL,
  /**
   * Aniversário — "crítico" no escopo mínimo da SPEC §5.8.
   *
   * A coluna nasce junto com a origem do dado. Sem o importador ela seria mais
   * um campo que o motor aceita e ninguém preenche, que é o defeito que o
   * `CLAUDE.md` §4 nomeia; com ele, mil e duzentos aniversários entram na
   * primeira carga.
   *
   * Sem teto superior no banco: `current_date` não é imutável e não pode entrar
   * num CHECK. "Não nasceu no futuro" é conferido na borda, onde o relógio da
   * unidade é conhecido.
   */
  ADD COLUMN birth_date date,
  ADD CONSTRAINT customers_nascimento_plausivel
    CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01');

/** A reversão pergunta "quais clientes esta importação criou?". */
CREATE INDEX customers_import_idx ON customers (import_id) WHERE import_id IS NOT NULL;
