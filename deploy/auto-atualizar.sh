#!/usr/bin/env bash
# Sobe sozinho, a cada commit novo na branch padrão.
#
#   deploy/auto-atualizar.sh --ligar                    # de 5 em 5 minutos
#   deploy/auto-atualizar.sh --ligar --exigir-esteira   # ...só com o CI verde
#   deploy/auto-atualizar.sh --desligar
#   deploy/auto-atualizar.sh                            # roda uma vez, agora
#
# ## O padrão é subir sem perguntar ao CI, e isso tem um custo escrito
#
# Esperar o verde do GitHub Actions é melhor **quando a esteira roda**. Quando
# ela está desligada ou bloqueada na conta, exigir o verde vira "nunca sobe" —
# e um deploy que nunca acontece é pior que um deploy sem rede.
#
# Então o padrão é: commit novo, sobe. E como não há portão do lado de fora, a
# rede de segurança tem que estar **aqui dentro**, em três camadas:
#
# 1. `atualizar.sh` tira backup **antes** de migrar, e para se a migração
#    falhar — sem subir nada, com a versão anterior servindo.
# 2. Se a versão nova não responder, este script **volta sozinho** para a
#    anterior. Sem isso, "automático" significaria o site passar a noite fora do
#    ar por um commit que ninguém conferiu.
# 3. O commit que falhou é anotado e **nunca é tentado de novo**. Sem essa
#    memória, o laço seria: sobe, quebra, volta, sobe de novo cinco minutos
#    depois — o site piscando a cada volta do cron, para sempre.
#
# Quando a esteira voltar a rodar, `--ligar --exigir-esteira` troca isso pelo
# comportamento mais seguro: só sobe commit aprovado.
#
# ## Por que perguntar, e não receber um webhook
#
# Webhook exigiria guardar uma chave do servidor no GitHub e abrir um endereço
# que aceita chamada de fora. Perguntando de dentro não há segredo guardado em
# lugar nenhum nem porta nova: o servidor continua com 80 e 443 e mais nada.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
REPO_API="${REPO_API:-https://api.github.com/repos/cardosomatheus1/barbearia}"
LOG="${AUTO_LOG:-/var/log/barbearia-deploy.log}"
TRAVA="/var/lock/barbearia-auto-atualizar.lock"
FALHOS="$DESTINO/.commits-que-falharam"
EXIGIR_ESTEIRA="${EXIGIR_ESTEIRA:-0}"

registrar() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# -- ligar e desligar --------------------------------------------------------

CRON_MARCA="barbearia-auto-atualizar"
case "${1:-}" in
  --ligar)
    exigir=0
    [ "${2:-}" = "--exigir-esteira" ] && exigir=1
    linha="*/5 * * * * DESTINO=$DESTINO EXIGIR_ESTEIRA=$exigir $DESTINO/deploy/auto-atualizar.sh >> $LOG 2>&1 # $CRON_MARCA"
    ( crontab -l 2>/dev/null | grep -v "$CRON_MARCA"; echo "$linha" ) | crontab -
    if [ "$exigir" = 1 ]; then
      echo "ligado: a cada 5 minutos, e só com a esteira verde."
    else
      echo "ligado: a cada 5 minutos, a cada commit novo."
      echo "sem portão do lado de fora — se a versão nova não responder, ele volta sozinho."
    fi
    echo "para acompanhar:  tail -f $LOG"
    exit 0
    ;;
  --desligar)
    ( crontab -l 2>/dev/null | grep -v "$CRON_MARCA" ) | crontab -
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

BRANCH="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||')"
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

# -- a esteira, quando se pede por ela ---------------------------------------
if [ "$EXIGIR_ESTEIRA" = "1" ]; then
  # O GitHub Actions produz **check runs**, não os "statuses" da API antiga. Um
  # commit recém-empurrado costuma ter zero por alguns segundos: isso é "ainda
  # não começou", não "não tem teste" — e tratá-lo como aprovado subiria
  # justamente o commit que ninguém conferiu.
  VEREDITO="$(api "$REPO_API/commits/$LA/check-runs" | python3 -c '
import sys, json
d = json.load(sys.stdin)
runs = d.get("check_runs", [])
if not runs:
    print("sem_esteira"); raise SystemExit
if any(r.get("status") != "completed" for r in runs):
    print("rodando"); raise SystemExit
ruins = [r["name"] for r in runs if r.get("conclusion") not in ("success", "neutral", "skipped")]
print("reprovado:" + ", ".join(ruins) if ruins else "aprovado")
' 2>/dev/null || echo erro)"

  case "$VEREDITO" in
    aprovado) ;;
    rodando|sem_esteira) exit 0 ;;
    reprovado:*)
      if ! grep -qx "$LA" "$FALHOS" 2>/dev/null; then
        echo "$LA" >> "$FALHOS"
        registrar "${LA:0:7} NÃO subiu — a esteira reprovou (${VEREDITO#reprovado:}). Continuo em ${AQUI:0:7}."
      fi
      exit 0
      ;;
    *) registrar "não consegui ler o resultado da esteira; tento de novo"; exit 0 ;;
  esac
fi

# -- sobe --------------------------------------------------------------------

registrar "${AQUI:0:7} → ${LA:0:7} — atualizando"

if DESTINO="$DESTINO" "$DESTINO/deploy/atualizar.sh" >> "$LOG" 2>&1; then
  registrar "${LA:0:7} no ar"
  exit 0
fi

# A partir daqui, deu errado. Duas situações, e elas se distinguem pelo estado
# do site — não pelo código de saída, que é o mesmo:
#
#   - a migração falhou: `atualizar.sh` parou antes de trocar a imagem, e o
#     site nunca saiu do ar. Não há o que voltar.
#   - a versão nova subiu e não responde: aí sim, volta.
echo "$LA" >> "$FALHOS"

if curl -fsS --max-time 10 "https://$(grep -E '^DOMINIO=' .env | cut -d= -f2 | tr -d '"')/" > /dev/null 2>&1; then
  registrar "FALHOU ao atualizar para ${LA:0:7}, mas o site responde. Nada foi revertido — veja o log acima."
  exit 1
fi

registrar "${LA:0:7} subiu e o site não responde — voltando para ${AQUI:0:7}"
if DESTINO="$DESTINO" "$DESTINO/deploy/voltar.sh" "$AQUI" >> "$LOG" 2>&1; then
  registrar "de volta em ${AQUI:0:7}. ${LA:0:7} não será tentado de novo."
else
  registrar "SOCORRO: a volta também falhou. O site está fora. Entre no servidor."
fi
exit 1
