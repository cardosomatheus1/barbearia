#!/usr/bin/env bash
# Sobe o sistema inteiro nesta máquina, do zero.
#
#   scripts/rodar-local.sh
#
# ## Por que este arquivo existe
#
# O README já dizia como rodar os testes, e não como rodar **o produto**. Quem
# recebe o repositório precisava juntar sozinho seis coisas espalhadas: criar o
# banco, criar o role restrito, aplicar 38 migrações, sortear três segredos que
# a aplicação exige e recusa default para, construir tudo e subir três
# processos na ordem. Nenhuma delas é difícil; a soma é meia hora e um erro
# calado no meio.
#
# É o mesmo argumento de `scripts/medicao.sh`: instrução que só existe em prosa
# é instrução que ninguém executa igual duas vezes.
#
# ## O que ele faz
#
#   1. confere Node, pnpm e Postgres
#   2. `pnpm install`
#   3. cria o banco, o role da aplicação e aplica as migrações
#   4. sorteia os segredos e guarda em `.env.local` (fora do Git)
#   5. constrói os pacotes
#   6. semeia uma barbearia de demonstração, com agenda do dia
#   7. sobe API, worker e web, e fica esperando — Ctrl+C derruba os três
#
# Rodar de novo **reaproveita** o banco e os segredos: só o que faltar é feito.
# Para começar limpo, `scripts/rodar-local.sh --zerar`.
#
# ## Opções
#
#   --zerar        apaga o banco antes de tudo
#   --sem-demo     não semeia a barbearia de demonstração
#   --sem-install  pula `pnpm install` (útil quando já rodou)
#   --sem-build    pula a construção (só quando `dist/` está fresco)
set -euo pipefail
cd "$(dirname "$0")/.."

ZERAR=""; SEM_DEMO=""; SEM_INSTALL=""; SEM_BUILD=""
for arg in "$@"; do
  case "$arg" in
    --zerar) ZERAR=1 ;;
    --sem-demo) SEM_DEMO=1 ;;
    --sem-install) SEM_INSTALL=1 ;;
    --sem-build) SEM_BUILD=1 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opção desconhecida: $arg (use --help)" >&2; exit 2 ;;
  esac
done

titulo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()     { printf '    \033[32m%s\033[0m\n' "$1"; }
aviso()  { printf '    \033[33m%s\033[0m\n' "$1"; }
erro()   { printf '\n\033[31m%s\033[0m\n' "$1" >&2; }

BANCO="${BARBEARIA_DB:-barbearia_local}"
ENV_LOCAL=".env.local"
PORTA_API="${PORT:-3000}"
PORTA_WEB="${PORTA_WEB:-3001}"

# ---------------------------------------------------------------------------
# 1. Pré-requisitos
# ---------------------------------------------------------------------------

titulo "conferindo o que precisa estar instalado"

faltou=""
precisa() {
  command -v "$1" >/dev/null 2>&1 || { erro "falta $1 — $2"; faltou=1; }
}
precisa node   "instale o Node 22 ou mais novo: https://nodejs.org"
precisa psql   "instale o PostgreSQL 16+ (o cliente psql vem junto)"
precisa openssl "vem com o sistema na maioria das distribuições"

if command -v node >/dev/null 2>&1; then
  MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$MAIOR" -lt 22 ]; then
    erro "Node $MAIOR encontrado; o projeto exige 22 ou mais novo"
    faltou=1
  else
    ok "node $(node -v)"
  fi
fi

# pnpm entra pelo corepack quando não está instalado: a versão exata está no
# `packageManager` do package.json, e é ela que o lockfile assume.
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    aviso "pnpm não encontrado; habilitando pelo corepack"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare --activate >/dev/null 2>&1 || true
  fi
fi
precisa pnpm "habilite com \`corepack enable\` ou \`npm i -g pnpm\`"
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm -v)"

[ -n "$faltou" ] && { erro "instale o que falta acima e rode de novo."; exit 1; }

# ---------------------------------------------------------------------------
# 2. Postgres de pé, e em qual porta
# ---------------------------------------------------------------------------
#
# A porta é procurada em vez de assumida: 5432 é o padrão, mas a instalação por
# Docker e a segunda instância de quem já tem um cluster costumam ficar na 5433.
# Errar isto é o "Connection refused" mais comum de quem recebe o repositório.

