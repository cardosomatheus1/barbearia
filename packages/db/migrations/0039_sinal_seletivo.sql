-- ============================================================================
-- 0039 — Sinal seletivo e política de reembolso (bloco 37, SPEC §2.12 e §2.13)
--
-- ## As duas colunas que já existiam e ninguém preenchia
--
-- `appointments.deposit_required_cents` e `deposit_paid_cents` nasceram na
-- migração **0001** e atravessaram trinta e seis blocos sem um único `UPDATE`.
-- O motor aceitava sinal e nada no produto sabia decidir se ele era devido, de
-- quanto era, ou o que fazer com ele num cancelamento — é o defeito de `blocks`
-- outra vez, e este bloco é o que finalmente lhes dá origem.
--
-- ## O carimbo que faltava
--
-- O score de confiabilidade separa quem cancelou com antecedência de quem
-- cancelou em cima da hora, e essa é a distinção mais importante dele: um
-- cancelamento avisado devolve a vaga para a grade, e punir quem avisa ensina a
-- não avisar. Só que **não havia como saber quando o cancelamento aconteceu**.
-- `updated_at` não serve: qualquer edição posterior o move.
--
-- `cancelled_at` fica nulo nos agendamentos anteriores a esta migração, e isso é
-- tratado como "não sei", nunca como "cancelou em cima". Reter o dinheiro de
-- alguém por causa de um registro que a casa não fez seria cobrar pelo próprio
-- buraco.
--
-- ## Por que a política mora em `locations`
--
-- Pelo mesmo motivo de `cancel_min_hours` (migração 0008): quem tem duas
-- unidades tem dois movimentos e duas realidades de falta. A do centro, cheia no
-- sábado, cobra sinal; a do bairro, não.
--
-- ## Por que o prazo de reembolso é separado do de cancelamento
--
-- São perguntas diferentes. `cancel_min_hours` diz se o cliente **pode**
-- desmarcar; `deposit_refund_hours` diz se ele leva o dinheiro de volta. Uma
-- barbearia pode aceitar cancelamento até uma hora antes e ainda assim reter o
-- sinal de quem desmarca em cima — e é justamente essa combinação que faz o
-- sinal funcionar sem transformar cancelamento em briga.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Quando o cancelamento aconteceu
-- ---------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN cancelled_at timestamptz;

COMMENT ON COLUMN appointments.cancelled_at IS
  'Instante do cancelamento. Base da antecedência no score de confiabilidade e '
  'na decisão de reembolso do sinal. Nulo em agendamento anterior à migração '
  '0039 e em agendamento que não foi cancelado — nos dois casos vale "não sei", '
  'e "não sei" devolve o sinal.';

-- Só quem está cancelado carrega o carimbo, e todo cancelado a partir daqui o
-- carrega. Sem esta CHECK, um `UPDATE status` esquecendo a coluna produziria
-- cancelamento sem antecedência conhecida em cima de dado novo — e o buraco
-- passaria por "agendamento antigo" para sempre.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_cancelled_at_so_em_cancelado
    CHECK (cancelled_at IS NULL OR status IN ('cancelled_customer', 'cancelled_business'));

-- ---------------------------------------------------------------------------
-- A política da unidade
-- ---------------------------------------------------------------------------

CREATE TYPE deposit_mode AS ENUM ('nenhum', 'fixo', 'percentual', 'total');

ALTER TABLE locations
  -- `nenhum` é o padrão, e é o comportamento anterior: nenhuma barbearia já
  -- instalada passa a cobrar sinal por causa de uma migração. A regra do
  -- CLAUDE.md sobre configuração que mexe em dinheiro vale aqui inteira.
  ADD COLUMN deposit_mode deposit_mode NOT NULL DEFAULT 'nenhum',
  ADD COLUMN deposit_fixed_cents integer NOT NULL DEFAULT 0,
  -- Pontos-base, como toda alíquota deste produto: 3000 = 30%.
  ADD COLUMN deposit_percent_bps integer NOT NULL DEFAULT 0,
  -- Abaixo deste score o sinal passa a ser exigido. O padrão é o da SPEC §2.13,
  -- e ele só significa alguma coisa por causa da escala documentada em
  -- `packages/core/src/confiabilidade.ts`: com os pesos literais do texto da
  -- SPEC o pior cliente possível fica em 75, e este limiar nunca dispararia.
  ADD COLUMN deposit_score_threshold smallint NOT NULL DEFAULT 60,
  -- Ticket acima do qual o sinal é exigido de qualquer um. Zero desliga o termo.
  ADD COLUMN deposit_ticket_over_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN deposit_refund_hours smallint NOT NULL DEFAULT 24,

  ADD CONSTRAINT locations_deposit_sane
    CHECK (deposit_fixed_cents >= 0
           AND deposit_percent_bps BETWEEN 0 AND 10000
           AND deposit_score_threshold BETWEEN 0 AND 100
           AND deposit_ticket_over_cents >= 0
           AND deposit_refund_hours BETWEEN 0 AND 720),

  -- Modalidade sem o valor que ela usa é sinal de zero real cobrado num
  -- agendamento que a tela disse que exigia pagamento. O banco recusa a
  -- combinação em vez de deixá-la virar um QR Code de R$ 0,00.
  ADD CONSTRAINT locations_deposit_tem_valor
    CHECK (deposit_mode <> 'fixo' OR deposit_fixed_cents > 0),
  ADD CONSTRAINT locations_deposit_tem_percentual
    CHECK (deposit_mode <> 'percentual' OR deposit_percent_bps > 0);

-- ---------------------------------------------------------------------------
-- O serviço que sempre exige
-- ---------------------------------------------------------------------------

ALTER TABLE services
  -- O quarto termo da SPEC §2.12. Existe para o serviço caro e demorado — a
  -- coloração de três horas — em que a falta custa a tarde inteira,
  -- independentemente de quem faltou.
  ADD COLUMN always_require_deposit boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- O override do gerente (SPEC §2.13, regra de justiça 7)
-- ---------------------------------------------------------------------------

ALTER TABLE customers
  -- Quando presente, substitui o score calculado. É a válvula para o caso que a
  -- fórmula não vê: o cliente que faltou três vezes por causa de uma internação,
  -- e o que tem histórico impecável e sumiu com a chave da barbearia.
  ADD COLUMN reliability_override smallint,
  ADD COLUMN reliability_override_reason text,
  ADD COLUMN reliability_override_at timestamptz,

  ADD CONSTRAINT customers_reliability_override_range
    CHECK (reliability_override IS NULL OR reliability_override BETWEEN 0 AND 100),

  -- Override sem motivo escrito é um número que ninguém consegue defender seis
  -- meses depois — e a SPEC pede justificativa auditada, não só auditoria. A
  -- CHECK cobra o motivo no banco; a trilha registra quem fez.
  ADD CONSTRAINT customers_reliability_override_tem_motivo
    CHECK (reliability_override IS NULL
           OR (reliability_override_reason IS NOT NULL
               AND length(btrim(reliability_override_reason)) >= 10
               AND reliability_override_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Índice
-- ---------------------------------------------------------------------------

-- O score varre os agendamentos de um cliente nos últimos doze meses, e é
-- consultado **na marcação** — com o cliente esperando a grade carregar. Sem
-- este índice a consulta varre a tabela inteira da barbearia.
--
-- Ele não carrega `tenant_id`: a RLS já recorta, e o par
-- (customer_id, service_starts_at) é o que a consulta usa.
CREATE INDEX appointments_historico_do_cliente_idx
  ON appointments (customer_id, service_starts_at DESC)
  WHERE customer_id IS NOT NULL;
