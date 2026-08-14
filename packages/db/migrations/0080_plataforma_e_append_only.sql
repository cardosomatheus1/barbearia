-- ============================================================================
-- 0080 — o que a revisão geral achou nas políticas e nos privilégios
--
-- Duas famílias, e as duas são a mesma frase por ângulos diferentes: **o que
-- protege é a política ou o `REVOKE`, nunca o `GRANT`** — a migração 0002
-- instala `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE`,
-- e listar menos verbos num `GRANT` posterior não retira nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — as quatro tabelas de plataforma da 0026 nunca foram apertadas
--
-- Elas nasceram com `FOR ALL USING (true) WITH CHECK (true)`, o que é RLS
-- ligada sem proteção nenhuma — nem contra uma consulta rodando **com** tenant
-- no contexto. A partir da 0028 o repositório passou a escrever a forma certa
-- para escrita de tabela de plataforma:
--
--     USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
--
-- e a aplicou em `feature_flags`, `tenant_features`, `plan_features`,
-- `subscriptions`, `invoices`, `billing_customers`, `psp_events`, `refunds`,
-- `franchises`, `franchise_tenants` e `marketplace_ads`. As quatro primeiras
-- ficaram para trás.
--
-- O peso está em `tenant_platform`. A `/security-review` do bloco 49 moveu
-- `platform_fee_bps` de `tenants` para lá **exatamente** porque, numa coluna de
-- `tenants`, a rota do painel deixava o cliente definir o preço que paga —
-- zerá-la desligava a receita sem nada falhar. Hoje ela guarda também
-- `marketplace_fee_bps` e `blocked_at`, e `packages/finance/src/split.ts` a lê
-- de dentro de um `withTenant`: o contexto de tenant **alcança** a tabela. O que
-- impede o mesmo exploit hoje é o caminho de acesso — e a conclusão daquele
-- bloco foi, em letras, que o caminho de acesso não basta.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS plans_escrita ON plans;
CREATE POLICY plans_escrita ON plans
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

/**
 * `tenant_platform`: a política fica, e quem trava é o **gatilho**.
 *
 * Duas tentativas erradas antes desta, e as duas o portão pegou:
 *
 * 1. fechar a escrita inteira quebrou oitenta e nove testes de identidade — a
 *    linha nasce por gatilho em `tenants`, o espelho;
 * 2. fechar só o `UPDATE` quebrou o onboarding — `atualizar_cadeiras_em_uso()`
 *    escreve `chairs_in_use` por gatilho, e `SECURITY DEFINER` **não** basta
 *    contra `FORCE ROW LEVEL SECURITY`, que sujeita até o dono da tabela.
 *
 * Ou seja: a tabela é escrita pelo lado da barbearia o tempo todo, de propósito.
 * O que ela não pode escrever são as **três colunas comerciais** — e RLS não
 * recorta coluna, então o recorte é gatilho, como em `marketplace_attributions`.
 *
 * O achado do bloco 49 é este e nenhum outro: `platform_fee_bps` e
 * `marketplace_fee_bps` são o preço que a barbearia paga, e `blocked_at` é o
 * bloqueio que ela cumpre. Numa coluna de `tenants` a rota do painel deixava o
 * cliente definir o próprio preço; mover a coluna resolveu o caminho, e a
 * conclusão daquele bloco foi que o caminho de acesso não basta.
 */
CREATE OR REPLACE FUNCTION tenant_platform_termo_comercial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps
     OR NEW.marketplace_fee_bps IS DISTINCT FROM OLD.marketplace_fee_bps
     OR NEW.blocked_at IS DISTINCT FROM OLD.blocked_at
  THEN
    RAISE EXCEPTION 'o termo comercial é da plataforma, não da barbearia'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER tenant_platform_termo_comercial
  BEFORE UPDATE ON tenant_platform
  FOR EACH ROW EXECUTE FUNCTION tenant_platform_termo_comercial();

/**
 * `platform_admins` e `platform_sessions` não têm ramo de leitura aberto.
 *
 * Elas são a conta e a sessão de quem administra a **plataforma**, e nada do
 * lado da barbearia precisa lê-las: quem as consulta é o painel da plataforma,
 * que roda sem tenant no contexto. Aqui a política estrita cobre leitura e
 * escrita de uma vez.
 */
