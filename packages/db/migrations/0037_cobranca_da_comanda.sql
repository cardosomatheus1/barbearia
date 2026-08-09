-- ============================================================================
-- 0037 — A cobrança online da comanda: Pix, cartão e link
--        (blocos 35 e 36, SPEC §3.3)
--
-- Até aqui o pagamento da comanda era **registro**: a recepção olhava a
-- maquininha ou o aplicativo do banco, e digitava no sistema o que já tinha
-- acontecido em outro lugar. `order_payments` guarda esse registro e continua
-- guardando — ele é a verdade contábil da venda.
--
-- Esta tabela é outra coisa: a cobrança que o **produto** emitiu e cujo
-- desfecho ele acompanha. Ela existe porque emitir tem três estados e um
-- relógio, e nada disso cabe em `order_payments`, que só sabe de dinheiro que
-- já entrou.
--
-- ## Quatro decisões que o schema impõe
--
-- 1. **Uma cobrança em aberto por comanda.** Índice único parcial. Dois QR
--    Codes vivos para a mesma conta é o cliente pagando duas vezes — e o
--    segundo pagamento chega como um webhook que não tem comanda aberta para
--    fechar, virando dinheiro sem destino.
--
-- 2. **O id do provedor é único, e é por ele que o webhook encontra.** Nunca
--    pelo `order_id` que vem no evento: o evento é do adquirente e o que ele
--    devolve é o que **nós** mandamos, mas encontrar pelo id que só a nossa
--    própria emissão escreveu é o que torna impossível um evento legítimo
--    tocar uma comanda que não é a dele. É o mesmo raciocínio de
--    `invoices.psp_charge_id` no bloco 29.
--
-- 3. **A linha nasce antes da chamada ao adquirente.** A ordem inversa —
--    chamar, e gravar o que voltou — perde a cobrança inteira se o processo
--    cair no meio: existiria um Pix no mundo que o produto não conhece, e
--    portanto que a conciliação não alcança. Por isso `psp_payment_id` é
--    anulável: nulo significa "emitimos e ainda não sabemos o id", que é
--    estado real e tem tratamento (a conciliação reemite com a mesma chave de
--    idempotência, derivada do id **desta linha**, e o adquirente devolve a
--    mesma cobrança em vez de criar a segunda).
--
-- 4. **Não existe coluna para PAN, CVV ou validade.** Como em
--    `billing_customers` (bloco 29), e pelo mesmo motivo: coluna que não existe
--    não é preenchida por engano. O que entra é identificador opaco do
--    provedor. Há invariante em `packages/db/test` que reprova se alguém criar
--    uma.
-- ============================================================================

CREATE TYPE order_charge_status AS ENUM ('aguardando', 'pago', 'recusado', 'expirado');

CREATE TABLE order_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  /**
   * O meio, reaproveitando o enum da comanda.
   *
   * Um enum novo faria `order_charges.method` e `order_payments.method` serem
   * dois vocabulários para a mesma coisa, e a conversão entre eles moraria em
   * código — que é onde ela se perde. O `CHECK` restringe aos meios que o
   * adquirente sabe emitir: não se emite cobrança de "dinheiro".
   */
  method         payment_method NOT NULL,
  amount_cents   integer NOT NULL,
  status         order_charge_status NOT NULL DEFAULT 'aguardando',

  /** O id no adquirente. Nulo entre a criação da linha e a resposta dele. */
  psp_payment_id text,
  /**
   * O texto do Pix (`copia e cola`).
   *
   * O texto e não a imagem: a imagem se desenha a partir dele, e guardar
   * imagem seria guardar o mesmo dado em formato maior e ilegível. É também o
   * que metade dos clientes usa de verdade — quem paga pelo mesmo celular que
   * abriu a tela não consegue fotografar a própria tela.
   */
  pix_payload    text,
  /** Para onde mandar o cliente quando o meio é link (bloco 36). */
  checkout_url   text,

  expires_at     timestamptz,
  paid_at        timestamptz,
  /** O código do adquirente quando recusou. Vai para a trilha, nunca cru para o cliente. */
  refused_reason text,

  /**
   * A chave de idempotência **do balcão**, escopada por operador na borda.
   *
   * Ela vem do cliente e é livre: duas recepcionistas mandando "1" colidiriam,
   * e a segunda receberia de volta a cobrança da primeira — com o texto do Pix,
   * que basta para cobrar o cliente errado.
   */
  idempotency_key text,

  created_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  /**
   * O nome de quem emitiu, copiado.
   *
   * Como em `cash_movements`: quem emitiu pode sair da barbearia, e a cobrança
   * continua tendo que dizer quem foi. `created_by` vira nulo, o nome fica.
   */
  created_by_name text NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_charges_valor_positivo CHECK (amount_cents > 0),
  CONSTRAINT order_charges_meio_emitivel CHECK (method IN ('pix', 'credit', 'link')),
  CONSTRAINT order_charges_paga_tem_hora CHECK (status <> 'pago' OR paid_at IS NOT NULL),
  -- Cobrança paga sem id do provedor seria dinheiro sem origem conferível: a
  -- conciliação não teria o que perguntar, e a divergência não teria dono.
  CONSTRAINT order_charges_paga_tem_id CHECK (status <> 'pago' OR psp_payment_id IS NOT NULL)
);

