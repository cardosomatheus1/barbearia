#!/usr/bin/env bash
# Liga armazenamento de mídia S3-compatível (AWS S3, Cloudflare R2 ou MinIO).
# O bucket permanece privado: o produto continua servindo /media/... pelo seu domínio.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
ENV="${ENV:-$DESTINO/.env}"
ENDPOINT="${1:-}"
BUCKET="${2:-}"
ACCESS_KEY="${3:-}"
SECRET_KEY="${4:-}"
REGION="${5:-auto}"
ALLOW_HTTP="${MEDIA_S3_ALLOW_HTTP:-0}"

morrer() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
[ -f "$ENV" ] || morrer "arquivo $ENV não existe; rode deploy/instalar.sh primeiro"
[ -n "$ENDPOINT" ] || morrer "uso: $0 <endpoint> <bucket> <access-key> <secret-key> [region]"
[ -n "$BUCKET" ] || morrer "bucket vazio"
[ -n "$ACCESS_KEY" ] || morrer "access key vazia"
[ -n "$SECRET_KEY" ] || morrer "secret key vazia"
case "$ENDPOINT" in
  https://*) ;;
  http://*)
    [ "$ALLOW_HTTP" = "1" ] || morrer "endpoint HTTP exige decisão explícita: rode MEDIA_S3_ALLOW_HTTP=1 $0 <endpoint> <bucket> <access-key> <secret-key> [region]"
    ;;
  *) morrer "endpoint deve começar com https:// (HTTP só com MEDIA_S3_ALLOW_HTTP=1)" ;;
esac

# O .env do compose usa aspas. Recusar quebra de linha/aspas é melhor que gerar
# configuração sintaticamente válida com valor diferente do que o operador digitou.
for valor in "$ENDPOINT" "$BUCKET" "$ACCESS_KEY" "$SECRET_KEY" "$REGION"; do
  case "$valor" in *$'\n'*|*'"'*) morrer 'credencial contém caractere não suportado pelo formato .env (aspas ou quebra de linha)' ;; esac
done

setar() {
  local nome="$1" valor="$2" tmp
  tmp="$(mktemp)"
  grep -v -E "^${nome}=" "$ENV" > "$tmp" || true
  printf '%s="%s"\n' "$nome" "$valor" >> "$tmp"
  cat "$tmp" > "$ENV"
  rm -f "$tmp"
}

setar MEDIA_STORAGE s3
setar MEDIA_S3_ENDPOINT "$ENDPOINT"
setar MEDIA_S3_BUCKET "$BUCKET"
setar MEDIA_S3_REGION "$REGION"
setar MEDIA_S3_ACCESS_KEY_ID "$ACCESS_KEY"
setar MEDIA_S3_SECRET_ACCESS_KEY "$SECRET_KEY"
setar MEDIA_S3_ALLOW_HTTP "$ALLOW_HTTP"
chmod 600 "$ENV"

cat <<FIM
Object storage configurado em $ENV.

Aplique a configuração com:
  cd $DESTINO
  docker compose -f deploy/compose.yml --env-file .env up -d --build api web

Depois envie uma foto em Configurações > Fotos e marca. A URL pública continuará
em /media/...; endpoint, bucket e credenciais nunca são enviados ao navegador.
FIM
