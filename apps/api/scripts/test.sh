#!/usr/bin/env bash
# Banco descartável + aplicação de verdade: e2e da API.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5433/postgres}"
DB_NAME="${TEST_DB_NAME:-barbearia_api_test}"
BASE="${ADMIN_URL%/*}"
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

cleanup() { psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

ADMIN_DATABASE_URL="$ADMIN_URL" ../../scripts/bootstrap-role.sh >/dev/null
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"
for migration in ../../packages/db/migrations/*.sql; do
  psql "$BASE/$DB_NAME" -q -v ON_ERROR_STOP=1 -f "$migration"
done

export DATABASE_URL="${BASE/postgres:\/\/postgres/postgres://barbearia_app:$APP_DB_PASSWORD}/$DB_NAME"
export APP_DATABASE_URL="$DATABASE_URL"
# O seed precisa de superusuário; a aplicação, do role restrito.
export SEED_DATABASE_URL="$BASE/$DB_NAME"
# A suíte funcional dispara muitos pedidos do mesmo IP. O limite tem teste
# próprio (rate-limit.e2e.test.ts); aqui ele não pode virar ruído.
export RATE_LIMIT_SHORT="${RATE_LIMIT_SHORT:-100000}"
export RATE_LIMIT_LONG="${RATE_LIMIT_LONG:-100000}"
exec vitest run
