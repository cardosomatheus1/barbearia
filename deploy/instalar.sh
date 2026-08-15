#!/usr/bin/env bash
# Do VPS vazio ao produto no ar, num comando.
#
#   curl -fsSL https://raw.githubusercontent.com/cardosomatheus1/barbearia/claude/barbershop-app-research-xvejhy/deploy/instalar.sh \
#     | bash -s -- barbearia.com.br voce@email.com
#
# ou, com o repositório já clonado:
#
#   deploy/instalar.sh barbearia.com.br voce@email.com
#
# Ele instala o Docker se faltar, gera os segredos, escreve o `.env`, sobe tudo
# e espera o produto responder. Roda de novo sem estragar nada: os segredos já
# gerados são **preservados**, porque regerar `MFA_SECRET_KEY` tornaria ilegível
# o segundo fator de todo mundo e regerar `STAFF_EMAIL_PEPPER` faria ninguém
# mais conseguir entrar.
set -euo pipefail

DOMINIO="${1:-}"
EMAIL="${2:-}"
DESTINO="${DESTINO:-/opt/barbearia}"
REPO="${REPO:-https://github.com/cardosomatheus1/barbearia.git}"
# Vazio significa "a branch padrão do repositório", resolvida no remoto.
#
# A primeira versão escrevia `main` como padrão, e a branch padrão deste
# repositório não é `main`: o clone falharia com "Remote branch main not found",
# no servidor de quem está instalando pela primeira vez. Nome de branch escrito
# à mão é a mesma lista paralela de sempre — quem renomear a branch amanhã
# quebra o instalador sem saber que ele existe.
BRANCH="${BRANCH:-}"

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$1"; }
titulo() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
morrer() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

[ -n "$DOMINIO" ] || morrer "uso: $0 <dominio> <email-para-o-certificado>"
[ -n "$EMAIL" ] || morrer "uso: $0 <dominio> <email-para-o-certificado>"
[ "$(id -u)" = 0 ] || morrer "rode como root (ou com sudo): ele instala pacote e escreve em $DESTINO"

# ---------------------------------------------------------------------------
# 1. O DNS, antes de qualquer coisa
#
# O Let's Encrypt confere o domínio pedindo uma requisição de volta. Sem o
# registro A apontando para esta máquina, o Caddy tenta, falha, e o site fica
# sem TLS — com o erro escondido no log de um contêiner. Conferir aqui troca
# isso por uma frase.
# ---------------------------------------------------------------------------
titulo "conferindo o DNS de $DOMINIO"
MEU_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -z "$DNS_IP" ]; then
  morrer "o domínio $DOMINIO não resolve. Crie o registro A apontando para $MEU_IP e espere alguns minutos."
fi
if [ -n "$MEU_IP" ] && [ "$DNS_IP" != "$MEU_IP" ]; then
  amarelo "  aviso: $DOMINIO aponta para $DNS_IP e esta máquina é $MEU_IP."
  amarelo "  Se estiver atrás de proxy (Cloudflare laranja), desligue o proxy até o certificado sair."
else
  verde "  ok  $DOMINIO → $DNS_IP"
fi

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
titulo "docker"
if ! command -v docker > /dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version > /dev/null 2>&1 || morrer "docker compose v2 não está disponível"
verde "  ok  $(docker --version)"

# ---------------------------------------------------------------------------
# 3. O código
# ---------------------------------------------------------------------------
titulo "código em $DESTINO"
command -v git > /dev/null || { apt-get update -qq && apt-get install -y -qq git; }
if [ -z "$BRANCH" ]; then
  # `--symref` pergunta ao remoto para onde o HEAD dele aponta, sem clonar.
  BRANCH="$(git ls-remote --symref "$REPO" HEAD 2>/dev/null | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2; exit}' || true)"
  [ -n "$BRANCH" ] || morrer "não consegui descobrir a branch padrão de $REPO"
fi
if [ -d "$DESTINO/.git" ]; then
  git -C "$DESTINO" fetch --quiet origin "$BRANCH"
  git -C "$DESTINO" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$DESTINO"
