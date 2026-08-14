-- ============================================================================
-- 0076 — webhooks assinados para terceiros (bloco 79, SPEC §5.6)
--
-- ## O webhook carrega **fato e id**, nunca dado pessoal
--
-- A tentação é mandar o agendamento inteiro: nome, telefone, serviço, preço. O
-- integrador quer, e é uma linha a menos no código dele.
--
-- Não. Um webhook é uma requisição que sai da nossa rede para um endereço que
-- a barbearia digitou num campo, sem TLS mútuo e sem ninguém do outro lado
-- respondendo por LGPD. Mandar telefone de cliente por ali é exportar base para
-- fora por um canal que a barbearia configurou em trinta segundos e esqueceu.
--
-- O que sai é *"o agendamento X foi criado às 14h"*. Quem quiser os detalhes
-- busca na API pública do bloco 78 — com chave, com escopo e com trilha. O
-- webhook avisa; a API responde.
--
-- ## O segredo é da barbearia, e é cifrado
--
-- Aqui **nós** assinamos, então o segredo precisa ser recuperável — ao
-- contrário da chave de API, que guarda só o HMAC. Cifrado com AES-256-GCM em
-- chave de ambiente própria (`WEBHOOK_SECRET_KEY`), pelo mesmo motivo do token
-- de WhatsApp: com uma chave só, girar a de outra finalidade deixaria isto
-- ilegível e o defeito apareceria dias depois como "parou de chegar".
--
-- ## A escada de retentativa para na recusa definitiva
--
-- É a regra da cobrança do bloco 46: contra um `400` do outro lado, repetir seis
-- vezes são seis chamadas que já sabem a resposta. `5xx` e tempo esgotado
-- retentam; `4xx` que não seja 408 nem 429 encerra com o motivo gravado.
-- ============================================================================

CREATE TYPE webhook_event AS ENUM (
  'appointment.created',
  'appointment.cancelled',
  'appointment.rescheduled',
  'appointment.completed',
  'order.paid'
);

CREATE TYPE webhook_delivery_status AS ENUM ('pendente', 'entregue', 'falhou', 'desistiu');

CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,

  /**
   * Só `https://`. Um endereço `http` levaria o corpo assinado em claro pela
   * rede — a assinatura prova a origem, não esconde o conteúdo.
   */
  url           text NOT NULL,

  /**
   * O segredo compartilhado, cifrado.
   *
   * Recuperável de propósito: quem assina somos nós. É a diferença para
   * `api_keys.secret_hmac`, onde quem apresenta o segredo é o outro lado.
   */
  secret_cipher text NOT NULL,

  events        webhook_event[] NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_endpoints_nome CHECK (length(btrim(name)) >= 2),
  CONSTRAINT webhook_endpoints_https CHECK (url LIKE 'https://%'),
  CONSTRAINT webhook_endpoints_assina_algo CHECK (cardinality(events) > 0)
);

CREATE INDEX webhook_endpoints_da_casa ON webhook_endpoints (tenant_id) WHERE active;

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_acesso ON webhook_endpoints FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO barbearia_app;

/**
 * Cada entrega, com o id que o outro lado usa para deduplicar.
 *
 * `event_id` é público e vai no corpo: reentrega é normal — a escada existe —,
 * e o integrador precisa de uma chave para não processar duas vezes. É o que
 * exigimos dos nossos próprios consumidores desde o bloco 1.
 *
 * O `payload` guarda o que **foi enviado**, congelado: reconstruí-lo na leitura
 * faria a tela mostrar o fato de hoje sobre uma entrega de ontem.
 */
CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /**
   * `RESTRICT`, e não `CASCADE`.
   *
   * Ação referencial roda com os direitos do **dono** da tabela e não passa
   * pelo `REVOKE DELETE` abaixo: com `CASCADE`, apagar o endereço seria o
   * caminho de destruição que a revogação existe para fechar — e o documento da
   * conversa iria junto. Ninguém apaga endereço hoje (`desligarEndpoint` vira o
   * estado), e é por isso que `RESTRICT` não atrapalha nada.
   */
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  event           webhook_event NOT NULL,
  payload         jsonb NOT NULL,
  status          webhook_delivery_status NOT NULL DEFAULT 'pendente',
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status smallint,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_deliveries_tentativas CHECK (attempts >= 0),
  CONSTRAINT webhook_deliveries_entregue_tem_hora
    CHECK ((status = 'entregue') = (delivered_at IS NOT NULL))
);

CREATE UNIQUE INDEX webhook_deliveries_evento ON webhook_deliveries (event_id);
CREATE INDEX webhook_deliveries_a_fazer
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pendente';
CREATE INDEX webhook_deliveries_da_casa ON webhook_deliveries (tenant_id, created_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
/**
 * Leitura com **ou sem** tenant; escrita idem.
 *
 * O worker entrega fora de requisição e precisa varrer o que está pendente em
 * todas as barbearias — é o mesmo desenho de `jobs`, que não tem RLS. Aqui a
 * tabela tem `tenant_id` e a barbearia enxerga só o que é dela; o que roda sem
 * tenant é a varredura, que não pertence a nenhuma.
 */
CREATE POLICY webhook_deliveries_acesso ON webhook_deliveries FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO barbearia_app;

/**
 * Sem `DELETE`: a entrega é o documento da conversa.
 *
 * *"Não recebi nada"* é a discussão que este registro fecha, e apagá-la deixaria
 * o integrador e a barbearia sem par. A limpeza do que envelheceu é decisão de
 * retenção, e ela ainda não existe — está declarada no ROADMAP.
 */
REVOKE DELETE ON webhook_deliveries FROM barbearia_app;

COMMENT ON TABLE webhook_deliveries IS
  'Entregas de webhook (bloco 79). O corpo carrega fato e id, nunca dado '
  'pessoal: quem quer detalhe busca na API publica, com chave e escopo.';

/**
 * O que a entrega precisa saber, por função — e não por política mais larga.
 *
 * `entregarWebhook` roda `semTenant`: o worker varre o pendente de todas as
 * barbearias. `webhook_deliveries` permite essa leitura, mas o `JOIN` com
 * `webhook_endpoints` — cuja política é estrita por tenant — devolvia **zero
 * linhas**, e a entrega respondia "sumiu" sobre uma pendência que estava lá.
 *
 * A alternativa era abrir a leitura de `webhook_endpoints` sem tenant. Não:
 * `USING` não recorta coluna, e aquilo entregaria `secret_cipher` de toda a
 * base a qualquer caminho sem tenant. Uma função que devolve os três campos de
 * **uma** entrega é a autorização do tamanho exato do que se precisa — é o
 * desenho de `carimbar_uso_da_chave`, do bloco 78.
 */
CREATE FUNCTION entrega_de_webhook(p_id uuid)
RETURNS TABLE (
  payload    jsonb,
  attempts   smallint,
  url        text,
  segredo    text,
  ativo      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.payload, d.attempts, e.url, e.secret_cipher, e.active
    FROM public.webhook_deliveries d
    JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
   WHERE d.id = p_id AND d.status = 'pendente'
$$;

COMMENT ON FUNCTION entrega_de_webhook(uuid) IS
  'Os tres campos que a entrega precisa, para uma pendencia so. SECURITY '
  'DEFINER porque o worker roda sem tenant e a politica de webhook_endpoints '
  'exige um — e abrir aquela politica entregaria o segredo cifrado da base.';

REVOKE ALL ON FUNCTION entrega_de_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entrega_de_webhook(uuid) TO barbearia_app;
