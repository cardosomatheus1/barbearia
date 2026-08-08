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

# Primeiro passo de propósito: é o mais barato e é o que responde "o que
# ficou para trás". Depois de typecheck e build ele viraria a última linha de
# uma saída longa, que é onde aviso deixa de ser lido.
step "lacunas declaradas"   node scripts/verificar-lacunas.mjs

step "typecheck"            pnpm -r typecheck
step "build"                pnpm -r build
step "core — unitários"     pnpm --filter @barbearia/core test
step "ui — tokens e componentes" pnpm --filter @barbearia/ui test
# A suíte do web ficou de fora do portão até o bloco 9. Teste que o portão não
# roda não é garantia nenhuma — o de `destinoSeguro` guarda contra
# redirecionamento aberto no login e precisa correr aqui.
step "web — lógica de tela" pnpm --filter @barbearia/web test

# ---------------------------------------------------------------------------
# Suítes de banco, em paralelo.
#
# Cada uma cria e destrói o **próprio** banco descartável (`TEST_DB_NAME` sai do
# nome do pacote), então elas não disputam estado nenhum. Em série gastavam o
# tempo somado; aqui gastam o da mais lenta.
#
# O que se paga por isso: a saída chega junta no fim, em vez de etapa a etapa.
# Por isso o log de cada uma é guardado inteiro e impresso na ordem fixa abaixo
# — ler saída de sete processos entrelaçada seria pior que esperar.
# ---------------------------------------------------------------------------
COM_BANCO=(
  "db — invariantes:@barbearia/db"
  "identity — OTP, sessão e segundo fator:@barbearia/identity"
  "scheduling — integração:@barbearia/scheduling"
  "onboarding — seis etapas:@barbearia/onboarding"
  "catalog — CRUD do admin:@barbearia/catalog"
  "finance — comanda, caixa e fiado:@barbearia/finance"
  "api — e2e:@barbearia/api"
)

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  # Uma senha efêmera para a execução inteira, e não uma por suíte.
  # `bootstrap-role.sh` faz `ALTER ROLE ... PASSWORD`, que é global ao cluster:
  # em paralelo, cada suíte trocaria a senha debaixo das outras e seis das sete
  # falhariam ao conectar. Continua sendo aleatória por execução — o que a regra
  # pede é que não haja credencial previsível, não que haja sete.
  export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

  printf '\n\033[1m==> suítes de banco (em paralelo)\033[0m\n'
  saida=$(mktemp -d)
  pids=()

  for entrada in "${COM_BANCO[@]}"; do
    pacote="${entrada##*:}"
    pnpm --filter "$pacote" test >"$saida/${pacote##*/}.log" 2>&1 &
    pids+=($!)
  done

  # Espera cada uma pelo pid, na mesma ordem em que foram lançadas, para casar
  # o código de saída com o nome certo.
  for i in "${!COM_BANCO[@]}"; do
    entrada="${COM_BANCO[$i]}"
    nome="${entrada%%:*}"
    pacote="${entrada##*:}"
    printf '\n\033[1m==> %s\033[0m\n' "$nome"
    if wait "${pids[$i]}"; then
      printf '\033[32m    ok\033[0m\n'
    else
      printf '\033[31m    FALHOU\033[0m\n'
      sed 's/^/    /' "$saida/${pacote##*/}.log" | tail -25
      failures+=("$nome")
    fi
  done

  rm -rf "$saida"
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
