#!/usr/bin/env bash
# O backup, e ele **sai da máquina** quando há para onde ir.
#
#   DESTINO=/opt/barbearia deploy/backup.sh
#
# ## O que este arquivo assume, e por que isso está escrito
#
# Banco e aplicação rodam no mesmo VPS — decisão do `deploy/compose.yml`, com o
# custo declarado ali. O custo é este: **um backup que mora no mesmo disco não é
# backup**. Ele cobre o erro humano ("apaguei o cliente errado") e não cobre o
# caso que tira a barbearia do ar, que é a máquina sumir.
#
# Por isso o envio para fora é o caminho normal e não um extra: com
# `BACKUP_REMOTO` configurado, o arquivo sai por `rclone` para onde quer que
# seja. Sem ele, o script **avisa em toda execução** em vez de fingir que está
# tudo certo — aviso silencioso é pior que erro visível.
#
# ## O formato é `custom`, não SQL
#
# `pg_restore` de um dump `custom` restaura em paralelo e permite escolher o que
# voltar. É o mesmo formato que `scripts/ensaio-de-rollback.sh` mede: 2,7s para
# 30 mil clientes. Um `.sql` de texto restaura em ordem, linha a linha, e não
# aceita nada disso.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
PASTA="${BACKUP_PASTA:-/var/backups/barbearia}"
GUARDAR_DIAS="${BACKUP_DIAS:-14}"
COMPOSE="docker compose -f $DESTINO/deploy/compose.yml --env-file $DESTINO/.env"

mkdir -p "$PASTA"
carimbo="$(date -u +%Y%m%dT%H%M%SZ)"
arquivo="$PASTA/barbearia-$carimbo.dump"

# `pg_dump` de dentro do contêiner do banco: o cliente e o servidor têm a mesma
# versão, e uma incompatibilidade de versão só aparece na hora de restaurar.
$COMPOSE exec -T db pg_dump --format=custom --username postgres barbearia > "$arquivo"

tamanho="$(du -h "$arquivo" | cut -f1)"

# Um dump vazio é o pior desfecho possível: o cron fica verde por meses e a
# descoberta acontece no dia da restauração. O piso é grosseiro de propósito —
# ele pega arquivo truncado e erro engolido, que é o que acontece de verdade.
bytes="$(stat -c %s "$arquivo")"
if [ "$bytes" -lt 20000 ]; then
  printf '\033[31mbackup suspeito: %s tem só %s bytes\033[0m\n' "$arquivo" "$bytes" >&2
  exit 1
fi

# Confere que o arquivo é legível **antes** de apagar os antigos: um dump
# corrompido que passe do piso de tamanho ainda derrubaria a rotação.
$COMPOSE exec -T db pg_restore --list < "$arquivo" > /dev/null

if [ -n "${BACKUP_REMOTO:-}" ]; then
  if command -v rclone > /dev/null; then
    rclone copy "$arquivo" "$BACKUP_REMOTO" --quiet
    printf 'backup %s (%s) enviado para %s\n' "$carimbo" "$tamanho" "$BACKUP_REMOTO"
  else
    printf '\033[33mBACKUP_REMOTO definido e rclone ausente: o backup ficou só nesta máquina\033[0m\n' >&2
  fi
else
  printf '\033[33mbackup %s (%s) só nesta máquina — configure BACKUP_REMOTO\033[0m\n' "$carimbo" "$tamanho" >&2
fi

# A rotação vem depois de tudo dar certo. Antes, um erro no dump de hoje
# apagaria o de ontem e deixaria a barbearia sem nenhum.
find "$PASTA" -name 'barbearia-*.dump' -mtime "+$GUARDAR_DIAS" -delete
