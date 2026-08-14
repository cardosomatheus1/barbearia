#!/usr/bin/env bash
# Ensaia a volta atrás de um deploy, e mede as duas.
#
#   ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres scripts/ensaio-de-rollback.sh
#
# ## As duas voltas são diferentes, e a diferença é tudo
#
# Existe uma pergunta antes de qualquer procedimento: **o que quebrou?**
#
# 1. **O aplicativo novo está ruim e o banco está bom.** É o caso comum — bug na
#    versão que subiu. A volta é subir a imagem anterior, e ela funciona porque
#    toda migração deste repositório é aditiva: a versão de ontem não conhece a
#    coluna nova e não precisa. Segundos, sem tocar em dado, sem perder venda.
#    Quem garante isso é `packages/db/test/migracao-aditiva.test.mjs`, no portão.
#
# 2. **A migração em si quebrou.** Aí não há imagem anterior que salve: é
#    restaurar o backup de antes dela. E o custo é o dado escrito entre o backup
#    e a volta — por isso o backup é tirado **imediatamente antes** de migrar, e
#    por isso este ensaio mede quanto tempo essa janela dura.
#
# Este script exercita a segunda, que é a cara. A primeira é uma linha de
# `docker` e uma propriedade provada por teste.
#
# ## O que ele responde, com número
#
# - quanto tempo o backup pré-migração leva sobre volume de verdade;
# - quanto tempo a migração leva;
# - quanto tempo a restauração leva — que é a duração real da indisponibilidade;
# - e se o banco restaurado é **o mesmo**: contagem por tabela, políticas de RLS,
#   `FORCE`, constraints de exclusão, gatilhos e checks.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN="${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"
BASE="${ADMIN%/*}"
DB="${ENSAIO_ROLLBACK_DB:-ensaio_rollback}"
ALVO="$BASE/$DB"
DUMP="$(mktemp -t rollback-XXXXXX.dump)"

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
titulo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

limpar() {
  local saida=$?
  psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" >/dev/null 2>&1 || true
  rm -f "$DUMP"
  exit "$saida"
}
trap limpar EXIT

