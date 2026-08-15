#!/usr/bin/env bash
# Os oito segredos do `.env`, gerados na máquina e preservados entre execuções.
#
#   deploy/segredos.sh <arquivo-env> <dominio> <email-do-certificado>
#
# ## Por que é um arquivo próprio, e não um trecho do instalador
#
# Ele nasceu dentro de `instalar.sh` e tinha um defeito que só aparecia na
# **primeira** execução — exatamente o caso que o instalador anuncia servir.
# Separado, ele roda sozinho, e por isso tem teste: `scripts/segredos-do-deploy.test.mjs`
# executa este arquivo duas vezes contra um `.env` vazio e confere que os oito
# saem preenchidos na primeira e **idênticos** na segunda.
#
# ## O defeito, escrito para não voltar
#
# `ler()` é um pipeline que começa em `grep`. Com o `.env` vazio o `grep` não
# acha nada e sai com 1; `pipefail` propaga esse 1 para o fim do pipeline, a
# atribuição `atual="$(ler ...)"` herda o status, e `set -e` mata o script ali —
# **em silêncio**, antes de imprimir a primeira linha.
#
# O `|| true` no fim do pipeline é o conserto, e ele diz o que se quer dizer:
# *"não achar é uma resposta, não um erro"*. Vale para toda leitura de valor que
# pode legitimamente não existir.
set -euo pipefail

ENV="${1:?uso: segredos.sh <arquivo-env> <dominio> <email>}"
DOMINIO="${2:?uso: segredos.sh <arquivo-env> <dominio> <email>}"
EMAIL="${3:?uso: segredos.sh <arquivo-env> <dominio> <email>}"

touch "$ENV"
chmod 600 "$ENV"

# Não achar é uma resposta. Sem o `|| true`, o `pipefail` transforma "esta
# variável ainda não existe" — o estado normal de uma instalação nova — em
# morte silenciosa do script inteiro.
ler() { grep -E "^$1=" "$ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }

guardar() { # nome, valor
  if grep -qE "^$1=" "$ENV"; then
    sed -i "s|^$1=.*|$1=\"$2\"|" "$ENV"
  else
    printf '%s="%s"\n' "$1" "$2" >> "$ENV"
  fi
}

# Gera se não houver; **preserva** se houver. Preservar é o que torna o
# instalador repetível, e não é conforto:
#   - `STAFF_EMAIL_PEPPER` indexa o login. Trocá-lo tranca todo mundo para fora.
#   - `MFA_SECRET_KEY` cifra o segundo fator. Trocá-lo invalida todos.
#   - `API_KEY_PEPPER` é o HMAC das chaves de API. Trocá-lo derruba integrações.
#   - as duas senhas de banco são a única forma de abrir o volume que já existe.
manter() { # nome, gerador
  local atual
  atual="$(ler "$1")"
  if [ -n "$atual" ]; then
    printf '  ==  %s (preservado)\n' "$1"
  else
    guardar "$1" "$(eval "$2")"
    printf '  ++  %s (gerado)\n' "$1"
  fi
}

# Uma chave por finalidade. Com uma chave só, girar a do segundo fator —
# operação normal de segurança — deixaria ilegível o token de WhatsApp de todas
# as barbearias ao mesmo tempo, e o defeito apareceria como "a mensagem parou de
# sair" dias depois.
manter POSTGRES_PASSWORD          "openssl rand -hex 24"
manter APP_DB_PASSWORD            "openssl rand -hex 24"
manter STAFF_EMAIL_PEPPER         "openssl rand -hex 32"
manter MARKETPLACE_ORIGIN_SECRET  "openssl rand -hex 32"
manter API_KEY_PEPPER             "openssl rand -hex 32"
manter MFA_SECRET_KEY             "openssl rand -base64 32"
manter WEBHOOK_SECRET_KEY         "openssl rand -base64 32"
manter WHATSAPP_TOKEN_KEY         "openssl rand -base64 32"

# Estes dois vêm do argumento e são sobrescritos: quem roda o instalador de novo
# com outro domínio está **dizendo** que o domínio mudou.
guardar DOMINIO "$DOMINIO"
guardar ACME_EMAIL "$EMAIL"

# Os interruptores das integrações só nascem; nunca são reescritos. Ligar a
# Stripe é decisão de quem opera, e rodar o instalador de novo não pode
# desligá-la.
grep -qE '^PSP_MODO='    "$ENV" || guardar PSP_MODO nenhum
grep -qE '^FISCAL_MODO=' "$ENV" || guardar FISCAL_MODO nenhum
