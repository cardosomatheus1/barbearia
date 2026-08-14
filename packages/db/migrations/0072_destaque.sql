-- ============================================================================
-- 0072 — destaque pago na busca (bloco 75)
--
-- O marketplace é a superfície de monetização do produto, e destaque é o que
-- todo marketplace vende. A pergunta deste bloco não é *se* dá para vender —
-- é **sob que regras**, porque a alternativa mais fácil destrói o que os
-- blocos 70 a 72 construíram.
--
-- ## Três decisões, e as três moram no schema
--
-- 1. **Destaque é rótulo, não ordenação.** O card patrocinado aparece marcado,
--    em cima, e a lista orgânica continua ordenada pelo que a pessoa pediu.
--    Misturar o pago no meio do orgânico é o que faz uma busca deixar de
--    responder a pergunta de quem busca — e este produto vende justamente o
--    contrário disso: *"a plataforma nunca cobra por cliente que já era seu"*.
--
-- 2. **Os lugares são escassos, e a escassez é imposta pelo banco.** Se
--    cinquenta barbearias comprarem destaque em Salvador, destaque deixa de
--    valer alguma coisa — para elas e para quem busca. Cada anúncio ocupa um
--    **lugar numerado**, e a constraint de exclusão impede dois anúncios no
--    mesmo lugar da mesma cidade com períodos que se cruzam. Um contador na
--    aplicação teria corrida; isto não tem.
--
-- 3. **O preço é congelado na venda.** Mesma decisão da fatura, da regra de
--    comissão e do sinal: renegociar a tabela em maio não muda o que foi
--    cobrado em abril.
-- ============================================================================

/**
 * A fatura do destaque é documento próprio, como a da comissão.
 *
 * Somá-la à mensalidade faria a barbearia receber um valor que ela não
 * consegue conferir. É a mesma razão de `marketplace` ter virado um tipo no
 * bloco 72, e o `ALTER TYPE` fica fora de bloco de transação pelo mesmo motivo:
 * o `psql` do `migrate.sh` roda instrução a instrução, e o rótulo precisa estar
 * comitado antes de o índice abaixo citá-lo.
 */
ALTER TYPE invoice_kind ADD VALUE IF NOT EXISTS 'ad';

CREATE TYPE marketplace_ad_status AS ENUM ('ativo', 'cancelado');

CREATE TABLE marketplace_ads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * A unidade em destaque.
   *
   * `RESTRICT` porque isto é registro de dinheiro cobrado: apagar a loja não
   * pode levar junto o anúncio que a barbearia pagou. É a mesma regra das
   * tabelas financeiras desde o bloco 51.
   */
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  /**
   * Onde ele aparece.
   *
   * Cidade e estado copiados, não derivados da unidade na leitura: mudar o
   * cadastro da loja não pode mudar a cidade de um anúncio já vendido e já
   * cobrado — quem comprou destaque em Salvador comprou em Salvador.
   */
  city          text NOT NULL,
  state         char(2) NOT NULL,

  /**
   * O lugar que este anúncio ocupa, de 1 a `LUGARES_EM_DESTAQUE`.
   *
   * É ele que torna a escassez uma garantia em vez de uma intenção: a
   * constraint de exclusão abaixo impede que dois anúncios ocupem o mesmo lugar
   * da mesma cidade em períodos que se cruzam.
   */
  slot          smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),

  /** Semiaberto `[início, fim)`, como todo intervalo daqui. */
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,

  price_cents   integer NOT NULL CHECK (price_cents >= 0),
  status        marketplace_ad_status NOT NULL DEFAULT 'ativo',

  invoice_id    uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  cancelled_at  timestamptz,
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,

  CONSTRAINT marketplace_ads_periodo_valido CHECK (ends_on > starts_on),
  CONSTRAINT marketplace_ads_cancelado_tem_motivo
    CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL)),
  CONSTRAINT marketplace_ads_cancelado_com_motivo
    CHECK (status <> 'cancelado' OR length(btrim(coalesce(cancel_reason, ''))) >= 10)
);