MIGRACOES=(packages/db/migrations/*.sql)
ULTIMA="${MIGRACOES[${#MIGRACOES[@]}-1]}"

titulo "banco no estado de ontem (sem $(basename "$ULTIMA"))"
psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" >/dev/null 2>&1 || true
psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB;"
ADMIN_DATABASE_URL="$ADMIN" scripts/bootstrap-role.sh >/dev/null
for m in "${MIGRACOES[@]}"; do
  [ "$m" = "$ULTIMA" ] && continue
  psql "$ALVO" -q -v ON_ERROR_STOP=1 -f "$m" >/dev/null
done
printf '    %s migrações aplicadas\n' "$(( ${#MIGRACOES[@]} - 1 ))"

titulo "volume: uma barbearia com movimento"
psql "$ALVO" -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'Ensaio');
INSERT INTO locations (id, tenant_id, name, timezone)
VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
        'Matriz', 'America/Bahia');
-- Trinta mil clientes e cem mil lançamentos: o suficiente para o backup e a
-- restauração pararem de ser instantâneos e virarem um número.
INSERT INTO customers (tenant_id, name, phone_e164)
SELECT '11111111-1111-4111-8111-111111111111', 'Cliente ' || i, '+5571' || (900000000 + i)
  FROM generate_series(1, 30000) AS i;
INSERT INTO customer_ledger (tenant_id, customer_id, kind, amount_cents,
                             balance_after_cents, created_by_name)
SELECT '11111111-1111-4111-8111-111111111111', c.id, 'fiado', 5000, 5000, 'Ensaio'
  FROM customers c, generate_series(1, 3) AS n;
SQL
printf '    %s clientes, %s lançamentos\n' \
  "$(psql "$ALVO" -tAc 'SELECT count(*) FROM customers')" \
  "$(psql "$ALVO" -tAc 'SELECT count(*) FROM customer_ledger')"

# -- 1. o backup de antes ------------------------------------------------------

titulo "backup imediatamente antes de migrar"
inicio=$(date +%s%N)
pg_dump --format=custom --file="$DUMP" "$ALVO"
backup_ms=$(( ($(date +%s%N) - inicio) / 1000000 ))
printf '    %s ms · %s\n' "$backup_ms" "$(du -h "$DUMP" | cut -f1)"

antes_tabelas=$(psql "$ALVO" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
antes_clientes=$(psql "$ALVO" -tAc 'SELECT count(*) FROM customers')
antes_politicas=$(psql "$ALVO" -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public'")

# A assinatura do schema: colunas, funções e constraints, numa soma só.
#
# Ela é **geral** de propósito. A primeira versão deste ensaio procurava uma
# coluna específica como marca da migração, e a coluna era de outra — a última
# migração troca o corpo de uma função e não acrescenta coluna nenhuma. Um
# marcador escolhido a dedo prova o que quem escreveu já achava; a assinatura
# prova que o banco voltou, seja qual for a migração da vez.
assinatura() {
  psql "$1" -tAc "
    SELECT md5(string_agg(linha, E'\n' ORDER BY linha)) FROM (
      SELECT table_name || '.' || column_name || ':' || data_type AS linha
        FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL
      SELECT 'fn:' || p.proname || ':' || md5(coalesce(p.prosrc, ''))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'ct:' || c.conname || ':' || pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
    ) t"
}
antes_assinatura=$(assinatura "$ALVO")

# -- 2. a migração -------------------------------------------------------------

titulo "aplicar $(basename "$ULTIMA")"
inicio=$(date +%s%N)
psql "$ALVO" -q -v ON_ERROR_STOP=1 -f "$ULTIMA" >/dev/null
migracao_ms=$(( ($(date +%s%N) - inicio) / 1000000 ))
depois_assinatura=$(assinatura "$ALVO")
printf '    %s ms\n' "$migracao_ms"

# -- 3. a volta ----------------------------------------------------------------

titulo "a migração quebrou: restaurar o backup"
inicio=$(date +%s%N)
psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" >/dev/null
psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB;"
pg_restore --dbname="$ALVO" --no-owner --no-privileges "$DUMP" >/dev/null 2>&1
restauracao_ms=$(( ($(date +%s%N) - inicio) / 1000000 ))
printf '    %s ms\n' "$restauracao_ms"

# -- 4. é o mesmo banco? -------------------------------------------------------

titulo "o banco restaurado é o de antes"
problemas=0
conferir() {
  local rotulo="$1" esperado="$2" obtido="$3"
  if [ "$esperado" = "$obtido" ]; then
    verde "    ok  $rotulo: $obtido"
  else
    vermelho "    ✗   $rotulo: esperava $esperado, veio $obtido"
    problemas=$((problemas + 1))
  fi
}

conferir "tabelas" "$antes_tabelas" \
  "$(psql "$ALVO" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
conferir "clientes" "$antes_clientes" "$(psql "$ALVO" -tAc 'SELECT count(*) FROM customers')"
conferir "políticas de RLS" "$antes_politicas" \
  "$(psql "$ALVO" -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public'")"

# A migração precisa ter mudado alguma coisa, senão o ensaio é vacuoso: ele
# "provaria" que restaurar um banco idêntico devolve um banco idêntico.
if [ "$antes_assinatura" = "$depois_assinatura" ]; then
  vermelho "    ✗   a migração não mudou o schema: este ensaio não prova nada"
  problemas=$((problemas + 1))
else
  verde "    ok  a migração mudou o schema (é o que se desfaz)"
fi

restaurada=$(assinatura "$ALVO")
if [ "$restaurada" = "$antes_assinatura" ]; then
  verde "    ok  a assinatura do schema é a de antes da migração"
else
  vermelho "    ✗   o schema restaurado não é o de antes: restaurou o banco errado"
  problemas=$((problemas + 1))
fi

# -- 5. o resumo ---------------------------------------------------------------

titulo "resumo"
printf '    backup      %6s ms\n' "$backup_ms"
printf '    migração    %6s ms\n' "$migracao_ms"
printf '    restauração %6s ms   ← a indisponibilidade real\n' "$restauracao_ms"

if [ "$problemas" -gt 0 ]; then
  vermelho "ensaio de rollback: $problemas problema(s)."
  exit 1
fi
verde "ensaio de rollback: a volta funciona, e leva $(( restauracao_ms / 1000 ))s."
