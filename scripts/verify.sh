#!/usr/bin/env bash
# Portão único do Definition of Done (CLAUDE.md).
#
# Roda tudo o que precisa estar verde para um bloco ser dado como concluído.
#
# ## Por que ele tem fases
#
# A versão em série gastava a soma de tudo. As medições que levaram a esta
# forma, num ambiente de 4 núcleos:
#
#   typecheck 18s (7,9s repetido) · build 29s, dos quais 21s são o Next do web
#   sete suítes de banco 128s em série, ~70s em paralelo
#   migrações do zero: 1s — não era ali que o tempo estava, ao contrário do
#   palpite inicial de trocá-las por `CREATE DATABASE ... TEMPLATE`
#
# A observação que sobrou: as suítes de banco passam a maior parte do tempo
# **esperando o Postgres**, e o build do web passa o dele **usando CPU**. São
# desperdícios complementares, então rodam juntos.
#
# A única ordem que precisa ser respeitada: o e2e da API importa `@barbearia/core`
# e `@barbearia/identity` de `dist`, não de `src`. Os pacotes são construídos
# antes de tudo; o resto não depende de nada e vai junto.
#
# ## Modo rápido
#
#   scripts/verify.sh --rapido
#
# Confere só os pacotes afetados pelo que mudou, mais quem depende deles. É para
# o **laço interno** — no bloco 18 foram cerca de trinta execuções, quase todas
# conferindo pacote que ninguém tinha tocado. Ele **não** fecha bloco: o
# Definition of Done continua exigindo o portão inteiro, e o modo rápido avisa
# isso na saída.
set -uo pipefail
cd "$(dirname "$0")/.."

# O cluster deste ambiente já caiu três vezes no meio de uma sessão, sem erro no
# log — parado de fora, não por falha. O sintoma engana: meia dúzia de suítes
# reprovando junto, cada uma por "Connection refused", como se uma mudança
# tivesse quebrado seis pacotes ao mesmo tempo. Conferir antes custa nada.
scripts/pg-de-pe.sh

RAPIDO=""
[ "${1:-}" = "--rapido" ] && RAPIDO=1

failures=()

# Roda em segundo plano, guardando a saída para ser impressa na ordem certa.
# Ler a saída de dez processos entrelaçada seria pior do que esperar por ela.
SAIDA=$(mktemp -d)
trap 'rm -rf "$SAIDA"' EXIT
nomes=()
pids=()

lancar() {
  local nome="$1"; shift
  local arquivo="$SAIDA/$(printf '%03d' ${#pids[@]}).log"
  ( "$@" ) >"$arquivo" 2>&1 &
  pids+=($!)
  nomes+=("$nome")
}

# Espera tudo o que foi lançado e imprime cada etapa na ordem de lançamento.
colher() {
  for i in "${!pids[@]}"; do
    [ -z "${nomes[$i]}" ] && continue
    printf '\n\033[1m==> %s\033[0m\n' "${nomes[$i]}"
    if wait "${pids[$i]}"; then
      printf '\033[32m    ok\033[0m\n'
    else
      printf '\033[31m    FALHOU\033[0m\n'
      sed 's/^/    /' "$SAIDA/$(printf '%03d' $i).log" | tail -25
      failures+=("${nomes[$i]}")
    fi
    nomes[$i]=""
  done
}

# Etapa serial e sozinha: é a mais barata e é a que responde "o que ficou para
# trás". Enterrada no meio de uma saída longa, ela deixaria de ser lida.
printf '\n\033[1m==> lacunas declaradas\033[0m\n'
if node scripts/verificar-lacunas.mjs >"$SAIDA/lacunas.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/lacunas.log" | tail -25
  failures+=("lacunas declaradas")
fi

# ---------------------------------------------------------------------------
# Fase 1 — o que os outros esperam.
# ---------------------------------------------------------------------------
printf '\n\033[1m==> build dos pacotes\033[0m\n'
if pnpm --filter "./packages/*" build >"$SAIDA/pacotes.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/pacotes.log" | tail -25
  failures+=("build dos pacotes")
  # Sem `dist` o e2e da API falharia por um motivo que não é dele. Parar aqui
  # dá uma saída legível em vez de sete suítes vermelhas pelo mesmo defeito.
  printf '\n\033[31mverify: build dos pacotes quebrado — as suítes não foram rodadas\033[0m\n'
  exit 1
fi

