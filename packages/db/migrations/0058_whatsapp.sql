-- ============================================================================
-- 0058 — WhatsApp oficial (bloco 55, SPEC §4.12)
--
-- O motor de aviso existe desde o bloco 20 — seis tipos, janela de silêncio no
-- fuso da unidade, interruptor por unidade, registro de tentativa com motivo —
-- e sempre mandou por uma abstração com implementação de console. Este bloco
-- entrega o canal de verdade.
--
-- ## Três decisões que o schema carrega
--
-- **O número é da barbearia, não da plataforma.** É a SPEC §4.12 em letras, e
-- não é preferência de marca: a mensagem que chega de um número desconhecido é
-- a que o cliente bloqueia, e é o número da barbearia que ele já tem na agenda.
-- O custo é real e está escrito na lacuna que este bloco fecha — a verificação
-- de empresa na Meta entra no caminho de quem está se cadastrando, e é etapa
-- que dá para abandonar no meio. Por isso o estado do cadastro é explícito e a
-- barbearia opera sem ele: sem WhatsApp ativo, o motor cai no que já fazia.
--
-- **Cloud API direto, sem intermediário.** Sem BSP: um a menos no caminho do
-- dado do cliente, e a conta é com a Meta. O que isso custa é a burocracia de
-- verificação ficar visível para a barbearia, e é o que a tela precisa guiar.
--
-- **Template é um cadastro com estado, não uma string no código.** A Meta
-- aprova cada texto, leva de minutos a dias, e recusa. Um texto no código
-- estaria certo hoje e errado no dia em que a Meta pedisse mudança — e não
-- haveria onde ler "por que a mensagem parou de sair".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- O cadastro do número
-- ----------------------------------------------------------------------------

/**
 * Onde a barbearia está no caminho da Meta.
 *
 * Estado explícito porque **a maior parte do tempo ele não é `ativo`**: a
 * verificação de empresa leva dias e passa por gente. Sem o estado, a tela
 * mostraria "WhatsApp: não" para três situações diferentes — nunca começou,
 * está esperando a Meta, e foi recusado — e as três pedem coisas diferentes de
 * quem opera.
 */
CREATE TYPE whatsapp_status AS ENUM (
  'nao_configurado',
  'aguardando_verificacao',
  'ativo',
  'suspenso'
);

CREATE TABLE whatsapp_settings (
  /**
   * Por unidade, como o cadastro fiscal.
   *
   * O cliente responde ao número de onde a mensagem veio, e precisa cair na
   * loja para onde ele vai. Numa barbearia de uma unidade — que é toda
   * barbearia até o bloco 58 — dá no mesmo; numa rede, um número só faria a
   * pessoa remarcar na loja errada.
   */
  location_id     uuid PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  status          whatsapp_status NOT NULL DEFAULT 'nao_configurado',

  /** Ids da Meta. Opacos deste lado, como o id de recebedor do adquirente. */
  phone_number_id text,
  waba_id         text,
  /** O número como o cliente o vê. Só para a tela conferir que é o certo. */
  display_phone   text,

  /**
   * O token de acesso, **cifrado**.
   *
   * AES-256-GCM com chave de ambiente, exatamente como o segredo do segundo
   * fator — e pela mesma razão: é credencial viva, e um `SELECT` na tabela não
   * pode devolvê-la. Não existe coluna em claro, e há invariante que reprova
   * quem criar uma.
   *
   * Ele mora aqui e não numa variável de ambiente porque é **por barbearia**:
   * uma variável serve a um valor só, e este produto tem um por conta da Meta.
   */
  access_token_cipher text,

  verified_at     timestamptz,
  /** Por que a Meta recusou ou suspendeu. É o que a tela precisa dizer. */
  status_reason   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  /** Ativo exige os três: sem qualquer um deles não há como mandar nada. */
  CONSTRAINT whatsapp_settings_ativo_completo CHECK (
    status <> 'ativo'
    OR (phone_number_id IS NOT NULL AND waba_id IS NOT NULL AND access_token_cipher IS NOT NULL)
  ),
  -- Implicação, não equivalência: a conta suspensa guarda o motivo e continua
  -- com os ids, que é o que permite reativá-la sem recadastrar tudo.
  CONSTRAINT whatsapp_settings_suspenso_com_motivo CHECK (
    status <> 'suspenso' OR status_reason IS NOT NULL
  )
);

ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Os templates
-- ----------------------------------------------------------------------------

