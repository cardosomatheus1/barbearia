-- ============================================================================
-- 0042 — A oferta de vaga, com janela exclusiva (bloco 39, SPEC §2.9)
--
-- O bloco 38 entregou a lista e o gatilho: um cancelamento abre uma vaga e o
-- produto sabe dizer quem a quer. O que faltava é o que a SPEC chama de
-- Priority Queue — ordenar os candidatos e **oferecer ao topo com dez minutos
-- de exclusividade**, passando ao próximo se não houver resposta.
--
-- ## Por que a oferta é uma linha, e não uma coluna na entrada
--
-- Porque a mesma entrada de espera pode receber várias ofertas ao longo da vida
-- — a pessoa perde a vaga de terça, e na quinta abre outra que também serve. Um
-- par de colunas em `waitlist_entries` guardaria só a última, e a pergunta
-- "quantas vezes oferecemos e quantas converteram?" — que é como se descobre se
-- a fila funciona — não teria resposta.
--
-- ## Por que a exclusividade precisa de um `slot_holds`
--
-- Sem segurar o horário, "exclusivo" é uma palavra na mensagem. Nos dez minutos
-- em que o topo da fila decide, qualquer pessoa entrando na página pública
-- marcaria aquele horário — e o convite viraria uma frustração a mais.
-- `slot_holds` existe desde a migração 0001 e é exatamente isso; a oferta
-- aponta para o hold que a segura, e os dois vencem juntos.
--
-- ## Uma oferta viva por vaga
--
-- É o que separa Priority Queue de First Come. Duas ofertas abertas para o
-- mesmo horário significam duas pessoas com direito exclusivo à mesma coisa, e
-- a segunda a responder descobre que perdeu — que é justamente o que o modo
-- padrão da SPEC existe para evitar.
-- ============================================================================

/**
 * `aceitando` existe por causa de uma corrida real, achada na revisão deste
 * bloco.
 *
 * Aceitar são três passos que não cabem numa transação só — o agendamento nasce
 * em `createAppointment`, que abre a própria. Sem um estado que diga "esta
 * oferta já foi resgatada", o duplo toque no link passa duas vezes pela mesma
 * checagem de "ainda está aberta?", e o segundo pedido só é barrado lá na
 * constraint de exclusão, devolvendo "horário indisponível" para quem tinha
 * exclusividade sobre ele.
 *
 * O estado é o que a trava do `FOR UPDATE` protege: sem escrita nenhuma dentro
 * da transação travada, a trava não separava nada — ela é liberada no commit e
 * o segundo leitor via o mesmo `aberta` de antes.
 */
CREATE TYPE waitlist_offer_status AS ENUM (
  'aberta', 'aceitando', 'aceita', 'vencida', 'cancelada'
);

CREATE TABLE waitlist_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id         uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,

  -- A vaga oferecida, congelada. A entrada diz o que a pessoa **queria**; isto
  -- diz o que foi oferecido de fato — e os dois divergem, porque a vaga é um
  -- horário e o pedido é uma faixa.
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,

  /**
   * O início **visível** — o que a mensagem anuncia e o que o aceite marca.
   *
   * `starts_at` é a janela ocupada, com os buffers: é o buraco de verdade na
   * grade, e é ela que precisa ser segurada. Mas o motor de reserva recebe o
   * início de serviço, e quem tem dez minutos de preparo tem os dois separados.
   * Guardar só o ocupado fazia a mensagem anunciar 8h50 para um corte das 9h e o
   * aceite marcar dez minutos antes do que foi combinado — numa janela que
   * ninguém segurou. Achado da revisão de segurança do bloco 39.
   *
   * Calculado com o buffer de quem **vai receber** a vaga, não de quem
   * desmarcou: os dois podem ter serviços diferentes.
   */
  service_starts_at timestamptz NOT NULL,

  status           waitlist_offer_status NOT NULL DEFAULT 'aberta',

  offered_at       timestamptz NOT NULL DEFAULT now(),
  -- Fim da janela exclusiva. Gravado, não calculado na leitura: o prazo é o que
  -- foi prometido à pessoa, e recalculá-lo com a constante de hoje mudaria o
  -- passado no dia em que a barbearia mudasse o número.
  expires_at       timestamptz NOT NULL,
  answered_at      timestamptz,

  -- O horário segurado enquanto ela decide. Nulo depois que a oferta encerra.
  hold_id          uuid REFERENCES slot_holds(id) ON DELETE SET NULL,
  -- O agendamento que nasceu daqui. Só existe em oferta aceita.
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,

  /**
   * O que o cliente recebe no link da mensagem.
   *
   * Só o **hash**, como o token da fila presencial (migração 0017): quem lê a
   * tabela não consegue aceitar a oferta de ninguém. O token em claro existe
   * uma vez, dentro da mensagem que sai.
   *
   * Ele é necessário porque a oferta chega por WhatsApp e a pessoa não tem
   * sessão: pedir login antes de aceitar é o mesmo atrito que fez a lista de
   * espera nascer sem login.
   */
  token_hash       text NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waitlist_offers_janela_valida CHECK (starts_at < ends_at),
  -- O início visível cai dentro do que foi segurado. Fora dele, o aceite marca
  -- um horário que a barbearia não tirou da grade para ninguém.
  CONSTRAINT waitlist_offers_servico_dentro_da_vaga CHECK (
    service_starts_at >= starts_at AND service_starts_at < ends_at
  ),
  CONSTRAINT waitlist_offers_prazo_no_futuro CHECK (expires_at > offered_at),
  -- Estado terminal sem hora de resposta não permite medir conversão depois — e
  -- "a fila funciona?" é a pergunta que decide se ela continua existindo.
  -- `aceitando` não é terminal: é o instante entre o resgate do convite e o
  -- agendamento existir.
  CONSTRAINT waitlist_offers_terminal_tem_hora CHECK (
    status IN ('aberta', 'aceitando') OR answered_at IS NOT NULL
  ),
  -- `aceita` é o único estado com agendamento, e toda aceita tem um.
  CONSTRAINT waitlist_offers_aceita_tem_agendamento CHECK (
    (status = 'aceita') = (appointment_id IS NOT NULL)
  )
);

