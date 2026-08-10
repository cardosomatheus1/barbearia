-- ============================================================================
-- 0039 — O segundo fator vira decisão da barbearia
--        (correção de desenho entre o 36 e o 37, SPEC Parte 5 §5.12)
--
-- Até aqui a exigência do segundo fator era **derivada da permissão declarada
-- na rota**, e ponto: quem tem `finance.*` ou `cashier.*` digita o código de
-- seis dígitos ou não abre o caixa. O mecanismo continua exatamente esse — o
-- que muda é que a barbearia passa a poder dizer se ele vale para ela.
--
-- ## Por que a derivação não morre junto
--
-- A tentação, ao ligar um interruptor destes, é transformar a exigência num
-- decorador `@ExigeSegundoFator()` que cada rota liga. Seria trocar um defeito
-- por outro: a rota de dinheiro escrita no bloco 45 nasceria sem o decorador e
-- ninguém veria. O interruptor é **uma pergunta a mais**, feita antes da
-- derivação; a derivação continua sendo quem responde "esta rota mexe em
-- dinheiro?".
--
-- ## Por que nasce desligado, e por que quem já existe nasce ligado
--
-- As duas coisas ao mesmo tempo, e não é contradição.
--
-- **Nasce desligado** porque foi a decisão do produto: uma barbearia que abriu
-- ontem tem uma conta, o dono, e um celular que ele ainda não configurou. Pedir
-- autenticador antes da primeira comanda é o atrito que faz a pessoa desistir
-- do sistema — e o desfecho real de atrito assim nunca é "vou configurar
-- direito", é "vou anotar num caderno".
--
-- **Quem já existe nasce ligado** pela regra escrita no `CLAUDE.md`: o padrão
-- de uma configuração que mexe em dinheiro é sempre o **comportamento
-- anterior**. É o precedente de `fee_treatment`, e aqui ele pesa mais: um
-- `DEFAULT false` sem esta linha faria toda barbearia instalada perder a
-- proteção do caixa no dia da migração, sem ninguém ter decidido nada. Perder
-- proteção em silêncio é pior que ganhar atrito em silêncio.
--
-- Quem quiser desligar tem um interruptor em `/admin/seguranca`, que é uma
-- decisão tomada por alguém, com nome e hora na trilha.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O interruptor
-- ---------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.mfa_required IS
  'A barbearia exige segundo fator de quem mexe em dinheiro. Nasce falso; '
  'quem já operava com a exigência foi mantido em verdadeiro na 0039.';

-- Comportamento anterior para quem já estava no ar. Barbearia nova cai no
-- `DEFAULT false` e não é tocada por esta linha.
UPDATE tenants SET mfa_required = true;

-- ---------------------------------------------------------------------------
-- Quem decide
-- ---------------------------------------------------------------------------

/**
 * `security.mfa_policy` — permissão própria, não `settings.manage`.
 *
 * O mesmo raciocínio de `customers.anonymize` no bloco 32: mudar o horário de
 * funcionamento e desligar a trava do caixa parecem "configuração" e não são a
 * mesma tarefa. Amarrá-las na mesma permissão faria toda barbearia que delegou
 * a configuração à recepção ter delegado junto o poder de abrir a gaveta sem
 * código — e a recepção é justamente de quem o segundo fator protege o dinheiro
 * do dono.
 *
 * Não é `if (role = 'owner')`, que a regra do projeto recusa: é permissão, e
 * portanto o dono **pode** delegá-la ao gerente pela tela de permissões. A
 * diferença é que aí ela terá sido uma decisão, tomada numa tela que diz o que
 * está sendo entregue, e não um efeito colateral de outra.
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
  'marketing.send', 'settings.manage', 'team.manage',
  'security.mfa_policy'
));

-- Só o dono, como `customers.export` e `customers.anonymize`. Ninguém ganha
-- capacidade que já não tivesse: o dono sempre pôde tudo.
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT id, 'owner', 'security.mfa_policy' FROM tenants
ON CONFLICT DO NOTHING;
