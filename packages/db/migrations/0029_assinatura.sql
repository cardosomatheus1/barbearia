-- ============================================================================
-- 0029 — Assinatura da barbearia: planos de verdade, trial e teto de cadeiras
--        (bloco 27, SPEC §9 e §9.1)
--
-- O bloco 24 semeou três planos inventados — cortesia, essencial, completo —
-- para que a troca de plano tivesse o que trocar. Eles cumpriram o papel e não
-- são o produto: a SPEC §9 tem quatro faixas com público declarado, e a âncora
-- de preço do Pro (R$ 79–110/mês) sai da análise de concorrência do §2.4.
--
-- ## Por que os antigos são desativados e não apagados
--
-- `plans` tem `ON DELETE RESTRICT` de propósito: apagar plano com barbearia
-- dentro reescreveria o histórico de quanto ela pagava. Desativar é a operação
-- que o bloco 24 desenhou para exatamente isto — o plano some da oferta e
-- continua valendo para quem está nele.
--
-- ## O que este bloco resolve, e que as duas lacunas declaradas cobravam
--
-- 1. **Teto de cadeiras aplicado.** `max_chairs` existia desde o bloco 24 e não
--    recusava nada. A regra passa a ser do **banco**, por gatilho, e não de um
--    caso de uso: cadeira nasce em três caminhos (onboarding, cadastro do
--    admin, religar quem estava desligado), e uma regra escrita em um deles é
--    uma regra que os outros dois furam.
--
-- 2. **Recurso amarrado ao plano.** Sem isto, "Starter" e "Business" custavam
--    diferente e entregavam a mesma coisa — o que faz o plano de cima não ter
--    argumento e o de baixo não ter limite.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O catálogo cresce
-- ---------------------------------------------------------------------------

ALTER TABLE plans
  /** Para quem é, na linguagem da SPEC §9: "barbeiro individual", "rede". */
  ADD COLUMN audience   text NOT NULL DEFAULT '',
  /**
   * Dias de teste do plano.
   *
   * Por plano, e não uma constante: o Enterprise não é vendido por
   * autoatendimento — quem chega nele veio de uma conversa, e um contador de
   * catorze dias correndo por baixo dessa conversa só produz bloqueio no meio
   * de uma negociação.
   */
  ADD COLUMN trial_days integer NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
  /**
   * O plano em que a barbearia nova entra.
   *
   * Exatamente um, garantido por índice parcial: zero deixaria toda conta nova
   * sem assinatura, e dois fariam a escolha depender da ordem da consulta.
   */
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX plans_um_padrao ON plans ((true)) WHERE is_default;

-- Os três do bloco 24 saem da oferta. Quem estiver neles continua neles.
UPDATE plans SET active = false WHERE code IN ('cortesia', 'essencial', 'completo');

/**
 * As quatro faixas da SPEC §9.
 *
 * O Pro nasce em R$ 99,00 porque a âncora do §2.4 é a faixa R$ 79–110 do
 * AppBarber para 2–5 profissionais, e é ele o plano que disputa a barbearia de
 * duas cadeiras — a que o §2.4 mede em "~1,5 corte por mês".
 *
 * O Enterprise entra com preço zero e **não** é o padrão: preço zero aqui não é
 * de graça, é "não tem preço de tabela". Ele existe no catálogo para que uma
 * franquia possa ser colocada nele pelo Super Admin depois da conversa; vender
 * franquia por autoatendimento não é uma decisão de schema.
 */
INSERT INTO plans (code, name, audience, price_cents, max_chairs, trial_days, is_default) VALUES
  ('starter',    'Starter',    'Barbeiro individual',  4900,   1,   14, false),
  ('pro',        'Pro',        'Barbearias',           9900,   5,   14, true),
  ('business',   'Business',   'Redes',               24900,  20,   14, false),
  ('enterprise', 'Enterprise', 'Franquias',               0,  NULL,  0, false)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- O que cada plano inclui
-- ---------------------------------------------------------------------------

/**
 * O recurso pertence ao plano; a exceção por barbearia continua vencendo.
 *
 * Três níveis, e cada um responde uma pergunta diferente:
 *
 * - `feature_flags.default_enabled` — o recurso é ligado para quem o plano não
 *   menciona? É o padrão de fábrica, e continua valendo.
 * - `plan_features` — o plano inclui? É o que dá conteúdo à tabela de preços.
 * - `tenant_features` — decidimos algo específico para **esta** conta? Vence os
 *   dois, e é como o suporte concede uma cortesia sem mudar o plano de ninguém.
 *
 * A ordem não é arbitrária: do geral para o particular, e o particular ganha.
 */