titulo "procurando o Postgres"

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  ADMIN_URL="$ADMIN_DATABASE_URL"
  psql "$ADMIN_URL" -q -c 'select 1' >/dev/null 2>&1 \
    || { erro "não consegui conectar em ADMIN_DATABASE_URL."; exit 1; }
  ok "usando ADMIN_DATABASE_URL"
else
  ADMIN_URL=""
  for tentativa in \
    "postgres://postgres@127.0.0.1:5432/postgres" \
    "postgres://postgres@127.0.0.1:5433/postgres" \
    "postgres://postgres:postgres@127.0.0.1:5432/postgres" \
    "postgres://postgres:postgres@127.0.0.1:5433/postgres"; do
    if psql "$tentativa" -q -c 'select 1' >/dev/null 2>&1; then ADMIN_URL="$tentativa"; break; fi
  done
  # Antes de desistir, tenta subir um cluster instalado e parado. É o caso mais
  # comum em máquina de desenvolvimento: o Postgres está instalado e o serviço
  # não sobe no boot, e a mensagem que o usuário vê ("Connection refused") não
  # sugere nada.
  if [ -z "$ADMIN_URL" ] && [ -x scripts/pg-de-pe.sh ]; then
    aviso "nenhum Postgres respondendo; tentando subir o cluster local"
    scripts/pg-de-pe.sh >/dev/null 2>&1 || true
    for tentativa in \
      "postgres://postgres@127.0.0.1:5432/postgres" \
      "postgres://postgres:postgres@127.0.0.1:5432/postgres"; do
      if psql "$tentativa" -q -c 'select 1' >/dev/null 2>&1; then ADMIN_URL="$tentativa"; break; fi
    done
  fi

  if [ -z "$ADMIN_URL" ]; then
    erro "não achei um Postgres respondendo em 127.0.0.1:5432 nem :5433."
    cat >&2 <<'AJUDA'

    Suba um assim, se tiver Docker:

      docker run -d --name barbearia-pg -p 5432:5432 \
        -e POSTGRES_PASSWORD=postgres postgres:16

    Ou aponte para o seu:

      ADMIN_DATABASE_URL="postgres://usuario:senha@host:porta/postgres" \
        scripts/rodar-local.sh

AJUDA
    exit 1
  fi
  ok "achei em ${ADMIN_URL##*@}"
fi
BASE="${ADMIN_URL%/*}"

# As três extensões que as migrações usam. `btree_gist` é a que sustenta a
# constraint anti-overbooking, e sem ela a migração 0002 para com um erro que
# não diz o que instalar.
for ext in pgcrypto citext btree_gist; do
  if ! psql "$ADMIN_URL" -tAc "select 1 from pg_available_extensions where name = '$ext'" | grep -q 1; then
    erro "a extensão \"$ext\" não está disponível neste Postgres."
    echo "    No Debian/Ubuntu ela vem em postgresql-contrib-16." >&2
    exit 1
  fi
done
ok "pgcrypto, citext e btree_gist disponíveis"

# ---------------------------------------------------------------------------
# 3. Segredos: sorteados uma vez e guardados
# ---------------------------------------------------------------------------
#
# A aplicação **recusa** default para estes três (CLAUDE.md §2): cair num valor
# fraco em silêncio deixaria o índice de login em claro e o segredo do segundo
# fator decifrável. Aqui eles são sorteados e gravados em `.env.local`, que o
# `.gitignore` já cobre pelo padrão `.env.*`.
#
# Reaproveitar o arquivo entre execuções não é conveniência: trocar o
# STAFF_EMAIL_PEPPER torna impossível o login de quem já tem conta, porque as
# chaves antigas deixam de bater.

titulo "segredos locais"

if [ -f "$ENV_LOCAL" ]; then
  # shellcheck disable=SC1090
  set -a; . "./$ENV_LOCAL"; set +a
  ok "reaproveitando $ENV_LOCAL"
