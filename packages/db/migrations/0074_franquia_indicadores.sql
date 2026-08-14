-- ============================================================================
-- 0074 — indicadores consolidados e metas da franquia (bloco 77)
--
-- ## A pergunta difícil do bloco: a franqueadora pode ver o faturamento?
--
-- Pode, e é a única coisa deste tipo que ela pode. Royalty é percentual sobre
-- receita, e a Lei 13.966/2019 obriga a franqueadora a declarar isso na COF —
-- receber o número de vendas é o contrato funcionando, não bisbilhotice.
--
-- O que ela **não** vê, e o schema é quem garante: cliente, telefone, ficha,
-- anotação, comanda, equipe. A RLS de cada franqueada continua inteira. O que
-- atravessa é uma **soma**, e só ela.
--
-- ## E a franqueada, vê a vizinha?
--
-- Não pela identidade. A franqueadora recebe a comparação nomeada — é o trabalho
-- dela e o direito dela; a franqueada recebe os próprios números e a **mediana
-- da rede**, sem nome nenhum. É o mesmo princípio de `SPEC §4.21`, em que o
-- indicador do barbeiro é comparado com o próprio passado e não com o colega:
-- aqui as partes são empresas concorrentes entre si na mesma marca, e uma lista
-- nomeada de faturamento alheio é informação comercial de terceiro.
--
-- A redação da identidade acontece **dentro** da função `SECURITY DEFINER`, que
-- é a fronteira; a mediana é calculada em `packages/core`, e a rota devolve só
-- o agregado. Duas camadas, e a de baixo não depende de a de cima acertar.
--
-- ## Indicador é derivado, nunca tabela
--
-- Mesma decisão do DRE, do saldo de estoque e do de fidelidade. Uma tabela de
-- indicadores da rede seria um número que alguém sobrescreve, e a pergunta que
-- chega nunca é "quanto deu", é *"por que caiu?"*. A função abaixo **carrega**;
-- quem faz conta é `packages/core`.
-- ============================================================================

/**
 * Meta de faturamento de uma franqueada, por mês.
 *
 * Mesma forma de `professional_goals` (bloco 22): por mês, nunca acumulada, sem
 * renovação automática. Meta não é preço — combinar um alvo de vendas é o
 * contrato de franquia; dizer por quanto vender é que não (Lei 12.529/2011,
 * art. 36 §3º IX).
 */
CREATE TABLE franchise_goals (
  franchise_id  uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month         date NOT NULL,
  revenue_cents bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month),
  CONSTRAINT franchise_goals_mes_no_dia_um CHECK (date_trunc('month', month) = month),
  CONSTRAINT franchise_goals_valor_sano CHECK (revenue_cents > 0)
);

CREATE INDEX franchise_goals_por_franquia ON franchise_goals (franchise_id, month);

/**
 * Leitura: a franqueada vê a **dela**; a franqueadora vê as da rede.
 *
 * Sem o segundo ramo a franqueadora abriria a tela vazia; sem o primeiro a
 * franqueada não saberia o alvo combinado com ela — que é a única coisa que
 * torna a meta uma meta e não um relatório interno de outra empresa.
 *
 * Escrita: só a franqueadora, e quem impõe é a política. Uma checagem de rota
 * seria a garantia dependendo de alguém lembrar dela na próxima.
 */
ALTER TABLE franchise_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchise_goals FORCE ROW LEVEL SECURITY;

CREATE POLICY franchise_goals_leitura ON franchise_goals FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  OR (franchise_id = franquia_do_contexto() AND papel_na_franquia() = 'franqueadora')
);
CREATE POLICY franchise_goals_escrita ON franchise_goals FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR (franchise_id = franquia_do_contexto() AND papel_na_franquia() = 'franqueadora')
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR (franchise_id = franquia_do_contexto() AND papel_na_franquia() = 'franqueadora')
  );