ALTER TABLE waitlist_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_offers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------

/**
 * Uma oferta viva por vaga.
 *
 * É o que separa Priority Queue de First Come. Duas ofertas abertas para o
 * mesmo horário são duas pessoas com direito exclusivo à mesma coisa, e a
 * segunda a responder descobre que perdeu.
 *
 * A vaga é o par (profissional, início) — não o horário sozinho, porque duas
 * cadeiras têm 9h ao mesmo tempo e são vagas diferentes.
 *
 * `aceitando` conta como viva: é o intervalo em que alguém está resgatando o
 * convite. Deixá-la de fora abriria exatamente a janela que o estado existe
 * para fechar.
 */
CREATE UNIQUE INDEX waitlist_offers_uma_viva_por_vaga
  ON waitlist_offers (professional_id, starts_at)
  WHERE status IN ('aberta', 'aceitando');

/**
 * Uma oferta viva por entrada.
 *
 * Sem isto, a mesma pessoa receberia duas mensagens de vaga ao mesmo tempo —
 * duas terças diferentes, ambas exclusivas por dez minutos — e só conseguiria
 * aceitar uma. A outra vira frustração com aparência de erro do sistema.
 */
CREATE UNIQUE INDEX waitlist_offers_uma_viva_por_entrada
  ON waitlist_offers (entry_id)
  WHERE status IN ('aberta', 'aceitando');

-- O token do link, procurado a cada abertura da página de aceite.
CREATE UNIQUE INDEX waitlist_offers_token_idx ON waitlist_offers (token_hash);

/**
 * A varredura que vence as ofertas sem resposta e passa ao próximo da fila.
 *
 * `aceitando` entra: um processo que morra no meio do resgate deixaria a oferta
 * presa nesse estado para sempre, e com ela a entrada e a vaga — os dois índices
 * acima contam `aceitando` como viva. A varredura é quem desata isso.
 */
CREATE INDEX waitlist_offers_vencendo_idx
  ON waitlist_offers (expires_at)
  WHERE status IN ('aberta', 'aceitando');

-- ---------------------------------------------------------------------------
-- Permissão da aplicação
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON waitlist_offers TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- O aviso da vaga entra no vocabulário de notificação
-- ---------------------------------------------------------------------------

/**
 * `vaga_liberada` (bloco 39).
 *
 * Transacional, não promocional: é resposta a um pedido explícito da pessoa
 * — "me avise se surgir uma vaga" —, e por isso **não** olha o consentimento de
 * marketing, exatamente como o lembrete de horário. O texto é que não pode
 * virar propaganda, e isso é regra de template.
 *
 * A janela de silêncio de 21h às 8h continua valendo. Uma vaga que abre às 22h
 * espera as 8h para ser oferecida — e é o certo: ninguém vai à barbearia às
 * 22h30, e acordar o cliente para oferecer um horário é o jeito mais rápido de
 * ele sair da lista.
 */
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'vaga_liberada';
