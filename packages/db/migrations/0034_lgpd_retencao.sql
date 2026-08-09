-- ============================================================================
-- 0034 — LGPD: anonimização, retenção e o pipeline de exclusão
--        (bloco 32, SPEC Parte 1 §1.8, regras 3 e 6)
--
-- ## O problema que a lei cria e que o schema tem que resolver
--
-- O titular tem direito à exclusão (art. 18 VI). A barbearia tem obrigação de
-- guardar o registro financeiro. As duas coisas são verdadeiras ao mesmo tempo,
-- e apagar a linha de `customers` resolveria a primeira quebrando a segunda:
-- `orders.customer_id`, `customer_ledger.customer_id` e a comissão fechada
-- apontam para ela, e um `DELETE` levaria a venda junto (`ON DELETE CASCADE`)
-- ou deixaria a nota fiscal apontando para o nada.
--
-- A saída que a SPEC §1.8 regra 3 escolhe — e que é a leitura corrente da lei —
-- é **anonimizar, não apagar**: a linha continua, as colunas que identificam
-- uma pessoa somem, e o registro financeiro permanece sem vínculo com pessoa
-- identificável. O `customer_id` continua ligando venda a cadastro; o que
-- deixa de existir é o cadastro apontar para alguém.
--
-- ## Por que uma função `SECURITY DEFINER`, que o projeto até aqui evitou
--
-- Metade do dado a apagar mora em tabela **append-only**: `customer_consents`
-- guarda o IP de cada decisão, `customer_ledger` guarda a nota que o balcão
-- escreveu à mão. As duas revogam `UPDATE` e `DELETE` de `barbearia_app` de
-- propósito, e a decisão continua certa — prova que a aplicação reescreve não
-- prova nada.
--
-- Então existe exatamente um caminho autorizado para mexer nelas, ele é
-- nomeado, e faz uma coisa só. É o oposto de devolver `UPDATE` à aplicação:
-- com o `GRANT`, qualquer consulta do produto poderia reescrever o extrato;
-- com a função, o que existe é `anonimizar_cliente(uuid, text)` e mais nada.
--
-- **O isolamento não vem da RLS aqui, e isso é deliberado.** `SECURITY DEFINER`
-- roda como o dono das tabelas, e em produção esse papel pode ser superusuário
-- — que ignora até `FORCE ROW LEVEL SECURITY`. Depender da política seria
-- depender de quem aplicou a migração. Por isso **toda** consulta lá dentro
-- filtra `tenant_id` explicitamente contra `app.tenant_id`, e a função recusa
-- rodar sem ele. Há invariante que tenta anonimizar o cliente da vizinha e
-- confere que nada aconteceu.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O estado do cadastro
-- ---------------------------------------------------------------------------

ALTER TABLE customers
  /** Quando deixou de identificar alguém. Nulo é cadastro vivo. */
  ADD COLUMN anonymized_at timestamptz,
  /**
   * Quando o dono foi avisado de que este cadastro está para sair.
   *
   * Guardado por cliente e não por lote: o aviso é sobre **esta** pessoa, e uma
   * visita dela zera a contagem sem precisar reprocessar o lote inteiro.
   */
  ADD COLUMN retention_notified_at timestamptz;

/**
 * O telefone passa a aceitar nulo — só para quem foi anonimizado.
 *
 * Ele é a chave natural de deduplicação e a coluna mais identificadora do
 * cadastro: mantê-lo depois da anonimização faria a busca do balcão reencontrar
 * a pessoa pelo número, que é exatamente o vínculo que a operação existe para
 * cortar. Nulo em vez de um número falso porque número falso passa pela CHECK
 * de formato, ocupa o índice único e engana quem lê a tabela.
 *
 * A CHECK amarra as duas colunas: cadastro vivo **tem** telefone. Sem ela, um
 * `UPDATE` errado em qualquer parte do produto poderia zerar o telefone de um
 * cliente ativo e ninguém notaria até a próxima busca.
 */
ALTER TABLE customers
  ALTER COLUMN phone_e164 DROP NOT NULL,
  ADD CONSTRAINT customers_sem_telefone_so_anonimizado CHECK (
    phone_e164 IS NOT NULL OR anonymized_at IS NOT NULL
  );

/**
 * A varredura pergunta "quem desta barbearia ainda não foi anonimizado?".
 *
 * Parcial: a partir do quinto ano de operação a maioria dos cadastros antigos
 * já terá saído, e o índice inteiro os carregaria para sempre.
 */