else
  # Alfabeto fechado na senha do banco: ela entra numa URL, e `url-do-app.sh`
  # recusa o que precisaria de escape.
  APP_DB_PASSWORD="$(openssl rand -hex 16)"
  STAFF_EMAIL_PEPPER="$(openssl rand -hex 32)"
  MFA_SECRET_KEY="$(openssl rand -base64 32)"
  # `WHATSAPP_TOKEN_KEY` faltava aqui, e o sintoma era o pior formato possível:
  # salvar o cadastro do WhatsApp respondia **500**, a tela dizia "Não deu para
  # salvar. Tente de novo." e tentar de novo dava o mesmo. O motivo real —
  # `CofreError: WHATSAPP_TOKEN_KEY não definida` — só existia no log da API.
  # Este arquivo existe justamente para ninguém ter que descobrir segredo
  # faltando por tentativa.
  WHATSAPP_TOKEN_KEY="$(openssl rand -base64 32)"
  cat > "$ENV_LOCAL" <<ENV
# Gerado por scripts/rodar-local.sh. Fora do Git (.gitignore cobre .env.*).
# Apagar este arquivo obriga a recriar o banco: trocar o pepper invalida os
# logins existentes, porque o índice de e-mail é um HMAC com ele.
APP_DB_PASSWORD="$APP_DB_PASSWORD"
STAFF_EMAIL_PEPPER="$STAFF_EMAIL_PEPPER"
MFA_SECRET_KEY="$MFA_SECRET_KEY"
WHATSAPP_TOKEN_KEY="$WHATSAPP_TOKEN_KEY"
ENV
  chmod 600 "$ENV_LOCAL"
  ok "sorteados e gravados em $ENV_LOCAL"
fi
export APP_DB_PASSWORD STAFF_EMAIL_PEPPER MFA_SECRET_KEY WHATSAPP_TOKEN_KEY

# ---------------------------------------------------------------------------
# 4. Dependências
# ---------------------------------------------------------------------------

# `--sem-install` é um atalho, não uma ordem de pular o indispensável.
#
# Sem esta conferência, pedi-lo com `node_modules` ausente levava o script
# direto ao build, que falhava com `sh: 1: tsc: not found` — uma mensagem que
# não diz nada sobre a causa e manda quem a recebeu procurar o TypeScript.
# Aconteceu no primeiro Codespaces, porque a preparação do ambiente não tinha
# rodado, e o atalho que existe para poupar trinta segundos custou a sessão
# inteira.
#
# A marca conferida é o `.bin` do pnpm: `node_modules` existe e fica pela
# metade quando uma instalação é interrompida, e é o `.bin` que carrega os
# executáveis que o build chama.
if [ -n "$SEM_INSTALL" ] && [ ! -d node_modules/.bin ]; then
  aviso "--sem-install ignorado: as dependências ainda não estão instaladas"
  SEM_INSTALL=""
fi

if [ -z "$SEM_INSTALL" ]; then
  titulo "instalando dependências"
  # `CI=true` porque o script também roda sem terminal interativo (Codespaces,
  # esteira): sem ele, o pnpm que precisa descartar um `node_modules` de outra
  # plataforma para e pede uma confirmação que ninguém pode dar.
  CI=true pnpm install --frozen-lockfile
  ok "ok"
fi

# ---------------------------------------------------------------------------
# 5. Banco
# ---------------------------------------------------------------------------

titulo "banco ($BANCO)"

if [ -n "$ZERAR" ]; then
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $BANCO WITH (FORCE);" >/dev/null
  aviso "banco anterior apagado"
fi

EXISTIA="$(psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname = '$BANCO'")"
if [ "$EXISTIA" != "1" ]; then
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $BANCO;"
  ok "criado"
fi

ADMIN_DATABASE_URL="$ADMIN_URL" scripts/bootstrap-role.sh >/dev/null
ok "role barbearia_app pronto (NOBYPASSRLS, sem DDL)"

