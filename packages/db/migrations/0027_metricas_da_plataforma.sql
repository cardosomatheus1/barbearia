-- ============================================================================
-- 0027 — Métricas globais da plataforma (bloco 25, SPEC §8 e Parte 1 §1.2)
--
-- "acompanha métricas globais, MRR, churn e pagamentos"
--
-- ## O problema, que é o mesmo do bloco 24 com outra roupa
--
-- O Super Admin precisa responder "como vai a plataforma?". As respostas —
-- ocupação, no-show, adoção do agendamento online, ticket médio — moram em
-- `appointments` e `orders`, que estão atrás da RLS e assim devem continuar.
--
-- Duas saídas erradas, e as duas já foram descartadas neste repositório:
--
-- 1. **Afrouxar a política** de `appointments`. Como nenhuma consulta do produto
--    repete `tenant_id` no `WHERE`, isso alargaria em silêncio todas elas
--    (migração 0026).
-- 2. **Varrer sem tenant no contexto.** Não funciona, e o bloco 20 já aprendeu:
--    a primeira versão da falta automática era uma varredura de plataforma e
--    devolvia zero linhas, porque `appointments` tem RLS. O teste pegou.
--
-- A saída é a terceira: **cada barbearia apura o próprio dia, por dentro do
-- próprio tenant**, e grava o resultado agregado aqui. Uma tarefa por barbearia
-- na fila do bloco 20 — o mesmo desenho da falta automática, pelo mesmo motivo.
--
-- ## Por que este agregado pode ser lido por todos
--
-- Pelo mesmo teste que `tenant_platform` passou: **não há dado de pessoa aqui**.
-- Nem nome, nem telefone, nem id de cliente, nem id de agendamento. São contagens
-- e somas do dia de uma barbearia — o mesmo tipo de informação que o dono já vê
-- no próprio painel, e que a plataforma precisa para saber quem está prestes a
-- cancelar.
--
-- O que **não** entra aqui, e é decisão e não esquecimento: nada por
-- profissional. Ranking entre barbearias já é limítrofe; ranking de pessoas
-- dentro de barbearias diferentes, visto por quem não é o empregador de nenhuma
-- delas, não tem finalidade legítima.
-- ============================================================================

CREATE TABLE tenant_metrics_daily (
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /**
   * O dia **da unidade**, não o instante UTC.
   *
   * Mesma decisão de `orders.business_day` (bloco 19): "que dia é este
   * movimento" é pergunta do fuso da barbearia. Uma barbearia em Rio Branco e
   * outra em Fernando de Noronha fecham o mesmo dia com três horas de diferença,
   * e somar por UTC misturaria as duas pontas.
   */
  business_day         date NOT NULL,

  /** Agendamentos que **começam** neste dia, qualquer que seja o desfecho. */
  appointments_total   integer NOT NULL DEFAULT 0 CHECK (appointments_total >= 0),
  /**
   * Quantos vieram do canal do cliente (site, app, WhatsApp, Instagram, Google,
   * marketplace) contra os que a recepção digitou.
   *
   * É a métrica de adoção da SPEC §8 — "% agendamentos online vs. recepção" —, e
   * é a que diz se a barbearia **usa** o produto ou só o tem.
   */
  appointments_online  integer NOT NULL DEFAULT 0 CHECK (appointments_online >= 0),
  no_shows             integer NOT NULL DEFAULT 0 CHECK (no_shows >= 0),
  cancellations        integer NOT NULL DEFAULT 0 CHECK (cancellations >= 0),
  completed            integer NOT NULL DEFAULT 0 CHECK (completed >= 0),

  /** Minutos vendidos sobre minutos de jornada: a ocupação, sem virar fração aqui. */
  minutes_sold         integer NOT NULL DEFAULT 0 CHECK (minutes_sold >= 0),
  minutes_available    integer NOT NULL DEFAULT 0 CHECK (minutes_available >= 0),

  /** Centavos inteiros, como todo dinheiro do sistema. Comandas pagas no dia. */
  revenue_cents        bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
  orders_paid          integer NOT NULL DEFAULT 0 CHECK (orders_paid >= 0),

  /** Quando a apuração rodou. Linha velha demais é sinal de worker parado. */
  computed_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, business_day)
);

ALTER TABLE tenant_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_metrics_daily FORCE ROW LEVEL SECURITY;

