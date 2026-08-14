#!/usr/bin/env bash
# A medição de navegador e carga, do começo ao fim.
#
#   ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres scripts/medicao.sh
#
# ## Por que este arquivo existe
#
# Ele nasceu de um erro de método, não de código. O job de medição da esteira
# era uma sequência de comandos soltos dentro do YAML: criar banco, migrar,
# construir, subir os dois servidores, esperar, medir. Nada daquilo dava para
# rodar aqui — e o resultado foi depurar por tentativa contra um laço de oito
# minutos por volta, aprendendo **um fato por execução**.
#
# Quatro voltas foram gastas assim, e as quatro causas eram locais:
# Playwright por caminho absoluto, URL de administração com senha, deadlock no
# TRUNCATE e o rate limit da API estrangulando a carga. Todas teriam aparecido
# em noventa segundos se houvesse um jeito de rodar a medição inteira aqui.
#
# A regra que fica: **a esteira não pode conter lógica que não roda na máquina
# de quem escreve**. O YAML chama este script; este script é o que existe.
#
# ## O que ele faz
#
# Sobe tudo do zero num banco descartável, mede e derruba. É seguro rodar em
# cima de um ambiente já de pé: ele mata o que estiver nas portas que usa.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"
BASE="${ADMIN_URL%/*}"
DEMO_DB="${MEDICAO_DB_NAME:-demo_medicao}"
export DEMO_DATABASE_URL="$BASE/$DEMO_DB"
export API_URL="${API_URL:-http://127.0.0.1:3000}"
export WEB_URL="${WEB_URL:-http://127.0.0.1:3001}"

export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"
export STAFF_EMAIL_PEPPER="${STAFF_EMAIL_PEPPER:-pepper-da-medicao}"
export MARKETPLACE_ORIGIN_SECRET="${MARKETPLACE_ORIGIN_SECRET:-origem-da-medicao-0123456789abcdef}"
# Sorteada por execução: o banco é descartável e nada aqui sobrevive.
export MFA_SECRET_KEY="${MFA_SECRET_KEY:-$(openssl rand -base64 32)}"

# A carga dispara milhares de requisições do mesmo IP. Com o limite normal
# ligado, a medição mede o rate limit — e o sintoma é traiçoeiro: o 429 cai na
# leitura da grade, ela volta vazia e o relatório diz "agenda não encheu".
# O limite tem suíte própria (`rate-limit.e2e.test.ts`); aqui ele é ruído.
export RATE_LIMIT_SHORT="${RATE_LIMIT_SHORT:-1000000}"
export RATE_LIMIT_LONG="${RATE_LIMIT_LONG:-1000000}"

PORTA_API="${API_URL##*:}"
PORTA_WEB="${WEB_URL##*:}"
LOG_API="$(mktemp -t medicao-api-XXXXXX.log)"
LOG_WEB="$(mktemp -t medicao-web-XXXXXX.log)"

derrubar() {
  local saida=$?
  if [ "$saida" -ne 0 ]; then
    printf '\n\033[1m--- log da API ---\033[0m\n'; tail -60 "$LOG_API" || true
    printf '\n\033[1m--- log do web ---\033[0m\n'; tail -60 "$LOG_WEB" || true
  fi
  fuser -k "$PORTA_API/tcp" >/dev/null 2>&1 || true
  fuser -k "$PORTA_WEB/tcp" >/dev/null 2>&1 || true
  if [ -z "${MEDICAO_MANTER_BANCO:-}" ]; then
    psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE);" >/dev/null 2>&1 || true
  fi
  rm -f "$LOG_API" "$LOG_WEB"
  exit "$saida"
}
trap derrubar EXIT

printf '\n\033[1m==> banco de demonstração (%s)\033[0m\n' "$DEMO_DB"
fuser -k "$PORTA_API/tcp" >/dev/null 2>&1 || true
fuser -k "$PORTA_WEB/tcp" >/dev/null 2>&1 || true
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE);" >/dev/null 2>&1 || true
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DEMO_DB;"
ADMIN_DATABASE_URL="$ADMIN_URL" scripts/bootstrap-role.sh >/dev/null
for m in packages/db/migrations/*.sql; do
  psql "$DEMO_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$m"
done
printf '    %s migrações aplicadas\n' "$(ls packages/db/migrations/*.sql | wc -l | tr -d ' ')"

if [ -z "${MEDICAO_PULAR_BUILD:-}" ]; then
  printf '\n\033[1m==> construir\033[0m\n'
  pnpm -r build >/dev/null
  printf '    ok\n'
fi

printf '\n\033[1m==> subir API e web\033[0m\n'
DATABASE_URL="$(scripts/url-do-app.sh "$ADMIN_URL" "$APP_DB_PASSWORD" "$DEMO_DB")"
export DATABASE_URL
export APP_DATABASE_URL="$DATABASE_URL"

# `nohup` com a saída redirecionada: sem isso os processos morrem junto com o
# shell e as etapas seguintes medem o nada.
nohup node apps/api/dist/main.js > "$LOG_API" 2>&1 &
nohup pnpm --filter @barbearia/web exec next start -p "$PORTA_WEB" > "$LOG_WEB" 2>&1 &
# Sem isto o shell imprime "Killed" ao derrubar os dois no fim, e a última
# linha da execução vira um susto em cima de uma medição que passou.
disown -a 2>/dev/null || true

# A espera é pela **sonda de pronto**, não por um `sleep`: ela só responde ok
# com o banco respondendo e a conexão sem BYPASSRLS. Um `sleep` esconderia
# atrás de um número uma API que subiu quebrada.
for i in $(seq 1 60); do
  if curl -fsS "$API_URL/health/pronto" 2>/dev/null | grep -q '"status":"ok"'; then
    printf '    API pronta\n'; break
  fi
  [ "$i" = 60 ] && { echo "API não ficou pronta"; exit 1; }
  sleep 1
done
for i in $(seq 1 60); do
  if curl -fsS "$WEB_URL/" >/dev/null 2>&1; then printf '    web pronto\n'; break; fi
  [ "$i" = 60 ] && { echo "web não subiu"; exit 1; }
  sleep 1
done

printf '\n\033[1m==> responsividade em 360, 390, 768 e 1280\033[0m\n'
node scripts/medir-responsividade.js

printf '\n\033[1m==> percursos: do clique ao banco\033[0m\n'
node scripts/percorrer.mjs

printf '\n\033[1m==> carga em /availability\033[0m\n'
node scripts/carga-availability.mjs

printf '\n\033[32mmedição: tudo dentro do esperado.\033[0m\n'
