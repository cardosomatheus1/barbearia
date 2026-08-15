#!/usr/bin/env bash
# Aplica as migrações **que faltam**, em ordem, no banco apontado por DATABASE_URL.
#
#   DATABASE_URL=postgres://postgres@127.0.0.1:5433/barbearia packages/db/scripts/migrate.sh
#
# ## O que mudou aqui, e por que o site caiu antes de mudar
#
# Este laço aplicava **todas** as migrações, sempre, sem registrar nenhuma. Na
# primeira subida funciona. Na segunda — que é toda atualização, porque o serviço
# `preparar` roda a cada `docker compose up` — o `0001` reencontra o que ele
# mesmo criou e morre em `CREATE TYPE professional_kind ... já existe`.
#
# O estrago não para no container que falhou: `api`, `worker` e `web` esperam o
# `preparar` com `condition: service_completed_successfully`, então o compose
# aborta a subida inteira e **não sobe o Caddy**. O sintoma é o site fora do ar,
# a 443 recusando conexão, depois de um comando que era só para atualizar.
#
# ## O livro-caixa
#
# `schema_migrations` guarda o nome de cada migração aplicada. O registro vai no
# **mesmo `psql`** da migração, como um `-c` depois do `-f`: com
# `ON_ERROR_STOP=1`, migração que falha interrompe o `psql` antes do `INSERT` e
# portanto **não é registrada**. É esta a direção que importa — registrar o que
# não foi aplicado faria a próxima subida pular a migração em silêncio, e a
# falha só apareceria quando a aplicação lesse a coluna que ninguém criou.
#
# ## Por que não `--single-transaction`
#
# Seria a resposta óbvia para o registro e a migração valerem juntos, e não
# funciona aqui: `0045_pacotes.sql` faz `ALTER TYPE order_item_type ADD VALUE
# 'package'` e usa o valor novo no mesmo arquivo. O Postgres recusa —
# *"unsafe use of new value ... must be committed before they can be used"* — e
# a migração que passava em autocommit passaria a falhar. Descoberto pelo teste,
# não em produção.
#
# O que sobra é uma janela estreita: processo morto entre a migração e o
# `INSERT` deixa o livro sem a linha, e a subida seguinte tenta reaplicar e
# falha alto. É ruído visível, com conserto de uma linha (`INSERT` manual no
# livro) — e o oposto do defeito silencioso que se está consertando.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?defina DATABASE_URL (ex.: postgres://postgres@127.0.0.1:5433/barbearia)}"

# A última migração anterior ao livro-caixa.
#
# Os bancos que já estão no ar não têm registro nenhum, e um livro vazio faria
# este script concluir que **nada** foi aplicado — reaplicando tudo e
# reproduzindo exatamente o erro que ele veio consertar. Por isso a adoção
# abaixo: banco com schema e sem livro é banco anterior ao livro.
#
# E ela vai só **até aqui**, em vez de marcar tudo: um banco adotado precisa
# continuar recebendo o que vier depois. Marcar todas faria a migração seguinte
# ser pulada em silêncio — a única falha pior que a que estamos consertando,
# porque ela só aparece quando a aplicação lê a coluna que ninguém criou.
BASELINE="0083_recurso_fiscal.sql"

psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c '
  CREATE TABLE IF NOT EXISTS schema_migrations (
    nome        text PRIMARY KEY,
    aplicada_em timestamptz NOT NULL DEFAULT now()
  )'

# `|| true` nos dois: não achar é resposta, não erro — e sob `pipefail` um 1 aqui
# mataria o script antes da primeira linha útil.
registradas="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations' || true)"
preexistente="$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'" || true)"

if [ "$registradas" = 0 ] && [ "$preexistente" != 0 ]; then
  adotadas=0
  for migration in migrations/*.sql; do
    nome="$(basename "$migration")"
    if [[ "$nome" > "$BASELINE" ]]; then continue; fi
    psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
      -c "INSERT INTO schema_migrations (nome) VALUES ('$nome')"
    adotadas=$((adotadas + 1))
  done
  echo "banco preexistente adotado: $adotadas migrações até $BASELINE marcadas como aplicadas"
fi

aplicadas=0
for migration in migrations/*.sql; do
  nome="$(basename "$migration")"
  ja="$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM schema_migrations WHERE nome = '$nome'" || true)"
  if [ -n "$ja" ]; then continue; fi

  echo "==> $nome"
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
    -f "$migration" \
    -c "INSERT INTO schema_migrations (nome) VALUES ('$nome')"
  aplicadas=$((aplicadas + 1))
done

if [ "$aplicadas" = 0 ]; then
  echo "migrações aplicadas: nada a aplicar"
else
  echo "migrações aplicadas: $aplicadas"
fi
