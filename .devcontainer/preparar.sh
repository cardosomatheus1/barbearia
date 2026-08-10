#!/usr/bin/env bash
# Roda uma vez, quando o Codespaces é criado.
#
# Só o que não pode esperar o primeiro comando: o cliente do Postgres (as
# migrações são SQL e entram por `psql`) e as dependências, que levam alguns
# minutos e seriam a primeira impressão de quem só quer ver o produto.
set -euo pipefail

# Sem isto o `apt` tenta abrir um diálogo, não consegue, e imprime cinco linhas
# de aviso do debconf — que parecem erro para quem está vendo o projeto subir
# pela primeira vez, e não são.
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends postgresql-client >/dev/null 2>&1

corepack enable

# `CI=true` porque não há terminal interativo aqui: o `postCreateCommand` roda
# sem TTY, e o pnpm que precisa descartar um `node_modules` de outra plataforma
# — o caso de quem já rodou o projeto na própria máquina antes de abrir o
# ambiente — para e pede confirmação que ninguém pode dar. A mensagem é
# `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, e ela não diz nada a quem só
# quer ver o produto subir.
CI=true pnpm install --frozen-lockfile

cat <<'FIM'

  Pronto. Para subir o sistema, no terminal:

      scripts/rodar-local.sh --sem-install

  Quando aparecer "web pronto", o Codespaces abre a porta 3001 sozinho
  (aba PORTS, se não abrir). Entrar no painel: teste@teste.com / testeteste

FIM
