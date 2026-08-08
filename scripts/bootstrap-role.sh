#!/usr/bin/env bash
# Cria o role da aplicação. Roda uma vez por cluster, antes das migrações.
#
# Fica fora das migrações de propósito: migração roda em produção, e credencial
# não mora no repositório (CLAUDE.md §2). A senha vem do ambiente — não há
# default, para que esquecer de definir falhe alto em vez de criar um role com
# senha conhecida.
#
# **É seguro chamar em paralelo.** As suítes de teste rodam juntas e todas
# passam por aqui; `CREATE ROLE` e `ALTER ROLE` mexem na mesma linha de
# `pg_authid`, e sem serializar o Postgres devolve `tuple concurrently updated`
# para quem perder a corrida. A trava consultiva resolve dentro do banco, que é
# onde a corrida acontece — um lockfile no disco não veria outra máquina.
set -euo pipefail

: "${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"
: "${APP_DB_PASSWORD:?defina APP_DB_PASSWORD (sem default: senha previsível é senha vazada)}"

psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -v senha="$APP_DB_PASSWORD" <<'SQL'
BEGIN;

-- A trava é liberada no COMMIT. Quem chegar junto espera aqui em vez de
-- competir pela mesma linha do catálogo.
SELECT pg_advisory_xact_lock(hashtext('barbearia_app_bootstrap'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    CREATE ROLE barbearia_app LOGIN;
  END IF;
END $$;

-- `:'senha'` é citado pelo psql, não interpolado pelo shell: aspa na senha
-- sorteada não vira SQL solto.
ALTER ROLE barbearia_app
  LOGIN PASSWORD :'senha' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

COMMIT;
SQL

echo "role barbearia_app pronto"