COMMENT ON TABLE franchise_goals IS
  'Meta de faturamento combinada entre franqueadora e franqueada (bloco 77). '
  'Por mes, congelada, sem renovacao automatica — como professional_goals.';

/**
 * Os números de cada franqueada num período.
 *
 * `SECURITY DEFINER` porque ela **precisa** atravessar a RLS de cada franqueada
 * — é a única coisa neste produto que faz isso de propósito, e por isso o filtro
 * está escrito dentro, como manda a convenção: a função roda como dono e a row
 * security não vale para ela.
 *
 * Três guardas, todas aqui dentro:
 *
 * 1. Só devolve linha de quem está **nesta** franquia, e a franquia é a do
 *    contexto — o parâmetro não escolhe: um id de franquia vindo da requisição
 *    seria o relatório da rede concorrente.
 * 2. Sem tenant no contexto não devolve nada. A plataforma não lê faturamento
 *    de barbearia por esta porta, e é a mesma postura de `tenant_platform`.
 * 3. **A identidade é redigida** quando quem pergunta é franqueada: o nome e o
 *    id saem nulos para todo mundo menos ela própria. A conta da mediana é de
 *    `packages/core`, e ela não precisa saber de quem é cada número.
 *
 * Ela carrega e não decide: soma, conta e devolve. Ticket médio, variação,
 * progresso da meta e mediana são regra de negócio, e regra de negócio não mora
 * em SQL.
 */
CREATE FUNCTION indicadores_da_franquia(p_de date, p_ate date)
RETURNS TABLE (
  tenant_id       uuid,
  nome            text,
  eu              boolean,
  receita_cents   bigint,
  vendas          bigint,
  atendimentos    bigint,
  meta_cents      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_eu uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_franquia uuid;
  v_papel franchise_role;
BEGIN
  IF v_eu IS NULL THEN RETURN; END IF;

  SELECT ft.franchise_id, ft.role INTO v_franquia, v_papel
    FROM public.franchise_tenants ft WHERE ft.tenant_id = v_eu;
  IF v_franquia IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    CASE WHEN v_papel = 'franqueadora' OR ft.tenant_id = v_eu THEN ft.tenant_id END,
    CASE WHEN v_papel = 'franqueadora' OR ft.tenant_id = v_eu THEN tp.name END,
    ft.tenant_id = v_eu,
    coalesce(v.receita, 0)::bigint,
    coalesce(v.vendas, 0)::bigint,
    coalesce(a.atendimentos, 0)::bigint,
    g.revenue_cents
  FROM public.franchise_tenants ft
  JOIN public.tenant_platform tp ON tp.tenant_id = ft.tenant_id
  LEFT JOIN LATERAL (
    SELECT sum(o.total_cents) AS receita, count(*) AS vendas
      FROM public.orders o
     WHERE o.tenant_id = ft.tenant_id
       AND o.status = 'paid'
       AND o.business_day >= p_de AND o.business_day <= p_ate
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS atendimentos
      FROM public.appointments ap
     WHERE ap.tenant_id = ft.tenant_id
       AND ap.status = 'completed'
       AND ap.starts_at >= p_de::timestamptz
       AND ap.starts_at < (p_ate + 1)::timestamptz
  ) a ON true
  LEFT JOIN public.franchise_goals g
         ON g.tenant_id = ft.tenant_id AND g.month = date_trunc('month', p_de)::date
  WHERE ft.franchise_id = v_franquia
    AND ft.role = 'franqueada'
  ORDER BY coalesce(v.receita, 0) DESC, ft.tenant_id;
END $$;

COMMENT ON FUNCTION indicadores_da_franquia(date, date) IS
  'Soma por franqueada, atravessando a RLS de proposito e com o filtro escrito '
  'dentro. Redige nome e id quando quem pergunta e franqueada: a mediana da '
  'rede nao precisa saber de quem e cada numero.';

REVOKE ALL ON FUNCTION indicadores_da_franquia(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION indicadores_da_franquia(date, date) TO barbearia_app;
