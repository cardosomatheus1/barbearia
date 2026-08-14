-- ============================================================================
-- 0073 — franquia: catálogo padrão e preço de referência (bloco 76)
--
-- ## Franquia não é multiunidade, e a diferença decide o schema inteiro
--
-- O bloco 58 entregou **multiunidade**: uma barbearia (um tenant) com várias
-- `locations`. Mesmo dono, mesmo dinheiro, mesma equipe, mesmo CNPJ — a loja
-- nova é um endereço a mais dentro do mesmo negócio.
--
-- Franquia é outra coisa: **vários tenants**. Cada franqueada tem CNPJ próprio,
-- caixa próprio, equipe própria e clientes próprios, e a franqueadora não tem
-- nada disso — ela tem uma marca e um padrão. É o precedente de `subscriptions`
-- × `club_subscriptions`: duas coisas que o mercado chama de "rede", e
-- confundi-las no schema seria confundi-las em toda consulta daqui para a
-- frente.
--
-- Daí a decisão que atravessa este arquivo: **franquia mora acima do tenant**.
-- `franchises` não tem `tenant_id`, como `plans`. Quem liga os dois lados é
-- `franchise_tenants`.
--
-- ## O preço é de referência, nunca imposto
--
-- A franqueadora publica o cardápio padrão com um preço; a franqueada adota o
-- item e **decide o preço dela**. Não existe caminho neste schema pelo qual o
-- número da franqueadora vire o número cobrado sem alguém da franqueada mandar.
--
-- Duas razões, e as duas são verdadeiras ao mesmo tempo:
--
-- 1. A franqueada é outra empresa. Impor preço de revenda a um distribuidor
--    independente é infração à ordem econômica — Lei 12.529/2011, art. 36
--    §3º IX. Um produto que fizesse isso por padrão entregaria o problema
--    pronto para o cliente dele.
-- 2. É a mesma forma do bloco 68: *"a IA recomenda, a pessoa aprova"*. Lá o
--    invariante reprova coluna onde um algoritmo escreva preço; aqui quem
--    sugere é gente de outra empresa, e por isso a coluna existe — mas ela
--    mora em tabela **separada** de `services`, que é onde o preço cobrado
--    vive. O caminho da adoção copia uma vez; republicar não reescreve nada.
--
-- É o mesmo par que o `CLAUDE.md` já escreve para `ON CONFLICT`: `DO NOTHING`
-- semeia padrão e respeita quem já decidiu; `DO UPDATE` sobrescreve escolha.
-- ============================================================================

CREATE TYPE franchise_role AS ENUM ('franqueadora', 'franqueada');

CREATE TABLE franchises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT franchises_nome_nao_vazio CHECK (length(btrim(name)) > 0)
);

/**
 * Quem é de qual franquia, e em que papel.
 *
 * `tenant_id` é a chave primária: uma barbearia pertence a **uma** franquia.
 * Duas seriam dois cardápios padrão sobre o mesmo catálogo, e a pergunta "qual
 * é o preço de referência deste corte?" passaria a ter duas respostas.
 *
 * `ON DELETE CASCADE` no tenant porque a linha só descreve um vínculo: apagada
 * a barbearia, não há vínculo a preservar. `RESTRICT` na franquia, porque
 * apagar uma franquia com franqueadas dentro é a operação destrutiva que
 * ninguém quis fazer.
 */
