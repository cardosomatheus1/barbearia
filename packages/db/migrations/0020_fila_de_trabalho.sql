-- ============================================================================
-- 0020 — Fila de trabalho e notificações
--
-- A primeira coisa deste produto que roda **fora de uma requisição**.
--
-- Até aqui todo efeito acontecia enquanto alguém esperava a resposta. Lembrete
-- de 24 horas não cabe nesse modelo: ninguém está esperando às 9h da manhã de
-- ontem. Daí uma fila.
--
-- Quatro decisões que merecem explicação:
--
-- 1. **A fila é uma tabela, não um Redis.** O trabalho a fazer nasce dentro da
--    mesma transação que cria o agendamento — se o agendamento entra, o
--    lembrete entra; se a transação volta atrás, o lembrete some junto. Com uma
--    fila fora do banco isso vira entrega em dois lugares, que é o problema que
--    o produto ainda não tem escala para justificar. Postgres com
--    `FOR UPDATE SKIP LOCKED` sustenta ordem de milhares de tarefas por minuto,
--    muito além de uma barbearia.
--
-- 2. **A chave de idempotência é do trabalho, não da execução.** Dois
--    processos, uma reentrega, um `retry` — nada disso pode produzir duas
--    mensagens para o mesmo cliente sobre o mesmo corte. O índice único é o que
--    garante, não um `SELECT` antes de inserir.
--
-- 3. **Tentativa tem teto e espera crescente.** Provedor fora do ar não pode
--    virar laço apertado gastando cota. E tarefa que falhou N vezes vira
--    `failed` visível, nunca desaparece — mensagem que ninguém enviou e ninguém
--    soube é a pior das duas falhas possíveis.
--
-- 4. **O que foi enviado fica registrado à parte.** `notifications` é o que
--    responde "o cliente foi avisado?" seis meses depois, quando a tarefa já
--    foi limpa da fila. É também o que sustenta o teto mensal e a
--    deduplicação.
-- ============================================================================

CREATE TYPE job_status AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /**
   * Toda tarefa tem dono, e isso não é burocracia.
   *
   * A primeira versão deixava `tenant_id` nulo para "tarefas de plataforma" —
   * uma varredura que atravessaria barbearias marcando quem passou da
   * tolerância. Ela não podia funcionar: `appointments` tem RLS, e sem tenant
   * no contexto a consulta devolve zero linhas **sempre**. O teste pegou.
   *
   * A correção foi melhor que o remendo. A falta não precisa de varredura: ela
   * é uma tarefa por agendamento, criada junto com ele, com `run_after` na hora
   * exata em que a tolerância vence. Mais precisa que varrer de minuto em
   * minuto, e sem nenhum caminho que enxergue barbearia alheia.
   *
   * Sobrou a regra: **quem não tem tenant não tem o que fazer aqui.**
   */
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  status          job_status NOT NULL DEFAULT 'pending',
  -- Quando pode rodar. É isto que transforma a fila em agendador: o lembrete de
  -- 24h nasce hoje com `run_after` para amanhã.
  run_after       timestamptz NOT NULL DEFAULT now(),

  attempts        smallint NOT NULL DEFAULT 0,
  max_attempts    smallint NOT NULL DEFAULT 5,
  last_error      text,

  -- Preenchido enquanto uma execução está de posse da tarefa. Serve para achar
  -- órfã: worker morto no meio deixa `running` com `locked_at` velho.
  locked_at       timestamptz,
  locked_by       text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  /**
   * A chave que impede duplicata.
   *
   * Nula quando repetir é legítimo (uma varredura periódica). Preenchida quando
   * não é: `lembrete_24h:<id do agendamento>` só pode existir uma vez, aconteça
   * o que acontecer com reentrega ou reinício.
   */
  idempotency_key text,

  CONSTRAINT jobs_tentativas_sanas CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT jobs_kind_preenchido CHECK (length(btrim(kind)) > 0)
);

CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- A consulta do worker, e a única que roda em laço: a próxima tarefa pronta.
-- Índice parcial porque `done` e `failed` são a maioria das linhas depois de
-- uma semana, e nenhuma delas interessa a esta pergunta.
CREATE INDEX jobs_prontas_idx ON jobs (run_after, id)
  WHERE status = 'pending';

