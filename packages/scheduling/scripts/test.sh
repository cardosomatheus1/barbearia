#!/usr/bin/env bash
# Cria banco descartável, migra e roda os testes de integração do Scheduling.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5433/postgres}"
DB_NAME="${TEST_DB_NAME:-barbearia_scheduling_test}"
BASE="${ADMIN_URL%/*}"

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"
for migration in ../db/migrations/*.sql; do
  psql "$BASE/$DB_NAME" -q -v ON_ERROR_STOP=1 -f "$migration"
done

export DATABASE_URL="$BASE/$DB_NAME"
export APP_DATABASE_URL="${BASE/postgres:\/\/postgres/postgres://barbearia_app:app}/$DB_NAME"
exec vitest run
