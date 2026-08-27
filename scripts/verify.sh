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

# A prontidão vem antes das suítes pelo mesmo motivo das lacunas: é barata e
# responde se o repositório está dizendo a verdade sobre o que pode ser vendido.
printf '\n\033[1m==> matriz de prontidão\033[0m\n'
if node scripts/verificar-prontidao.mjs >"$SAIDA/prontidao.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/prontidao.log" | tail -25
  failures+=("matriz de prontidão")
fi

# R8 mantém a linguagem comercial abaixo da matriz de prontidão.
printf '\n\033[1m==> verdade comercial R8\033[0m\n'
if node scripts/verificar-r8-comercial.mjs >"$SAIDA/r8.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r8.log" | tail -25
  failures+=("verdade comercial R8")
fi

# V0 é barato e estrutural: garante que renomear/reagrupar não apague uma porta
# antiga e que o login passe pela decisão de casa por perfil.
printf '
\033[1m==> vocabulário e navegação V0\033[0m
'
if node scripts/verificar-v0-navegacao.mjs >"$SAIDA/v0.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v0.log" | tail -25
  failures+=("vocabulário e navegação V0")
fi

# As correções críticas de auditoria viram contrato cumulativo: uma branch futura
# não pode ficar verde removendo junto o bug e a asserção que o detectava.
printf '\n\033[1m==> invariantes da auditoria\033[0m\n'
if node scripts/verificar-invariantes-auditoria.mjs >"$SAIDA/invariantes-auditoria.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/invariantes-auditoria.log" | tail -40
  failures+=("invariantes da auditoria")
fi

# A terceira camada de auditoria cruza semântica financeira, timezone e falhas
# externas. É separada da guarda de regressão visual porque esses bugs podem
# manter rota, tipo e tela corretos enquanto o número econômico fica errado.
printf '\n\033[1m==> auditoria profunda de invariantes\033[0m\n'
if node scripts/verificar-auditoria-profunda.mjs >"$SAIDA/auditoria-profunda.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/auditoria-profunda.log" | tail -40
  failures+=("auditoria profunda de invariantes")
fi

# A quarta camada protege os achados ofensivos: dinheiro externo, slugs/rotas
# públicas e a janela temporal da apuração da plataforma.
printf '\n\033[1m==> auditoria ofensiva de invariantes\033[0m\n'
if node scripts/verificar-auditoria-ofensiva.mjs >"$SAIDA/auditoria-ofensiva.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/auditoria-ofensiva.log" | tail -40
  failures+=("auditoria ofensiva de invariantes")
fi

# A auditoria de rotas pega links literais quebrados antes do build do Next.
printf '\n\033[1m==> rotas internas web\033[0m\n'
if node scripts/verificar-rotas-web.mjs >"$SAIDA/rotas-web.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/rotas-web.log" | tail -25
  failures+=("rotas internas web")
fi

# V1 abre a entidade central do produto. É barato conferir aqui porque uma
# regressão de permissão ou navegação não precisa esperar build ou Postgres.
printf '\n\033[1m==> porta de clientes V1\033[0m\n'
if node scripts/verificar-v1-clientes.mjs >"$SAIDA/v1.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v1.log" | tail -25
  failures+=("porta de clientes V1")
fi

# V3 fecha a orientação: uma única navegação vertical, migalha derivada e abas
# horizontais. É barato e precisa falhar antes do build se alguém recriar uma
# segunda lista de navegação.
printf '\n\033[1m==> orientação V3\033[0m\n'
if node scripts/verificar-v3-orientacao.mjs >"$SAIDA/v3.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v3.log" | tail -25
  failures+=("orientação V3")
fi

# V4 separa o que é operação diária do que é configuração por exceção. A
# guarda cobra dois grupos reais, peso secundário e o comportamento de tablet
# que mantém as áreas do dia visíveis sem rolagem.
printf '\n\033[1m==> operação x configuração V4\033[0m\n'
if node scripts/verificar-v4-separacao.mjs >"$SAIDA/v4.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v4.log" | tail -25
  failures+=("operação x configuração V4")
fi

# V5 transforma Hoje na casa da operação. A guarda cobra a primeira dobra,
# separação de permissão financeira e ausência de gráfico antes do build.
printf '\n\033[1m==> centro operacional V5\033[0m\n'
if node scripts/verificar-v5-hoje.mjs >"$SAIDA/v5.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v5.log" | tail -25
  failures+=("centro operacional V5")
fi

# R5 abre a primeira ilha de JavaScript do produto. A guarda barata cobra que
# ela exista somente no admin, tenha estado por linha e não puxe domínio/banco
# para o navegador. O tamanho real dos chunks é medido depois do Next build.
printf '\n\033[1m==> primeira ilha de cliente R5\033[0m\n'
if node scripts/verificar-r5-ilha.mjs >"$SAIDA/r5.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r5.log" | tail -25
  failures+=("primeira ilha de cliente R5")
fi

# R6 impede que título histórico ✅ volte a prometer a parte que uma lacuna
# aberta ainda declara ausente.
printf '\n\033[1m==> promessas históricas R6\033[0m\n'
if node scripts/verificar-r6-promessas.mjs >"$SAIDA/r6.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r6.log" | tail -25
  failures+=("promessas históricas R6")
fi

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

# V10 troca a lista visual pela régua proporcional. A guarda confere que a
# jornada vem do domínio, o buraco usa buffer e o alvo de marcação continua
# contido/operável no mobile.
printf '\n\033[1m==> agenda proporcional V10\033[0m\n'
if node scripts/verificar-v10-agenda.mjs >"$SAIDA/v10.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v10.log" | tail -25
  failures+=("agenda proporcional V10")
fi

# V11 é a válvula de escape da arquitetura de navegação: função vem do
# registro já recortado; pessoa e horário vêm das rotas que já aplicam tenant
# e permissão. Ações no contexto impedem procurar o mesmo objeto uma segunda vez.
printf '\n\033[1m==> busca global e ações V11\033[0m\n'
if node scripts/verificar-v11-busca.mjs >"$SAIDA/v11.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/v11.log" | tail -25
  failures+=("busca global e ações V11")
fi

if node scripts/verificar-v2-ficha.mjs >"$SAIDA/v2.log" 2>&1; then
  echo "  ✓ V2: ficha do cliente organizada"
else
  echo "  ✗ V2: ficha do cliente"
  cat "$SAIDA/v2.log"
  exit 1
fi

if node scripts/verificar-v6-painel.mjs >"$SAIDA/v6.log" 2>&1; then
  echo "  ✓ V6: painel do dono narrativo"
else
  echo "  ✗ V6: painel do dono"
  cat "$SAIDA/v6.log"
  exit 1
fi


# V7/V8/V9 consolidam o desenho depois das jornadas estarem no lugar: molde
# declarado, hierarquia em três níveis e cor com significado fechado.
if node scripts/verificar-v789-visual.mjs >"$SAIDA/v789.log" 2>&1; then
  echo "  ✓ V7/V8/V9: moldes, hierarquia e semântica visual"
else
  echo "  ✗ V7/V8/V9: consolidação visual"
  cat "$SAIDA/v789.log"
  exit 1
fi

# V8 global estático percorre todas as superfícies TSX e fecha anti-padrões que
# não dependem de banco/navegador: mídia sem alt, target externo inseguro,
# tabindex positivo, clique sem semântica, botão fora do design system, summary
# sem contrato e tabela de dados sem recipiente horizontal.
printf '
[1m==> V8 técnico global estático[0m
'
if node scripts/verificar-v8-estatico-global.mjs >"$SAIDA/v8-global.log" 2>&1 \
  && node scripts/verificar-v8-estatico-global.test.mjs >>"$SAIDA/v8-global.log" 2>&1; then
  printf '[32m    ok[0m
'
else
  printf '[31m    FALHOU[0m
'
  sed 's/^/    /' "$SAIDA/v8-global.log" | tail -25
  failures+=("V8 técnico global estático")
fi

# A11Y/UX fecha regressões que a revisão visual estrutural não enxerga: pular
# navegação, foco seguro da busca modal, indicação de foco e revelação
# progressiva do pagamento dividido na Comanda.
printf '
[1m==> acessibilidade e densidade operacional[0m
'
if node scripts/verificar-a11y-ux.mjs >"$SAIDA/a11y-ux.log" 2>&1 \
  && node scripts/verificar-a11y-ux.test.mjs >>"$SAIDA/a11y-ux.log" 2>&1; then
  printf '[32m    ok[0m
'
else
  printf '[31m    FALHOU[0m
'
  sed 's/^/    /' "$SAIDA/a11y-ux.log" | tail -25
  failures+=("acessibilidade e densidade operacional")
fi

# O percurso financeiro precisa provar uma venda, não apenas abrir a tela. Esta
# guarda prende os marcos mínimos do E2E (caixa → comanda → item → pagamento →
# troco → movimento → fechamento) antes de o Playwright/DB rodar na medição.
printf '\n\033[1m==> honestidade do percurso financeiro E2E\033[0m\n'
if node scripts/verificar-percurso-venda-e2e.mjs >"$SAIDA/percurso-venda-e2e.log" 2>&1 \
  && node scripts/verificar-percurso-venda-e2e.test.mjs >>"$SAIDA/percurso-venda-e2e.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/percurso-venda-e2e.log" | tail -25
  failures+=("honestidade do percurso financeiro E2E")
fi

# R12 aqui é só o smoke estrutural e a integridade do instrumento. A medição
# humana não pode virar teste automatizado sem perder o que ela mede.
printf '\n\033[1m==> percursos de usabilidade R12\033[0m\n'
if node scripts/verificar-r12-percursos.mjs >"$SAIDA/r12.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r12.log" | tail -25
  failures+=("percursos de usabilidade R12")
fi

# R9 tira a página pública de hosts externos e transforma imagem em dado
# persistente do produto. A guarda também cobra backup e preserva o consentimento
# específico das fotos de cliente.
printf '\n\033[1m==> armazenamento próprio de mídia R9\033[0m\n'
if node scripts/verificar-r9-midia.mjs >"$SAIDA/r9.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r9.log" | tail -25
  failures+=("armazenamento próprio de mídia R9")
fi

# R10 parte o CSS por superfície sem mudar a cascata. A guarda cobra que o
# índice continue sendo só índice, que todos os fragmentos estejam importados
# uma vez e que cópia idêntica de regra não volte a crescer em silêncio.
printf '\n\033[1m==> CSS por superfície R10\033[0m\n'
if node scripts/verificar-r10-css.mjs >"$SAIDA/r10.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r10.log" | tail -25
  failures+=("CSS por superfície R10")
fi

# R11 parte os dois maiores monólitos internos do admin por domínio, mantendo
# fachadas estáveis para que a UI não conheça a topologia da implementação.
printf '\n\033[1m==> módulos do admin R11\033[0m\n'
if node scripts/verificar-r11-modulos.mjs >"$SAIDA/r11.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/r11.log" | tail -25
  failures+=("módulos do admin R11")
fi

# A comanda financeira era o maior hotspot de domínio do backend. A guarda
# mantém leitura, fiado e tipos fora da fachada e preserva as travas críticas
# que justificam a separação.
printf '\n\033[1m==> módulos financeiros da comanda\033[0m\n'
if node scripts/verificar-finance-comanda-modulos.mjs >"$SAIDA/finance-comanda-modulos.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/finance-comanda-modulos.log" | tail -25
  failures+=("módulos financeiros da comanda")
fi

# O booking era o maior hotspot do motor de agenda. A guarda mantém consultas
# do cliente e contratos/SQLSTATE fora da fachada transacional sem deslocar as
# defesas de concorrência que impedem overbooking.
printf '\n\033[1m==> módulos do motor de booking\033[0m\n'
if node scripts/verificar-scheduling-booking-modulos.mjs >"$SAIDA/scheduling-booking-modulos.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/scheduling-booking-modulos.log" | tail -25
  failures+=("módulos do motor de booking")
fi

# O canal WhatsApp era o próximo hotspot do CRM: credencial, templates,
# mensagens, webhook e roteamento público agora têm fronteiras próprias.
printf '\n\033[1m==> módulos do CRM/WhatsApp\033[0m\n'
if node scripts/verificar-crm-whatsapp-modulos.mjs >"$SAIDA/crm-whatsapp-modulos.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/crm-whatsapp-modulos.log" | tail -25
  failures+=("módulos do CRM/WhatsApp")
fi

# Comissão é uma fronteira de dinheiro: a modularização só vale se fechamento,
# estorno, vales e limites defensivos continuarem no mesmo contrato.
printf '\n\033[1m==> módulos financeiros de comissão\033[0m\n'
if node scripts/verificar-finance-comissao-modulos.mjs >"$SAIDA/finance-comissao-modulos.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/finance-comissao-modulos.log" | tail -25
  failures+=("módulos financeiros de comissão")
fi

# Fiscal é uma integração externa sensível: a modularização só vale se o código
# continuar dizendo a verdade sobre o que existe (nenhum/fake), preservando
# idempotência, estados em voo, recorte da unidade e entrega no máximo uma vez.
printf '\n\033[1m==> módulos financeiros fiscais\033[0m\n'
if node scripts/verificar-finance-fiscal-modulos.mjs >"$SAIDA/finance-fiscal-modulos.log" 2>&1; then
  printf '\033[32m    ok\033[0m\n'
else
  printf '\033[31m    FALHOU\033[0m\n'
  sed 's/^/    /' "$SAIDA/finance-fiscal-modulos.log" | tail -25
  failures+=("módulos financeiros fiscais")
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
  sh -c 'pnpm --filter @barbearia/web build && node scripts/medir-bundle-r5.mjs && pnpm --filter @barbearia/web typecheck'
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
lancar "guarda da matriz de prontidão" node --test scripts/verificar-prontidao.test.mjs
lancar "guarda CSS R10 — negativos" node --test scripts/verificar-r10-css.test.mjs
lancar "guarda R11 — módulos por domínio" npx vitest run scripts/verificar-r11-modulos.test.mjs
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
# Métrica no catálogo que ninguém calcula responde "—" para sempre, e o link
# "conferir na tela" precisa levar a uma tela que mostre o número.
lancar "métrica com resposta" npx vitest run scripts/metrica-com-resposta.test.mjs
# `professionals` guarda balcao, sala e quem atende fora junto de quem atende.
# Contados como cadeira, o denominador da ocupacao cresce e a hora cheia deixa
# de parecer cheia -- e e ela que decide sinal, preco de pico e hora fria.
lancar "capacidade com tipo de cadeira" npx vitest run scripts/cadeira-com-tipo.test.mjs
# A RLS separa barbearias e nao separa lojas dentro de uma. Oito defeitos da
# varredura de multiunidade eram a mesma linha: leitura por id numa tabela com
# location_id, dentro de funcao que ja recebia a loja. O pior fechava a comanda
# da matriz com o dinheiro caindo na gaveta da filial.
lancar "id conferido contra a unidade" npx vitest run scripts/id-com-unidade.test.mjs
# Permissao no catalogo que nenhuma rota exige e controle de seguranca que o
# dono acredita ter configurado: a caixa esta la, ele desmarca, e nada muda.
lancar "permissao com rota" npx vitest run scripts/permissao-com-rota.test.mjs
lancar "recusa com frase" npx vitest run scripts/recusa-com-frase.test.mjs
lancar "uniao do dominio" npx vitest run scripts/uniao-do-dominio.test.mjs
lancar "summary com classe" npx vitest run scripts/summary-com-classe.test.mjs
# Rota nova de primeiro nível é endereço que sai da mão de uma barbearia sem
# nada acusar: o Next serve a rota, `/{slug}` nunca é consultado, e o sintoma é
# "meu link não abre". Quatro rotas já tinham passado por baixo da lista.
lancar "rota de primeiro nível × slug reservado" npx vitest run scripts/rotas-reservadas.test.mjs
lancar "segredos do deploy" npx vitest run scripts/segredos-do-deploy.test.mjs
lancar "configuração de produção" node --test scripts/verificar-configuracao-producao.test.mjs
# Segurança de lançamento: nenhuma função raw-unsafe em produção, nenhum segredo
# no snapshot e proteção anti-bot não pode ser removida só de um lado do fluxo.
lancar "SQL seguro" node scripts/verificar-sql-seguro.mjs
lancar "SQL seguro — negativos" node --test scripts/verificar-sql-seguro.test.mjs
lancar "segredos no snapshot" node scripts/verificar-segredos.mjs
lancar "secret scan — negativos" node --test scripts/verificar-segredos.test.mjs
lancar "proteção anti-bot" node scripts/verificar-bot-protection.mjs
lancar "proteção anti-bot — negativos" node --test scripts/verificar-bot-protection.test.mjs
lancar "portão de segurança" node scripts/verificar-portao-seguranca.mjs
lancar "portão de segurança — negativos" node --test scripts/verificar-portao-seguranca.test.mjs
lancar "identidade/tenant — segurança" node scripts/verificar-identidade-seguranca.mjs
lancar "identidade/tenant — negativos" node --test scripts/verificar-identidade-seguranca.test.mjs
lancar "auditoria Scheduling" node scripts/verificar-auditoria-scheduling.mjs
lancar "auditoria Scheduling — negativos" node --test scripts/verificar-auditoria-scheduling.test.mjs
lancar "auditoria Financeiro" node scripts/verificar-auditoria-financeiro.mjs
lancar "auditoria Financeiro — negativos" node --test scripts/verificar-auditoria-financeiro.test.mjs
lancar "auditoria CRM/WhatsApp" node scripts/verificar-auditoria-crm-whatsapp.mjs
lancar "auditoria CRM/WhatsApp — negativos" node --test scripts/verificar-auditoria-crm-whatsapp.test.mjs
lancar "auditoria Catálogo/Onboarding" node scripts/verificar-auditoria-catalogo-onboarding.mjs
lancar "auditoria Catálogo/Onboarding — negativos" node --test scripts/verificar-auditoria-catalogo-onboarding.test.mjs
lancar "auditoria Platform/Jobs" node scripts/verificar-auditoria-platform-jobs.mjs
lancar "auditoria Platform/Jobs — negativos" node --test scripts/verificar-auditoria-platform-jobs.test.mjs
lancar "auditoria Final Cross-Domain" node scripts/verificar-auditoria-final-cross-domain.mjs
lancar "auditoria Final Cross-Domain — negativos" node --test scripts/verificar-auditoria-final-cross-domain.test.mjs
lancar "auditoria Recheck Final" node scripts/verificar-recheck-final.mjs
lancar "auditoria Recheck Final — negativos" node --test scripts/verificar-recheck-final.test.mjs
lancar "certificação prática da pilha" node scripts/verificar-certificacao-pratica.mjs
lancar "certificação prática da pilha — negativos" node --test scripts/verificar-certificacao-pratica.test.mjs
lancar "carga concorrente — contrato do ensaio" node --test scripts/carga-concorrencia-reserva.test.mjs
lancar "404 por superfície" node scripts/verificar-404-por-superficie.mjs
lancar "estado de agendamento no domínio" node scripts/estado-de-agendamento-do-dominio.mjs
lancar "estado de agendamento — negativos" node --test scripts/estado-de-agendamento-do-dominio.test.mjs
# Quatro guardas que existiam, passavam e **não rodavam** — nenhuma estava aqui.
# Duas delas são os testes negativos de guardas que o portão já executava, então
# a prova de que aquelas conseguem ficar vermelhas nunca era exercitada: guarda
# cuja prova negativa não roda é guarda em que se confia sem motivo.
#
# Runners diferentes de propósito: `varredura-com-chamador` é suíte `vitest`; os
# outros três são scripts que lançam em regressão e saem diferente de zero. Rodar
# um com o runner do outro dá verde sobre nada — `node --test` conta o arquivo e
# o `vitest` diz "No test suite found".
lancar "varredura com chamador" npx vitest run scripts/varredura-com-chamador.test.mjs
lancar "R12 usabilidade — negativos" node scripts/r12-usabilidade.test.mjs
lancar "R6 promessas — negativos" node scripts/verificar-r6-promessas.test.mjs
lancar "R8 comercial — negativos" node scripts/verificar-r8-comercial.test.mjs
lancar "movimento reduzido" node scripts/verificar-movimento-reduzido.mjs
lancar "movimento reduzido — negativos" node --test scripts/verificar-movimento-reduzido.test.mjs
lancar "404 por superfície — negativos" node --test scripts/verificar-404-por-superficie.test.mjs
lancar "alvo do bloqueio e regra de comissão" node scripts/verificar-alvo-e-comissao.mjs
lancar "alvo do bloqueio e regra de comissão — negativos" node --test scripts/verificar-alvo-e-comissao.test.mjs
lancar "vazio de texto" node scripts/verificar-vazio-de-texto.mjs
lancar "vazio de texto — negativos" node --test scripts/verificar-vazio-de-texto.test.mjs
lancar "pulo com motivo" node scripts/verificar-pulo-com-motivo.mjs
lancar "hora com fuso" node scripts/verificar-hora-com-fuso.mjs
lancar "hora com fuso — negativos" node scripts/verificar-hora-com-fuso.test.mjs
lancar "entrega de OTP — negativos" node --test scripts/verificar-otp-entregavel.test.mjs
lancar "rede de deploy" node scripts/verificar-rede-de-deploy.mjs
lancar "rede de deploy — negativos" node --test scripts/verificar-rede-de-deploy.test.mjs
lancar "criptografia de backup" node scripts/verificar-criptografia-backup.mjs
lancar "criptografia de backup — runtime" node --test scripts/backup-crypto.test.mjs
lancar "backup shell criptografado" node --test scripts/backup-shell.test.mjs
lancar "criptografia de backup — negativos" node --test scripts/verificar-criptografia-backup.test.mjs
lancar "hardening de integrações" node --test scripts/verificar-hardening-integracoes.test.mjs
lancar "robustez operacional" node scripts/verificar-robustez-operacional.mjs
lancar "robustez operacional — negativos" node scripts/verificar-robustez-operacional.test.mjs
lancar "observabilidade e diagnóstico" node scripts/verificar-observabilidade.mjs
lancar "observabilidade — negativos" node scripts/verificar-observabilidade.test.mjs
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
