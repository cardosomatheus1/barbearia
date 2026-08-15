#!/usr/bin/env bash
# A volta que acontece quase sempre: subir a imagem anterior.
#
#   deploy/voltar.sh
#
# ## Por que ela é barata, e o que a torna barata
#
# **Nada é feito com o banco.** A versão de ontem roda contra o banco de hoje
# porque toda migração deste repositório é aditiva — a versão anterior não
# conhece a coluna nova e não precisa dela. Isso não é convenção esperançosa:
# `packages/db/test/migracao-aditiva.test.mjs` varre as 83 migrações atrás das
# cinco formas que quebrariam quem está no ar (`DROP TABLE`, `DROP COLUMN`,
# `RENAME`, mudança de tipo e `SET NOT NULL`) e reprova o portão.
#
# Por isso esta volta custa o tempo de um `build` e zero dado. A outra volta —
# restaurar o backup — é para quando **a migração** corrompeu algo, e ela perde
# tudo que foi escrito depois do dump. Está em `docs/go-live.md`, e é a que se
# quer nunca precisar.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
COMPOSE="docker compose -f $DESTINO/deploy/compose.yml --env-file $DESTINO/.env"

titulo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
morrer() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

cd "$DESTINO"
ALVO="${1:-$(cat "$DESTINO/.versao-anterior" 2>/dev/null || true)}"
[ -n "$ALVO" ] || morrer "não sei para onde voltar: passe o commit, ou rode depois de um deploy/atualizar.sh"

titulo "voltando para $(git rev-parse --short "$ALVO")"
git reset --hard --quiet "$ALVO"

titulo "construindo a anterior"
$COMPOSE build

titulo "subindo"
# Sem `preparar`: **não se desfaz migração**. A coluna nova fica no banco e a
# versão anterior a ignora, que é exatamente o que a torna reversível.
$COMPOSE up -d --no-deps api worker web

printf '\n\033[32mno ar na versão %s. O banco não foi tocado.\033[0m\n' "$(git rev-parse --short HEAD)"
