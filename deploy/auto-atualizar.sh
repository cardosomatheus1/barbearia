#!/usr/bin/env bash
# Sobe sozinho, a cada commit novo na branch padrão.
#
#   deploy/auto-atualizar.sh --ligar                    # de 5 em 5 min, CI obrigatório
#   deploy/auto-atualizar.sh --desligar
#   deploy/auto-atualizar.sh                            # roda uma vez, agora
#
# O portão é obrigatório: os dois jobs do workflow portao.yml precisam passar
# para o SHA que será implantado. Ausência, skip e falha bloqueiam a atualização.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
REPO_API="${REPO_API:-https://api.github.com/repos/cardosomatheus1/barbearia}"
LOG="${AUTO_LOG:-/var/log/barbearia-deploy.log}"
TRAVA="${AUTO_TRAVA:-/var/lock/barbearia-auto-atualizar.lock}"
FALHOS="$DESTINO/.commits-que-falharam"
EXIGIR_ESTEIRA="${EXIGIR_ESTEIRA:-1}"
[ "$EXIGIR_ESTEIRA" = 1 ] || { echo "Não é permitido desativar o portão" >&2; exit 1; }

registrar() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# -- ligar e desligar --------------------------------------------------------

CRON_MARCA="barbearia-auto-atualizar"
case "${1:-}" in
  --ligar)
    linha="*/5 * * * * DESTINO=$DESTINO EXIGIR_ESTEIRA=1 $DESTINO/deploy/auto-atualizar.sh >> $LOG 2>&1 # $CRON_MARCA"
    # Ausência de crontab/entrada é normal. Sob pipefail ela abortava antes
    # do echo e instalava um crontab vazio na primeira ativação.
    ( crontab -l 2>/dev/null | grep -v "$CRON_MARCA" || true; echo "$linha" ) | crontab -
    echo "ligado: a cada 5 minutos, e só com a esteira verde."
    echo "para acompanhar:  tail -f $LOG"
    exit 0
    ;;
  --desligar)
    ( crontab -l 2>/dev/null | grep -v "$CRON_MARCA" || true ) | crontab -
    echo "desligado. As atualizações voltam a ser $DESTINO/deploy/atualizar.sh na mão."
    exit 0
    ;;
esac

# -- uma execução ------------------------------------------------------------

# Duas voltas ao mesmo tempo fariam dois `docker compose up` disputando os
# mesmos contêineres. Sem espera: se a anterior ainda está construindo, esta
# desiste em silêncio — a próxima volta é daqui a cinco minutos.
exec 9> "$TRAVA"
flock -n 9 || exit 0

cd "$DESTINO"

# `|| true` porque não achar é uma resposta: um clone sem `origin/HEAD` faria o
# `pipefail` matar o cron em silêncio — e num cron ninguém está olhando.
BRANCH="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
AQUI="$(git rev-parse HEAD)"

api() { curl -fsS --max-time 20 -H 'accept: application/vnd.github+json' "$1"; }

LA="$(api "$REPO_API/commits/$BRANCH" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sha"])' 2>/dev/null || true)"
if [ -z "$LA" ]; then
  registrar "não consegui perguntar ao GitHub; tento de novo na próxima volta"
  exit 0
fi

# Já estamos nele: o caso mais comum, e ele não escreve no log. Um log que
# repete "nada a fazer" a cada cinco minutos é um log que ninguém lê.
[ "$AQUI" = "$LA" ] && exit 0

# O commit que já derrubou o site uma vez não é tentado de novo. Quem o
# desbloqueia é um commit **novo** — ou apagar esta linha do arquivo à mão,
# depois de entender o que quebrou.
if [ -f "$FALHOS" ] && grep -qx "$LA" "$FALHOS"; then
  exit 0
fi

# Falha de CI não grava o SHA como deploy falho: a reexecução legítima pode
# aprová-lo depois. Só uma tentativa de implantação falha vai para FALHOS.
if ! node "$DESTINO/deploy/verificar-esteira.mjs" "$LA" "$BRANCH" >> "$LOG" 2>&1; then
  registrar "${LA:0:7} aguarda aprovação dos dois jobs obrigatórios"
  exit 0
fi

# -- sobe --------------------------------------------------------------------

registrar "${AQUI:0:7} → ${LA:0:7} — atualizando"

if DESTINO="$DESTINO" DEPLOY_SHA="$LA" "$DESTINO/deploy/atualizar.sh" >> "$LOG" 2>&1; then
  registrar "${LA:0:7} no ar"
  exit 0
else
  resultado=$?
fi

# O segundo exame pode encontrar uma reexecução de CI iniciada entre as
# consultas. Ainda não houve implantação: não bloquear este SHA nem voltar.
if [ "$resultado" = 78 ]; then
  registrar "${LA:0:7} voltou a aguardar o portão; implantação não iniciada"
  exit 0
fi

# A partir daqui, deu errado. Duas situações, e elas se distinguem pelo estado
# do site — não pelo código de saída, que é o mesmo:
#
#   - a migração falhou: `atualizar.sh` parou antes de trocar a imagem, e o
#     site nunca saiu do ar. Não há o que voltar.
#   - a versão nova subiu e não responde: aí sim, volta.
echo "$LA" >> "$FALHOS"

if DESTINO="$DESTINO" node "$DESTINO/deploy/verificar-prontidao.mjs" "$AQUI" > /dev/null 2>&1; then
  registrar "FALHOU ao atualizar para ${LA:0:7}, mas a pilha anterior está pronta. Veja o log."
  exit 1
fi

registrar "${LA:0:7} subiu e o site não responde — voltando para ${AQUI:0:7}"
if DESTINO="$DESTINO" "$DESTINO/deploy/voltar.sh" "$AQUI" >> "$LOG" 2>&1; then
  registrar "de volta em ${AQUI:0:7}. ${LA:0:7} não será tentado de novo."
else
  registrar "SOCORRO: a volta também falhou. O site está fora. Entre no servidor."
fi
exit 1
