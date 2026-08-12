-- ============================================================================
-- 0060 — campanhas (bloco 57, SPEC §4.13)
--
-- > *"Toda campanha reporta: enviados · entregues · lidos · cliques ·
-- > **agendamentos gerados** · **receita atribuída**. A última coluna é a única
-- > que importa."*
--
-- É a frase que decide o schema. Uma tabela de campanha que guardasse só o
-- público e a data responderia às quatro primeiras colunas e a nenhuma das
-- duas últimas — e as duas últimas são a razão de a tela existir.
--
-- ## Campanha e automação são coisas diferentes
--
-- A automação do bloco 56 é uma **regra** que dispara sozinha quando um fato
-- acontece. A campanha é um **envio**, decidido por uma pessoa, para um público
-- que ela escolheu agora. Elas se parecem no que produzem — uma mensagem — e
-- não no que são: a automação não tem público, e a campanha não tem gatilho.
--
-- Compartilham as proteções (teto, opt-out, silêncio, um por dia), que moram em
-- `packages/core` desde o bloco 20 e são chamadas pelas duas.
--
-- ## O público é congelado na criação
--
-- `campaign_targets` guarda quem entrou, e não o filtro. Guardar o filtro faria
-- "quantos receberam" mudar toda vez que alguém fosse cadastrado — e a receita
-- atribuída, que divide por esse número, mudaria junto. O filtro é como se
-- chegou ao público; o público é o fato.
-- ============================================================================

/**
 * De onde veio o público.
 *
 * A célula fria do heatmap é o primeiro filtro do produto, e é o que a SPEC
 * §5.9 pede em letras: *"célula fria é clicável e vira campanha direcionada — o
 * heatmap não é relatório, é ponto de partida de ação"*.
 */
CREATE TYPE campaign_filter AS ENUM (
  'inativos',
  'aniversariantes',
  'todos',
  'celula_fria'
);

CREATE TYPE campaign_status AS ENUM (
  'rascunho',
  'enviando',
  'enviada'
);

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name            text NOT NULL,
  filter          campaign_filter NOT NULL,
  /** O número do filtro: dias sem vir, ou a hora da célula fria. */
  filter_value    integer,
  /** O dia da semana, quando o filtro é célula fria. */
  filter_weekday  smallint,

  kind            notification_kind NOT NULL,
  status          campaign_status NOT NULL DEFAULT 'rascunho',

  /**
   * A janela de atribuição, igual à da automação.
   *
   * Mesma decisão e mesmo motivo: sem a ponta de cima, a campanha leva crédito
   * por um corte que a pessoa faria de qualquer jeito. Atribuição frouxa é pior
   * que atribuição nenhuma, porque tem número.
   */
  goal_window_days integer NOT NULL DEFAULT 7,

  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT campaigns_nome_nao_vazio CHECK (length(btrim(name)) > 0),
  CONSTRAINT campaigns_janela_util CHECK (goal_window_days BETWEEN 1 AND 90),
  CONSTRAINT campaigns_dia_valido CHECK (
    filter_weekday IS NULL OR filter_weekday BETWEEN 0 AND 6
  ),
  -- Célula fria precisa de dia **e** hora: sem os dois, o público seria "toda
  -- terça" ou "todo mundo das 14h", que é outro filtro.
  CONSTRAINT campaigns_celula_completa CHECK (
    filter <> 'celula_fria' OR (filter_weekday IS NOT NULL AND filter_value IS NOT NULL)
  ),
  CONSTRAINT campaigns_enviada_com_data CHECK (
    status <> 'enviada' OR sent_at IS NOT NULL
  )
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Quem entrou no público, e o que aconteceu com cada um.
 *
 * As seis colunas da SPEC §4.13 saem daqui por agregação: enviados, entregues e
 * lidos do estado; cliques do carimbo; agendamentos gerados e receita atribuída
 * da janela. Uma tabela de contadores na campanha responderia às três primeiras
 * e envelheceria — o webhook do WhatsApp chega depois, e ele muda o estado de
 * uma linha que já estava fechada.
 */
CREATE TABLE campaign_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,

  sent_at         timestamptz,
  skipped_reason  text,
  /** O id da mensagem na Meta, que liga esta linha ao estado de entrega. */
  wamid           text,
  clicked_at      timestamptz,

  /** O objetivo, com o mesmo desenho da automação. */
  goal_met_at     timestamptz,
  goal_ref        uuid,
  /**
   * A receita atribuída, **congelada** no momento da atribuição.
   *
   * É a exceção da regra de valor derivado deste schema, e pelo mesmo motivo do
   * split: recalcular na leitura faria o relatório de uma campanha de março
   * mudar quando alguém estornasse uma venda em maio — e a pergunta que a
   * coluna responde é "quanto esta campanha trouxe", não "quanto vale hoje".
   */
  goal_amount_cents integer,

  CONSTRAINT campaign_targets_desfecho_coerente CHECK (
    sent_at IS NULL OR skipped_reason IS NULL
  ),
  CONSTRAINT campaign_targets_objetivo_exige_envio CHECK (
    goal_met_at IS NULL OR sent_at IS NOT NULL
  ),
  CONSTRAINT campaign_targets_valor_com_objetivo CHECK (
    goal_amount_cents IS NULL OR goal_met_at IS NOT NULL
  )
);

ALTER TABLE campaign_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_targets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/** Uma linha por pessoa por campanha: o público é congelado, não recalculado. */
CREATE UNIQUE INDEX campaign_targets_um_por_pessoa
  ON campaign_targets (campaign_id, customer_id);

CREATE INDEX campaign_targets_a_enviar_idx
  ON campaign_targets (campaign_id)
  WHERE sent_at IS NULL AND skipped_reason IS NULL;

CREATE INDEX campaign_targets_por_wamid_idx ON campaign_targets (wamid) WHERE wamid IS NOT NULL;
