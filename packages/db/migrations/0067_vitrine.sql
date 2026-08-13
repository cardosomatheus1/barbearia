-- ============================================================================
-- 0067 — a vitrine do marketplace (bloco 70, SPEC §5.2)
--
-- > *"Busca: barbearias perto de mim. Filtros: distância · preço · avaliação ·
-- > disponível hoje · disponível agora · serviço · profissional · assinatura ·
-- > acessibilidade."*
--
-- ## Por que uma tabela, e por que ela **não** tem RLS
--
-- Toda tabela de negócio deste produto tem `FORCE ROW LEVEL SECURITY`, e a
-- política compara `tenant_id` com `app.tenant_id`. A busca do marketplace é a
-- primeira leitura do produto que atravessa barbearias de propósito: ela roda
-- **antes** de existir tenant no contexto, porque descobrir a barbearia é
-- justamente o que ela faz. Uma consulta com RLS e sem tenant devolve zero
-- linhas, sempre e em silêncio.
--
-- É a exceção que `tenant_slugs` já abriu no bloco 1 e que `tenant_platform`
-- repetiu no 21 — as duas lidas por `semTenant`. A regra que as torna seguras é
-- a mesma aqui: **só entra o que já é público**. Nome, endereço, coordenada,
-- foto, faixa de preço e nota são o que qualquer visitante lê na página da
-- barbearia hoje. Cliente, agenda, caixa e comissão continuam atrás da RLS, e
-- não há coluna aqui que os alcance.
--
-- ## Derivada, e portanto obrigada a se atualizar
--
-- `price_from_cents` e a nota não são cadastro: saem de `services` e `reviews`,
-- que têm RLS. Copiá-las é o preço de a busca existir — e a cópia envelhece. Por
-- isso `refreshed_at` é obrigatório e a atualização é **por evento**, no mesmo
-- caminho que publica a barbearia e que mexe no catálogo, com varredura diária
-- como rede. Cache invalidado só por TTL é a regra que este repositório proíbe
-- desde o bloco 8; aqui o TTL é a rede, não o mecanismo.
-- ============================================================================

/**
 * Aparecer na busca é decisão da barbearia, e ela **nasce ligada**.
 *
 * A convenção do bloco 60 é escrita: regra que recusa nasce desligada, regra
 * que beneficia nasce ligada. Ser encontrada é o benefício que a plataforma
 * vende, e o dado que aparece já é o da própria página pública dela. Quem não
 * quiser desliga — e a tela diz o que sai da vitrine.
 */
ALTER TABLE locations
  ADD COLUMN listed_in_marketplace boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN locations.listed_in_marketplace IS
  'Se esta unidade aparece na busca do marketplace (bloco 70, SPEC §5.2). '
  'Nasce ligada: ser encontrada é o benefício, e o dado exibido já é público.';

CREATE TABLE marketplace_listings (
  location_id       uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /** O endereço público da barbearia. É por ele que o card leva para a página. */
  slug              text NOT NULL,
  name              text NOT NULL,

  city              text,
  state             char(2),
  latitude          numeric(9, 6) NOT NULL,
  longitude         numeric(9, 6) NOT NULL,
  cover_url         text,

  /**
   * "Corte a partir de R$ 55,00" — o menor preço ativo do catálogo.
   *
   * O card da SPEC mostra o piso, e não o ticket: o piso é o que faz a pessoa
   * clicar, e é o único número de preço que não depende do que ela vai escolher.
   */
  price_from_cents  integer,

  /**
   * A nota **pública**, em pontos-base, e a contagem ao lado.
   *
   * Pontos-base inteiros (4900 = 4,90) como toda fração deste código. Nula
   * abaixo do mínimo: *"5,0 de uma avaliação é ruído estatístico com cara de
   * excelência"* — a mesma regra da página pública, e quem a aplica é
   * `resumoPublico`, em `packages/core`.
   */
  rating_bps        integer CHECK (rating_bps IS NULL OR rating_bps BETWEEN 100 AND 500),
  rating_count      integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0),

  /** Filtros do card, copiados do cadastro que já é público. */
  amenities         text[] NOT NULL DEFAULT '{}',
  has_club          boolean NOT NULL DEFAULT false,

  /**
   * Quando esta linha foi refeita.
   *
   * Obrigatório porque a linha é **cópia**: sem o carimbo não há como saber se
   * a faixa de preço da vitrine é a de hoje ou a de março, e uma vitrine que
   * mente sobre preço é pior que uma vitrine vazia.
   */
  refreshed_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketplace_listings_preco_nao_negativo
    CHECK (price_from_cents IS NULL OR price_from_cents >= 0),

  /**
   * A foto sai daqui para um `src` numa página anônima e de muito tráfego, e um
   * dia sairá para `og:image` — onde um esquema que não seja `https` deixa de
   * ser inerte. A aplicação já filtra na escrita e na leitura; esta é a camada
   * que não depende de ninguém lembrar.
   */
  CONSTRAINT marketplace_listings_foto_https
    CHECK (cover_url IS NULL OR cover_url LIKE 'https://%')
);

-- A busca é sempre "perto de mim": o recorte grosseiro por caixa de coordenadas
-- vem antes da distância exata, e é ele que precisa de índice.
CREATE INDEX marketplace_listings_por_coordenada
  ON marketplace_listings (latitude, longitude);
CREATE INDEX marketplace_listings_por_cidade ON marketplace_listings (state, city);

/**
 * Sem RLS, de propósito — ver o cabeçalho.
 *
 * A garantia aqui não é a política: é o **conteúdo**. Toda coluna desta tabela
 * já é lida por qualquer visitante na página da barbearia, e nenhuma delas
 * alcança cliente, agenda ou dinheiro.
 */
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_listings TO barbearia_app;

COMMENT ON TABLE marketplace_listings IS
  'Vitrine do marketplace (bloco 70, SPEC §5.2). Sem RLS de propósito: a busca '
  'atravessa barbearias e roda antes de existir tenant no contexto, como '
  'tenant_slugs e tenant_platform. Só contém dado que a página pública já '
  'mostra; é cópia derivada, e refreshed_at diz de quando ela é.';
