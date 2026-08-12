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

# O e2e importa `@barbearia/core` e `@barbearia/identity` de `dist`, não de
# `src`. Rodando esta suíte sozinha, um `dist` velho produz falha de um defeito
# que já foi corrigido no fonte — aconteceu duas vezes no bloco 18, e as duas
# vezes o tempo foi gasto investigando o que não existia. Com `incremental`
# ligado, reconstruir sem mudança custa ~4s.
#
# Dentro do `pnpm verify` isto é redundante (a fase 1 já construiu), e é barato
# o bastante para não valer uma variável de ambiente que alguém esqueceria de
# passar no caminho que importa.
if [ -z "${PULAR_BUILD_DAS_DEPENDENCIAS:-}" ]; then
  pnpm --filter "@barbearia/api^..." build >/dev/null
fi

ADMIN_DATABASE_URL="$ADMIN_URL" ../../scripts/bootstrap-role.sh >/dev/null
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"
for migration in ../../packages/db/migrations/*.sql; do
  psql "$BASE/$DB_NAME" -q -v ON_ERROR_STOP=1 -f "$migration"
done

DATABASE_URL="$(../../scripts/url-do-app.sh "$ADMIN_URL" "$APP_DB_PASSWORD" "$DB_NAME")"
export DATABASE_URL
export APP_DATABASE_URL="$DATABASE_URL"
# O seed precisa de superusuário; a aplicação, do role restrito.
# Efêmera por execução, como a senha do role: nenhuma chave previsível, e
# nenhuma no repositório. O código falha alto sem ela, que é o que se quer.
export WHATSAPP_TOKEN_KEY="${WHATSAPP_TOKEN_KEY:-$(openssl rand -base64 32)}"
export SEED_DATABASE_URL="$BASE/$DB_NAME"
# A suíte funcional dispara muitos pedidos do mesmo IP. O limite tem teste
# próprio (rate-limit.e2e.test.ts); aqui ele não pode virar ruído.
export RATE_LIMIT_SHORT="${RATE_LIMIT_SHORT:-100000}"
export RATE_LIMIT_LONG="${RATE_LIMIT_LONG:-100000}"
# Uma linha por requisição enterraria a mensagem do teste que falhou.
export LOG_REQUISICOES=nao
export STAFF_EMAIL_PEPPER="${STAFF_EMAIL_PEPPER:-pepper-de-teste}"
# Sorteada por execução: o banco é descartável e o segredo não sobrevive a ela.
# Sem esta variável o segundo fator falha alto, de propósito — e a suíte do
# bloco 26 exercita justamente o TOTP da plataforma.
export MFA_SECRET_KEY="${MFA_SECRET_KEY:-$(openssl rand -base64 32)}"
# `"$@"`: rodar um arquivo só durante o laço interno. Sem isto, provar que um
# teste fica vermelho custa a suíte inteira por quebra.
exec vitest run "$@"
