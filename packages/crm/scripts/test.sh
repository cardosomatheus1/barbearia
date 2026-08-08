#!/usr/bin/env bash
# Banco descartável: a ficha do cliente contra banco real, com RLS ativa.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5433/postgres}"
DB_NAME="${TEST_DB_NAME:-barbearia_crm_test}"
BASE="${ADMIN_URL%/*}"
# Senha efêmera por execução: nenhuma credencial previsível, nenhuma no repositório.
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

cleanup() { psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

ADMIN_DATABASE_URL="$ADMIN_URL" ../../scripts/bootstrap-role.sh >/dev/null
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"
for migration in ../db/migrations/*.sql; do
  psql "$BASE/$DB_NAME" -q -v ON_ERROR_STOP=1 -f "$migration"
done

# A aplicação conecta pelo role restrito. Apontar DATABASE_URL para
# superusuário desligaria a RLS e os testes de isolamento passariam vazios.
export DATABASE_URL="${BASE/postgres:\/\/postgres/postgres://barbearia_app:$APP_DB_PASSWORD}/$DB_NAME"
export APP_DATABASE_URL="$DATABASE_URL"
export SEED_DATABASE_URL="$BASE/$DB_NAME"
exec vitest run
