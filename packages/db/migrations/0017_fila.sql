-- ============================================================================
-- 0017 — Fila presencial (walk-in)
--
-- A SPEC (Parte 2 §2.10) é explícita: a fila é **outro objeto e outra tela**,
-- não um agendamento improvisado. E a diferença não é organizacional.
--
-- Um agendamento ocupa janela: tem `starts_at`, entra na constraint de exclusão
-- que impede overbooking e é subtraído da grade. Quem chegou na porta não tem
-- horário — tem ordem de chegada e uma estimativa que muda a cada corte que
-- termina. Modelar isso como `appointment` obrigaria a inventar um horário
-- falso, e esse horário passaria a bloquear a agenda de quem quer marcar.
--
-- O caminho é o inverso: a fila vira agendamento **no momento em que começa o
-- atendimento**, com o horário real. Aí sim ocupa janela, entra na comanda e
-- conta na comissão.
--
-- Três decisões que merecem explicação:
--
-- 1. **A preferência de profissional é anulável.** `NULL` é "qualquer um", que
--    é o caso mais comum na porta e é o que permite não deixar cadeira parada.
--
-- 2. **O link de acompanhamento é guardado com hash.** A SPEC pede que o
--    cliente acompanhe a posição pelo celular, por link, sem app. Esse link é
--    credencial ao portador: quem o tiver vê a posição daquela pessoa. Guardar
--    em claro faria de um vazamento de banco um molho de chaves ainda válidas.
--    O token tem entropia total, então basta SHA-256 — pimenta não acrescenta
--    nada contra força bruta aqui, ao contrário de senha escolhida por gente.
--
-- 3. **Ninguém entra duas vezes na mesma fila.** Índice único parcial sobre os
--    estados vivos. Duplo toque em celular lento na recepção criaria duas
--    entradas para a mesma pessoa, e a segunda empurraria a fila inteira.
-- ============================================================================

CREATE TYPE queue_status AS ENUM (
  -- Na fila, esperando.
  'waiting',
  -- Chamado: a recepção gritou o nome. Ainda não sentou.
  'called',
  -- Sentou. A partir daqui existe um `appointment` de verdade.
  'in_service',
  'done',
  -- Cansou de esperar e foi embora. Separado de `done` de propósito: é o número
  -- que mede se a fila está funcionando, e somá-lo aos atendidos o esconderia.
  'gave_up'
);

CREATE TABLE queue_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Preferência. NULL = qualquer profissional, que é o caso comum na porta.
  professional_id   uuid REFERENCES professionals(id) ON DELETE SET NULL,

  status            queue_status NOT NULL DEFAULT 'waiting',

  -- Ordem de chegada. É o que a fila ordena, e o que a barbearia promete.
  joined_at         timestamptz NOT NULL DEFAULT now(),
  called_at         timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,

  -- O atendimento que nasceu desta entrada. Nulo enquanto ela espera.
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,

  -- SHA-256 do token do link de acompanhamento. Ver decisão 2 no topo.
  public_token_hash text NOT NULL,

  -- Chave de idempotência do POST que criou. Escopada por cliente, nunca só por
  -- tenant: ela vem de fora e é livre, então duas pessoas mandando "1"
  -- colidiriam — e a segunda receberia de volta a entrada da primeira, com o
  -- token que dá acesso à posição dela.
  idempotency_key   text,

  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT queue_entries_ordem_cronologica CHECK (
    (called_at IS NULL OR called_at >= joined_at)
    AND (started_at IS NULL OR started_at >= joined_at)
    AND (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
  ),
  -- Estado terminal sem hora de término não permite medir nada depois.
  CONSTRAINT queue_entries_terminal_tem_hora CHECK (
    status NOT IN ('done', 'gave_up') OR finished_at IS NOT NULL
  ),
  -- Em atendimento sem agendamento seria fila que não vira dinheiro: a comanda,
  -- a comissão e o relatório saem todos do `appointment`.
  CONSTRAINT queue_entries_atendendo_tem_agendamento CHECK (
    status <> 'in_service' OR appointment_id IS NOT NULL
  )
);

ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON queue_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A mesma pessoa não entra duas vezes na fila viva da mesma unidade.
CREATE UNIQUE INDEX queue_entries_uma_viva_por_cliente
  ON queue_entries (location_id, customer_id)
  WHERE status IN ('waiting', 'called');

-- Idempotência escopada por cliente (ver comentário da coluna).
CREATE UNIQUE INDEX queue_entries_idempotency_idx
  ON queue_entries (tenant_id, customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- O link do celular procura por hash e mais nada. Único porque colisão aqui
-- entregaria a posição de uma pessoa para outra.
CREATE UNIQUE INDEX queue_entries_token_idx ON queue_entries (public_token_hash);

-- A consulta da tela: a fila viva de uma unidade, em ordem de chegada. Índice
-- parcial porque a fila de ontem nunca é lida por ela, e em três meses os
-- terminais são a quase totalidade da tabela.
CREATE INDEX queue_entries_vivas_idx
  ON queue_entries (location_id, joined_at)
  WHERE status IN ('waiting', 'called');

COMMENT ON COLUMN queue_entries.professional_id IS 'Preferência; NULL é "qualquer um".';
COMMENT ON COLUMN queue_entries.public_token_hash IS 'SHA-256 do token do link de acompanhamento.';

-- ---------------------------------------------------------------------------
-- O que a pessoa da fila quer fazer
-- ---------------------------------------------------------------------------

CREATE TABLE queue_entry_services (
  queue_entry_id uuid NOT NULL REFERENCES queue_entries(id) ON DELETE CASCADE,
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position       smallint NOT NULL DEFAULT 0,

  PRIMARY KEY (queue_entry_id, service_id)
);

ALTER TABLE queue_entry_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entry_services FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON queue_entry_services
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Origem do agendamento
-- ---------------------------------------------------------------------------

-- Sem isto, o atendimento que nasceu na porta fica indistinguível do que a
-- recepção marcou por telefone — e a pergunta "quanto do meu movimento é
-- walk-in?" decide horário de funcionamento e escala de equipe.
ALTER TYPE appointment_source ADD VALUE IF NOT EXISTS 'walk_in';

-- ---------------------------------------------------------------------------
-- A média de duração real que a fila consome
-- ---------------------------------------------------------------------------

-- A estimativa de espera lê os atendimentos concluídos dos últimos 90 dias para
-- saber quanto cada serviço leva de fato. Sem este índice a consulta varre
-- `appointments` inteira a cada carga da tela da fila — e a fila fica aberta o
-- dia todo no balcão.
--
-- Medido em banco descartável com 34 mil atendimentos: 40,9 ms com Seq Scan,
-- 8,8 ms com este índice. O que importa mais que o número é a curva: sem a
-- janela de 90 dias, o custo crescia com todo o passado da barbearia.
--
-- Parcial porque o predicado da consulta é sempre o mesmo, e porque em três
-- anos a maioria das linhas não satisfaz nenhuma das três condições.
CREATE INDEX appointments_concluidos_idx ON appointments (completed_at)
  WHERE status = 'completed' AND completed_at IS NOT NULL AND started_at IS NOT NULL;
