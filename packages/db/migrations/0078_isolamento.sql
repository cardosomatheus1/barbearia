-- ============================================================================
-- 0078 — o que a revisão geral de segurança achou no isolamento
--
-- Três correções de banco, todas da mesma família: **uma tabela pode ter a
-- leitura pública e a escrita restrita, e copiar só a primeira metade é como o
-- isolamento vaza pela direção que ninguém olhou.**
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — `whatsapp_numbers`: leitura pública, escrita da dona
--
-- A tabela é o roteamento do webhook da Meta e nasceu sem RLS por decisão certa
-- e escrita: o webhook chega **antes** de existir tenant no contexto, e
-- consultar tabela com row security sem tenant devolve zero linhas sempre e em
-- silêncio. O precedente citado no cabeçalho dela é `tenant_slugs`.
--
-- Só que de `tenant_slugs` foi copiada uma metade. Lá a leitura é `USING (true)`
-- e a escrita é do tenant do contexto; aqui não havia política nenhuma, e o
-- `ON CONFLICT (phone_number_id) DO UPDATE` era incondicional.
--
-- O ataque, executado em `apps/api/test/ataque.e2e.test.ts`: a segunda
-- barbearia a reivindicar o mesmo `phone_number_id` **leva o roteamento**. A
-- partir dali, todo evento que a Meta entregar sobre aquele número resolve para
-- o tenant do atacante — `whatsapp_inbound` passa a gravar, sob o tenant dele,
-- o telefone e o texto que os clientes da vítima escreveram, e o toque em
-- "Confirmar" do cliente dela é descartado em silêncio. A vítima não vê nada:
-- a trilha da operação fica na conta de quem tomou.
--
-- O `phone_number_id` não é enumerável (é opaco, emitido pela Meta), mas também
-- não é segredo: aparece em todo payload de webhook da conta e é visto por
-- qualquer agência que ajudou no cadastro. O que era inequívoco é que não havia
-- guarda nenhuma.
--
-- Duas camadas, como o resto do schema: a política aqui, e a condição no
-- `ON CONFLICT` do domínio. A política é a que sobrevive a uma reescrita.
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_numbers FORCE ROW LEVEL SECURITY;

/**
 * A leitura continua aberta, e é o ponto inteiro da tabela.
 *
 * Ela guarda três ids opacos e nada mais — nome, telefone, token e mensagem
 * moram em `whatsapp_settings` e `whatsapp_inbound`, que têm RLS e só são lidas
 * depois de o tenant estar resolvido.
 */
CREATE POLICY whatsapp_numbers_leitura ON whatsapp_numbers
  FOR SELECT USING (true);

CREATE POLICY whatsapp_numbers_insercao ON whatsapp_numbers
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * `USING` **e** `WITH CHECK` no update, e as duas importam por razões
 * diferentes: a primeira decide de quais linhas se pode partir — sem ela, a
 * vizinha reescreve a linha alheia —, e a segunda decide onde se pode chegar —
 * sem ela, alguém entregaria a própria linha para outro tenant.
 */
CREATE POLICY whatsapp_numbers_alteracao ON whatsapp_numbers
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY whatsapp_numbers_remocao ON whatsapp_numbers
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2 — `staff_directory`: mesma correção, mesma razão
--
-- A justificativa escrita da política `USING (true) WITH CHECK (true)` cobre a
-- **leitura**: o login resolve e-mail para tenant antes de existir tenant no
-- contexto, e o conteúdo é só HMAC mais o destino. Ela não cobre a escrita —
-- e com `WITH CHECK (true)` qualquer contexto insere, altera ou apaga a linha
-- de roteamento de login de outra barbearia.
--
-- Apagar a linha de alguém não derruba a conta (ela mora em `staff_users`, com
-- RLS), mas faz o login dela deixar de resolver: a pessoa digita a senha certa
-- e recebe a mesma recusa de quem não tem conta.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS staff_directory_lookup ON staff_directory;
DROP POLICY IF EXISTS staff_directory_isolation ON staff_directory;
DROP POLICY IF EXISTS staff_directory_acesso ON staff_directory;

CREATE POLICY staff_directory_leitura ON staff_directory
  FOR SELECT USING (true);

CREATE POLICY staff_directory_insercao ON staff_directory
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY staff_directory_alteracao ON staff_directory
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY staff_directory_remocao ON staff_directory
  FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 3 — `tenants`: o nome da casa é legível sem tenant no contexto
--
-- `TenantService.nameOf` consulta `tenants` **fora** de `withTenant`, para
-- compor a mensagem do código de acesso. A tabela tem `FORCE ROW LEVEL
-- SECURITY` com política `id = current_setting('app.tenant_id')` e nenhuma
-- leitura pública: sem tenant no contexto a consulta devolve **zero linhas, em
-- silêncio**, e todo OTP sai como *"Seu código para Barbearia"*.
--
-- O silêncio é o defeito. Nada falha, nada loga, e o sintoma só aparece no
-- celular de quem está tentando entrar — foi assim que ele sobreviveu desde o
-- bloco 5.
--
-- Duas correções possíveis, e as duas entram: a chamada passa a usar
-- `withTenant` (é o conserto de verdade, e está no mesmo commit), e o **nome**
-- ganha leitura sem tenant, porque ele já é público — está no `<title>` da
-- página da barbearia, no card do marketplace e em `marketplace_listings`, que
-- não tem RLS de propósito. Só o nome: a política estrita continua valendo para
-- todo o resto da linha, que tem fuso, plano, teto de desconto e a decisão de
-- exigir segundo fator.
--
-- É por isso que a leitura sem tenant é `FOR SELECT` numa **coluna só**, via
-- função, e não uma política aberta na tabela: RLS não recorta coluna.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nome_da_barbearia(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT name FROM public.tenants WHERE id = p_tenant
$$;

COMMENT ON FUNCTION nome_da_barbearia(uuid) IS
  'O nome, e so o nome. Publico por definicao (titulo da pagina, card do '
  'marketplace), e necessario antes de existir tenant no contexto para compor '
  'a mensagem do codigo de acesso. A politica estrita de tenants continua '
  'valendo para o resto da linha — RLS nao recorta coluna, entao o recorte e '
  'esta funcao.';

REVOKE ALL ON FUNCTION nome_da_barbearia(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nome_da_barbearia(uuid) TO barbearia_app;