CREATE TABLE plan_features (
  plan_code text NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  flag_code text NOT NULL REFERENCES feature_flags(code) ON DELETE CASCADE,
  PRIMARY KEY (plan_code, flag_code)
);

ALTER TABLE plan_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_features FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_features_leitura ON plan_features FOR SELECT USING (true);
CREATE POLICY plan_features_escrita ON plan_features FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

/**
 * O Starter é o barbeiro sozinho: agenda, cliente, agendamento online e caixa
 * simples (SPEC §9). Fila de espera e importação de base são operação de casa
 * com mais de uma cadeira; aviso automático custa mensagem por disparo e é o
 * que o §9.1 vende como pacote.
 */
INSERT INTO plan_features (plan_code, flag_code) VALUES
  ('pro', 'fila'), ('pro', 'importacao'), ('pro', 'avisos'),
  ('business', 'fila'), ('business', 'importacao'), ('business', 'avisos'),
  ('enterprise', 'fila'), ('enterprise', 'importacao'), ('enterprise', 'avisos')
ON CONFLICT DO NOTHING;

-- O Starter não recebe linha nenhuma, e isso **é** a informação: sem menção do
-- plano, o recurso cai no padrão de fábrica. Por isso os três nascem desligados
-- por padrão a partir daqui — antes disso ligado era o certo, porque não havia
-- plano para dizer o contrário.
UPDATE feature_flags SET default_enabled = false WHERE code IN ('fila', 'importacao', 'avisos');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON plan_features TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A assinatura
-- ---------------------------------------------------------------------------

/**
 * `trialing` é conta nova dentro do prazo; `active` já pagou pelo menos uma
 * vez; `past_due` venceu e ainda está na régua de cobrança (bloco 28);
 * `canceled` saiu.
 *
 * `past_due` **não** é bloqueio. Bloqueio é `tenant_platform.blocked_at`, que
 * tira a barbearia do ar, e essa decisão é da régua — não do vencimento. A
 * confusão entre os dois é o que produz o sistema que corta o acesso do cliente
 * no dia seguinte ao boleto atrasado.
 */
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled');

