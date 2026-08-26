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

# Conferir antes de dizer "no ar", como o `atualizar.sh` já fazia.
#
# Este script terminava imprimindo "no ar na versão X" sem verificar nada, e
# imprimiu isso sobre um contêiner morto: a versão anterior tinha um `throw` no
# boot da API e não subia. Quem acionou a rede de segurança ficou com o site
# fora e uma mensagem verde dizendo que estava tudo bem.
#
# Rede de segurança que só falha quando é acionada é pior que nenhuma — quem
# tem uma para de procurar outra saída. Se a volta não sobe, o que resta é ir
# para frente ou restaurar o backup, e a mensagem diz isso em vez de mentir.
DOMINIO_NO_ENV="$(grep -E '^DOMINIO=' .env | cut -d= -f2 | tr -d '"' || true)"
titulo "conferindo"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMINIO_NO_ENV/" > /dev/null 2>&1; then
    printf '\n\033[32mno ar na versão %s. O banco não foi tocado.\033[0m\n' "$(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 4
done

morrer "a versão $(git rev-parse --short HEAD) subiu e o site não respondeu em 2 minutos.
Ela também está quebrada — voltar mais não necessariamente ajuda.
Veja o motivo com:
  docker compose -f $DESTINO/deploy/compose.yml --env-file $DESTINO/.env logs api --tail 60"