CREATE INDEX customers_vivos_idx ON customers (tenant_id)
  WHERE anonymized_at IS NULL;

/**
 * "Quando esta pessoa interagiu pela última vez?" — os índices que a varredura
 * exige, criados junto com ela.
 *
 * `appointments` já tinha o dele desde o bloco 1. Faltavam `orders` e
 * `queue_entries`: a varredura pergunta o máximo por cliente nas três, e sem
 * índice cada pergunta vira varredura completa da tabela de vendas — que é a
 * que mais cresce no produto.
 *
 * Não são parciais: a pergunta é sobre o **máximo**, e um filtro por status
 * deixaria de fora justamente a comanda antiga que define a data.
 */
CREATE INDEX orders_customer_idx ON orders (customer_id, opened_at DESC);
CREATE INDEX queue_entries_customer_idx ON queue_entries (customer_id, joined_at DESC);

-- ---------------------------------------------------------------------------
-- A anonimização
-- ---------------------------------------------------------------------------

/**
 * Apaga o que identifica a pessoa e preserva o que a lei manda guardar.
 *
 * Devolve `true` quando anonimizou, `false` quando não havia o que fazer —
 * cadastro de outra barbearia, inexistente, ou já anonimizado. **Não levanta
 * exceção nesses casos, de propósito**: a varredura de retenção processa lote,
 * e uma linha que outro processo acabou de anonimizar não pode derrubar as
 * outras quarenta.
 *
 * O que sai:
 *   nome, telefone, nascimento, IP do consentimento, a ficha inteira
 *   (o que evitar, o degradê, a anotação), a nota da fila, a nota do extrato,
 *   o telefone mascarado das mensagens e toda sessão aberta no navegador dele.
 *
 * O que fica:
 *   as vendas, os valores, as datas, a comissão apurada e o extrato do fiado —
 *   com os centavos intactos e a nota em branco. É o registro que a obrigação
 *   fiscal exige, agora sem pessoa identificável do outro lado.
 *
 * `customer_consents` fica com a **decisão** e perde o IP: a prova de que houve
 * aceite continua existindo, e o que era dado pessoal dentro dela sai.
 *
 * `otp_challenges` some inteiro para aquele número, e a `/security-review` deste
 * bloco foi quem cobrou. Aquela tabela guarda o telefone em claro **e**
 * `pending_name` — e `verifyOtp` reaproveita o `pending_name` ao criar o
 * cadastro. Sem apagá-la, a mesma pessoa entrando de novo com o número antigo
 * teria o **nome verdadeiro** de volta, num cadastro novo: a anonimização
 * desfeita pela porta dos fundos, sem ninguém notar.
 */
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

/**
 * Executável só pela aplicação, e por ninguém mais.
 *
 * `PUBLIC` inclui todo papel futuro do cluster. Uma função `SECURITY DEFINER`
 * aberta a `PUBLIC` é escalonamento de privilégio esperando acontecer.
 */
REVOKE EXECUTE ON FUNCTION anonimizar_cliente(uuid, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    -- Só isto: `customers` já é escrita pela aplicação desde a 0002, e o
    -- carimbo do aviso de retenção mora lá. O que precisava de porta era o que
    -- é append-only, e a porta é esta função.
    GRANT EXECUTE ON FUNCTION anonimizar_cliente(uuid, text) TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A permissão de anonimizar
-- ---------------------------------------------------------------------------

/**
 * `customers.anonymize` entra no vocabulário.
 *
 * O `CHECK` espelha `packages/core/src/permissoes.ts`, e a duplicação é
 * deliberada desde o bloco 16: é o banco que impede uma permissão inventada de
 * ser concedida numa correção manual de madrugada. Há teste que reprova se as
 * duas listas divergirem.
 *
 * **Nenhum `INSERT` de retrocompatibilidade aqui**, ao contrário da 0032. Lá a
 * migração acrescentou vocabulário para capacidades que as pessoas já
 * exerciam — quem escrevia anotação continuou escrevendo. Esta é uma capacidade
 * que ninguém tinha, porque não existia: distribuí-la automaticamente para
 * quem tem `settings.manage` seria conceder a destruição da base a todo gerente
 * sem que ninguém decidisse isso.
 *
 * O dono continua com tudo pela semente de papel do bloco 16, que insere
 * `PERMISSOES` inteiro para `owner`.
 */
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));

INSERT INTO role_permissions (tenant_id, role, permission)
SELECT id, 'owner', 'customers.anonymize' FROM tenants
ON CONFLICT DO NOTHING;
