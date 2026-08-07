#!/usr/bin/env bash
# Aplica todas as migrações, em ordem, no banco apontado por DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?defina DATABASE_URL (ex.: postgres://postgres@127.0.0.1:5433/barbearia)}"

for migration in migrations/*.sql; do
  echo "==> $migration"
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$migration"
done
echo "migrações aplicadas"
