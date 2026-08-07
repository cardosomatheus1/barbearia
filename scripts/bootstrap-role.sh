#!/usr/bin/env bash
# Cria o role da aplicação. Roda uma vez por cluster, antes das migrações.
#
# Fica fora das migrações de propósito: migração roda em produção, e credencial
# não mora no repositório (CLAUDE.md §2). A senha vem do ambiente — não há
# default, para que esquecer de definir falhe alto em vez de criar um role com
# senha conhecida.
set -euo pipefail

: "${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"
: "${APP_DB_PASSWORD:?defina APP_DB_PASSWORD (sem default: senha previsível é senha vazada)}"

psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -v senha="$APP_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    CREATE ROLE barbearia_app LOGIN;
  END IF;
END $$;
SQL

psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE barbearia_app LOGIN PASSWORD '$APP_DB_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;"

echo "role barbearia_app pronto"
