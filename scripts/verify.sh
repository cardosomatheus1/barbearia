#!/usr/bin/env bash
# Portão único do Definition of Done (CLAUDE.md).
#
# Roda tudo o que precisa estar verde para um bloco ser dado como concluído.
#
# ## Por que ele tem fases
#
# A versão em série gastava a soma de tudo. As medições que levaram a esta
# forma, num ambiente de 4 núcleos:
#
#   typecheck 18s (7,9s repetido) · build 29s, dos quais 21s são o Next do web
#   sete suítes de banco 128s em série, ~70s em paralelo
#   migrações do zero: 1s — não era ali que o tempo estava, ao contrário do
#   palpite inicial de trocá-las por `CREATE DATABASE ... TEMPLATE`
#
# A observação que sobrou: as suítes de banco passam a maior parte do tempo
# **esperando o Postgres**, e o build do web passa o dele **usando CPU**. São
# desperdícios complementares, então rodam juntos.
#
# A única ordem que precisa ser respeitada: o e2e da API importa `@barbearia/core`
# e `@barbearia/identity` de `dist`, não de `src`. Os pacotes são construídos
# antes de tudo; o resto não depende de nada e vai junto.
set -uo pipefail
cd "$(dirname "$0")/.."

failures=()

# Roda em segundo plano, guardando a saída para ser impressa na ordem certa.
# Ler a saída de dez processos entrelaçada seria pior do que esperar por ela.
SAIDA=$(mktemp -d)
trap 'rm -rf "$SAIDA"' EXIT
nomes=()
pids=()

lancar() {
  local nome="$1"; shift
  local arquivo="$SAIDA/$(printf '%03d' ${#pids[@]}).log"
  ( "$@" ) >"$arquivo" 2>&1 &
  pids+=($!)
  nomes+=("$nome")
}

# Espera tudo o que foi lançado e imprime cada etapa na ordem de lançamento.
colher() {
  for i in "${!pids[@]}"; do
    [ -z "${nomes[$i]}" ] && continue
    printf '\n\033[1m==> %s\033[0m\n' "${nomes[$i]}"
    if wait "${pids[$i]}"; then
      printf '\033[32m    ok\033[0m\n'
    else
      printf '\033[31m    FALHOU\033[0m\n'
      sed 's/^/    /' "$SAIDA/$(printf '%03d' $i).log" | tail -25
      failures+=("${nomes[$i]}")
    fi
    nomes[$i]=""
  done
}

# Etapa serial e sozinha: é a mais barata e é a que responde "o que ficou para
# trás". Enterrada no meio de uma saída longa, ela deixaria de ser lida.
printf '\n\033[1m==> lacunas declaradas\033[0m\n'
if node scripts/verificar-lacunas.mjs >"$SAIDA/lacunas.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/lacunas.log" | tail -25
  failures+=("lacunas declaradas")
fi

# ---------------------------------------------------------------------------
# Fase 1 — o que os outros esperam.
# ---------------------------------------------------------------------------
printf '\n\033[1m==> build dos pacotes\033[0m\n'
if pnpm --filter "./packages/*" build >"$SAIDA/pacotes.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/pacotes.log" | tail -25
  failures+=("build dos pacotes")
  # Sem `dist` o e2e da API falharia por um motivo que não é dele. Parar aqui
  # dá uma saída legível em vez de sete suítes vermelhas pelo mesmo defeito.
  printf '\n\033[31mverify: build dos pacotes quebrado — as suítes não foram rodadas\033[0m\n'
  exit 1
fi

# ---------------------------------------------------------------------------
# Fase 2 — tudo o que não depende de mais nada.
#
# Cada suíte de banco cria e destrói o **próprio** banco descartável, então elas
# não disputam estado. O que elas disputam é a senha do role, que é global ao
# cluster: por isso ela é sorteada **uma vez** aqui e exportada. Continua sendo
# efêmera por execução — a regra pede que não haja credencial previsível, não
# que haja sete.
# ---------------------------------------------------------------------------
printf '\n\033[1m==> typecheck, builds e suítes (em paralelo)\033[0m\n'

lancar "typecheck"                 pnpm -r typecheck
lancar "build do web"              pnpm --filter @barbearia/web build
lancar "build da api"              pnpm --filter @barbearia/api build
lancar "core — unitários"          pnpm --filter @barbearia/core test
lancar "ui — tokens e componentes" pnpm --filter @barbearia/ui test
# A suíte do web ficou de fora do portão até o bloco 9. Teste que o portão não
# roda não é garantia nenhuma — o de `destinoSeguro` guarda contra
# redirecionamento aberto no login e precisa correr aqui.
lancar "web — lógica de tela"      pnpm --filter @barbearia/web test

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

  lancar "db — invariantes"                    pnpm --filter @barbearia/db test
  lancar "identity — OTP, sessão e 2º fator"   pnpm --filter @barbearia/identity test
  lancar "scheduling — integração"             pnpm --filter @barbearia/scheduling test
  lancar "onboarding — seis etapas"            pnpm --filter @barbearia/onboarding test
  lancar "catalog — CRUD do admin"             pnpm --filter @barbearia/catalog test
  lancar "finance — comanda, caixa e fiado"    pnpm --filter @barbearia/finance test
  # A fase 1 já construiu os pacotes; a suíte não precisa refazer.
  lancar "api — e2e"  env PULAR_BUILD_DAS_DEPENDENCIAS=1 pnpm --filter @barbearia/api test
fi

colher

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
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
