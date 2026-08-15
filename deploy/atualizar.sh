#!/usr/bin/env bash
# Subir a versão nova, com a volta pronta antes de começar.
#
#   deploy/atualizar.sh
#
# É o procedimento de quatro linhas do `docs/go-live.md`, executável:
#
#   1. backup **imediatamente antes** de migrar — é ele que define quanto dado
#      se perde no pior caso;
#   2. migrações; se falharem, para aqui e nada subiu;
#   3. imagem nova no ar;
#   4. se a versão nova estiver ruim, `deploy/voltar.sh` sobe a anterior — e o
#      banco fica como está, porque toda migração deste repositório é aditiva e
#      há teste no portão que cobra isso.
#
# A ordem importa e é o oposto do intuitivo: o backup vem antes da migração, não
# depois do deploy. Depois já é tarde — o que se quer poder desfazer é
# justamente a migração.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
# A branch padrão do repositório, e não um nome escrito aqui: quem renomear a
# branch quebraria a atualização de um servidor que já está no ar.
BRANCH="${BRANCH:-$(git -C "${DESTINO:-/opt/barbearia}" rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)}"
BRANCH="${BRANCH:-main}"
COMPOSE="docker compose -f $DESTINO/deploy/compose.yml --env-file $DESTINO/.env"

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
titulo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
morrer() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

cd "$DESTINO"

titulo "a versão de agora, para poder voltar"
ANTERIOR="$(git rev-parse HEAD)"
echo "$ANTERIOR" > "$DESTINO/.versao-anterior"
verde "  $(git rev-parse --short "$ANTERIOR")"

titulo "backup antes de migrar"
DESTINO="$DESTINO" "$DESTINO/deploy/backup.sh" || morrer "o backup falhou: nada foi migrado e nada subiu"

titulo "código novo"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
verde "  $(git rev-parse --short HEAD)"

titulo "construindo"
$COMPOSE build

titulo "migrações"
# `preparar` sai com código diferente de zero se qualquer migração falhar, e o
# `set -e` para aqui: a imagem antiga continua no ar, servindo.
$COMPOSE run --rm preparar || morrer "migração falhou. A versão anterior continua no ar. Restaure o backup só se o banco tiver ficado inconsistente."

titulo "subindo"
$COMPOSE up -d --no-deps api worker web

DOMINIO_NO_ENV="$(grep -E '^DOMINIO=' .env | cut -d= -f2 | tr -d '"' || true)"
titulo "conferindo"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMINIO_NO_ENV/" > /dev/null 2>&1; then
    verde "  ok  o site responde"
    exit 0
  fi
  sleep 4
done
morrer "o site não respondeu em 2 minutos. Volte com: deploy/voltar.sh"