/**
 * Leitura ampla, escrita restrita — e as duas metades têm motivos diferentes.
 *
 * A **leitura** é `USING (true)` como em `tenant_platform`: o Super Admin
 * precisa somar todas as barbearias, e o que está aqui é agregado sem pessoa
 * dentro (o teste de invariantes recusa qualquer coluna que não seja número,
 * data ou o id da barbearia).
 *
 * A **escrita** é do próprio tenant. A primeira versão desta migração deixava
 * `WITH CHECK (true)` por simetria, e a `/security-review` apontou o que isso
 * significa: no nível do SQL, uma conexão de barbearia poderia reescrever o
 * faturamento da vizinha. Nenhum caminho do produto permite isso hoje — não há
 * SQL arbitrário em lugar nenhum —, mas a defesa que custa uma linha e não
 * depende de nenhum código continuar certo é a que se escreve.
 *
 * O único escritor é a apuração diária, que roda dentro de `withTenant` e grava
 * a própria linha: a política descreve exatamente o que ele já faz.
 */
CREATE POLICY tenant_metrics_leitura ON tenant_metrics_daily FOR SELECT USING (true);
CREATE POLICY tenant_metrics_escrita ON tenant_metrics_daily FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A consulta da plataforma é sempre "os últimos N dias, todas as barbearias".
CREATE INDEX tenant_metrics_por_dia ON tenant_metrics_daily (business_day DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_metrics_daily TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- O ciclo de vida da conta, que é de onde sai o churn
-- ---------------------------------------------------------------------------

/**
 * Por que uma tabela nova em vez de `tenant_platform.blocked_at`.
 *
 * `blocked_at` responde "está bloqueada agora?", e o desbloqueio a limpa — de
 * propósito, porque `NULL` é o que significa conta ativa. Churn não é uma
 * pergunta sobre agora: é "quantas saíram **em maio**", e a resposta precisa
 * sobreviver a uma reativação em junho.
 *
 * Também não sai de `platform_audit`. Aquela tabela é trilha, e trilha é lida
 * por gente: renomear uma ação lá é uma decisão de texto que não deveria mudar
 * um número de negócio em silêncio. Duas escritas na mesma transação custam
 * menos que essa surpresa.
 */
CREATE TYPE tenant_lifecycle_event AS ENUM ('activated', 'blocked', 'unblocked');

CREATE TABLE tenant_lifecycle (
  id          bigserial PRIMARY KEY,
  /** Sem `ON DELETE CASCADE`, como `platform_audit`: o histórico sobrevive à conta. */
  tenant_id   uuid NOT NULL,
  event       tenant_lifecycle_event NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_lifecycle FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_lifecycle_acesso ON tenant_lifecycle FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX tenant_lifecycle_por_data ON tenant_lifecycle (happened_at DESC, event);

-- Append-only pelo mesmo mecanismo da trilha: número de negócio que pode ser
-- reescrito não é número, é opinião.
REVOKE UPDATE, DELETE ON tenant_lifecycle FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON tenant_lifecycle TO barbearia_app;
    REVOKE UPDATE, DELETE ON tenant_lifecycle FROM barbearia_app;
    GRANT USAGE, SELECT ON SEQUENCE tenant_lifecycle_id_seq TO barbearia_app;
  END IF;
END $$;

/**
 * A ativação é registrada pelo banco, como o espelho do bloco 24.
 *
 * Se dependesse de a aplicação lembrar, o denominador do churn ficaria menor que
 * a realidade no primeiro caminho que criasse tenant fora do lugar certo — e um
 * churn calculado sobre um denominador incompleto é **maior** que o real, que é
 * o erro que faz alguém tomar decisão errada achando que está bem informado.
 */
CREATE OR REPLACE FUNCTION registrar_ativacao_do_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_lifecycle (tenant_id, event) VALUES (NEW.id, 'activated');
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_registra_ativacao
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION registrar_ativacao_do_tenant();

-- As barbearias que já existem entram com a data em que foram criadas, e não
-- com `now()`: pôr todas no dia da migração faria o gráfico mostrar uma safra
-- inteira nascendo hoje.
INSERT INTO tenant_lifecycle (tenant_id, event, happened_at)
SELECT id, 'activated', created_at FROM tenants;
