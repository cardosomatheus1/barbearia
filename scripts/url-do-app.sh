#!/usr/bin/env bash
# Monta a URL de conexão do role da aplicação a partir da URL de administração.
#
#   DATABASE_URL="$(scripts/url-do-app.sh "$ADMIN_URL" "$SENHA" "$BANCO")"
#
# ## Por que isto existe
#
# Os nove scripts de teste faziam a mesma substituição de texto:
#
#   ${BASE/postgres:\/\/postgres/postgres://barbearia_app:$SENHA}
#
# Ela troca a string literal `postgres://postgres` e, com isso, assume que a URL
# de administração **não tem senha**. É verdade no ambiente de desenvolvimento
# daqui (`postgres://postgres@127.0.0.1:5432/postgres`) e é falso em qualquer
# Postgres gerenciado — inclusive no serviço da esteira, onde a URL é
# `postgres://postgres:postgres@...`. Ali a substituição produzia
# `postgres://barbearia_app:<senha>:postgres@...`, e o banco recusava a conexão
# com "password authentication failed" nas nove suítes de uma vez.
#
# Foi o primeiro defeito que a esteira pegou depois de existir, e é exatamente a
# categoria que ela existe para pegar: um pressuposto sobre o ambiente que
# ninguém tinha escrito em lugar nenhum.
#
# ## O que ele faz
#
# Lê host e porta da URL de administração — com ou sem credencial antes do `@` —
# e devolve a URL do role restrito para o banco pedido.
set -euo pipefail

ADMIN_URL="${1:?url de administração}"
SENHA="${2:?senha do role da aplicação}"
BANCO="${3:?nome do banco}"

# Senha entra numa URL. Em vez de escapar — e errar em silêncio no dia em que
# alguém usar um caractere estranho —, o alfabeto é fechado e o que sair dele
# falha alto. As senhas do projeto são hexadecimais sorteadas ou o identificador
# da execução da esteira; as duas cabem aqui.
if [[ ! "$SENHA" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "url-do-app: senha com caractere que precisaria de escape em URL." >&2
  echo "            Use apenas [A-Za-z0-9._~-]." >&2
  exit 1
fi

sem_esquema="${ADMIN_URL#*://}"
autoridade="${sem_esquema%%/*}"
# `##*@` remove tudo até a última arroba. Sem arroba nenhuma, devolve a string
# inteira — que já é o `host:porta`.
host_porta="${autoridade##*@}"

echo "postgres://barbearia_app:${SENHA}@${host_porta}/${BANCO}"
