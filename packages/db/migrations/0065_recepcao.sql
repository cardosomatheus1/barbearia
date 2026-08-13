-- ============================================================================
-- 0065 — recepção digital e o registro de lacunas (bloco 66, SPEC §4.17)
--
-- > *"Respostas vêm **exclusivamente** dos dados configurados pela barbearia.
-- > Pergunta sem resposta configurada → encaminha a um humano e **registra a
-- > lacuna**, para o dono preencher. Essa lista de lacunas é, sozinha, um
-- > produto útil."*
--
-- A última frase é a que decide esta migração. O produto óbvio seria só escalar
-- para humano; o que a SPEC pede é **medir o que ninguém consegue responder**.
-- Uma barbearia que vê "dezoito pessoas perguntaram se você abre no domingo, e
-- você não cadastrou o horário de domingo" tem uma tarefa clara — e é isso que
-- transforma um chatbot que não sabe numa lista de trabalho.
--
-- ## Uma linha por pergunta, com contador — não uma linha por vez que perguntam
--
-- Guardar cada ocorrência daria uma tabela que cresce sem limite e uma tela que
-- precisa agrupar para dizer qualquer coisa. O que o dono precisa saber é
-- **quais perguntas** e **quantas vezes**, e isso é `ON CONFLICT DO UPDATE` sobre
-- o texto normalizado.
--
-- A normalização é a chave: "vocês abrem domingo?" e "Abrem no domingo" são a
-- mesma pergunta, e contá-las separadas faria a lista ter cinquenta linhas de
-- uma coisa só — que é exatamente a tela que ninguém olha.
--
-- ## Sem `customer_id`, de propósito
--
-- É o precedente do recado do bloco 43: a pergunta mais valiosa é a de quem
-- ainda não é cliente — alguém pesquisando a barbearia pela primeira vez, que
-- não vai criar cadastro para perguntar o preço do corte. Guardar quem perguntou
-- transformaria uma leitura operacional em dado pessoal, com o consentimento que
-- ele exige, para responder uma pergunta que não precisa de nome.
-- ============================================================================

CREATE TABLE reception_gaps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * O texto normalizado — sem acento, sem caixa, sem pontuação.
   *
   * É a chave de agrupamento, e ela é gravada junto do texto original porque a
   * tela precisa mostrar a pergunta como alguém a escreveu: "vcs abre dmg" diz
   * ao dono mais sobre o público dele que "voce abre domingo".
   */
  pergunta_chave  text NOT NULL,

  /**
   * O texto como a pessoa escreveu — **com prazo**.
   *
   * Ele é o que diz ao dono quem é o público dele, e é também a única coisa
   * nesta tabela que uma pessoa pode ter enchido de dado pessoal: nada impede
   * alguém de digitar "meu nome é Ana, telefone tal, posso ir hoje?". Sem
   * `customer_id`, esse texto não é alcançável por `anonimizar_cliente` e não
   * sai na exportação do titular — então ele não pode ficar para sempre.
   *
   * A saída é a mesma de `imports.payload`: cópia de dado pessoal fora de
   * `customers` vive com prazo escrito no schema. Passados
   * `RETENCAO_DO_TEXTO_DIAS` sem ninguém repetir a pergunta, o texto é apagado
   * e a linha continua — a chave normalizada e o contador são o produto, e eles
   * não identificam ninguém. Perguntar de novo o traz de volta, porque aí ele é
   * novo.
   */
  pergunta_texto  text,

  vezes           integer NOT NULL DEFAULT 1 CHECK (vezes > 0),
  primeira_vez    timestamptz NOT NULL DEFAULT now(),
  ultima_vez      timestamptz NOT NULL DEFAULT now(),

  /**
   * O dono marca como resolvida quando cadastra o que faltava.
   *
   * Resolver é **estado**, nunca `DELETE`: a pergunta continua contando para a
   * leitura do trimestre, e apagar perderia a informação de que ela existiu. É a
   * mesma decisão do recado do bloco 43.
   */
  resolvida_em    timestamptz,
  resolvida_por   uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  -- Nulo é "o prazo venceu"; vazio nunca é resposta.
  CONSTRAINT reception_gaps_texto_nao_vazio
    CHECK (pergunta_texto IS NULL OR length(btrim(pergunta_texto)) > 0)
);

CREATE UNIQUE INDEX reception_gaps_por_pergunta
  ON reception_gaps (tenant_id, pergunta_chave);

-- A tela lista o que ainda não foi resolvido, do mais perguntado para o menos.
CREATE INDEX reception_gaps_abertas
  ON reception_gaps (tenant_id, vezes DESC) WHERE resolvida_em IS NULL;

ALTER TABLE reception_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE reception_gaps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reception_gaps
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON reception_gaps TO barbearia_app;

/**
 * Sem `DELETE`, como o recado.
 *
 * Apagar a pergunta que ninguém soube responder é apagar exatamente o dado que
 * esta tabela existe para produzir. Resolver é estado.
 */
REVOKE DELETE ON reception_gaps FROM barbearia_app;

-- A varredura acha em uma consulta o que passou do prazo; sem o índice ela lê a
-- tabela inteira todo dia.
CREATE INDEX reception_gaps_texto_a_expirar
  ON reception_gaps (tenant_id, ultima_vez) WHERE pergunta_texto IS NOT NULL;

COMMENT ON TABLE reception_gaps IS
  'Perguntas que a recepção digital não soube responder (bloco 66, SPEC §4.17). '
  'Uma linha por pergunta normalizada, com contador. Sem customer_id de propósito: '
  'a pergunta mais valiosa é a de quem ainda não é cliente.';
