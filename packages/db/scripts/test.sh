#!/usr/bin/env bash
# Banco descartável: invariantes SQL + testes do cliente com escopo de tenant.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5433/postgres}"
DB_NAME="${TEST_DB_NAME:-barbearia_test}"
BASE="${ADMIN_URL%/*}"
# Senha efêmera por execução: nunca há credencial previsível, nem no repositório.
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

cleanup() { psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

ADMIN_DATABASE_URL="$ADMIN_URL" ../../scripts/bootstrap-role.sh >/dev/null
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"
for migration in migrations/*.sql; do
  psql "$BASE/$DB_NAME" -q -v ON_ERROR_STOP=1 -f "$migration"
done

echo "==> invariantes do schema"
# A saída completa vai para arquivo e o filtro roda em cima dele. Filtrar o psql
# direto pelo cano escondia o erro: um arquivo que abortava na primeira linha
# não imprimia NOTICE nenhuma, o `grep` não casava nada, e a única pista era o
# código de saída. Foi assim que a prova nova ficou minutos "sem rodar".
for prova in test/*.test.sql; do
  saida=$(mktemp)
  if psql "$BASE/$DB_NAME" -v ON_ERROR_STOP=1 -f "$prova" >"$saida" 2>&1; then
    # Um arquivo que roda inteiro e não anuncia nada é indistinguível de um que
    # não foi escrito — e antes desta guarda ele derrubava a suíte sem dizer o
    # nome, porque o `grep` vazio saía 1 sob `set -e`. Foi o que aconteceu com a
    # prova do bloco 37, que escrevia "ok" em vez de "OK".
    if ! grep -E "NOTICE:  (OK|---|FALHOU)" "$saida" | sed 's/^NOTICE:  //'; then
      echo "FALHOU: $prova não anunciou nenhuma invariante."
      echo "    Cada prova precisa de RAISE NOTICE 'OK n — ...' (maiúsculo)."
      rm -f "$saida"
      exit 1
    fi
  else
    echo "FALHOU: $prova"
    tail -20 "$saida" | sed 's/^/    /'
    rm -f "$saida"
    exit 1
  fi
  rm -f "$saida"
done

echo "==> cliente com escopo de tenant"
export DATABASE_URL="$BASE/$DB_NAME"
APP_DATABASE_URL="$(../../scripts/url-do-app.sh "$ADMIN_URL" "$APP_DB_PASSWORD" "$DB_NAME")"
export APP_DATABASE_URL
exec vitest run