fi
cd "$DESTINO"
verde "  ok  $BRANCH @ $(git -C "$DESTINO" rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
# 4. Os segredos
#
# Gerados aqui e **nunca** no repositório. Cada um tem finalidade própria: com
# uma chave só, girar a do segundo fator — operação normal de segurança —
# deixaria ilegível o token de WhatsApp de todas as barbearias ao mesmo tempo.
#
# Preservados entre execuções, e isto é o que torna o script repetível:
#   - `STAFF_EMAIL_PEPPER` indexa o login. Trocá-lo tranca todo mundo para fora.
#   - `MFA_SECRET_KEY` cifra o segundo fator. Trocá-lo invalida todos.
#   - `API_KEY_PEPPER` é o HMAC das chaves de API. Trocá-lo derruba integrações.
#   - as duas senhas de banco são a única forma de abrir o volume que já existe.
# ---------------------------------------------------------------------------
titulo "segredos"
# Arquivo próprio, e é por isso que ele tem teste. Aqui dentro, este bloco tinha
# um defeito que só aparecia na **primeira** execução — o `grep` de uma variável
# ainda inexistente saía com 1, o `pipefail` propagava, e o `set -e` matava o
# instalador em silêncio, antes de imprimir a primeira linha. O caso que o
# instalador existe para servir era o único que ele não servia.
"$DESTINO/deploy/segredos.sh" "$DESTINO/.env" "$DOMINIO" "$EMAIL"
ENV="$DESTINO/.env"

# ---------------------------------------------------------------------------
# 5. O firewall
#
# O compose não publica o banco nem a API, mas o Docker escreve direto no
# `iptables` e passa por cima do `ufw` — quem confia só no ufw descobre isso
# quando alguém acha a 5432. Aqui a garantia é a de cima: nenhum `ports` além
# do Caddy. O ufw entra como segunda camada, para o que **não** é Docker.
# ---------------------------------------------------------------------------
titulo "firewall"
if command -v ufw > /dev/null; then
  ufw allow 22/tcp  > /dev/null 2>&1 || true
  ufw allow 80/tcp  > /dev/null 2>&1 || true
  ufw allow 443/tcp > /dev/null 2>&1 || true
  yes | ufw enable  > /dev/null 2>&1 || true
  verde "  ok  22, 80 e 443"
else
  amarelo "  ufw não instalado; siga com o firewall do provedor"
fi

# ---------------------------------------------------------------------------
# 6. No ar
# ---------------------------------------------------------------------------
titulo "construindo e subindo (a primeira vez leva alguns minutos)"
docker compose -f deploy/compose.yml --env-file "$ENV" up -d --build

titulo "esperando o produto responder"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$DOMINIO/" > /dev/null 2>&1; then
    verde "  ok  https://$DOMINIO responde"
    break
  fi
  [ "$i" = 60 ] && {
    amarelo "  ainda não respondeu. O certificado pode estar sendo emitido — veja:"
    amarelo "    docker compose -f deploy/compose.yml logs caddy --tail 40"
  }
  sleep 5
done

# ---------------------------------------------------------------------------
# 7. O backup, no relógio
# ---------------------------------------------------------------------------
titulo "backup diário"
install -m 700 deploy/backup.sh /usr/local/bin/barbearia-backup
cron_linha="17 4 * * * DESTINO=$DESTINO /usr/local/bin/barbearia-backup >> /var/log/barbearia-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v barbearia-backup; echo "$cron_linha" ) | crontab -
verde "  ok  todo dia às 04:17 (fuso da máquina)"

titulo "pronto"
cat <<FIM

  O site:   https://$DOMINIO
  O painel: https://$DOMINIO/admin/criar-conta

  Falta **uma** coisa para operar: a conta de plataforma. Ela não nasce de
  nenhuma rota, de propósito — é a conta que bloqueia barbearia e troca plano:

    cd $DESTINO
    docker compose -f deploy/compose.yml --env-file .env run --rm \\
      -e SUPER_ADMIN_PASSWORD='<uma senha longa>' api \\
      node scripts/criar-super-admin.mjs "Seu Nome" voce@email.com --operador

  Para atualizar depois de um commit novo:

    deploy/atualizar.sh

FIM
