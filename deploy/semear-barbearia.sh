#!/usr/bin/env bash
# Uma barbearia inteira, com oito meses de movimento, na instalação de verdade.
#
#   SEMENTE_SENHA='uma-senha-sua-longa' deploy/semear-barbearia.sh
#
# Cria a barbearia, a equipe, 620 clientes com ciclo próprio, 245 dias de
# atendimento dia a dia — com hora de pico, sazonalidade e crescimento —, e
# depois preenche prateleira, clube, pacote, financeiro, marketing e
# integrações. É a mesma semente que a medição usa, com **as suas** credenciais.
#
# ## Por que a senha é obrigatória e não tem padrão
#
# A semente cria uma conta de **dono**. Com a senha que está publicada no
# repositório, num endereço que a internet alcança, isso é uma porta aberta para
# base de clientes com telefone e ficha, caixa, comanda, fiado, exportação LGPD,
# chaves de API e cadastro de webhook — que é o ponto de saída de rede do
# produto.
#
# A trava vive em `scripts/semente-permitida.mjs` e é conferida lá dentro
# também: este arquivo só falha mais cedo, com uma frase melhor.
#
# ## O que ele **não** é
#
# Não é para uma barbearia que vai atender de verdade. Os dados são inventados —
# clientes, comandas, comissões, notas — e não existe caminho de "apagar só o
# que a semente criou". Isto serve para você **ver o produto cheio**; a
# barbearia real nasce vazia, em `/admin/criar-conta`.
set -euo pipefail

DESTINO="${DESTINO:-/opt/barbearia}"
COMPOSE="docker compose -f $DESTINO/deploy/compose.yml --env-file $DESTINO/.env"

NOME_DA_CASA="${SEMENTE_BARBEARIA:-Barbearia Matheus}"
DONO="${SEMENTE_DONO:-Matheus Neiva}"
EMAIL="${SEMENTE_EMAIL:-matheus@barberdock.com.br}"
TELEFONE="${SEMENTE_TELEFONE:-(71) 99999-0000}"

vermelho() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

if [ -z "${SEMENTE_SENHA:-}" ]; then
  vermelho 'SEMENTE_SENHA é obrigatória.'
  cat >&2 <<'FIM'

  Esta semente cria uma conta de dono. Sem senha própria ela usaria a que está
  publicada no repositório — e este servidor tem endereço na internet.

    SEMENTE_SENHA='escolha-uma-senha-longa' deploy/semear-barbearia.sh

FIM
  exit 1
fi

DOMINIO="$(grep -E '^DOMINIO=' "$DESTINO/.env" | cut -d= -f2 | tr -d '"' || true)"

# O histórico é escrito com o papel `postgres`, porque ele atravessa a RLS que o
# role da aplicação não pode atravessar — mas dentro do banco **da aplicação**.
#
# O `ADMIN_DATABASE_URL` do compose não serve para isso e não deveria mesmo: ele
# aponta para o banco `postgres`, de manutenção, que é o que o `preparar` usa
# para dar `CREATE DATABASE barbearia`. A semente lê `ADMIN_DATABASE_URL` e
# encontrava ali um banco sem tabela nenhuma — `relation "tenant_slugs" does not
# exist`, depois de já ter criado a barbearia pela API.
#
# No compose de desenvolvimento as duas URLs caem no mesmo banco, e por isso o
# defeito não aparece lá: ele é só da instalação de verdade.
SENHA_PG="$(grep -E '^POSTGRES_PASSWORD=' "$DESTINO/.env" | cut -d= -f2 | tr -d '"' || true)"
BANCO_DO_HISTORICO="postgres://postgres:$SENHA_PG@db:5432/barbearia"

printf '\n\033[1m==> semeando "%s"\033[0m\n' "$NOME_DA_CASA"
printf '    dono:   %s <%s>\n' "$DONO" "$EMAIL"
printf '    leva alguns minutos: são 245 dias de movimento, dia a dia.\n\n'

# `run --rm` e não `exec`: o contêiner da API está servindo requisição, e a
# semente é trabalho de uma vez só. Um processo pesado dentro dele deixaria o
# painel lento enquanto roda.
$COMPOSE run --rm \
  -e SEMENTE_BARBEARIA="$NOME_DA_CASA" \
  -e SEMENTE_DONO="$DONO" \
  -e SEMENTE_EMAIL="$EMAIL" \
  -e SEMENTE_SENHA="$SEMENTE_SENHA" \
  -e SEMENTE_TELEFONE="$TELEFONE" \
  -e WEB_URL="https://$DOMINIO" \
  -e ADMIN_DATABASE_URL="$BANCO_DO_HISTORICO" \
  api node scripts/semear-demo.mjs

printf '\n\033[32m==> pronto\033[0m\n'
printf '    painel:  https://%s/admin/entrar\n' "$DOMINIO"
printf '    entre com  %s  e a senha que você escolheu.\n' "$EMAIL"
printf '    a equipe (gerente, recepção, barbeiros) usa a **mesma** senha.\n\n'