-- Para achar órfã de worker morto.
CREATE INDEX jobs_presas_idx ON jobs (locked_at) WHERE status = 'running';

CREATE INDEX jobs_tenant_idx ON jobs (tenant_id, created_at DESC);

/**
 * `jobs` **não** tem RLS, e é de propósito.
 *
 * Ela é infraestrutura, não dado de negócio: o worker roda sem tenant no
 * contexto e precisa ver a fila inteira para saber o que fazer em seguida. Pôr
 * RLS aqui obrigaria o worker a adivinhar de qual barbearia é a próxima tarefa
 * antes de poder lê-la.
 *
 * O que protege o dado de negócio continua sendo a RLS **das tabelas que a
 * tarefa toca**: o handler abre `withTenant` com o tenant da própria tarefa, e
 * dali para dentro nada muda. O `payload` guarda id, nunca conteúdo — nome de
 * cliente e telefone são lidos sob RLS na hora de executar.
 *
 * A API não fala com esta tabela: quem escreve é o código de domínio dentro da
 * transação, e quem lê é o worker.
 */
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO barbearia_app;

-- ---------------------------------------------------------------------------
-- O que foi enviado
-- ---------------------------------------------------------------------------

CREATE TYPE notification_kind AS ENUM (
  'confirmacao', 'lembrete_24h', 'lembrete_2h', 'sua_vez', 'senha_de_acesso', 'retorno'
);

CREATE TYPE notification_status AS ENUM ('sent', 'failed', 'skipped');

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  kind            notification_kind NOT NULL,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  staff_user_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  status          notification_status NOT NULL,
  -- Por que não saiu, quando não saiu. "Nada foi enviado" sem motivo transforma
  -- toda pergunta do dono numa investigação.
  reason          text,
  -- Mascarado (`(71) 9****-1234`). O número inteiro já está em `customers`, sob
  -- RLS e sob a política de dado pessoal; repeti-lo aqui multiplicaria a
  -- superfície sem responder nada que esta tabela precise responder.
  phone_masked    text,

  sent_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- O teto mensal e a pergunta "quantas promocionais este cliente recebeu?".
CREATE INDEX notifications_por_cliente_idx
  ON notifications (customer_id, sent_at DESC) WHERE status = 'sent';

CREATE INDEX notifications_por_agendamento_idx ON notifications (appointment_id);

/**
 * O registro de envio é append-only.
 *
 * Mesma decisão de `audit_log` e do extrato do cliente: é a resposta a "o
 * cliente foi avisado?" numa discussão sobre falta, e resposta que pode ser
 * reescrita não responde nada.
 */
REVOKE UPDATE, DELETE ON notifications FROM barbearia_app;

-- ---------------------------------------------------------------------------
-- Preferências da barbearia
-- ---------------------------------------------------------------------------

ALTER TABLE locations
  -- Cada aviso liga e desliga por conta própria: barbearia que acha o de 2h
  -- intrusivo desliga só ele, em vez de abrir mão do de 24h junto.
  ADD COLUMN notify_confirmation boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_reminder_24h boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_reminder_2h  boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_comeback     boolean NOT NULL DEFAULT false,
  -- Dias sem voltar até a mensagem de retorno. O ciclo individual por
  -- histórico é do bloco 61; aqui é o número que a barbearia escolheu.
  ADD COLUMN comeback_after_days smallint NOT NULL DEFAULT 45,

  ADD CONSTRAINT locations_comeback_sane CHECK (comeback_after_days BETWEEN 7 AND 365);

/**
 * Consentimento de marketing, separado do necessário para o serviço.
 *
 * A LGPD e o `CLAUDE.md` §2 pedem a separação explícita, com data e versão do
 * texto. Um cliente que recusa promoção continua recebendo o lembrete do
 * próprio corte — são coisas diferentes, e o produto trata como tal.
 */
ALTER TABLE customers
  ADD COLUMN accepts_marketing boolean NOT NULL DEFAULT false,
  ADD COLUMN marketing_consent_at timestamptz,
  ADD COLUMN marketing_consent_ip inet,
  ADD COLUMN marketing_consent_version text;
