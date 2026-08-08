-- ============================================================================
-- 0016 — RBAC e trilha de auditoria
--
-- `staff_users.role` existe desde a migração 0012 e **nunca foi lido para
-- decidir nada**. Toda conta de gestor tem poder de dono: quem abre o balcão
-- para a recepcionista entrega junto a chave do faturamento, do catálogo e da
-- base de clientes. É o incidente que este bloco existe para impedir.
--
-- Três decisões que merecem explicação:
--
-- 1. **A permissão é dado, não constante.** A SPEC (Parte 1 §1.3) é explícita:
--    papéis são conjuntos nomeados de permissões, editáveis pelo proprietário.
--    Guardar o mapa no código faria "gerente vê faturamento" virar deploy em
--    vez de linha. `role_permissions` é por tenant justamente para o bloco 30
--    precisar só de tela, não de migração.
--
-- 2. **A senha de primeiro acesso é gerada, não escolhida.** Quem cria a conta
--    é o dono, com a pessoa do lado; senha escolhida por terceiro tende a ser a
--    mesma para todo mundo. `must_change_password` obriga a troca antes de
--    qualquer outra coisa.
--
-- 3. **A trilha é append-only no banco, não por convenção.** A SPEC lista
--    alteração de permissão, exportação de clientes e impersonação como
--    auditados obrigatoriamente, com retenção de cinco anos para eventos
--    financeiros. Trilha que a própria aplicação pode reescrever não serve de
--    prova — por isso o REVOKE de UPDATE e DELETE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Permissões por papel, por barbearia
-- ---------------------------------------------------------------------------

CREATE TABLE role_permissions (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       staff_role NOT NULL,
  permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, role, permission),
  -- Espelha o catálogo de `packages/core/src/permissoes.ts`. Duplicar a lista
  -- aqui é deliberado: é o banco que impede uma permissão inventada de ser
  -- concedida por engano numa correção manual de madrugada. Há teste que falha
  -- se as duas listas divergirem.
  CONSTRAINT role_permissions_conhecida CHECK (permission IN (
    'appointments.view', 'appointments.create', 'appointments.cancel',
    'appointments.reschedule', 'appointments.view_all_professionals',
    'appointments.attend',
    'cashier.open', 'cashier.close', 'cashier.withdraw',
    'finance.view', 'finance.view_profit', 'finance.export',
    'commission.view_own', 'commission.view_all', 'commission.edit_rules',
    'customers.view', 'customers.edit', 'customers.export',
    'customers.view_photos', 'customers.view_notes',
    'reports.finance', 'reports.operational',
    'inventory.view', 'inventory.adjust',
    'marketing.send', 'settings.manage', 'team.manage'
  ))
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Conta de equipe
-- ---------------------------------------------------------------------------

-- Quem entra com senha entregue por outra pessoa troca antes de usar o sistema.
ALTER TABLE staff_users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Quem criou a conta. Sem isto, "quem deu acesso ao caixa para essa pessoa?"
-- não tem resposta — e é a primeira pergunta depois de um incidente.
ALTER TABLE staff_users
  ADD COLUMN created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Trilha de auditoria
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Quem fez. Nulo só quando o ator é o próprio sistema (rotina, worker).
  actor_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_name  text NOT NULL,
  -- O que fez, em vocabulário estável: `staff.created`, `staff.role_changed`.
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  -- Antes e depois. A SPEC pede o par no exemplo de registro (Parte 1 §1.7):
  -- saber que alguém mudou uma permissão sem saber de quê para quê não fecha
  -- investigação nenhuma.
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A consulta é sempre "o que aconteceu nesta barbearia, do mais recente para o
-- mais antigo". Sem o índice, a tela de auditoria varre cinco anos de eventos.
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);
-- E "o que esta pessoa fez", que é a pergunta depois de uma demissão.
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Append-only de verdade.
 *
 * A migração 0002 concedeu SELECT, INSERT, UPDATE e DELETE por
 * `ALTER DEFAULT PRIVILEGES`, então uma tabela nova nasce com os quatro. Aqui os
 * dois últimos são retirados: trilha que a aplicação consegue reescrever não é
 * prova de nada, e o atacante que chega ao role da aplicação apagaria o próprio
 * rastro. O role é `NOBYPASSRLS` e não tem DDL, então não consegue devolver.
 */
REVOKE UPDATE, DELETE ON audit_log FROM barbearia_app;

COMMENT ON TABLE audit_log IS
  'Append-only. UPDATE e DELETE revogados do role da aplicação de propósito.';

-- ---------------------------------------------------------------------------
-- Semente: as barbearias que já existem passam a ter o padrão de fábrica
-- ---------------------------------------------------------------------------

/**
 * Sem esta carga, toda conta existente ficaria sem permissão nenhuma no
 * primeiro deploy — inclusive a do dono, que perderia o acesso à própria
 * barbearia. Migração aditiva também vale para dado.
 */
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, p.role::staff_role, p.permission
FROM tenants t
CROSS JOIN (
  VALUES
    ('owner', 'appointments.view'), ('owner', 'appointments.create'),
    ('owner', 'appointments.cancel'), ('owner', 'appointments.reschedule'),
    ('owner', 'appointments.view_all_professionals'), ('owner', 'appointments.attend'),
    ('owner', 'cashier.open'), ('owner', 'cashier.close'), ('owner', 'cashier.withdraw'),
    ('owner', 'finance.view'), ('owner', 'finance.view_profit'), ('owner', 'finance.export'),
    ('owner', 'commission.view_own'), ('owner', 'commission.view_all'),
    ('owner', 'commission.edit_rules'),
    ('owner', 'customers.view'), ('owner', 'customers.edit'), ('owner', 'customers.export'),
    ('owner', 'customers.view_photos'), ('owner', 'customers.view_notes'),
    ('owner', 'reports.finance'), ('owner', 'reports.operational'),
    ('owner', 'inventory.view'), ('owner', 'inventory.adjust'),
    ('owner', 'marketing.send'), ('owner', 'settings.manage'), ('owner', 'team.manage'),

    ('manager', 'appointments.view'), ('manager', 'appointments.create'),
    ('manager', 'appointments.cancel'), ('manager', 'appointments.reschedule'),
    ('manager', 'appointments.view_all_professionals'), ('manager', 'appointments.attend'),
    ('manager', 'cashier.open'), ('manager', 'cashier.close'), ('manager', 'cashier.withdraw'),
    ('manager', 'finance.view'),
    ('manager', 'commission.view_all'),
    ('manager', 'customers.view'), ('manager', 'customers.edit'),
    ('manager', 'customers.view_notes'),
    ('manager', 'reports.operational'),
    ('manager', 'inventory.view'), ('manager', 'inventory.adjust'),
    ('manager', 'settings.manage'),

    ('receptionist', 'appointments.view'), ('receptionist', 'appointments.create'),
    ('receptionist', 'appointments.cancel'), ('receptionist', 'appointments.reschedule'),
    ('receptionist', 'appointments.view_all_professionals'), ('receptionist', 'appointments.attend'),
    ('receptionist', 'cashier.open'),
    ('receptionist', 'customers.view'), ('receptionist', 'customers.edit'),
    ('receptionist', 'inventory.view'),

    ('professional', 'appointments.view'), ('professional', 'appointments.create'),
    ('professional', 'appointments.cancel'), ('professional', 'appointments.reschedule'),
    ('professional', 'commission.view_own'),
    ('professional', 'customers.view'), ('professional', 'customers.view_notes')
) AS p(role, permission)
ON CONFLICT DO NOTHING;
