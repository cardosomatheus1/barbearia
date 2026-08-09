#!/usr/bin/env bash
# Garante o Postgres de pé antes de uma suíte de banco.
#
# Neste ambiente o cluster já caiu duas vezes no meio de uma sessão, sem erro no
# log — parado de fora, não por falha. Descobrir isso pelo `Connection refused`
# de um `psql` no meio de uma suíte custa a suíte inteira e alguns minutos
# procurando um defeito que não existe.
set -euo pipefail
if pg_isready -h 127.0.0.1 -p 5432 -q; then exit 0; fi

echo "postgres fora do ar; subindo" >&2
pg_ctlcluster 16 main start >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 -q && exit 0
  sleep 1
done

echo "postgres não subiu" >&2
exit 1
