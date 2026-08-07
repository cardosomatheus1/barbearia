#!/usr/bin/env bash
# Cria um banco descartável, migra e roda os testes de integridade.
#
# As garantias testadas (constraint de exclusão anti-overbooking e RLS) são do
# Postgres, não da aplicação — precisam de um banco real para valer alguma coisa.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5433/postgres}"
DB_NAME="${TEST_DB_NAME:-barbearia_test}"
TEST_URL="${ADMIN_URL%/*}/$DB_NAME"

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

for migration in migrations/*.sql; do
  psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -f "$migration"
done

failures=0
for suite in test/*.test.sql; do
  echo "==> $suite"
  if ! psql "$TEST_URL" -v ON_ERROR_STOP=1 -f "$suite" 2>&1 \
       | grep -E "NOTICE:  (OK|---|FALHOU)" | sed 's/^NOTICE:  //'; then
    failures=$((failures + 1))
  fi
done

[ "$failures" -eq 0 ] || { echo "FALHOU: $failures suíte(s)"; exit 1; }