# ---------------------------------------------------------------------------
# Fase 2 — tudo o que não depende de mais nada.
#
# Cada suíte de banco cria e destrói o **próprio** banco descartável, então elas
# não disputam estado. O que elas disputam é a senha do role, que é global ao
# cluster: por isso ela é sorteada **uma vez** aqui e exportada. Continua sendo
# efêmera por execução — a regra pede que não haja credencial previsível, não
# que haja sete.
# ---------------------------------------------------------------------------
printf '\n\033[1m==> typecheck, builds e suítes (em paralelo)\033[0m\n'

# A lista de suítes de banco é a mesma nos dois modos; o que muda é o filtro.
NOMES=(
  "@barbearia/db:db — invariantes"
  "@barbearia/identity:identity — OTP, sessão e 2º fator"
  "@barbearia/scheduling:scheduling — integração"
  "@barbearia/onboarding:onboarding — seis etapas"
  "@barbearia/catalog:catalog — CRUD do admin"
  "@barbearia/finance:finance — comanda, caixa e fiado"
  "@barbearia/crm:crm — a ficha do cliente"
  "@barbearia/jobs:jobs — fila, avisos e falta automática"
  "@barbearia/platform:platform — planos, bloqueio e a porta do Super Admin"
  "@barbearia/api:api — e2e"
)

if [ -n "$RAPIDO" ]; then
  AFETADOS=$(node scripts/afetados.mjs 2>/dev/null)
  precisa() { grep -qx -- "$1" <<<"$AFETADOS"; }
else
  precisa() { return 0; }
fi

