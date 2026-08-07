-- ============================================================================
-- 0004 — Resolução pública de slug
--
-- Problema de ordem: a RLS filtra por `app.tenant_id`, mas para descobrir o
-- tenant a API precisa consultar o slug — que é justamente o que ela ainda não
-- resolveu. Ovo e galinha.
--
-- O mapeamento slug -> tenant é público por natureza: o slug está na bio do
-- Instagram da barbearia. Então `tenant_slugs` ganha leitura aberta, e **só
-- leitura**. Escrita continua restrita ao dono do registro.
--
-- Esta é a única tabela do sistema legível sem tenant no contexto. Qualquer
-- outra que precise disso no futuro deve justificar do mesmo jeito.
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation ON tenant_slugs;

-- Leitura: aberta. Expõe apenas slug -> tenant_id, e o tenant_id nunca sai da
-- API para o cliente.
CREATE POLICY tenant_slugs_public_read ON tenant_slugs
  FOR SELECT USING (true);

-- Escrita: sempre restrita ao tenant do contexto.
CREATE POLICY tenant_slugs_insert ON tenant_slugs
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_slugs_update ON tenant_slugs
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
             WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_slugs_delete ON tenant_slugs
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
