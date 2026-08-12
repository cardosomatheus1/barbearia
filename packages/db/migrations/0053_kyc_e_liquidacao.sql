-- ============================================================================
-- 0053 — Split: KYC do profissional, liquidação e estorno (bloco 50, SPEC §3.5)
--
-- O bloco 49 montou as partes; este as move. Três requisitos da SPEC, e os três
-- são sobre o que acontece **quando dá errado**:
--
-- 1. *"Profissional precisa de cadastro no PSP (KYC). O onboarding disso é
--    assíncrono: enquanto pendente, o pagamento cai integralmente na barbearia
--    e a comissão é paga fora, **sem bloquear a venda**."*
-- 2. A liquidação em si — a transferência para a conta de cada um.
-- 3. *"Estorno com split já liquidado exige política explícita de recuperação."*
--
-- ## O KYC não bloqueia nada, e é essa a decisão
--
-- É a frase mais importante da seção, e ela vai contra o instinto: o caminho
-- óbvio seria recusar a venda até o barbeiro estar aprovado. O que isso produz é
-- a barbearia descobrindo no balcão, com o cliente na frente, que não consegue
-- cobrar — por uma pendência burocrática entre o barbeiro e um banco.
--
-- O caminho certo é o que já está desenhado desde o 49: a parte dele fica
-- `retido`, o dinheiro cai inteiro na casa, e a comissão sai no fechamento como
-- sempre saiu. O KYC muda **por onde** ele recebe, nunca **se** a venda acontece.
--
-- ## O estorno de repasse já liquidado é o caso difícil
--
-- O dinheiro saiu da conta da plataforma e entrou na do barbeiro. Estornar a
-- venda não o traz de volta: quem tem que devolver é ele, e nenhum adquirente
-- deixa a plataforma sacar de um recebedor.
--
-- A política escrita, que a SPEC exige que seja explícita: o repasse liquidado
-- vira **dívida do profissional com a casa**, lançada como comissão negativa no
-- período aberto — que é exatamente o que a SPEC §3.4 já manda fazer para
-- estorno ("gera comissão negativa no período corrente, nunca reescreve o
-- fechado"). Não se inventa um mecanismo novo: usa-se o que já existe e que o
-- barbeiro já entende.
-- ============================================================================

/**
 * O estado do cadastro do profissional no adquirente.
 *
 * `ausente` é o padrão e o estado da esmagadora maioria: ninguém tem cadastro
 * até alguém começar um. `pendente` é o onboarding assíncrono que a SPEC nomeia
 * — o adquirente pede documento, confere, e responde em horas ou dias.
 */
CREATE TYPE psp_kyc_status AS ENUM ('ausente', 'pendente', 'aprovado', 'recusado');

/**
 * `liquidando`: a chamada ao adquirente saiu e ainda não voltou.
 *
 * Achado da `/security-review` deste bloco, e é o mesmo desenho de `aceitando`
 * no resgate de convite do bloco 39: **`FOR UPDATE` sem escrita não separa
 * nada**. A trava cai no commit, e a liquidação solta a linha antes de falar com
 * o adquirente — sem um estado próprio, o estorno da venda podia entrar
 * exatamente nessa janela, ler `pendente`, marcar `estornado` e concluir que
 * ninguém devia nada. Segundos depois o adquirente confirmava a transferência: o
 * cliente reembolsado, o barbeiro com o dinheiro, e a dívida que este bloco
 * existe para criar nunca criada.
 *
 * Com o estado, o estorno enxerga "pode ter saído" e cobra — que é a escolha
 * conservadora certa quando o desfecho é ambíguo.
 */
ALTER TYPE split_status ADD VALUE IF NOT EXISTS 'liquidando' AFTER 'pendente';

ALTER TABLE professionals
  /**
   * O id do **recebedor** no adquirente. Nunca dados bancários.
   *
   * Agência, conta e CPF ficam com o adquirente, que é quem tem obrigação
   * regulatória de guardá-los. Aqui fica a referência opaca, pela mesma razão de
   * o cartão do clube guardar só o token: dado que não existe nesta tabela não
   * vaza dela, e há invariante que reprova quem criar coluna para eles.
   */
  ADD COLUMN psp_recipient_id text,
  ADD COLUMN psp_kyc_status psp_kyc_status NOT NULL DEFAULT 'ausente',
  ADD COLUMN psp_kyc_updated_at timestamptz,
  /** O que o adquirente respondeu quando recusou, para o balcão poder explicar. */
  ADD COLUMN psp_kyc_reason text;

ALTER TABLE professionals ADD CONSTRAINT professionals_recebedor_nao_vazio CHECK (
  psp_recipient_id IS NULL OR length(btrim(psp_recipient_id)) > 0
);

/**
 * Aprovado exige recebedor.
 *
 * "Aprovado" sem id é um profissional que a régua de liquidação escolheria para
 * repassar e para o qual não há para onde mandar — e a falha apareceria na
 * chamada ao adquirente, longe de onde a causa está.
 */
ALTER TABLE professionals ADD CONSTRAINT professionals_aprovado_tem_recebedor CHECK (
  psp_kyc_status <> 'aprovado' OR psp_recipient_id IS NOT NULL
);

CREATE INDEX professionals_kyc_idx ON professionals (psp_kyc_status)
  WHERE psp_kyc_status IN ('pendente', 'aprovado');

-- ---------------------------------------------------------------------------
-- A tentativa de repasse
--
-- Uma linha por chamada ao adquirente, e não um contador na parte do split.
-- É a mesma razão de `stock_movements` ser tabela e de `club_uses` ser tabela: a
-- pergunta que chega é *"por que o Ruan não recebeu?"*, e um contador responde
-- "três tentativas" enquanto a resposta é o motivo da terceira.
-- ---------------------------------------------------------------------------

CREATE TABLE split_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /**
   * `RESTRICT` pela mesma razão do bloco 49: a tabela é registro de dinheiro e
   * tem `REVOKE DELETE`, e ação referencial não passa pela revogação.
   */
  split_id        uuid NOT NULL REFERENCES payment_splits(id) ON DELETE RESTRICT,

  amount_cents    integer NOT NULL,
  /** `true` quando o adquirente aceitou. */
  ok              boolean NOT NULL,
  psp_transfer_id text,
  error_code      text,
  error_message   text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT split_transfers_valor_positivo CHECK (amount_cents > 0),
  /**
   * Aceito tem id; recusado tem motivo.
   *
   * Sem isto, um repasse "ok" sem id é uma transferência que ninguém consegue
   * rastrear no extrato do adquirente — e é justamente o extrato que o barbeiro
   * traz quando diz que não recebeu.
   */
  CONSTRAINT split_transfers_desfecho_coerente CHECK (
    (ok AND psp_transfer_id IS NOT NULL AND length(btrim(psp_transfer_id)) > 0)
    OR (NOT ok AND error_message IS NOT NULL)
  )
);

