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
midia="$PASTA/barbearia-$carimbo-media.tar.gz"

# Node **não** é dependência do host.
#
# `deploy/instalar.sh` leva um Ubuntu limpo ao produto no ar instalando Docker,
# e nada mais — é a promessa do deploy. Cifrar o backup com um `node` do host
# quebrava o backup em toda máquina instalada pelo caminho documentado, e com
# ele a atualização inteira, porque ela aborta quando o backup falha.
#
# A imagem base do próprio produto (`node:22-bookworm-slim`) já está no cache
# local de quem rodou o compose uma vez, então o contêiner sobe sem rede. O
# `node` do host continua sendo usado quando existe: é mais rápido e é o caso
# da máquina de desenvolvimento.
#
# A chave vai por ambiente, nunca em argumento — é a mesma regra que o
# `backup-crypto.mjs` documenta sobre não vazar em linha de comando.
cripto() {
  if command -v node > /dev/null 2>&1; then
    node "$DESTINO/scripts/backup-crypto.mjs" "$@"
  else
    docker run --rm \
      -e BACKUP_ENCRYPTION_KEY \
      -v "$DESTINO/scripts:/app/scripts:ro" \
      -v "$PASTA:$PASTA" \
      node:22-bookworm-slim node /app/scripts/backup-crypto.mjs "$@"
  fi
}
arquivo_enc="$arquivo.enc"
midia_enc="$midia.enc"
MEDIA_STORAGE="$(grep -E '^MEDIA_STORAGE=' "$DESTINO/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
MEDIA_STORAGE="${MEDIA_STORAGE:-local}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-$(grep -E '^BACKUP_ENCRYPTION_KEY=' "$DESTINO/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)}"
if [ -z "$BACKUP_ENCRYPTION_KEY" ]; then
  printf '\033[31mBACKUP_ENCRYPTION_KEY ausente: backup não será gravado em claro\033[0m\n' >&2
  exit 1
fi
export BACKUP_ENCRYPTION_KEY

# Plaintext existe só durante a criação/validação local. Qualquer saída — erro de
# pg_dump, criptografia ou upload — apaga os temporários legíveis. Em falha,
# artefato criptografado parcial também é removido para não entrar na rotação.
limpar_temporarios() {
  local rc=$?
  trap - EXIT
  rm -f "$arquivo" "$midia"
  if [ "$rc" -ne 0 ]; then rm -f "$arquivo_enc" "$midia_enc"; fi
  exit "$rc"
}
trap limpar_temporarios EXIT

# `pg_dump` de dentro do contêiner do banco: o cliente e o servidor têm a mesma
# versão, e uma incompatibilidade de versão só aparece na hora de restaurar.
$COMPOSE exec -T db pg_dump --format=custom --username postgres barbearia > "$arquivo"
# No modo local as imagens vivem fora do Postgres, no volume da API, e entram
# no backup. Em S3/R2/MinIO elas já vivem fora do VPS; copiar `/data/media`
# produziria um tar vazio e daria falsa sensação de proteção. Nesse modo a
# retenção/versionamento do bucket é uma configuração do provedor.
if [ "$MEDIA_STORAGE" = "local" ]; then
  $COMPOSE exec -T api sh -c 'mkdir -p /data/media && tar -C /data/media -czf - .' > "$midia"
fi

tamanho="$(du -h "$arquivo" | cut -f1 || true)"
tamanho_midia=""
if [ "$MEDIA_STORAGE" = "local" ]; then
  tamanho_midia="$(du -h "$midia" | cut -f1 || true)"
fi

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
# A segunda metade do backup local também é testada antes da rotação.
# `tar -tzf` detecta arquivo truncado/corrompido sem extrair nada.
if [ "$MEDIA_STORAGE" = "local" ]; then
  tar -tzf "$midia" > /dev/null
fi

# O dump e a mídia não permanecem legíveis nem no VPS nem no destino remoto.
# A chave é independente das demais chaves da aplicação: girar MFA/WhatsApp
# não deve tornar backup antigo ilegível. O GCM autentica o arquivo inteiro;
# `check` lê e valida a tag antes de aceitarmos o artefato criptografado.
cripto "encrypt" "$arquivo" "$arquivo_enc"
cripto "check" "$arquivo_enc"
if [ "$MEDIA_STORAGE" = "local" ]; then
  cripto "encrypt" "$midia" "$midia_enc"
  cripto "check" "$midia_enc"
fi
rm -f "$arquivo" "$midia"

if [ -n "${BACKUP_REMOTO:-}" ]; then
  if command -v rclone > /dev/null; then
    rclone copy "$arquivo_enc" "$BACKUP_REMOTO" --quiet
    if [ "$MEDIA_STORAGE" = "local" ]; then
      rclone copy "$midia_enc" "$BACKUP_REMOTO" --quiet
      printf 'backup criptografado %s (banco %s + mídia %s) enviado para %s\n' "$carimbo" "$tamanho" "$tamanho_midia" "$BACKUP_REMOTO"
    else
      printf 'backup criptografado %s (banco %s) enviado para %s; mídia está em object storage\n' "$carimbo" "$tamanho" "$BACKUP_REMOTO"
    fi
  else
    printf '\033[33mBACKUP_REMOTO definido e rclone ausente: o backup ficou só nesta máquina\033[0m\n' >&2
  fi
else
  if [ "$MEDIA_STORAGE" = "local" ]; then
    printf '\033[33mbackup criptografado %s (banco %s + mídia %s) só nesta máquina — configure BACKUP_REMOTO\033[0m\n' "$carimbo" "$tamanho" "$tamanho_midia" >&2
  else
    printf '\033[33mbackup criptografado %s (banco %s) só nesta máquina; mídia está em object storage — configure BACKUP_REMOTO para o banco e versionamento/retention no bucket\033[0m\n' "$carimbo" "$tamanho" >&2
  fi
fi

# A rotação vem depois de tudo dar certo. Antes, um erro no dump de hoje
# apagaria o de ontem e deixaria a barbearia sem nenhum.
find "$PASTA" -name 'barbearia-*.dump.enc' -mtime "+$GUARDAR_DIAS" -delete
find "$PASTA" -name 'barbearia-*-media.tar.gz.enc' -mtime "+$GUARDAR_DIAS" -delete