/**
 * O estado do template na Meta.
 *
 * `pausado` existe e não é invenção: a Meta pausa template cujo índice de
 * qualidade cai — quando muita gente marca como spam ou bloqueia. É o estado
 * mais importante da lista, porque é o único que aparece **depois** de tudo ter
 * funcionado, e sem ele a mensagem simplesmente pararia de sair sem explicação.
 */
CREATE TYPE whatsapp_template_status AS ENUM (
  'rascunho',
  'pendente',
  'aprovado',
  'rejeitado',
  'pausado'
);

CREATE TABLE whatsapp_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  /**
   * Para que serve este template.
   *
   * É o mesmo enum dos avisos, e de propósito: o motor decide "vou mandar um
   * lembrete de 24h" e precisa achar o template daquilo. Um nome livre faria a
   * ligação depender de alguém digitar igual nos dois lugares.
   */
  kind            notification_kind NOT NULL,

  /** O nome na Meta: minúsculas, números e sublinhado. É a chave lá. */
  name            text NOT NULL,
  language        text NOT NULL DEFAULT 'pt_BR',
  status          whatsapp_template_status NOT NULL DEFAULT 'rascunho',
  /** O id que a Meta devolve. Nulo enquanto o template não foi submetido. */
  meta_id         text,
  rejection_reason text,

  /**
   * O texto, com as variáveis posicionais da Meta (`{{1}}`, `{{2}}`).
   *
   * Guardado aqui porque a tela precisa mostrar o que foi aprovado — e porque
   * a Meta não é fonte de leitura no caminho do envio: consultar a cada
   * mensagem seria uma chamada de rede por aviso.
   */
  body            text NOT NULL,
  /**
   * Os botões, na ordem. `[{"tipo":"confirmar","texto":"Confirmar"}, ...]`
   *
   * É o que a SPEC §4.12 chama de requisito e não de enfeite: o botão de
   * cancelar dentro da mensagem reduz falta **e** reduz cancelamento tardio ao
   * mesmo tempo, porque quem não precisa voltar ao site avisa com antecedência
   * em vez de simplesmente não aparecer.
   */
  buttons         jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- O limite de repetição do regex do Postgres é 255, e o nome da Meta vai a
  -- 512: o tamanho vira condição própria em vez de contador dentro do padrão.
  CONSTRAINT whatsapp_templates_nome_da_meta CHECK (
    name ~ '^[a-z0-9_]+$' AND length(name) <= 512
  ),
  CONSTRAINT whatsapp_templates_corpo_nao_vazio CHECK (length(btrim(body)) > 0),
  CONSTRAINT whatsapp_templates_rejeicao_com_motivo CHECK (
    status <> 'rejeitado' OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT whatsapp_templates_botoes_lista CHECK (jsonb_typeof(buttons) = 'array')
);

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_templates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX whatsapp_templates_nome_key
  ON whatsapp_templates (location_id, name, language);

/**
 * Um template **aprovado** por tipo e idioma.
 *
 * Índice parcial: rejeitado e rascunho podem se acumular — é o histórico de
 * tentativas, e é o que explica ao dono por que a mensagem não sai. O que não
 * pode é dois aprovados para o mesmo aviso, porque aí a escolha de qual mandar
 * seria arbitrária e mudaria entre duas leituras.
 */
CREATE UNIQUE INDEX whatsapp_templates_um_aprovado_por_tipo
  ON whatsapp_templates (location_id, kind, language)
  WHERE status = 'aprovado';

-- ----------------------------------------------------------------------------
-- As mensagens que saíram
-- ----------------------------------------------------------------------------

CREATE TYPE whatsapp_message_status AS ENUM (
  'enviada',
  'entregue',
  'lida',
  'falhou'
);