CREATE TABLE subscriptions (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code     text NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,
  status        subscription_status NOT NULL DEFAULT 'trialing',

  /**
   * O preço **contratado**, congelado em centavos.
   *
   * Mesma decisão da comissão (bloco 19): o lançamento guarda a regra copiada.
   * Reajustar a tabela não pode mudar o que uma barbearia já contratada paga
   * sem alguém decidir isso — e, quando decidir, decide por barbearia.
   */
  price_cents   integer NOT NULL CHECK (price_cents >= 0),

  trial_ends_at timestamptz,
  /** A janela que está sendo paga agora. É ela que a fatura do bloco 28 fecha. */
  period_start  timestamptz NOT NULL DEFAULT now(),
  period_end    timestamptz NOT NULL,

  canceled_at   timestamptz,
  cancel_reason text,

  /**
   * Quantas cadeiras a barbearia ocupa hoje.
   *
   * Derivado e guardado, e não contado na hora — e o motivo não é desempenho:
   * `professionals` tem RLS, e a plataforma lê **sem tenant**. Uma subconsulta
   * daqui devolveria zero sempre, em silêncio, e a tela do plano diria "0 de 5
   * cadeiras" para uma barbearia lotada. A primeira versão deste bloco fez
   * exatamente isso e o teste de integração pegou.
   *
   * Quem mantém é o gatilho abaixo, na mesma transação que mexe na cadeira.
   */
  chairs_in_use integer NOT NULL DEFAULT 0 CHECK (chairs_in_use >= 0),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assinatura_periodo_valido CHECK (period_end > period_start),
  CONSTRAINT assinatura_trial_coerente CHECK (
    (status = 'trialing' AND trial_ends_at IS NOT NULL) OR status <> 'trialing'
  ),
  CONSTRAINT assinatura_cancelamento_coerente CHECK (
    (status = 'canceled' AND canceled_at IS NOT NULL)
    OR (status <> 'canceled' AND canceled_at IS NULL)
  )
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
-- Leitura ampla: a própria barbearia precisa saber em que plano está e até
-- quando vai o teste. Não há dado de pessoa aqui — plano, preço e datas.
CREATE POLICY subscriptions_leitura ON subscriptions FOR SELECT USING (true);
CREATE POLICY subscriptions_escrita ON subscriptions FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

-- A varredura da régua (bloco 28) pergunta "quem vence antes de tal instante?".
CREATE INDEX subscriptions_por_vencimento ON subscriptions (period_end)
  WHERE status IN ('trialing', 'active', 'past_due');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO barbearia_app;
  END IF;
END $$;

/**
 * Barbearia nova nasce em teste, pelo banco.
 *
 * Mesmo motivo do espelho do bloco 24 e do ciclo de vida do 25: se dependesse
 * de a aplicação lembrar, o primeiro caminho que criasse tenant fora do lugar
 * certo produziria uma barbearia sem assinatura — que não é "de graça", é
 * "invisível para a cobrança". O tipo de erro que só aparece no fim do mês.
 *
 * `SECURITY DEFINER` pelo mesmo motivo do contador de cadeiras: o cadastro roda
 * **dentro** do tenant (`signUpOwner` abre `withTenant` antes de inserir em
 * `tenants`), e a política de escrita de `subscriptions` exige conexão sem
 * tenant — para que a barbearia não troque o próprio plano. Sem isto, criar
 * conta responde 500 com "new row violates row-level security policy", que foi
 * exatamente o que a suíte de equipe acusou.
 *
 * O alcance continua contido: sem parâmetro, alvo tirado da linha que disparou
 * o gatilho, e `search_path` vazio com tudo qualificado (ver a nota em
 * `atualizar_cadeiras_em_uso`, que vale para as duas).
 */
CREATE OR REPLACE FUNCTION iniciar_assinatura_em_teste() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE padrao public.plans%ROWTYPE;
BEGIN
  SELECT * INTO padrao FROM public.plans WHERE is_default LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nenhum plano padrão definido; barbearia não pode nascer sem assinatura';
  END IF;

  INSERT INTO public.subscriptions (tenant_id, plan_code, status, price_cents,
                             trial_ends_at, period_start, period_end)
  VALUES (
    NEW.id, padrao.code, 'trialing', padrao.price_cents,
    now() + make_interval(days => padrao.trial_days),
    now(),
    now() + make_interval(days => padrao.trial_days)
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  RETURN NEW;
END $$;

CREATE TRIGGER tenants_inicia_assinatura
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION iniciar_assinatura_em_teste();

-- As barbearias que já existem entram em teste a partir de agora. Elas não
-- tiveram teste nenhum até aqui, e começar cobrando quem já estava dentro seria
-- mudar o contrato pelo lado de dentro.
INSERT INTO subscriptions (tenant_id, plan_code, status, price_cents,
                           trial_ends_at, period_start, period_end)
SELECT t.id, p.code, 'trialing', p.price_cents,
       now() + make_interval(days => p.trial_days),
       now(),
       now() + make_interval(days => p.trial_days)
FROM tenants t CROSS JOIN plans p
WHERE p.is_default
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- O teto de cadeiras, imposto pelo banco
-- ---------------------------------------------------------------------------

/**
 * Por que gatilho e não caso de uso.
 *
 * Cadeira nasce em três caminhos — o onboarding (que substitui o conjunto
 * inteiro), o cadastro do admin e o religar de quem estava desligado — e vai
 * nascer num quarto no dia em que existir importação de equipe. Uma regra
 * escrita em um deles é uma regra que os outros furam, e o furo aparece como
 * "essa barbearia tem oito cadeiras num plano de cinco" no fechamento do mês.
 *
 * É a mesma escolha da constraint anti-overbooking: garantia que o produto
 * inteiro herda sem ninguém pedir.
 *
 * **Conta só `kind = 'professional'` e ativo.** Balcão e recurso (`counter`,
 * `resource_only`) não são cadeira que atende — cobrar por eles seria cobrar
 * pela recepção. E o desligado não ocupa vaga: é assim que a barbearia troca de
 * barbeiro sem estourar o plano.
 *
 * Esta **não** é `SECURITY DEFINER` — ela só lê, e lê o que o invocador já
 * enxerga. Mesmo assim vai de `search_path = ''` qualificado, pelo motivo
 * explicado em `atualizar_cadeiras_em_uso`: aqui o sequestro não daria poder de
 * dono, mas uma `subscriptions` temporária vazia faria `teto` sair nulo e o
 * teto do plano simplesmente sumir. O controle é de cobrança; furá-lo não
 * precisa ser escalada de privilégio para custar dinheiro.
 */
CREATE OR REPLACE FUNCTION conferir_teto_de_cadeiras() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE teto integer; ocupadas integer; plano text;
BEGIN
  IF NEW.kind <> 'professional' OR NOT NEW.active THEN
    RETURN NEW;
  END IF;

  SELECT p.max_chairs, p.name INTO teto, plano
    FROM public.subscriptions s JOIN public.plans p ON p.code = s.plan_code
   WHERE s.tenant_id = NEW.tenant_id;

  -- Sem assinatura ou sem teto declarado, não há o que conferir. Recusar aqui
  -- transformaria uma barbearia sem plano em barbearia que não cadastra
  -- ninguém, e quem decide plano é a plataforma, não o cadastro.
  IF teto IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO ocupadas FROM public.professionals
   WHERE tenant_id = NEW.tenant_id AND kind = 'professional' AND active
     AND id <> NEW.id;

  IF ocupadas >= teto THEN
    RAISE EXCEPTION 'o plano % permite % cadeira(s) e a barbearia já tem %',
      plano, teto, ocupadas
      USING ERRCODE = 'check_violation', CONSTRAINT = 'plano_tem_teto_de_cadeiras';
  END IF;

  RETURN NEW;
END $$;

/**
 * Mantém a contagem de cadeiras que a plataforma lê.
 *
 * `SECURITY DEFINER` de propósito. Ela roda dentro da transação da
 * **barbearia** (que tem `app.tenant_id` fixado) e precisa escrever em
 * `subscriptions`, cuja política de escrita exige o contrário — conexão sem
 * tenant. Relaxar essa política para o próprio tenant seria abrir a troca de
 * plano para quem paga por ele.
 *
 * O poder é contido por construção: a função não recebe parâmetro, o alvo sai
 * do `tenant_id` da própria linha que disparou o gatilho, e a única coluna que
 * ela toca é a que ela recalcula.
 *
 * ## `search_path = ''`, e não `= public`
 *
 * A primeira versão escrevia `SET search_path = public` e o comentário dizia
 * que isso fechava o sequestro. **Não fecha.** `search_path` sem `pg_temp`
 * escrito não tira o esquema temporário do caminho: o Postgres o procura
 * **antes** de tudo quando ele não é nomeado, e a isenção vale só para função e
 * operador — nome de tabela continua sequestrável. Como `barbearia_app` pode
 * criar tabela temporária (é privilégio padrão de qualquer role), um
 * `CREATE TEMP TABLE subscriptions (...)` na sessão dela faria esta função —
 * que roda como dono do banco — escrever na tabela do atacante, e o mesmo vale
 * para `professionals` na subconsulta.
 *
 * Com `''` não sobra caminho nenhum a sequestrar: todo nome de relação é
 * qualificado, e `pg_catalog` continua implícito para `count`, `now` e os
 * tipos. É por isso que não há `REVOKE TEMPORARY` no bootstrap do role —
 * tirar a temporária seria remendo do lado errado, e a temporária tem uso
 * legítimo em manutenção.
 */
CREATE OR REPLACE FUNCTION atualizar_cadeiras_em_uso() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE alvo uuid;
BEGIN
  alvo := COALESCE(NEW.tenant_id, OLD.tenant_id);

  UPDATE public.subscriptions
     SET chairs_in_use = (
           SELECT count(*) FROM public.professionals
            WHERE tenant_id = alvo AND kind = 'professional' AND active
         )
   WHERE tenant_id = alvo;

  RETURN NULL;
END $$;

/**
 * Ninguém chama estas duas fora do gatilho.
 *
 * `EXECUTE` nasce liberado para `PUBLIC` em toda função nova, e função
 * `SECURITY DEFINER` liberada é convite: `SELECT atualizar_cadeiras_em_uso()`
 * chamado à mão roda como dono do banco. O gatilho continua disparando — a
 * permissão de executar é conferida em `CREATE TRIGGER`, não a cada disparo.
 */
REVOKE EXECUTE ON FUNCTION iniciar_assinatura_em_teste() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION atualizar_cadeiras_em_uso() FROM PUBLIC;

CREATE TRIGGER professionals_conta_cadeiras
AFTER INSERT OR UPDATE OF active, kind OR DELETE ON professionals
FOR EACH ROW EXECUTE FUNCTION atualizar_cadeiras_em_uso();

-- As barbearias que já existem entram com a contagem certa.
UPDATE subscriptions s SET chairs_in_use = (
  SELECT count(*) FROM professionals p
   WHERE p.tenant_id = s.tenant_id AND p.kind = 'professional' AND p.active
);

/**
 * `INSERT OR UPDATE`, e o UPDATE importa tanto quanto.
 *
 * Sem ele, a barbearia de cinco cadeiras desliga uma, cadastra duas e religa a
 * antiga — sete cadeiras num plano de cinco, sem nunca ter passado por um
 * INSERT que estourasse o teto.
 */
CREATE TRIGGER professionals_confere_teto
BEFORE INSERT OR UPDATE OF active, kind ON professionals
FOR EACH ROW EXECUTE FUNCTION conferir_teto_de_cadeiras();
