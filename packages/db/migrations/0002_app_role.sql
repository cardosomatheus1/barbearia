-- ============================================================================
-- 0002 — Role da aplicação
--
-- A RLS da migração 0001 só tem efeito se a aplicação conectar com um role
-- **não-superusuário**: superusuário ignora RLS por definição, e o dono da
-- tabela ignoraria se não houvesse FORCE.
--
-- Este role é o que a API usa. Ele não pode criar nem alterar estrutura — só
-- ler e gravar dados, sempre filtrado pelas políticas de tenant.
-- ============================================================================

-- A criação do role **não** acontece aqui: migração roda em produção, e
-- credencial não mora no repositório (CLAUDE.md §2). O role é criado por
-- `scripts/bootstrap-role.sh`, que exige a senha por variável de ambiente.
--
-- As garantias são **conferidas**, não aplicadas.
--
-- Aqui havia um `ALTER ROLE ... NOSUPERUSER NOCREATEDB NOCREATEROLE
-- NOBYPASSRLS`, e ele tinha dois problemas.
--
-- O de projeto: consertar em silêncio é esconder. Um role da aplicação que
-- chegou a produção com `BYPASSRLS` é um incidente de configuração, e uma
-- migração que o corrige sem dizer nada faz o incidente desaparecer sem
-- ninguém aprender que ele aconteceu. Recusar a migração é o comportamento
-- correto: quem provisionou precisa saber.
--
-- O prático: `ALTER ROLE` escreve em `pg_authid`, que é do **cluster**, não do
-- banco. Sete suítes de teste migrando bancos descartáveis em paralelo
-- colidiam com `tuple concurrently updated`. Trava consultiva não resolveria —
-- ela é por banco, e cada suíte está no seu. Conferir é só leitura, e leitura
-- não disputa nada.
DO $$
DECLARE
  papel pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO papel FROM pg_roles WHERE rolname = 'barbearia_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'role barbearia_app não existe. Rode scripts/bootstrap-role.sh antes das migrações.';
  END IF;

  IF papel.rolsuper OR papel.rolbypassrls OR papel.rolcreatedb OR papel.rolcreaterole THEN
    RAISE EXCEPTION
      'role barbearia_app tem privilégio demais (super=% bypassrls=% createdb=% createrole=%). '
      'A RLS não protege nada assim. Corrija o provisionamento antes de migrar.',
      papel.rolsuper, papel.rolbypassrls, papel.rolcreatedb, papel.rolcreaterole;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO barbearia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO barbearia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO barbearia_app;

-- Tabelas criadas por migrações futuras herdam os mesmos privilégios.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO barbearia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO barbearia_app;