# As migrações são idempotentes o bastante para reaplicar? Não são — e por isso
# só rodam em banco novo. Reaplicar num banco já migrado pararia no primeiro
# CREATE TABLE, com um erro que parece defeito e é só ordem.
if [ "$EXISTIA" != "1" ]; then
  for m in packages/db/migrations/*.sql; do
    psql "$BASE/$BANCO" -q -v ON_ERROR_STOP=1 -f "$m"
  done
  ok "$(ls packages/db/migrations/*.sql | wc -l | tr -d ' ') migrações aplicadas"
else
  ok "banco já existia; migrações não foram reaplicadas (use --zerar para recomeçar)"
fi

DATABASE_URL="$(scripts/url-do-app.sh "$ADMIN_URL" "$APP_DB_PASSWORD" "$BANCO")"
export DATABASE_URL
export APP_DATABASE_URL="$DATABASE_URL"
export ADMIN_DATABASE_URL="$ADMIN_URL"

# ---------------------------------------------------------------------------
# 6. Construir
# ---------------------------------------------------------------------------

if [ -z "$SEM_BUILD" ]; then
  titulo "construindo (leva alguns minutos na primeira vez)"
  pnpm -r build
  ok "ok"
fi

# ---------------------------------------------------------------------------
# 7. Subir os três processos
# ---------------------------------------------------------------------------

titulo "subindo API, worker e web"

export PORT="$PORTA_API"
export API_URL="http://127.0.0.1:$PORTA_API"

LOG_API="$(mktemp -t barbearia-api-XXXXXX.log)"
LOG_WORKER="$(mktemp -t barbearia-worker-XXXXXX.log)"
LOG_WEB="$(mktemp -t barbearia-web-XXXXXX.log)"

derrubar() {
  local saida=$?
  printf '\n'
  titulo "derrubando"
  # Mata o grupo de cada filho: `next start` gera um processo próprio, e matar
  # só o pai deixaria a porta 3001 ocupada para a próxima execução.
  for pid in ${PID_API:-} ${PID_WORKER:-} ${PID_WEB:-}; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  if [ "$saida" -ne 0 ]; then
    printf '\n\033[1m--- log da API ---\033[0m\n';    tail -40 "$LOG_API" 2>/dev/null || true
    printf '\n\033[1m--- log do worker ---\033[0m\n'; tail -20 "$LOG_WORKER" 2>/dev/null || true
    printf '\n\033[1m--- log do web ---\033[0m\n';    tail -40 "$LOG_WEB" 2>/dev/null || true
  fi
  rm -f "$LOG_API" "$LOG_WORKER" "$LOG_WEB"
  ok "até logo"
  exit "$saida"
}
trap derrubar EXIT INT TERM

node apps/api/dist/main.js > "$LOG_API" 2>&1 &
PID_API=$!
node apps/worker/dist/main.js > "$LOG_WORKER" 2>&1 &
PID_WORKER=$!

# A espera é pela **sonda de pronto**, não por um `sleep`: ela só responde ok
# com o banco respondendo e a conexão sem BYPASSRLS. Um `sleep` esconderia
# atrás de um número uma API que subiu quebrada.
for i in $(seq 1 90); do
  if curl -fsS "$API_URL/health/pronto" 2>/dev/null | grep -q '"status":"ok"'; then
    ok "API pronta em $API_URL"; break
  fi
  kill -0 "$PID_API" 2>/dev/null || { erro "a API morreu ao subir."; exit 1; }
  [ "$i" = 90 ] && { erro "a API não ficou pronta."; exit 1; }
  sleep 1
done

pnpm --filter @barbearia/web exec next start -p "$PORTA_WEB" > "$LOG_WEB" 2>&1 &
PID_WEB=$!
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORTA_WEB/" >/dev/null 2>&1; then
    ok "web pronto em http://127.0.0.1:$PORTA_WEB"; break
  fi
  kill -0 "$PID_WEB" 2>/dev/null || { erro "o web morreu ao subir."; exit 1; }
  [ "$i" = 90 ] && { erro "o web não subiu."; exit 1; }
  sleep 1
done

# ---------------------------------------------------------------------------
# 8. Demonstração
# ---------------------------------------------------------------------------

if [ -z "$SEM_DEMO" ]; then
  titulo "barbearia de demonstração"
  WEB_URL="http://127.0.0.1:$PORTA_WEB" node scripts/semear-demo.mjs || {
    aviso "a semeadura falhou; o sistema continua de pé e vazio"
  }
fi

printf '\n\033[32m%s\033[0m\n' "tudo de pé. Ctrl+C derruba os três processos."
printf '\n'
printf '    site         http://127.0.0.1:%s\n' "$PORTA_WEB"
printf '    painel       http://127.0.0.1:%s/admin/entrar\n' "$PORTA_WEB"
printf '    API          %s\n' "$API_URL"
printf '\n'
printf '    logs:  tail -f %s\n' "$LOG_API"
printf '           tail -f %s\n' "$LOG_WEB"
printf '\n'

wait
