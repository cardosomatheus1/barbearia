-- ============================================================================
-- 0035 — Segurança: força bruta, papéis na plataforma e o canal do alerta
--        (bloco 33, SPEC Parte 5 §5.12)
--
-- Três coisas que não têm nada a ver entre si, e é de propósito: são as três
-- que faltavam para o produto ter uma postura de segurança em vez de uma lista
-- de controles avulsos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Força bruta no login
-- ---------------------------------------------------------------------------

/**
 * A contagem de erros por **conta e origem**, e a chave é o ponto do desenho.
 *
 * ## Por que não por IP só
 *
 * O teto por IP existe desde o bloco 4 e continua necessário — é o que segura
 * varredura de endpoint caro. Para adivinhar **uma senha** ele não serve: mil
 * tentativas de mil endereços são baratas.
 *
 * ## Por que não por conta só
 *
 * Porque vira arma. Uma escada por conta que recusa mesmo a senha certa
 * transforma "adivinhar a senha do dono" em "trancar o dono fora do próprio
 * negócio": basta errar de propósito uma vez a cada meia hora, de qualquer
 * endereço, e a conta nunca abre. Foi o que a primeira versão desta tabela
 * fazia, e a `/security-review` do bloco 33 apontou — o bloqueio custava ao
 * atacante 48 requisições por dia e custava ao dono o fim de semana inteiro.
 *
 * ## Por conta **e** origem
 *
 * O atacante tranca a escada dele, não a do dono — porque o dono entra de outro
 * endereço. Ataque distribuído continua barrado pelo teto por IP, que é o que
 * limita quantos endereços um atacante consegue usar por minuto.
 *
 * O IP é `inet` e aceita nulo: requisição sem endereço conhecido cai numa
 * escada só, que é o comportamento conservador.
 *
 * ## Sem tenant, e por isso com HMAC
 *
 * Mesma situação de `staff_directory`: o login precisa consultar **antes** de
 * saber de que barbearia é a conta. Então a tabela não tem `tenant_id`, a
 * política é `USING (true)`, e a chave é o mesmo HMAC do e-mail que aquela
 * tabela usa — e-mail em claro numa tabela de leitura ampla é a lista de
 * clientes da plataforma exposta a qualquer consulta que escape.
 *
 * O HMAC do login da plataforma é **separado por domínio** (`plataforma:` no
 * material antes do HMAC). Sem isso, marretar `/v1/admin/login` com o endereço
 * do plantonista trancaria o painel da plataforma pela porta da barbearia — que
 * é a porta que qualquer um alcança.
 */
CREATE TABLE login_attempts (
  email_key      text NOT NULL,
  /** Nulo quando a origem não é conhecida. Todos eles caem na mesma escada. */
  ip             inet,
  failures       smallint NOT NULL DEFAULT 0,
  last_failure_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT login_attempts_failures_non_negative CHECK (failures >= 0)
);

/**
 * `COALESCE` na chave porque `NULL` não é igual a `NULL` num índice único.
 *
 * Sem isto, toda tentativa sem IP conhecido criaria uma linha nova e a escada
 * nunca subiria para elas — que é justamente o caminho que um atacante
 * escolheria.
 */
CREATE UNIQUE INDEX login_attempts_chave
  ON login_attempts (email_key, COALESCE(ip, '::'::inet));

ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts FORCE ROW LEVEL SECURITY;

/**
 * `USING (true)`, como `staff_directory`.
 *
 * Não é descuido: a tabela não guarda dado de negócio nenhum — um HMAC, um
 * contador e uma data. O que ela responde ("esta chave está de castigo?") é
 * perguntado antes de existir tenant no contexto, e uma política por
 * `app.tenant_id` devolveria zero linhas sempre, desligando a proteção em
 * silêncio.
 */
CREATE POLICY login_attempts_acesso ON login_attempts FOR ALL USING (true) WITH CHECK (true);

/** A limpeza do que já foi esquecido roda por data. */
CREATE INDEX login_attempts_velhas ON login_attempts (last_failure_at);

-- ---------------------------------------------------------------------------
-- Papéis dentro da plataforma
-- ---------------------------------------------------------------------------

/**
 * Quem só consulta, e quem mexe na conta do cliente.
 *
 * Era lacuna declarada desde o bloco 26, e a razão de esperar está escrita lá:
 * havia **uma** conta, criada por quem tem acesso ao banco de produção, e
 * inventar papéis antes de existir a segunda pessoa criaria permissão que
 * nenhuma conta distingue.
 *
 * O que mudou é que agora existe o que separar. Depois dos blocos 28 e 29 uma
 * conta de plataforma bloqueia barbearia, liga recurso, entra na conta do
 * cliente por suporte assistido e cancela cobrança. Isso é poder demais para
 * quem foi contratado para responder chamado e olhar métrica.
 *
 * `operator` para as existentes: tirar capacidade de quem já opera, numa
 * migração, é derrubar quem está trabalhando. Contas novas nascem `viewer` pelo
 * padrão da coluna, que é o lado seguro.
 */
CREATE TYPE platform_role AS ENUM ('viewer', 'operator');

ALTER TABLE platform_admins
  ADD COLUMN role platform_role NOT NULL DEFAULT 'viewer';

UPDATE platform_admins SET role = 'operator';

-- ---------------------------------------------------------------------------
-- O canal do alerta operacional
-- ---------------------------------------------------------------------------

/**
 * O que o dono quer que interrompa o dia dele.
 *
 * A lacuna declarada desde o bloco 22 dizia que faltava "ligar o alerta
 * operacional no canal" — e que o que sobrava era **decisão de produto**: o que
 * merece interromper o dono, e com que frequência. É esta tabela.
 *
 * Um registro por barbearia, criado sob demanda: sem linha, valem os padrões
 * abaixo. Crítico ligado e aviso desligado é a escolha certa para começar —
 * alerta que dispara à toa é alerta que se aprende a ignorar, e um canal
 * ignorado é pior do que canal nenhum, porque dá a sensação de estar coberto.
 */
CREATE TABLE tenant_alert_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  /** Fila travada, queda de volume — o que exige alguém agir hoje. */
  enviar_critico boolean NOT NULL DEFAULT true,
  /** O mesmo sinal em intensidade menor. Desligado por padrão. */
  enviar_aviso   boolean NOT NULL DEFAULT false,
  /** Cadastro que sai por retenção (bloco 32). Ligado: é obrigação legal. */
  enviar_retencao boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_alert_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_alert_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * O que já foi avisado, para não avisar de novo.
 *
 * Sem isto o mesmo alerta sai todo dia enquanto a causa não for resolvida — e
 * "a fila está travada" repetido por uma semana é como o dono aprende a
 * arquivar a mensagem sem ler. A chave inclui o dia: o alerta volta amanhã se a
 * situação continuar, mas uma vez por dia, não a cada volta do worker.
 *
 * `code` é o identificador da regra (`volume_caiu`, `fila_travada`,
 * `retencao`), não o texto: o texto muda, a regra não.
 */
CREATE TABLE tenant_alerts_sent (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  dia        date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code, dia)
);

ALTER TABLE tenant_alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_alerts_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_alerts_sent
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON login_attempts TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON tenant_alert_settings TO barbearia_app;
    GRANT SELECT, INSERT ON tenant_alerts_sent TO barbearia_app;
    -- Sem `DELETE` em `tenant_alerts_sent`: o registro de que o dono foi
    -- avisado é o que responde "por que ninguém me contou?" depois.
    REVOKE DELETE ON tenant_alerts_sent FROM barbearia_app;
  END IF;
END $$;
