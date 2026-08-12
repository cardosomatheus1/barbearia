-- ============================================================================
-- 0059 — marketing automation (bloco 56, SPEC §4.11)
--
-- *"Motor baseado em eventos, não em listas estáticas."* É a primeira linha da
-- seção, e é a decisão inteira: uma lista estática envelhece no dia seguinte ao
-- de ser montada, e quem a monta precisa lembrar de montá-la de novo.
--
-- ## O que já existia, e por isso não está aqui
--
-- Teto de mensagens, opt-out, janela de silêncio e "lembrete cuja hora já
-- passou não sai" moram em `packages/core/src/notificacao.ts` desde o bloco 20,
-- com teste. Este bloco **não os reimplementa** — ele os chama. Reimplementar
-- seria a forma mais rápida de ter duas regras de silêncio discordando.
--
-- ## Os dois números que a SPEC exige e não existiam
--
-- *"Toda automação declara o objetivo mensurável. Sem isso não há como desligar
-- o que não funciona."* Uma automação sem objetivo é uma mensagem que ninguém
-- consegue defender nem matar: ela some no meio do custo e fica ligada para
-- sempre. Aqui o objetivo é coluna, e o desfecho de cada disparo também.
--
-- ## A deduplicação é do dia, não da regra
--
-- *"Cliente não recebe duas campanhas no mesmo dia."* Se fosse por regra, cinco
-- automações razoáveis mandariam cinco mensagens na terça — cada uma correta
-- sozinha, e o conjunto sendo spam. O índice é por cliente e por dia.
-- ============================================================================

/**
 * Os gatilhos da SPEC §4.11.
 *
 * Lista fechada e não texto livre: cada um é um fato que o produto **sabe**
 * reconhecer, e um gatilho que ninguém dispara é uma opção na tela que não
 * funciona. Os que dependem de dado que ainda não existe ficam de fora, e a
 * lacuna diz qual bloco os traz.
 */
CREATE TYPE automation_trigger AS ENUM (
  'primeiro_atendimento',
  'aniversario',
  'sem_retorno',
  'assinatura_vencendo',
  'pacote_acabando',
  'cancelamento',
  'avaliacao_positiva',
  'avaliacao_negativa',
  'servico_realizado',
  'produto_comprado',
  'vaga_na_espera'
);

/**
 * O que a automação promete produzir, e em quanto tempo.
 *
 * É o que separa "mandamos duzentas mensagens" de "isto funciona". Sem ele, a
 * única pergunta respondível seria o custo — e o custo sozinho sempre manda
 * desligar tudo.
 */
CREATE TYPE automation_goal AS ENUM (
  'agendamento',
  'venda',
  'avaliacao'
);

CREATE TABLE automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name            text NOT NULL,
  trigger         automation_trigger NOT NULL,

  /**
   * A condição do gatilho, em dias.
   *
   * `sem_retorno` precisa de "quantos dias"; `aniversario`, de "quantos dias
   * antes"; `pacote_acabando`, de "quantas unidades" — que também é um número.
   * Uma coluna só, com significado por gatilho, em vez de um `jsonb` que a tela
   * teria que saber montar: o que muda entre gatilhos é o rótulo, não a forma.
   */
  threshold       integer,

  /**
   * Quanto esperar depois do fato.
   *
   * Zero é legítimo e comum. O atraso existe porque mensagem no instante do
   * fato às vezes é pior: "como foi seu atendimento?" mandado enquanto a pessoa
   * ainda está pagando não é pesquisa, é constrangimento.
   */
  delay_minutes   integer NOT NULL DEFAULT 0,

  /**
   * O conteúdo, pelo tipo de aviso que já existe.
   *
   * Não é texto aqui: o texto mora no template aprovado pela Meta (bloco 55),
   * e escrevê-lo de novo nesta tabela criaria duas fontes para a mesma frase.
   */
  kind            notification_kind NOT NULL,

  goal            automation_goal NOT NULL,
  /** A janela em que o objetivo conta. Fora dela, o crédito não é desta. */
  goal_window_days integer NOT NULL DEFAULT 7,

  active          boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT automations_nome_nao_vazio CHECK (length(btrim(name)) > 0),
  CONSTRAINT automations_atraso_nao_negativo CHECK (delay_minutes >= 0),
  /**
   * A janela do objetivo tem teto, e as duas pontas importam.
   *
   * Zero faria o objetivo nunca ser alcançável — a automação nasceria morta com
   * cara de ligada. E uma janela de dois anos daria crédito a esta mensagem por
   * um corte que a pessoa marcaria de qualquer jeito: atribuição frouxa é pior
   * que atribuição nenhuma, porque tem número.
   */
  CONSTRAINT automations_janela_util CHECK (goal_window_days BETWEEN 1 AND 90),
  CONSTRAINT automations_limiar_positivo CHECK (threshold IS NULL OR threshold > 0)
);

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX automations_ativas_idx ON automations (tenant_id, trigger) WHERE active;

