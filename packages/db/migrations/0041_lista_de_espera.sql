-- ============================================================================
-- 0041 — Lista de espera (bloco 38, SPEC §2.9)
--
-- "Não tem horário no sábado? **Avise-me se surgir uma vaga.**"
--
-- ## Não é a fila da porta
--
-- `queue_entries` (migração 0017) é a fila presencial do §2.10: quem **está na
-- barbearia agora**, ordenada por chegada. Esta tabela é sobre quem foi embora
-- sem conseguir marcar, e o que ela ordena é compatibilidade com uma vaga que
-- ainda não existe. Os nomes se parecem e as duas não compartilham nada —
-- reaproveitar a primeira teria custado uma coluna `kind` e dois significados
-- para cada linha.
--
-- ## Por que o período é um intervalo, e não um dia
--
-- A SPEC escreve "dia (ou faixa de dias)". Um dia só resolveria o caso do
-- sábado e obrigaria quem aceita qualquer dia da semana a criar sete entradas —
-- estourando o limite de três logo na terceira, e enchendo o aviso de vaga da
-- barbearia com a mesma pessoa. `wanted_from = wanted_to` é o dia único.
--
-- ## Por que os serviços vão numa tabela à parte
--
-- Mesma razão de `appointment_services`: um array de uuid não tem chave
-- estrangeira, e uma entrada apontando para um serviço apagado viraria uma vaga
-- que nunca casa com nada, sem ninguém entender por quê. A duração é congelada
-- na entrada porque o catálogo muda — quem pediu um corte de 30 min não passa a
-- caber numa vaga de 30 quando a barbearia aumenta o serviço para 40.
-- ============================================================================

CREATE TYPE waitlist_status AS ENUM ('waiting', 'booked', 'left', 'expired');

CREATE TABLE waitlist_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Preferência. NULL = qualquer profissional, e é o caso comum: quem tem
  -- preferência forte costuma esperar a agenda dele abrir, não uma vaga.
  professional_id   uuid REFERENCES professionals(id) ON DELETE SET NULL,

  -- Datas locais da unidade. `date` e não `timestamptz` de propósito: o cliente
  -- pediu "sábado", não "sábado às 00:00 em algum fuso".
  wanted_from       date NOT NULL,
  wanted_to         date NOT NULL,

  -- Minutos locais desde a meia-noite, como toda janela deste produto.
  window_start_minute smallint NOT NULL,
  window_end_minute   smallint NOT NULL,

  -- Congelada na entrada, não lida do catálogo na hora de casar. Ver cabeçalho.
  duration_minutes  smallint NOT NULL,

  status            waitlist_status NOT NULL DEFAULT 'waiting',

  -- Ordem de entrada. É o décimo do score do §2.9, e a única parte dele que
  -- este bloco já tem — o resto entra no 39.
  joined_at         timestamptz NOT NULL DEFAULT now(),
  -- Quando saiu, por qualquer um dos três caminhos terminais.
  closed_at         timestamptz,

  -- O agendamento que nasceu desta espera. Nulo até a vaga virar horário.
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,

  -- Escopada por cliente na derivação, nunca só por tenant: ela vem de fora e é
  -- livre, então duas pessoas mandando "1" colidiriam — e a segunda receberia de
  -- volta a entrada da primeira.
  idempotency_key   text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waitlist_periodo_coerente CHECK (wanted_to >= wanted_from),
  CONSTRAINT waitlist_janela_coerente CHECK (
    window_start_minute >= 0
    AND window_end_minute <= 1440
    AND window_end_minute > window_start_minute
  ),
  -- Um serviço de zero minuto casaria com qualquer buraco da grade, inclusive
  -- os que não existem.
  CONSTRAINT waitlist_duracao_positiva CHECK (duration_minutes > 0),

  -- Estado terminal sem hora de término não permite medir nada depois — é a
  -- mesma invariante de `queue_entries`.
  CONSTRAINT waitlist_terminal_tem_hora CHECK (
    status = 'waiting' OR closed_at IS NOT NULL
  ),
  -- `booked` é o único estado que tem agendamento, e todo `booked` tem um: sem
  -- isto, "conseguiu marcar" viraria um rótulo sem lastro, e a pergunta
  -- "converteu?" não teria resposta.
  CONSTRAINT waitlist_marcada_tem_agendamento CHECK (
    (status = 'booked') = (appointment_id IS NOT NULL)
  )
);

ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Os serviços pedidos
-- ---------------------------------------------------------------------------

