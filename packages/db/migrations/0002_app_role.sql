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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    -- A senha real é definida pela infraestrutura; este default só serve para
    -- ambiente local e CI.
    CREATE ROLE barbearia_app LOGIN PASSWORD 'app';
  END IF;
END $$;

-- Garantias explícitas: sem DDL, sem bypass.
ALTER ROLE barbearia_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO barbearia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO barbearia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO barbearia_app;

-- Tabelas criadas por migrações futuras herdam os mesmos privilégios.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO barbearia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO barbearia_app;
