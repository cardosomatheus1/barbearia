# Resolução dos achados da auditoria independente — 23/08/2026

## Corrigidos em código

1. **Ficha / gasto total** — nova leitura financeira protegida soma todos os pedidos `paid`; a timeline limitada não é mais fonte do acumulado.
2. **Ficha / última visita** — usa a última visita concluída; falta e cancelamento continuam no histórico, mas não contam como visita.
3. **V9 / cor semântica** — `danger` removido de navegação e decoração detectadas, inclusive shell, brilho de cards numéricos e filtro ativo do Painel; `paid` passou a `success`; fatura aberta e preço acima da base passaram a `warning`; guarda ampliada.
4. **R9 / limpeza de arquivo pós-commit** — exclusão física é best-effort depois de o banco ser a fonte de verdade; erro de filesystem não transforma sucesso lógico em 500 e gera warning para reconciliação de possível órfão.
5. **V10 / 44px** — documentação e guarda alinhadas: alvo interativo tem 44px; intervalo curto demais permanece informativo.

## Corrigidos como contrato/auditoria

6. **V8** — o overclaim foi corrigido **sem baixar o critério original**. A guarda cobre moldes V7 em todas as seções e níveis explícitos em Hoje/Painel/Ficha, mas V8 global permanece pendente de revisão visual das demais telas.
7. **R5** — implementação/guarda estática permanecem, mas Definition of Done exige build real para medir bundle/LCP; não é marcado como prova concluída.
8. **R12** — baseline pré-reorganização permanece irrecuperável; único caminho válido é medir o estado atual com pessoas novas e manter checkpoints daqui para frente.

## Provas adicionadas

- `scripts/verificar-v2-ficha.mjs` reprova soma do acumulado a partir da timeline e exige rota financeira protegida.
- `scripts/verificar-v789-visual.mjs` reprova `danger` no shell, herói/ambiente, brilho de KPI e filtro ativo; também cobra `paid → success` e preço acima da base → `warning`.
- `scripts/verificar-r9-midia.mjs` exige limpeza best-effort pós-commit.
- testes de integração foram estendidos para última visita concluída e gasto acumulado de todos os pedidos pagos.

## Ainda exige ambiente/uso real

- `pnpm install --frozen-lockfile` + `pnpm verify`;
- build Next/API/worker;
- PostgreSQL/migrations/RLS;
- medição R5 de bundle/LCP;
- R12 com pessoas novas e operação assistida em 3–5 barbearias.


## Validação reproduzida após as correções

- **19/19 guardas principais verdes** (`docs/auditoria/evidencias/guardas-2026-08-23.txt`).
- **736 TS/TSX parseados, 0 erro sintático** (`parse-typescript-2026-08-23.txt`).
- **2.253 imports internos/locais estáticos/dinâmicos inspecionados, 0 caminho ausente** pelo scanner independente desta correção (`imports-locais-2026-08-23.txt`). A contagem difere da auditoria anterior porque o scanner usa outro critério de coleta; o resultado relevante é zero destino interno ausente.
- tentativa de `corepack pnpm` bloqueada por indisponibilidade/DNS do registry; por isso build/typecheck/Vitest/PostgreSQL não foram simulados como se tivessem rodado.