CREATE TABLE waitlist_entry_services (
  entry_id   uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position   smallint NOT NULL DEFAULT 0,

  PRIMARY KEY (entry_id, service_id)
);

ALTER TABLE waitlist_entry_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entry_services FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entry_services
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------

-- A consulta do gatilho: um cancelamento abre uma vaga e pergunta quem a quer.
-- Ela roda **dentro da transação do cancelamento**, com a recepção esperando a
-- tela responder, então varrer a tabela inteira não serve. O índice é parcial
-- porque o filtro é sempre o mesmo: só quem está esperando interessa.
CREATE INDEX waitlist_candidatos_idx
  ON waitlist_entries (location_id, wanted_from, wanted_to)
  WHERE status = 'waiting';

-- "Quantas entradas ativas este cliente tem?" — conferido a cada entrada nova,
-- para aplicar o teto de três.
CREATE INDEX waitlist_do_cliente_idx
  ON waitlist_entries (customer_id)
  WHERE status = 'waiting';

-- Duplo toque no "me avise" não põe a pessoa duas vezes na mesma lista.
CREATE UNIQUE INDEX waitlist_idempotencia_idx
  ON waitlist_entries (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/**
 * A mesma pessoa não entra duas vezes para a mesma coisa.
 *
 * A chave de idempotência resolve o duplo toque; isto resolve o pedido repetido
 * dias depois, que ela não alcança. Sem o índice, quem esquece que já se
 * inscreveu para o sábado se inscreve de novo, gasta duas das três vagas e
 * recebe o aviso em dobro — e a barbearia acha que tem dois interessados.
 *
 * `professional_id` entra com `COALESCE` porque `NULL` não colide com `NULL` num
 * índice único: sem isso, "qualquer barbeiro no sábado" poderia ser cadastrado
 * quantas vezes se quisesse, que é justamente o pedido mais comum.
 */
CREATE UNIQUE INDEX waitlist_sem_repetido_idx
  ON waitlist_entries (
    customer_id, wanted_from, wanted_to,
    window_start_minute, window_end_minute,
    COALESCE(professional_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'waiting';

-- ---------------------------------------------------------------------------
-- Permissão da aplicação
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON waitlist_entries TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON waitlist_entry_services TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A anonimização fecha a lista de espera junto
--
-- A entrada não guarda dado pessoal — datas, uma faixa de horas e uma duração —,
-- então a linha fica. O que não pode ficar é o estado vivo: `waiting` continuaria
-- concorrendo a toda vaga que abrisse, e o balcão veria um apelido sem telefone
-- na lista de quem chamar.
--
-- Recriada inteira porque plpgsql não se remenda pela metade. É a mesma função
-- da 0039, com o bloco marcado a mais.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION anonimizar_cliente(p_customer uuid, p_motivo text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_apelido text;
  v_telefone text;
BEGIN
  /**
   * Sem tenant no contexto a função não roda.
   *
   * É a diferença entre "anonimize este cliente da barbearia X" e "anonimize
   * este uuid, onde quer que ele esteja". A segunda seria uma porta para apagar
   * cadastro alheio conhecendo só o id — e `SECURITY DEFINER` a abriria de par
   * em par, porque aqui dentro a RLS pode não estar valendo.
   */
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'anonimizar_cliente exige app.tenant_id no contexto';
  END IF;

  IF length(btrim(coalesce(p_motivo, ''))) < 3 THEN
    RAISE EXCEPTION 'anonimizar_cliente exige motivo escrito';
  END IF;

  -- O `FOR UPDATE` fecha a corrida entre a varredura de retenção e alguém
  -- atendendo o pedido de exclusão pela tela no mesmo instante: a segunda
  -- transação espera, relê `anonymized_at` preenchido e devolve `false`.
  -- O telefone é lido **antes** de ser apagado: ele é a chave de
  -- `otp_challenges`, e sem guardá-lo aqui não haveria como limpar aquela linha
  -- depois.
  SELECT phone_e164 INTO v_telefone
    FROM public.customers
   WHERE id = p_customer AND tenant_id = v_tenant AND anonymized_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_apelido := 'cliente_anonimizado_' || substring(replace(p_customer::text, '-', '') from 1 for 4);

  UPDATE public.customers
     SET name = v_apelido,
         phone_e164 = NULL,
         birth_date = NULL,
         accepts_marketing = false,
         marketing_consent_ip = NULL,
         -- O par do IP, e ele ficava para trás. A invariante de catálogo que
         -- este bloco criou foi quem o encontrou: `accepts_marketing` já virava
         -- `false`, então o carimbo dizia "esta pessoa consentiu às 14h22" sobre
         -- um consentimento que não vale mais. A prova de verdade é o histórico
         -- append-only de `customer_consents`, que continua intacto — isto aqui
         -- é espelho derivado, e espelho de dado apagado é dado apagado.
         marketing_consent_at = NULL,
         marketing_consent_version = NULL,
         -- Bloco 37. O motivo do override é texto livre escrito por um gerente
         -- **sobre uma pessoa**, e os exemplos deste repositório são "faltou
         -- por internação" e "sumiu com a chave da barbearia": dado de saúde e
         -- imputação de crime. Sobreviver à anonimização faria a função apagar
         -- o nome e guardar a narrativa — com carimbo de hora, que sozinho já
         -- reidentifica. Achado da `/security-review` do bloco 37, e é o mesmo
         -- defeito que `otp_challenges` teve no bloco 32.
         reliability_override = NULL,
         reliability_override_reason = NULL,
         reliability_override_at = NULL,
         anonymized_at = now(),
         updated_at = now()
   WHERE id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_consents
     SET ip = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_ledger
     SET note = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_preferences
     SET maquina_laterais = NULL, tipo_degrade = NULL, topo = NULL,
         barba_estilo = NULL, produtos_evitar = NULL, observacoes = NULL,
         updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.queue_entries
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A lista de espera fecha junto (bloco 38).
   *
   * Não é dado pessoal — são datas, uma faixa de horas e uma duração —, e por
   * isso a linha fica. O que não pode ficar é o estado **vivo**: uma entrada
   * `waiting` continuaria concorrendo a toda vaga que abrisse, e o balcão veria
   * "cliente_anonimizado_a3f1" na lista de quem chamar, sem telefone para
   * chamar. A pessoa pediu justamente para sair.
   *
   * Mora aqui e não na camada de cima porque o princípio desta função é ser o
   * caminho **único**: quem chamar o SQL direto — a varredura de retenção, uma
   * correção manual — também precisa fechar a lista.
   */
  UPDATE public.waitlist_entries
     SET status = 'left', closed_at = now(), updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status = 'waiting';

  UPDATE public.appointments
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.notifications
     SET phone_masked = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A sessão do navegador é credencial viva, não histórico.
   *
   * Apagada e não revogada: revogar deixaria `ip` e `user_agent` na tabela, que
   * são dado pessoal, e a linha não serve para nada depois disso — a trilha do
   * que essa pessoa fez está em `appointments` e `orders`.
   */
  DELETE FROM public.customer_sessions
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * O desafio de OTP daquele número, inteiro.
   *
   * A tabela guarda o telefone em claro e o nome pendente, e `verifyOtp`
   * reaproveita o nome ao criar o cadastro. Deixá-la faria a pessoa entrar de
   * novo com o número antigo e reaparecer com o **nome verdadeiro**.
   */
  IF v_telefone IS NOT NULL THEN
    DELETE FROM public.otp_challenges
     WHERE tenant_id = v_tenant AND phone_e164 = v_telefone;
  END IF;

  RETURN true;
END $$;