DROP POLICY IF EXISTS platform_admins_acesso ON platform_admins;
CREATE POLICY platform_admins_acesso ON platform_admins
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

DROP POLICY IF EXISTS platform_sessions_acesso ON platform_sessions;
CREATE POLICY platform_sessions_acesso ON platform_sessions
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

-- ---------------------------------------------------------------------------
-- 2 — os `REVOKE` que catorze tabelas acharam que tinham
--
-- Cada uma delas recebeu um `GRANT` explícito listando menos verbos do que o
-- padrão da 0002 concede, e o comentário ao lado descreve a tabela como
-- append-only. Conceder não revoga: o verbo omitido continuava lá.
--
-- `online_blocks` é o mais nítido. A convenção diz que o interruptor que recusa
-- "vem com a lista de quem ele recusou, **com o valor congelado no momento**" —
-- e a lista aceitava `UPDATE` e `DELETE`. `stock_transfers` é o segundo: o teste
-- da 0061 afirma "transferência é append-only para a aplicação" e confere só o
-- `DELETE`, enquanto os testes equivalentes de `split_transfers` e
-- `package_transfers` conferem os dois.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON online_blocks FROM barbearia_app;
REVOKE UPDATE ON stock_transfers FROM barbearia_app;
/**
 * `order_charge_events` **não** entra, e o teste mostrou por quê.
 *
 * O `GRANT SELECT, INSERT` da 0037 parecia dizer append-only, e o `REVOKE`
 * correspondente derrubou nove testes de cobrança: a linha nasce como
 * reivindicação de idempotência — "este evento é meu" — e é **fechada** depois
 * com o desfecho e o id da cobrança. São duas escritas do mesmo fato, não uma
 * reescrita.
 *
 * Fica registrado porque a leitura do `GRANT` sugeria o contrário, e o próximo
 * a revisar vai tropeçar na mesma pedra.
 */
REVOKE UPDATE ON tenant_alerts_sent FROM barbearia_app;

/**
 * O `DELETE` de cadastro é outra conversa, e por isso não entra aqui.
 *
 * `products`, `packages`, `club_plans` e `loyalty_programs` receberam `GRANT`
 * sem `DELETE` e o mantiveram — mas nenhuma delas é append-only por natureza:
 * são catálogo, e apagar catálogo é operação legítima que hoje não tem rota. O
 * que se revoga abaixo é só o que o próprio comentário da migração de origem
 * chamou de imutável.
 */
REVOKE DELETE ON data_requests FROM barbearia_app;
REVOKE DELETE ON login_attempts FROM barbearia_app;

-- ---------------------------------------------------------------------------
-- 3 — `marketplace_attributions`: a barbearia escreve a própria comissão
--
-- A escrita foi aberta ao tenant no bloco 72 com justificativa escrita —
-- "contestar é direito dela". Mas RLS **não recorta coluna**, e não há gatilho
-- congelando `base_cents`, `fee_bps`, `fee_cents`, `status` nem `invoice_id`.
-- O contraste está no comentário da tabela ao lado: `invoices` tem escrita só
-- sem tenant *"porque uma barbearia que pudesse escrever na própria fatura se
-- daria baixa sozinha"*. Aqui ela podia escrever a linha inteira da comissão
-- que deve.
--
-- O produto já usa gatilho para exatamente isto — a nota imutável do bloco 43,
-- a comissão fechada do 19. O que a barbearia pode mexer é só o que a
-- contestação precisa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marketplace_attributions_congelada() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /**
   * O corte é por **coluna**, não por quem está escrevendo.
   *
   * A primeira versão isentava a escrita sem tenant, presumindo que "com tenant
   * é a barbearia". É falso: a emissão da fatura roda `withTenant` de propósito,
   * porque a política de escrita da tabela é do tenant. O gatilho reprovou a
   * própria plataforma cobrando, e a suíte de atribuição pegou na hora.
   *
   * O que ninguém reescreve — nem a casa, nem a plataforma — é o **valor** da
   * comissão e de quem ela é. `status`, `contested_at` e `contested_reason`
   * ficam livres: são a contestação, que é direito da barbearia, e a reversão,
   * que é da plataforma.
   */
  IF NEW.base_cents IS DISTINCT FROM OLD.base_cents
     OR NEW.fee_bps IS DISTINCT FROM OLD.fee_bps
     OR NEW.fee_cents IS DISTINCT FROM OLD.fee_cents
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
  THEN
    RAISE EXCEPTION 'o valor da comissão do marketplace não se reescreve'
      USING ERRCODE = 'check_violation';
  END IF;

  /**
   * `invoice_id` é escrito **uma vez**, enquanto é nulo.
   *
   * É o precedente de `psp_charge_id`: apontar a comissão para outra fatura, ou
   * desapontá-la, é a barbearia se dando baixa sozinha — que é exatamente o que
   * o comentário de `invoices` diz que não pode acontecer.
   */
  IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'a comissão já faturada não muda de fatura'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER marketplace_attributions_congelada
  BEFORE UPDATE ON marketplace_attributions
  FOR EACH ROW EXECUTE FUNCTION marketplace_attributions_congelada();

