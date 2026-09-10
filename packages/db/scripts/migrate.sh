#!/usr/bin/env bash
# Histórico com checksum, trava por banco e adoção legada validada contra referência.
# Banco sem histórico nunca é confundido automaticamente com uma baseline.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?defina DATABASE_URL}"
exec node scripts/migrate.mjs
