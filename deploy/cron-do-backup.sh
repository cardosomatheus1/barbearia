#!/usr/bin/env bash
# O backup no relógio, sem apagar o cron de quem já usa a máquina.
#
#   deploy/cron-do-backup.sh /opt/barbearia
#
# ## Por que isto é um arquivo, e não três linhas no instalador
#
# Eram três linhas no fim de `deploy/instalar.sh`, e a do meio derrubava o
# instalador em toda máquina recém-instalada:
#
#     ( crontab -l 2>/dev/null | grep -v barbearia-backup; echo "$linha" ) | crontab -
#
# Root novo não tem crontab. `crontab -l` sai com 1, o `grep -v` recebe entrada
# vazia e sai com 1 também — "nenhuma linha selecionada" é 1 no grep —, e o
# `pipefail` mata o subshell antes de o `echo` acontecer. Do outro lado do cano,
# o `crontab -` recebe entrada vazia e instala um crontab **vazio**; o `set -e`
# derruba o instalador na sequência, antes do `pronto`.
#
# O estrago é duplo e silencioso: o instalador não termina, e o backup diário —
# a única cópia dos dados — não existe. Ninguém descobre no dia da instalação.
# Descobre-se no dia da restauração.
#
# O que roda sozinho pode ter teste, e `scripts/cron-do-backup.test.mjs` executa
# este arquivo contra um `crontab` de mentira, inclusive no caso que quebrava.
set -euo pipefail

DESTINO="${1:-/opt/barbearia}"

# 04:17 e não 04:00: horário redondo é quando todo cron do mundo acorda junto.
LINHA="17 4 * * * DESTINO=$DESTINO /usr/local/bin/barbearia-backup >> /var/log/barbearia-backup.log 2>&1"

# Os dois `|| true` são o conserto, e dizem o que se quer dizer: **não ter
# crontab é uma resposta, não um erro**, e é a resposta de toda máquina nova.
# O segundo cobre o mesmo no `grep`, para o caso de a tabela existir e não ter
# nenhuma linha nossa.
outras="$({ crontab -l 2>/dev/null || true; } | grep -v barbearia-backup || true)"

if [ -n "$outras" ]; then
  printf '%s\n%s\n' "$outras" "$LINHA" | crontab -
else
  printf '%s\n' "$LINHA" | crontab -
fi
