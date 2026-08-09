-- ============================================================================
-- 0032 — Duas permissões que faltavam e o teto do desconto
--        (bloco 30, SPEC Parte 1 §1.3)
--
-- `role_permissions` é editável por barbearia desde o bloco 16, e a migração de
-- lá dizia, por escrito, que o bloco 30 precisaria "só de tela, não de
-- migração". Precisou das duas, e o motivo está declarado como lacuna desde o
-- bloco 21: **duas rotas guardam escrita com permissão de leitura.**
--
-- 1. **`customers.edit_notes`.** Escrever a anotação do cliente exigia
--    `customers.view_notes` — ler e escrever sob a mesma chave. Quem podia ler
--    o que a barbearia anotou sobre a pessoa podia reescrever, e a permissão
--    declarada na rota deixava de descrever o que a rota faz.
--
-- 2. **`finance.discount`.** Dar desconto exigia `finance.view`, que é *ver
--    dinheiro*. O efeito colateral era o oposto do pretendido: para deixar a
--    recepção dar 10% de desconto, era preciso entregar o faturamento junto.
--
-- E um teto, porque a lacuna cobrava os dois: sem ele, quem dá desconto pode
-- dar 100% — que é a mesma capacidade de um estorno, com outro nome.
--
-- ## Por que as duas nascem concedidas a quem já podia
--
-- Migração que **tira** poder de alguém no meio da operação quebra a barbearia
-- na segunda-feira. Quem tinha `customers.view_notes` recebe `edit_notes`; quem
-- tinha `finance.view` recebe `discount`. Ninguém ganha capacidade nova, e a
-- partir de agora o dono pode separar as duas coisas pela tela — que é
-- exatamente o que este bloco entrega.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O catálogo cresce
-- ---------------------------------------------------------------------------

/**
 * O `CHECK` espelha `packages/core/src/permissoes.ts` e a duplicação é
 * deliberada desde o bloco 16: é o banco que impede uma permissão inventada de
 * ser concedida numa correção manual de madrugada. Há teste que reprova se as
 * duas listas divergirem — e foi ele que cobrou esta migração.
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
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));

-- Quem já escrevia anotação continua escrevendo; quem já dava desconto continua
-- dando. A migração acrescenta vocabulário, não retira capacidade.
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT tenant_id, role, 'customers.edit_notes'
  FROM role_permissions WHERE permission = 'customers.view_notes'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (tenant_id, role, permission)
SELECT tenant_id, role, 'finance.discount'
  FROM role_permissions WHERE permission = 'finance.view'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- O teto do desconto
-- ---------------------------------------------------------------------------

/**
 * Quanto de desconto a barbearia permite, em pontos-base.
 *
 * Pontos-base inteiros como toda alíquota deste schema (2000 = 20%), pelo mesmo
 * motivo da comissão: fração em ponto flutuante multiplicada por centavo
 * produz o centavo que não fecha no fim do mês.
 *
 * **Vinte por cento é o padrão, e é uma escolha, não um número neutro.** Zero
 * transformaria a migração em "ninguém mais dá desconto" numa segunda-feira;
 * 10000 (100%) faria a coluna existir sem restringir nada — que é a definição
 * de campo que o motor aceita e ninguém preenche. Vinte cobre a promoção comum
 * ("primeira vez", "leve dois") e recusa o desconto que zera a conta, que é
 * onde mora o risco. Quem precisar de mais muda na tela de configurações, que
 * entrou junto neste bloco.
 */
ALTER TABLE tenants
  ADD COLUMN max_discount_bps integer NOT NULL DEFAULT 2000
  CONSTRAINT tenants_max_discount_range CHECK (max_discount_bps BETWEEN 0 AND 10000);

COMMENT ON COLUMN tenants.max_discount_bps IS
  'Teto de desconto por comanda, em pontos-base (2000 = 20%).';
