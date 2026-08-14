-- ============================================================================
-- 0079 — o que a revisão geral de segurança achou no dado pessoal
--
-- Três achados da mesma família, e a família tem nome: **`anonimizar_cliente` é
-- lista escrita, e a varredura de catálogo do bloco 34 só olha colunas de
-- `customers`.** Texto sobre uma pessoa guardado em qualquer outra tabela passa
-- pelas duas redes sem tocar em nenhuma.
--
-- Já aconteceu três vezes: o motivo do override (bloco 37), a foto (74), a
-- justificativa da contestação (80). Aqui são mais duas, e desta vez o conserto
-- é o mecanismo que o bloco 80 escolheu — **gatilho**, não mais uma linha na
-- função. A função precisa ser lembrada; o gatilho alcança qualquer caminho
-- que anonimize, inclusive o que alguém escrever daqui a dez blocos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — o texto escrito sobre a pessoa sai quando ela sai
--
-- `loyalty_entries.note` é obrigatório no ajuste manual (`CHECK >= 10`) e é
-- escrito por quem tem `finance.loyalty_adjust`. O exemplo que aparece no
-- balcão é literalmente sobre a pessoa: *"creditei 500 pontos porque o Marcelo
-- brigou com o barbeiro na frente da loja e ameaçou processar"*. Depois da
-- anonimização a linha continuava apontando para o cadastro apagado, com o
-- texto intacto e a data — reidentificável cruzando com a venda do mesmo dia.
--
-- `data_requests.note` é pior pela ironia: é o motivo da **recusa de um pedido
-- do titular**, e era o único texto que sobrevivia justamente à exclusão que a
-- pessoa pediu. A tabela é excluída da exportação com motivo escrito ("registro
-- do processo"), então ele também era invisível para quem descrevia.
--
-- O gatilho é em `customers`, e dispara quando `anonymized_at` deixa de ser
-- nulo: é o instante em que a pessoa sai, e é único. Assim o mecanismo não
-- depende de a função lembrar de cada satélite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION customers_anonimiza_textos_satelites() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN
    UPDATE public.loyalty_entries
       SET note = NULL
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id AND note IS NOT NULL;

    /**
     * O pedido do titular vira marcador, não nulo.
     *
     * O `CHECK data_requests_recusa_tem_motivo` exige motivo escrito numa
     * recusa, e ele está certo: recusar sem dizer por quê não é recusa
     * auditável. O que o marcador preserva é a **forma** do registro sem o
     * texto sobre a pessoa — é o desenho de `reviews.contest_note` no bloco 80.
     */
    UPDATE public.data_requests
       SET note = 'texto removido na anonimizacao do titular'
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND note IS NOT NULL
       AND note <> 'texto removido na anonimizacao do titular';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customers_anonimiza_textos_satelites
  AFTER UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_anonimiza_textos_satelites();

-- ---------------------------------------------------------------------------
-- 2 — a cascata que destruía o consentimento e o razão de fidelidade
--
-- `reverterImportacao` recusa desfazer quando o cliente importado já tem
-- agendamento, comanda, fila ou razão de fiado — quatro dos filhos. Faltavam os
-- dois **append-only**, e a consequência é a regra que este repositório enuncia
-- desde o bloco 51: *`ON DELETE CASCADE` roda com os direitos do dono da tabela
-- e **não passa** pelo `REVOKE DELETE`*.
--
-- O caminho é curto e não exige privilégio nenhum além do que a importação já
-- pede: sobe a base, um cliente registra consentimento de marketing no balcão
-- (ou recebe crédito manual), reverte a importação. A guarda passa — não há
-- comanda nem agendamento —, o `DELETE FROM customers` cascateia, e some a
-- prova de consentimento LGPD com data, IP e versão do texto.
--
-- `SET NULL` e não `RESTRICT`, pelo mesmo critério de `reviews.customer_id` e
-- `feedbacks.customer_id`: a linha é fato do negócio e fica; quem sai de dentro
-- dela é a pessoa.
-- ---------------------------------------------------------------------------
ALTER TABLE customer_consents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE customer_consents DROP CONSTRAINT customer_consents_customer_id_fkey;
ALTER TABLE customer_consents
  ADD CONSTRAINT customer_consents_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE loyalty_entries ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE loyalty_entries DROP CONSTRAINT loyalty_entries_customer_id_fkey;
ALTER TABLE loyalty_entries
  ADD CONSTRAINT loyalty_entries_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3 — o desafio de OTP tem prazo, e ele passa a existir
--
-- `otp_challenges` guarda `phone_e164` **em claro** e `pending_name` — o nome
-- que a pessoa digitou antes de confirmar. A migração 0005 anuncia um índice
-- "faxina de desafios vencidos" e a faxina nunca foi escrita: não há `DELETE`
-- na aplicação nem no worker.
--
-- O único apagamento mora dentro de `anonimizar_cliente`, condicionado ao
-- telefone do cadastro — ou seja, alcança só quem **é** cliente com aquele
-- número naquele instante. Sobram dois casos, e o segundo é o pior:
--
-- 1. quem pediu o código, desistiu e nunca marcou nada fica gravado
--    indefinidamente numa barbearia com a qual nunca teve relação. Não está em
--    `customers`, então nenhum pedido de exclusão a alcança e a retenção de
--    cinco anos não a enxerga;
-- 2. quem trocou de número: a anonimização apaga o desafio do número **novo**,
--    e o do antigo fica — com o nome verdadeiro. É exatamente o que o
--    comentário da 0071 diz que não pode acontecer.
--
-- Um dump da tabela é a lista de todo telefone que já tentou agendar em
-- qualquer barbearia da plataforma. O prazo entra no schema, como
-- `imports.payload` e `reception_gaps.pergunta_texto`, e a varredura fica no
-- worker.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE otp_challenges IS
  'Desafios de OTP. Guarda telefone em claro e o nome digitado antes de '
  'confirmar: e copia de dado pessoal FORA de customers, entao vive com prazo '
  'escrito — 7 dias depois de vencido ou consumido, varridos por '
  'expirarDesafiosDeOtp no worker. Sem o prazo, um dump desta tabela e a lista '
  'de todo telefone que ja tentou agendar na plataforma, inclusive de quem '
  'nunca virou cliente e por isso nao e alcancavel por anonimizar_cliente.';

/**
 * O índice da varredura.
 *
 * Parcial no que já pode sair: a consulta procura `expires_at` antigo, e um
 * índice sobre a coluna inteira seria quase todas as linhas da tabela.
 */
CREATE INDEX IF NOT EXISTS otp_challenges_vencidos
  ON otp_challenges (expires_at)
  WHERE consumed_at IS NOT NULL OR expires_at IS NOT NULL;