-- ---------------------------------------------------------------------------
-- 4 — `entrega_de_webhook` ganha a guarda que as outras oito têm
--
-- Ela é a única função `SECURITY DEFINER` do schema sem recorte escrito dentro:
-- devolve `url` e `secret_cipher` de **qualquer** entrega, de qualquer
-- barbearia, para qualquer transação. Hoje o único chamador é o worker, com um
-- id que ele mesmo enfileirou, e o segredo sai cifrado — mas a convenção deste
-- repositório é explícita nos dois sentidos, e o dia em que existir uma tela de
-- "reenviar esta entrega" que receba o id pelo corpo, isso vira leitura de
-- endereço alheio sem nada ficar vermelho.
--
-- A condição real de uso é "worker, sem tenant no contexto", e é ela que fica
-- escrita: com tenant, a leitura tem que passar pela política de sempre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entrega_de_webhook(p_id uuid)
RETURNS TABLE (
  payload    jsonb,
  attempts   smallint,
  url        text,
  segredo    text,
  ativo      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.payload, d.attempts, e.url, e.secret_cipher, e.active
    FROM public.webhook_deliveries d
    JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
   WHERE d.id = p_id AND d.status = 'pendente'
     -- A guarda escrita dentro: esta funcao existe para o worker, que roda sem
     -- tenant. Com tenant no contexto, a leitura passa pela politica da tabela.
     AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
$$;

REVOKE ALL ON FUNCTION entrega_de_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entrega_de_webhook(uuid) TO barbearia_app;

-- ---------------------------------------------------------------------------
-- 5 — as dez cascatas que a varredura global achou
--
-- As seis varreduras por tabela que existiam falhavam pelo **recorte**, não
-- pela exceção: a da 0062 filtrava `attname = 'location_id'`, então
-- `customer_id` era invisível; a da 0054 listava duas tabelas e deixava
-- `financial_accounts` de fora, apesar de ela receber `REVOKE DELETE` na mesma
-- migração. A pergunta ao catálogo, em `test/0080_cascata_global.test.sql`,
-- acha as dez de uma vez — quatro delas nunca tinham sido listadas por revisão
-- nenhuma.
--
-- `RESTRICT` na maioria: numa tabela que a aplicação não pode apagar, a cascata
-- é o caminho de destruição que o `REVOKE` existia para fechar, e travar a
-- remoção do pai é a recusa honesta. `SET NULL` só onde perder o vínculo é o
-- comportamento certo e já é o de um irmão — `commission_entries.professional_id`
-- fica igual a `commission_closure_lines.professional_id` e a
-- `payment_splits.professional_id`, que já eram `SET NULL`.
-- ---------------------------------------------------------------------------
ALTER TABLE commission_entries ALTER COLUMN professional_id DROP NOT NULL;
ALTER TABLE commission_entries DROP CONSTRAINT commission_entries_professional_id_fkey;
ALTER TABLE commission_entries
  ADD CONSTRAINT commission_entries_professional_id_fkey
  FOREIGN KEY (professional_id) REFERENCES professionals(id) ON DELETE SET NULL;

ALTER TABLE club_uses ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE club_uses DROP CONSTRAINT club_uses_subscription_id_fkey;
ALTER TABLE club_uses
  ADD CONSTRAINT club_uses_subscription_id_fkey
  FOREIGN KEY (subscription_id) REFERENCES club_subscriptions(id) ON DELETE SET NULL;

-- O resto trava: apagar o pai destruiria registro de dinheiro ou de reclamação,
-- e nenhuma rota do produto apaga esses pais hoje. `RESTRICT` transforma a
-- ausência de rota em garantia do banco.
ALTER TABLE commission_closure_lines DROP CONSTRAINT commission_closure_lines_closure_id_fkey;
ALTER TABLE commission_closure_lines
  ADD CONSTRAINT commission_closure_lines_closure_id_fkey
  FOREIGN KEY (closure_id) REFERENCES commission_closures(id) ON DELETE RESTRICT;

/**
 * O razão do fiado trava, e é o mais importante dos dez.
 *
 * Ele é a única explicação de cada centavo quando o cliente discorda, e era
 * alcançável por `reverterImportacao` — cuja guarda já recusa reverter quando há
 * razão. `RESTRICT` é essa guarda escrita onde não depende de ninguém lembrar.
 */
ALTER TABLE customer_ledger DROP CONSTRAINT customer_ledger_customer_id_fkey;
ALTER TABLE customer_ledger
  ADD CONSTRAINT customer_ledger_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE feedbacks DROP CONSTRAINT feedbacks_location_id_fkey;
ALTER TABLE feedbacks
  ADD CONSTRAINT feedbacks_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;

ALTER TABLE financial_accounts DROP CONSTRAINT financial_accounts_location_id_fkey;
ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;

ALTER TABLE franchise_services DROP CONSTRAINT franchise_services_franchise_id_fkey;
ALTER TABLE franchise_services
  ADD CONSTRAINT franchise_services_franchise_id_fkey
  FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE RESTRICT;

ALTER TABLE order_charges DROP CONSTRAINT order_charges_location_id_fkey;
ALTER TABLE order_charges
  ADD CONSTRAINT order_charges_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;

ALTER TABLE order_charges DROP CONSTRAINT order_charges_order_id_fkey;
ALTER TABLE order_charges
  ADD CONSTRAINT order_charges_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;

ALTER TABLE package_uses DROP CONSTRAINT package_uses_customer_package_id_fkey;
ALTER TABLE package_uses
  ADD CONSTRAINT package_uses_customer_package_id_fkey
  FOREIGN KEY (customer_package_id) REFERENCES customer_packages(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 6 — `cash_movements` nunca teve o `REVOKE` que o produto inteiro presume
--
-- Achado da varredura de privilégio, e é o mais surpreendente dos dois lotes: a
-- convenção escrita diz *"o dinheiro saiu e `cash_movements` registrou, que é
-- **append-only desde o bloco 18**"*, e é sobre essa premissa que a decisão de
-- "conta paga pela gaveta não volta atrás" se apoia. O privilégio nunca foi
-- revogado — a aplicação tinha `UPDATE` e `DELETE` na tabela.
--
-- Ninguém os usa (nenhum `UPDATE cash_movements` nem `DELETE FROM
-- cash_movements` no código), o que é o motivo de nunca ter aparecido: a
-- garantia era mantida por disciplina, não pelo banco. E a diferença entre as
-- duas é exatamente o que o extrato do caixa precisa quando o fechamento acusa
-- falta e ninguém explica.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON cash_movements FROM barbearia_app;

/**
 * E o `REVOKE` acima revelou uma cascata que ele mesmo escondia.
 *
 * `cash_movements.session_id` era `CASCADE`, e a varredura não a via porque a
 * tabela ainda tinha `DELETE` — a pergunta é "cascata onde a aplicação **não**
 * pode apagar". Fechado o privilégio, ela apareceu na mesma execução.
 *
 * É o argumento inteiro para a varredura ser derivada e não uma lista: as duas
 * metades do mesmo defeito se escondiam uma atrás da outra, e nenhuma revisão
 * de leitura ligou as duas.
 */
ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_session_id_fkey;
ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES cash_sessions(id) ON DELETE RESTRICT;