ALTER TABLE order_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_charges
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma cobrança viva por comanda.
 *
 * Dois QR Codes abertos para a mesma conta é o cliente pagando duas vezes, e o
 * segundo pagamento chegaria como evento sem comanda aberta para fechar. A
 * recusa é aqui, no banco, e não numa consulta antes do `INSERT` — essa tem
 * janela de corrida, e dois toques no "Cobrar" acontecem em milissegundos.
 */
CREATE UNIQUE INDEX order_charges_uma_viva_por_comanda
  ON order_charges (order_id) WHERE status = 'aguardando';

/** Como o webhook encontra o que confirmar. */
CREATE UNIQUE INDEX order_charges_psp_idx
  ON order_charges (psp_payment_id) WHERE psp_payment_id IS NOT NULL;

CREATE UNIQUE INDEX order_charges_idempotency_idx
  ON order_charges (tenant_id, location_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/** "O que está pendurado?" — a pergunta da conciliação e da expiração. */
CREATE INDEX order_charges_pendentes
  ON order_charges (created_at) WHERE status = 'aguardando';

/** A tela da comanda lê as cobranças dela, mais recente primeiro. */
CREATE INDEX order_charges_order_idx ON order_charges (order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- A trilha do que o adquirente disse, do lado da barbearia
-- ---------------------------------------------------------------------------

/**
 * O espelho de `psp_events` para a comanda — e é tabela separada de propósito.
 *
 * `psp_events` é infraestrutura da plataforma: a política dela só deixa passar
 * quem **não** tem tenant fixado, porque o evento da mensalidade não é da
 * barbearia. Aqui é o contrário: o evento é de uma venda dela, e quem o aplica
 * roda com o tenant aberto. Uma tabela só teria que satisfazer as duas
 * políticas ao mesmo tempo, e o jeito de fazer isso seria afrouxar as duas.
 *
 * A chave primária é o id do evento, e é ela — não um `SELECT` antes do
 * `INSERT` — que trava a entrega **concorrente**. O adquirente reentrega por
 * desenho: é assim que ele garante entrega ao menos uma vez.
 */
CREATE TABLE order_charge_events (
  event_id     text PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  charge_id    uuid REFERENCES order_charges(id) ON DELETE SET NULL,
  type         text NOT NULL,
  /** O desfecho em uma palavra: `pago`, `recusado`, `expirado`, `ignorado`. */
  outcome      text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE order_charge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_charge_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_charge_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX order_charge_events_charge_idx ON order_charge_events (charge_id, received_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON order_charges TO barbearia_app;
    GRANT SELECT, INSERT ON order_charge_events TO barbearia_app;
    /**
     * Sem `DELETE` nos dois.
     *
     * A cobrança recusada e o evento que a recusou são a resposta para "por que
     * esta venda não fechou?", e é justamente a pergunta que alguém quer apagar
     * quando o número não bate. Cobrança que não vale mais vira `expirado`, que
     * é estado, não sumiço.
     */
    REVOKE DELETE ON order_charges FROM barbearia_app;
    REVOKE DELETE ON order_charge_events FROM barbearia_app;
  END IF;
END $$;
