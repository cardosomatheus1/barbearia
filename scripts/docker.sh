#!/usr/bin/env bash
# Sobe o produto inteiro com Docker — Linux e macOS.
#
#   scripts/docker.sh
#
# O equivalente do `RODAR-NO-WINDOWS.cmd`, e existe pelo mesmo motivo: gerar o
# `.env` que o `docker-compose.yml` exige. Os segredos não moram no
# repositório, e o compose recusa subir sem eles — então alguém precisa
# sorteá-los na primeira vez, e esse alguém não pode ser um passo escrito em
# prosa no README.
#
#   --zerar   apaga o banco do compose antes de subir
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não está instalado: https://docs.docker.com/get-docker/" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "O Docker está instalado mas não está rodando. Abra o Docker Desktop." >&2
  exit 1
fi

if [ ! -f .env ]; then
  # Alfabeto fechado na senha do banco: ela entra numa URL de conexão, e o que
  # sairia dele precisaria de escape — que é onde se erra em silêncio.
  cat > .env <<ENV
# Gerado por scripts/docker.sh. Fora do Git (.gitignore cobre .env*).
# Apagar este arquivo obriga a recriar o banco: o índice de login é um HMAC com
# o STAFF_EMAIL_PEPPER, e trocá-lo invalida as contas existentes.
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
STAFF_EMAIL_PEPPER=$(openssl rand -hex 32)
OTP_PEPPER=$(openssl rand -hex 32)
MARKETPLACE_ORIGIN_SECRET=$(openssl rand -hex 32)
API_KEY_PEPPER=$(openssl rand -hex 32)
MFA_SECRET_KEY=$(openssl rand -base64 32)
WEBHOOK_SECRET_KEY=$(openssl rand -base64 32)
WHATSAPP_TOKEN_KEY=$(openssl rand -base64 32)
KYC_INTENT_HMAC_SECRET=$(openssl rand -hex 32)
ENV
  chmod 600 .env
  echo "segredos sorteados em .env"
fi

if [ "${1:-}" = "--zerar" ]; then
  docker compose down -v
fi

echo
echo "  Construindo e subindo. Na primeira vez leva alguns minutos."
echo "  Depois, abra:  http://localhost:3001"
echo "  Painel:        teste@teste.com / testeteste"
echo
# `--profile demo` liga o semeador, que cria a conta de dono com senha
# conhecida. Ele fica atrás do profile de propósito: fora daqui, `docker compose
# up` sobe o produto sem nenhuma conta padrão.
exec docker compose --profile demo up --build