/**
 * Cada disparo, com o desfecho.
 *
 * Tabela e não contador, pela razão de sempre neste schema: a pergunta que
 * chega não é "quantas saíram", é *"por que esta não saiu?"* e *"esta trouxe
 * alguém de volta?"*. Um contador responde a primeira e nenhuma das outras
 * duas.
 */
CREATE TABLE automation_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,

  /**
   * O fato que disparou, do jeito que ele é único.
   *
   * Para `aniversario` é o ano; para `sem_retorno`, a data da última visita;
   * para `servico_realizado`, o id da comanda. É o que impede a mesma automação
   * de disparar de novo sobre o mesmo fato quando a varredura roda outra vez —
   * e a varredura roda a cada hora.
   */
  trigger_key     text NOT NULL,

  /** Quando o fato aconteceu, e quando a mensagem deve sair. */
  triggered_at    timestamptz NOT NULL DEFAULT now(),
  scheduled_for   timestamptz NOT NULL,
  sent_at         timestamptz,
  /** Por que não saiu. "Nada foi enviado" sem motivo vira investigação. */
  skipped_reason  text,

  /**
   * O objetivo alcançado, e **quando**.
   *
   * É a única coluna que responde "isto funciona". Carimbo e não booleano pela
   * razão de sempre: a pergunta seguinte é sempre "quanto tempo depois".
   */
  goal_met_at     timestamptz,
  /** O que contou como objetivo — o agendamento, a venda, a avaliação. */
  goal_ref        uuid,

  CONSTRAINT automation_sends_desfecho_coerente CHECK (
    sent_at IS NULL OR skipped_reason IS NULL
  ),
  -- Objetivo alcançado exige mensagem enviada: crédito a mensagem que não saiu
  -- é atribuição inventada, e ela apareceria como sucesso no relatório.
  CONSTRAINT automation_sends_objetivo_exige_envio CHECK (
    goal_met_at IS NULL OR sent_at IS NOT NULL
  )
);

ALTER TABLE automation_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_sends
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/** Um disparo por automação, cliente e fato. A varredura roda a cada hora. */
CREATE UNIQUE INDEX automation_sends_uma_por_fato
  ON automation_sends (automation_id, customer_id, trigger_key);

/**
 * Uma mensagem de automação por cliente por dia — a regra da SPEC.
 *
 * **Parcial no que foi enviado**: o disparo pulado não ocupa a vaga do dia. Sem
 * isso, a automação que não saiu porque o cliente optou por não receber
 * bloquearia a que sairia — e a barbearia veria o silêncio sem entender.
 *
 * Por cliente e por dia, e não por regra: cinco automações razoáveis mandariam
 * cinco mensagens na terça, cada uma correta sozinha, e o conjunto sendo spam.
 */
CREATE UNIQUE INDEX automation_sends_uma_por_dia
  ON automation_sends (tenant_id, customer_id, ((sent_at AT TIME ZONE 'UTC')::date))
  WHERE sent_at IS NOT NULL;

/** A fila da varredura: o que está marcado e ainda não saiu. */
CREATE INDEX automation_sends_a_enviar_idx
  ON automation_sends (scheduled_for)
  WHERE sent_at IS NULL AND skipped_reason IS NULL;

/** A janela de atribuição, que a leitura do objetivo percorre. */
CREATE INDEX automation_sends_por_cliente_idx
  ON automation_sends (customer_id, sent_at DESC) WHERE sent_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Permissão
--
-- `marketing.send` já existe no catálogo desde o bloco 30 e é exatamente isto:
-- decidir o que a casa manda para a base de clientes. Uma permissão nova seria
-- uma segunda porta para a mesma sala.
-- ----------------------------------------------------------------------------
