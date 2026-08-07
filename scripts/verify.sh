#!/usr/bin/env bash
# Portão único do Definition of Done (CLAUDE.md).
#
# Roda tudo o que precisa estar verde para um bloco ser dado como concluído.
# Sobe um Postgres descartável quando ADMIN_DATABASE_URL não é informado.
set -uo pipefail
cd "$(dirname "$0")/.."

failures=()
step() {
  local name="$1"; shift
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m    ok\033[0m\n'
  else
    printf '\033[31m    FALHOU\033[0m\n'
    failures+=("$name")
  fi
}

step "typecheck"            pnpm -r typecheck
step "build"                pnpm -r build
step "core — unitários"     pnpm --filter @barbearia/core test

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  step "db — invariantes"   pnpm --filter @barbearia/db test
  step "scheduling — integração" pnpm --filter @barbearia/scheduling test
else
  printf '\n\033[33m==> testes de banco PULADOS\033[0m\n'
  printf '    defina ADMIN_DATABASE_URL para rodá-los. Um bloco não pode ser\n'
  printf '    concluído sem eles verdes.\n'
  failures+=("testes de banco não executados")
fi

printf '\n'
if [ ${#failures[@]} -eq 0 ]; then
  printf '\033[32mverify: tudo verde\033[0m\n'
  exit 0
fi

printf '\033[31mverify: %d etapa(s) com problema\033[0m\n' "${#failures[@]}"
printf '  - %s\n' "${failures[@]}"
exit 1