/**
 * Dois anúncios não ocupam o mesmo lugar da mesma cidade ao mesmo tempo.
 *
 * `daterange` semiaberto e `WHERE status = 'ativo'`: o cancelado libera o lugar
 * na hora, que é o que a barbearia espera ao cancelar. Um contador na aplicação
 * teria corrida entre duas vendas simultâneas — e a escassez é o produto.
 */
ALTER TABLE marketplace_ads
  ADD CONSTRAINT marketplace_ads_um_por_lugar
  EXCLUDE USING gist (
    city WITH =, state WITH =, slot WITH =,
    daterange(starts_on, ends_on, '[)') WITH &&
  ) WHERE (status = 'ativo');

-- A busca pergunta "quem está em destaque nesta cidade hoje".
CREATE INDEX marketplace_ads_na_cidade
  ON marketplace_ads (state, city, starts_on, ends_on) WHERE status = 'ativo';

/**
 * **Com** RLS, ao contrário de `marketplace_listings` — e a diferença é o
 * conteúdo.
 *
 * A primeira versão desta tabela não tinha política, com o argumento de que "um
 * anúncio diz que a barbearia X está em destaque em Salvador, o que é público".
 * Isso é verdade de `city`, `state`, `slot` e do período — e **falso** de
 * `price_cents`, `invoice_id`, `cancel_reason` e `created_by`, que são o que a
 * barbearia pagou e por que a plataforma tirou do ar. `marketplace_listings`
 * não tem coluna dessas; esta tem quatro.
 *
 * Sem política, a primeira consulta `withTenant` que tocasse esta tabela sem
 * repetir o filtro leria o gasto de anúncio de toda a concorrência — e neste
 * repositório o repositório **não** repete o filtro de propósito, porque quem
 * filtra é a política. Achado da `/security-review` do bloco 75.
 *
 * A forma é a de `invoices`: leitura com **ou sem** tenant — a busca anônima
 * roda sem, e a barbearia vê o que é dela —, escrita só **sem** tenant, porque
 * destaque é vendido pela plataforma e não solicitado pela barbearia.
 */
ALTER TABLE marketplace_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_ads FORCE ROW LEVEL SECURITY;

CREATE POLICY marketplace_ads_leitura ON marketplace_ads FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY marketplace_ads_escrita ON marketplace_ads FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

GRANT SELECT, INSERT, UPDATE ON marketplace_ads TO barbearia_app;

/**
 * Sem `DELETE`, como todo registro de dinheiro cobrado.
 *
 * Cancelar é **estado**, com motivo escrito e data: o anúncio que a barbearia
 * pagou e a plataforma tirou do ar precisa continuar existindo para a conversa
 * ter documento.
 */
REVOKE DELETE ON marketplace_ads FROM barbearia_app;

COMMENT ON TABLE marketplace_ads IS
  'Destaque pago na busca (bloco 75). Lugares escassos por cidade, impostos '
  'por constraint de exclusão; preço congelado na venda; o card sai marcado '
  'como patrocinado, nunca disfarçado de resultado orgânico.';

-- ----------------------------------------------------------------------------
-- A plataforma consegue reverter uma contestação (bloco 75)
--
-- O bloco 72 abriu a **leitura** de `marketplace_attributions` sem tenant, para
-- o outro lado do contrato poder auditar — e parou aí. A escrita continuou
-- estrita por tenant, então a reversão da plataforma, que roda `semTenant`, não
-- alcançava linha nenhuma: a rota existiria e nunca funcionaria.
--
-- A política de escrita passa a ter os dois ramos, e cada um é um dos lados do
-- contrato: a barbearia mexe nas linhas **dela** (é assim que ela contesta), e
-- a plataforma — que é quem roda sem tenant — mexe no que precisa revisar.
-- Nenhum dos dois alcança a barbearia vizinha, que é o que a política existe
-- para garantir.
--
-- É a mesma forma de `invoices`, com a polaridade invertida de propósito: lá a
-- escrita é **só** sem tenant, porque uma barbearia que pudesse escrever na
-- própria fatura se daria baixa sozinha. Aqui ela precisa escrever, porque
-- contestar é direito dela.
-- ----------------------------------------------------------------------------

DROP POLICY marketplace_attributions_escrita ON marketplace_attributions;
CREATE POLICY marketplace_attributions_escrita ON marketplace_attributions FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
