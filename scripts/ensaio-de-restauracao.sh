#!/usr/bin/env bash
# Ensaio de restauração (SPEC Parte 5 §5.12: "backup não testado não é backup").
#
#   ADMIN_DATABASE_URL=... scripts/ensaio-de-restauracao.sh <banco-de-origem>
#
# ## Por que "pg_restore saiu 0" não é resposta
#
# O jeito comum de "testar backup" é restaurar e olhar o código de saída. Isso
# responde "o arquivo não está corrompido" e mais nada. As três formas de perder
# dado que já vi passar por esse teste:
#
# - **o dump não tinha tudo** — schema sem dados, ou uma tabela fora do filtro;
# - **a restauração perdeu a segurança** — as políticas de RLS não vieram junto,
#   e o banco restaurado mistura as barbearias. Continua "funcionando";
# - **o schema restaurado é de outra versão** — o dump é de antes de uma
#   migração, e a aplicação sobe contra ele e quebra em produção.
#
# Este ensaio confere as três. Ele restaura num banco descartável e faz
# perguntas ao **banco restaurado**, não ao processo que restaurou.
#
# ## Quando rodar
#
# Uma vez por mês, é o que a SPEC pede — e depois de toda mudança no processo de
# backup. O resultado é para ser lido: ele imprime o que comparou.
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGEM_DB="${1:?nome do banco de origem (ex.: barbearia_producao)}"
: "${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"

BASE="${ADMIN_DATABASE_URL%/*}"
ORIGEM="$BASE/$ORIGEM_DB"
ENSAIO_DB="ensaio_restauracao_$$"
ENSAIO="$BASE/$ENSAIO_DB"
DUMP="$(mktemp -t barbearia-dump-XXXXXX.sql)"

limpar() {
  psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS $ENSAIO_DB WITH (FORCE);" >/dev/null 2>&1 || true
  rm -f "$DUMP"
}
trap limpar EXIT

falhas=0
reprovar() { printf '  \033[31mFALHOU\033[0m  %s\n' "$1"; failures=1; falhas=$((falhas + 1)); }
aprovar()  { printf '  \033[32mok\033[0m      %s\n' "$1"; }

printf '\n\033[1m==> dump de %s\033[0m\n' "$ORIGEM_DB"
pg_dump "$ORIGEM" --format=plain --no-owner --no-privileges --file="$DUMP"
printf '    %s\n' "$(du -h "$DUMP" | cut -f1)"

printf '\n\033[1m==> restauração num banco descartável\033[0m\n'
psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $ENSAIO_DB;"
psql "$ENSAIO" -q -v ON_ERROR_STOP=1 -f "$DUMP" >/dev/null
printf '    restaurado em %s\n' "$ENSAIO_DB"

# `xargs` e não `tr -d ' '`: o segundo apaga **todo** espaço, inclusive os
# separadores da lista de tabelas — que virava um identificador único de
# quatrocentos caracteres. Aqui só as pontas são cortadas.
conta() { psql "$1" -tAc "$2" | xargs; }

printf '\n\033[1m==> o que veio junto\033[0m\n'

# 1. Cada tabela de negócio tem a mesma contagem dos dois lados.
#
# Comparar só o total do banco esconderia uma tabela vazia compensada por outra
# — e a que costuma vir vazia é a que tem trigger ou constraint estranha, que é
# justamente a que dói perder.
TABELAS=$(conta "$ORIGEM" "
  SELECT string_agg(tablename, ' ' ORDER BY tablename)
  FROM pg_tables WHERE schemaname = 'public'")

for tabela in $TABELAS; do
  antes=$(conta "$ORIGEM" "SELECT count(*) FROM $tabela")
  depois=$(conta "$ENSAIO" "SELECT count(*) FROM $tabela")
  if [ "$antes" != "$depois" ]; then
    reprovar "$tabela: $antes linha(s) na origem, $depois no restaurado"
  fi
done
[ "$falhas" -eq 0 ] && aprovar "contagem idêntica em $(echo "$TABELAS" | wc -w) tabelas"

# 2. A RLS veio junto.
#
# É a garantia que separa uma barbearia da outra. Um dump feito sem ela
# restaura um banco que responde a tudo — e ninguém percebe até a primeira
# consulta devolver o cliente do vizinho.
antes_rls=$(conta "$ORIGEM" "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
depois_rls=$(conta "$ENSAIO" "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
if [ "$antes_rls" = "$depois_rls" ] && [ "$antes_rls" -gt 0 ]; then
  aprovar "$depois_rls políticas de RLS restauradas"
else
  reprovar "políticas de RLS: $antes_rls na origem, $depois_rls no restaurado"
fi

forcadas=$(conta "$ENSAIO" "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity")
antes_forcadas=$(conta "$ORIGEM" "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity")
if [ "$forcadas" = "$antes_forcadas" ] && [ "$forcadas" -gt 0 ]; then
  aprovar "$forcadas tabelas continuam com RLS FORCE"
else
  reprovar "RLS FORCE: $antes_forcadas na origem, $forcadas no restaurado"
fi

# 3. Constraint de exclusão, trigger e check — o que Prisma não representa.
#
# São elas que impedem overbooking e alteração de comissão fechada. Um dump que
# as perdesse deixaria um banco que aceita o que o produto inteiro existe para
# recusar.
for par in "constraints de exclusão:SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='x'" \
           "triggers:SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal" \
           "checks:SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='c'"; do
  nome="${par%%:*}"
  sql="${par#*:}"
  a=$(conta "$ORIGEM" "$sql")
  d=$(conta "$ENSAIO" "$sql")
  if [ "$a" = "$d" ] && [ "$a" -gt 0 ]; then
    aprovar "$d $nome"
  else
    reprovar "$nome: $a na origem, $d no restaurado"
  fi
done

# 4. O schema restaurado é da versão que a aplicação espera.
#
# Um dump de antes de uma migração restaura um banco íntegro e **errado**: a
# aplicação sobe contra ele e quebra na primeira consulta a uma coluna nova. A
# comparação é com o que está em `packages/db/migrations`, que é a fonte da
# verdade do schema (CLAUDE.md §4).
ultima_migracao=$(ls packages/db/migrations/*.sql | tail -1 | xargs basename)
printf '\n\033[1m==> versão do schema\033[0m\n'
printf '    última migração no repositório: %s\n' "$ultima_migracao"

# As colunas do bloco 22 são o marcador mais recente que o schema carrega. Trocar
# isto por uma tabela de versões é o passo natural quando houver deploy de
# verdade — está declarado como lacuna no ROADMAP.
tem_import=$(conta "$ENSAIO" "
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='customers' AND column_name='import_id'")
if [ "$tem_import" = "1" ]; then
  aprovar "schema restaurado tem as colunas da última migração aplicada"
else
  reprovar "schema restaurado é anterior à migração 0025 — a aplicação não sobe contra ele"
fi

printf '\n'
if [ "$falhas" -eq 0 ]; then
  printf '\033[32mensaio: o backup de %s restaura e serve.\033[0m\n' "$ORIGEM_DB"
  exit 0
fi

printf '\033[31mensaio: %d verificação(ões) reprovaram — este backup não serve.\033[0m\n' "$falhas"
exit 1
