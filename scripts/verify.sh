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
  # A saída da etapa é preservada em arquivo: filtrar `pnpm verify` com grep
  # escondeu uma falha de build atrás de suítes verdes, e o commit saiu vermelho.
  local log; log=$(mktemp)
  if "$@" >"$log" 2>&1; then
    printf '\033[32m    ok\033[0m\n'
  else
    printf '\033[31m    FALHOU\033[0m\n'
    sed 's/^/    /' "$log" | tail -25
    failures+=("$name")
  fi
  rm -f "$log"
}

step "typecheck"            pnpm -r typecheck
step "build"                pnpm -r build
step "core — unitários"     pnpm --filter @barbearia/core test
step "ui — tokens e componentes" pnpm --filter @barbearia/ui test
# A suíte do web ficou de fora do portão até o bloco 9. Teste que o portão não
# roda não é garantia nenhuma — o de `destinoSeguro` guarda contra
# redirecionamento aberto no login e precisa correr aqui.
step "web — lógica de tela" pnpm --filter @barbearia/web test

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  step "db — invariantes"   pnpm --filter @barbearia/db test
  step "identity — OTP e sessão" pnpm --filter @barbearia/identity test
  step "scheduling — integração" pnpm --filter @barbearia/scheduling test
  step "api — e2e"          pnpm --filter @barbearia/api test
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