CREATE TABLE franchise_tenants (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  franchise_id  uuid NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
  role          franchise_role NOT NULL DEFAULT 'franqueada',
  joined_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX franchise_tenants_por_franquia ON franchise_tenants (franchise_id);

/**
 * Uma franqueadora por franquia.
 *
 * Índice único parcial, como a conta do barbeiro no bloco 29: duas
 * franqueadoras seriam duas mãos publicando o mesmo cardápio, e a última a
 * salvar venceria em silêncio.
 */
CREATE UNIQUE INDEX franchise_tenants_uma_franqueadora
  ON franchise_tenants (franchise_id) WHERE role = 'franqueadora';

/**
 * A franquia do tenant no contexto, e o papel dele nela.
 *
 * `SECURITY DEFINER` pelo mesmo motivo de `anonimizar_cliente` e de
 * `consentimento_vigente`: elas são chamadas de **dentro de políticas de RLS**,
 * e uma política que consultasse `franchise_tenants` diretamente cairia na
 * política daquela tabela — recursão infinita, que o Postgres recusa em tempo
 * de execução.
 *
 * E, como manda a convenção, o filtro de tenant está **escrito dentro**: função
 * `SECURITY DEFINER` roda como dono e a RLS pode não valer para ela.
 */
CREATE FUNCTION franquia_do_contexto() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ft.franchise_id FROM public.franchise_tenants ft
   WHERE ft.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION papel_na_franquia() RETURNS franchise_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ft.role FROM public.franchise_tenants ft
   WHERE ft.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

/**
 * O cardápio padrão da franquia.
 *
 * `reference_price_cents` é o preço **de referência**, e o nome importa: ele
 * nunca é cobrado de ninguém. O que é cobrado mora em `services.price_cents`,
 * de cada franqueada, e chega lá uma vez só — no momento em que alguém de lá
 * adota o item.
 *
 * `duration_minutes` vai junto porque duração é padrão de operação e não preço:
 * a franqueadora que padroniza "corte de 30 minutos" está padronizando a grade,
 * que é dela por contrato. O valor cobrado é que não é.
 */
CREATE TABLE franchise_services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id          uuid NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  reference_price_cents integer NOT NULL,
  duration_minutes      smallint NOT NULL,
  category_name         text,
  position              smallint NOT NULL DEFAULT 0,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT franchise_services_nome_nao_vazio CHECK (length(btrim(name)) > 0),
  CONSTRAINT franchise_services_preco_nao_negativo CHECK (reference_price_cents >= 0),
  CONSTRAINT franchise_services_duracao_positiva CHECK (duration_minutes > 0)
);

CREATE UNIQUE INDEX franchise_services_nome_unico
  ON franchise_services (franchise_id, lower(btrim(name)));

/**
 * RLS pela **participação**, não por `tenant_id` — a coluna não existe aqui, e
 * é de propósito: o cardápio é da franquia, não de nenhuma das barbearias.
 *
 * Leitura: quem é da franquia lê o cardápio dela. A plataforma, que roda sem
 * tenant, lê tudo — é ela quem monta a franquia.
 *
 * Escrita: **só a franqueadora**, e quem impõe isso é a política. Sem ela a
 * garantia seria uma checagem de rota, e a franqueada que chamasse a rota da
 * franqueadora reescreveria o padrão da rede inteira. Aqui o banco recusa.
 */
ALTER TABLE franchise_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchise_services FORCE ROW LEVEL SECURITY;

CREATE POLICY franchise_services_leitura ON franchise_services FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR franchise_id = franquia_do_contexto()
);
CREATE POLICY franchise_services_escrita ON franchise_services FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR (franchise_id = franquia_do_contexto() AND papel_na_franquia() = 'franqueadora')
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR (franchise_id = franquia_do_contexto() AND papel_na_franquia() = 'franqueadora')
  );