/**
 * O que a Meta contou sobre cada mensagem.
 *
 * Tabela própria e não colunas em `notifications` porque a pergunta é outra:
 * `notifications` responde "o motor decidiu mandar?", e esta responde "chegou?".
 * O estado muda **depois**, por webhook, e pode mudar mais de uma vez —
 * enviada, entregue, lida — sobre uma linha que já estava fechada.
 */
CREATE TABLE whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * O id da mensagem na Meta (`wamid...`). É a chave da idempotência.
   *
   * Único: a Meta reentrega webhook, e é comportamento normal dela. Sem a
   * unicidade, a mesma confirmação de leitura contaria duas vezes em qualquer
   * relatório que este dado alimente.
   */
  wamid           text NOT NULL,

  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES whatsapp_templates(id) ON DELETE SET NULL,

  status          whatsapp_message_status NOT NULL DEFAULT 'enviada',
  /** O que a Meta disse quando falhou. É o que a tela mostra ao dono. */
  failure_reason  text,

  sent_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  read_at         timestamptz,

  CONSTRAINT whatsapp_messages_falha_com_motivo CHECK (
    status <> 'falhou' OR failure_reason IS NOT NULL
  )
);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX whatsapp_messages_wamid_key ON whatsapp_messages (wamid);
CREATE INDEX whatsapp_messages_por_cliente_idx
  ON whatsapp_messages (customer_id, sent_at DESC);

-- ----------------------------------------------------------------------------
-- O que o cliente respondeu
-- ----------------------------------------------------------------------------

/**
 * O toque no botão da mensagem.
 *
 * Gravado **antes** de ser tratado, e por id: a Meta reentrega, e a segunda
 * entrega de "cancelar" não pode cancelar um horário que já foi remarcado por
 * cima. É o mesmo desenho do webhook do adquirente desde o bloco 36.
 *
 * O telefone entra em claro aqui porque é ele que identifica quem respondeu — a
 * Meta não manda o nosso id de cliente de volta — e sai na anonimização junto
 * com o resto. `customer_id` é resolvido na hora de tratar, não na de gravar:
 * gravar rápido é o que devolve 200 à Meta antes de ela desistir.
 */
CREATE TABLE whatsapp_inbound (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  wamid           text NOT NULL,
  from_phone      text NOT NULL,
  /** `confirmar`, `remarcar`, `cancelar`, `agendar_novamente` — ou texto livre. */
  payload         text,
  /** O texto que a pessoa digitou, quando não foi botão. */
  body            text,

  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,

  received_at     timestamptz NOT NULL DEFAULT now(),
  handled_at      timestamptz,
  /** O que foi feito, ou por que nada foi. */
  outcome         text
);

ALTER TABLE whatsapp_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_inbound
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX whatsapp_inbound_wamid_key ON whatsapp_inbound (wamid);

/** A fila de quem tocou o botão e ainda não foi atendido. */
CREATE INDEX whatsapp_inbound_a_tratar_idx
  ON whatsapp_inbound (received_at)
  WHERE handled_at IS NULL;

-- ----------------------------------------------------------------------------
-- Permissões
-- ----------------------------------------------------------------------------

/**
 * `settings.manage` e não permissão própria.
 *
 * Cadastrar o número do WhatsApp é configurar como a casa fala com o cliente —
 * a mesma natureza de horário de funcionamento e política de cancelamento. Não
 * move dinheiro e não revela dado pessoal, então não deriva segundo fator.
 *
 * A **leitura** das mensagens é outra coisa e usa `customers.view`: quem chegou
 * e quem leu é dado de cliente.
 */
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT tenant_id, role, 'whatsapp.manage'
  FROM role_permissions
 WHERE permission = 'settings.manage'
ON CONFLICT DO NOTHING;

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_conhecida;
-- A lista foi copiada da 0056, não reescrita de memória: reescrevê-la levaria
-- junto permissões que dez blocos acrescentaram, e a CHECK passaria a recusar
-- papéis que já existem. A única diferença é a última linha.
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
  'finance.subscription_manage', 'finance.split_manage',
  'finance.bills_manage', 'finance.credit_limit',
  'finance.advance', 'finance.order_refund', 'finance.package_transfer',
  'fiscal.view', 'fiscal.issue', 'fiscal.settings',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'reviews.view', 'reviews.recover',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage',
  'whatsapp.manage'
));