#
# O `typecheck` do web sai separado dos outros, e **depois** do build dele.
#
# `apps/web/tsconfig.json` inclui `.next/types/**`, que o `next build` apaga e
# regera. Rodando os dois em paralelo, o tsc lê a pasta no meio da troca e
# reprova com `TS6053: File not found` sobre arquivo que ninguém escreveu — uma
# falha intermitente no portão, que é o tipo de vermelho que ensina todo mundo a
# ignorar vermelho. Encadeados, o par custa ~29s e continua cabendo abaixo do
# e2e da API, que é o caminho crítico: não se perde tempo de relógio nenhum.
if [ -n "$RAPIDO" ] && [ -n "$AFETADOS" ]; then
  # `--filter` por pacote, em vez de `-r`: no modo rápido conferir os dez tipos
  # quando um mudou é a mesma gordura que rodar as dez suítes.
  FILTROS=()
  while read -r pacote; do
    [ -n "$pacote" ] && [ "$pacote" != "@barbearia/web" ] && FILTROS+=(--filter "$pacote")
  done <<<"$AFETADOS"
  [ ${#FILTROS[@]} -gt 0 ] && lancar "typecheck" pnpm "${FILTROS[@]}" typecheck
else
  # `!barbearia` exclui a **raiz**, e sem ela a linha inteira não valia nada:
  # o pacote raiz casa com o filtro, e o `typecheck` dele é `pnpm -r typecheck`
  # — que recursa nos quinze, web incluído. O par build+typecheck logo abaixo
  # existia para evitar a corrida do `.next/types`, e ela acontecia assim mesmo,
  # de vez em quando, com o `TS6053` que o comentário acima descreve. Portão que
  # inventa falha treina todo mundo a ignorar vermelho.
  lancar "typecheck" pnpm --filter '!@barbearia/web' --filter '!barbearia' -r typecheck
fi

precisa "@barbearia/web" && lancar "build do web + typecheck" \
  sh -c 'pnpm --filter @barbearia/web build && pnpm --filter @barbearia/web typecheck'
precisa "@barbearia/api" && lancar "build da api" pnpm --filter @barbearia/api build
precisa "@barbearia/core" && lancar "core — unitários" pnpm --filter @barbearia/core test
precisa "@barbearia/ui" && lancar "ui — tokens e componentes" pnpm --filter @barbearia/ui test
# A suíte do web ficou de fora do portão até o bloco 9. Teste que o portão não
# roda não é garantia nenhuma — o de `destinoSeguro` guarda contra
# redirecionamento aberto no login e precisa correr aqui.
precisa "@barbearia/web" && lancar "web — lógica de tela" pnpm --filter @barbearia/web test
# O resolvedor tem teste próprio: ele decide o que vai ser conferido, e errar
# para menos ali devolveria verde sobre código que ninguém rodou.
lancar "resolvedor de afetados" npx vitest run scripts/afetados.test.mjs
# Crase dentro de consulta fecha o tagged template e o erro sai como sintaxe em
# cima de uma linha de prosa. Custou três voltas de build em três blocos.
lancar "crase em consulta SQL" npx vitest run scripts/crase-em-sql.test.mjs
# Terceira vez que crase dentro de template literal custa uma volta de build: SQL,
# CSS e agora o script do Embedded Signup. O erro sai como sintaxe sobre prosa.
lancar "crase em script inline" npx vitest run scripts/crase-em-script-inline.test.mjs
lancar "o .env.example é a lista" npx vitest run scripts/env-example.test.mjs
lancar "recurso do menu × catálogo" npx vitest run scripts/recursos-da-navegacao.test.mjs
# A RLS separa barbearias e não separa lojas: `UPDATE locations` sem WHERE
# alcança a rede inteira, e sete estavam assim ao mesmo tempo no bloco 111.
lancar "UPDATE de unidade com WHERE" npx vitest run scripts/update-de-unidade-com-where.test.mjs
# Evento no catálogo sem quem o dispare é promessa vazia na superfície que a
# barbearia mostra a terceiros — e do lado de lá ninguém tem como investigar.
lancar "evento de webhook com emissor" npx vitest run scripts/evento-de-webhook-com-emissor.test.mjs
# A tela de chaves prometia trinta e um escopos e duas rotas honravam dois.
lancar "escopo de chave × rota" npx vitest run scripts/escopo-com-rota.test.mjs
# Id da URL sem pipe vira 500 sobre entrada externa, em vez de 400 com motivo.
lancar "@Param com pipe" npx vitest run scripts/param-com-pipe.test.mjs
# Rota nova de primeiro nível é endereço que sai da mão de uma barbearia sem
# nada acusar: o Next serve a rota, `/{slug}` nunca é consultado, e o sintoma é
# "meu link não abre". Quatro rotas já tinham passado por baixo da lista.
lancar "rota de primeiro nível × slug reservado" npx vitest run scripts/rotas-reservadas.test.mjs
lancar "segredos do deploy" npx vitest run scripts/segredos-do-deploy.test.mjs
# Máquina recém-instalada não tem crontab, e era esse o caso que instalava um
# crontab vazio e deixava o backup diário — a única cópia dos dados — sem existir.
lancar "cron do backup" npx vitest run scripts/cron-do-backup.test.mjs
lancar "trava da semente" npx vitest run scripts/semente-permitida.test.mjs
# Semente que inventa tipo ou motivo faz o produto parecer capaz do que não é —
# e já contaminou o vocabulário do domínio uma vez.
lancar "semente não inventa" npx vitest run scripts/semente-nao-inventa.test.mjs
# Migração destrutiva tira do rollback a forma barata dele: a volta deixa de ser
# "sobe a imagem anterior" e vira "restaura backup e perde o que veio depois".
lancar "migração aditiva" npx vitest run packages/db/test/migracao-aditiva.test.mjs

if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(openssl rand -hex 16)}"

  # Precisa de Postgres de verdade: o que se prova é que a **segunda** passada
  # das migrações não quebra. Era ela que abortava o compose e derrubava o site
  # a cada atualização.
  lancar "migrações repetíveis" npx vitest run packages/db/test/migracoes-repetiveis.test.mjs

  for entrada in "${NOMES[@]}"; do
    pacote="${entrada%%:*}"
    nome="${entrada#*:}"
    precisa "$pacote" || continue
    if [ "$pacote" = "@barbearia/api" ]; then
      # A fase 1 já construiu os pacotes; a suíte não precisa refazer.
      lancar "$nome" env PULAR_BUILD_DAS_DEPENDENCIAS=1 pnpm --filter "$pacote" test
    else
      lancar "$nome" pnpm --filter "$pacote" test
    fi
  done
fi

colher

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  printf '\n\033[33m==> testes de banco PULADOS\033[0m\n'
  printf '    defina ADMIN_DATABASE_URL para rodá-los. Um bloco não pode ser\n'
  printf '    concluído sem eles verdes.\n'
  failures+=("testes de banco não executados")
fi

printf '\n'
if [ ${#failures[@]} -eq 0 ]; then
  if [ -n "$RAPIDO" ]; then
    printf '\033[32mverify --rapido: verde\033[0m\n'
    printf '\033[33mPARCIAL: só os pacotes afetados. Não fecha bloco — rode `pnpm verify`.\033[0m\n'
  else
    printf '\033[32mverify: tudo verde\033[0m\n'
  fi
  exit 0
fi

printf '\033[31mverify: %d etapa(s) com problema\033[0m\n' "${#failures[@]}"
printf '  - %s\n' "${failures[@]}"
exit 1