ALTER TABLE split_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE split_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON split_transfers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX split_transfers_da_parte_idx ON split_transfers (split_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Quantas vezes já se tentou, e o teto
--
-- No `payment_splits` e não derivado da contagem de `split_transfers`, por uma
-- razão de concorrência: o contador entra no `WHERE` do `UPDATE` que reivindica
-- a tentativa, e é ele que impede dois workers de mandarem o mesmo repasse duas
-- vezes. Contar linhas numa tabela que a outra transação ainda não commitou não
-- impede nada.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_splits
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0,
  /**
   * A dívida criada quando um repasse já liquidado é estornado.
   *
   * O dinheiro saiu para a conta do profissional e nenhum adquirente deixa a
   * plataforma sacar de volta. A política escrita da SPEC §3.5 é esta coluna
   * apontando para o lançamento de comissão negativa — o mesmo mecanismo que o
   * estorno de venda já usa desde o bloco 19, e que o barbeiro já entende.
   */
  ADD COLUMN clawback_entry_id uuid REFERENCES commission_entries(id) ON DELETE SET NULL;

ALTER TABLE payment_splits ADD CONSTRAINT payment_splits_tentativas_nao_negativas CHECK (
  attempts >= 0
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON split_transfers TO barbearia_app;
    REVOKE UPDATE, DELETE ON split_transfers FROM barbearia_app;
  END IF;
END $$;