/**
 * `franchises` e `franchise_tenants` **com** RLS, e a forma é a de `invoices`:
 * a plataforma escreve, a barbearia lê o que é dela.
 *
 * A primeira versão deixou as duas sem política, com um `GRANT SELECT` como
 * única defesa. **Aquele `GRANT` não defendia nada**: a migração 0002 instala
 * `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE`, então
 * toda tabela nova já nasce com os quatro para `barbearia_app` — e conceder não
 * revoga. As duas ficaram com DML completo e sem row security.
 *
 * O estrago não era teórico: `franchise_tenants` é a tabela que decide **de qual
 * franquia cada barbearia é e em que papel**, e é dela que as duas funções
 * `SECURITY DEFINER` acima derivam a política de `franchise_services`. Escrever
 * nela é escrever a própria política — uma barbearia qualquer se punha como
 * franqueadora de uma rede alheia e reescrevia o padrão dela. Achado da
 * `/security-review` do bloco 76.
 *
 * A escrita fica **só sem tenant**, que é como a plataforma roda. A leitura da
 * participação é a linha da própria barbearia; o nome da marca é `USING (true)`,
 * como `tenant_platform`, porque é o que a fachada da franqueada já mostra.
 *
 * Sem recursão: a política de participação é uma comparação direta com o
 * contexto, sem subconsulta. É por isso que as funções `SECURITY DEFINER`
 * continuam funcionando com ela ligada — a consulta delas filtra exatamente o
 * que a política exige.
 */
ALTER TABLE franchises ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchises FORCE ROW LEVEL SECURITY;
CREATE POLICY franchises_leitura ON franchises FOR SELECT USING (true);
CREATE POLICY franchises_escrita ON franchises FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

ALTER TABLE franchise_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchise_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY franchise_tenants_leitura ON franchise_tenants FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY franchise_tenants_escrita ON franchise_tenants FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

/**
 * A franquia não é apagável pela aplicação: `sairDaFranquia` apaga o **vínculo**,
 * e dissolver a rede é operação que não existe ainda. `franchise_tenants`
 * mantém o `DELETE` porque é exatamente o que sair de uma rede faz — e a
 * política acima já limita quem pode.
 */
REVOKE DELETE ON franchises FROM barbearia_app;
REVOKE DELETE ON franchise_services FROM barbearia_app;

/**
 * De qual item do padrão este serviço veio.
 *
 * `ON DELETE SET NULL`: a franqueadora tirar o item do cardápio padrão não pode
 * apagar o serviço que a franqueada vende há dois anos — `appointment_services`
 * aponta para `services.id`, e apagar levaria o passado junto. O vínculo se
 * desfaz; o serviço fica.
 *
 * `adopted_at` guarda **quando** o preço de referência foi copiado. Sem ele não
 * há como dizer "você adotou este item quando ele custava R$ 45, e hoje o
 * padrão é R$ 55" — que é a única frase útil que a franqueadora tem para dizer,
 * já que ela não pode mudar o preço da franqueada.
 */
ALTER TABLE services
  ADD COLUMN franchise_service_id uuid REFERENCES franchise_services(id) ON DELETE SET NULL,
  ADD COLUMN adopted_at timestamptz;

CREATE UNIQUE INDEX services_um_por_item_do_padrao
  ON services (tenant_id, franchise_service_id)
  WHERE franchise_service_id IS NOT NULL AND active;

COMMENT ON TABLE franchises IS
  'Franquia: marca acima do tenant (bloco 76). Nao confundir com locations, '
  'que e multiunidade dentro de uma barbearia so.';
COMMENT ON COLUMN franchise_services.reference_price_cents IS
  'Preco de referencia da franqueadora. Nunca cobrado: o cobrado e '
  'services.price_cents de cada franqueada, copiado uma vez na adocao.';

-- ----------------------------------------------------------------------------
-- A permissão nova, no `CHECK` que o bloco 32 criou.
--
-- `franchise.manage` é da franqueadora: publicar o cardápio padrão. Ela não
-- entra em papel nenhum por omissão — a barbearia comum não é franqueadora, e
-- uma permissão que nasce concedida numa base inteira é permissão que ninguém
-- decidiu dar.
-- ----------------------------------------------------------------------------
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_conhecida;
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
  'customers.view_photos', 'customers.manage_photos',
  'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'franchise.manage',
  'reviews.view', 'reviews.recover',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage',
  'whatsapp.manage'
));
