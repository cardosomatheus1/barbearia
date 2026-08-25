# Barberdock — melhoria de notas — Bloco 2

**Data:** 24/08/2026  
**Foco:** manutenibilidade do motor de agenda (`packages/scheduling/src/booking.ts`).

## Objetivo

Reduzir o maior hotspot restante do motor de agenda sem alterar comportamento, contratos externos ou as defesas de concorrência que evitam overbooking.

## Alterações

O `booking.ts` original deste bloco tinha **1.731 linhas**. Após a refatoração ficou com **1.251 linhas**, redução de aproximadamente **27,7%**.

Foram extraídos dois módulos coesos:

- `booking-leitura.ts` — 359 linhas: listagem de agendamentos do cliente, comprovante, consulta para remarcação, política de booking e confirmação de presença;
- `booking-contratos.ts` — 163 linhas: tipos públicos, erros estáveis, interpretação de SQLSTATE e classificação de contenção de horário.

A fachada `booking.ts` continua dona das mutações/transações de criação, hold, cancelamento e remarcação.

## Compatibilidade pública

A API pública de `booking.ts` foi comparada por AST antes/depois:

- exports antes: **27**;
- exports depois: **27**;
- removidos: **0**;
- adicionados acidentalmente: **0**.

Isso preserva inclusive imports internos existentes de `pgCode`, `contencaoDeHorario` e `createAppointment` via `./booking.js`.

## Guarda permanente

Foi criado `scripts/verificar-scheduling-booking-modulos.mjs` e incluído em `scripts/verify.sh`.

A guarda exige:

- limite de crescimento da fachada e dos módulos extraídos;
- ausência de dependência circular para `booking.ts`;
- permanência das consultas no módulo de leitura;
- permanência dos tipos/erros/SQLSTATE no módulo de contratos;
- reconhecimento explícito de `23P01`, `40P01` e `40001`;
- preservação do filtro por `customer_id` nas consultas do cliente;
- preservação da tradução de contenção para `slot_taken`.

## Validação executada neste runtime

- **29/29 verificadores Node executáveis:** OK;
- nova guarda `scheduling/booking modular`: OK;
- sintaxe/transpilação TypeScript de `packages/scheduling/src`: **31/31 arquivos**;
- grafo de imports relativos do pacote Scheduling: OK;
- API pública antes/depois: **27/27 exports preservados**;
- `scripts/verify.sh`: sintaxe Bash OK.

Um verificador (`scripts/verificar-r11-modulos.test.mjs`) não executou diretamente porque importa `vitest`, que não está instalado neste runtime. Isso é limitação de dependência do ambiente, não falha da refatoração.

## Limitações conhecidas do ambiente

O portão completo ainda não pôde ser repetido depois desta refatoração porque este runtime não possui `pnpm`/`node_modules`; o Corepack tentou obter `pnpm@10.33.0`, mas não possui acesso ao registry. PostgreSQL também continua indisponível, como já documentado na rodada anterior.

Portanto, continuam necessárias em ambiente completo:

1. `pnpm --filter @barbearia/scheduling typecheck`;
2. build de `@barbearia/scheduling`;
3. Vitest/unitários do pacote;
4. suíte de integração com PostgreSQL 16;
5. `scripts/verify.sh` integral.

## Efeito esperado na avaliação

A refatoração reduz um hotspot de 1.731 para 1.251 linhas, explicita fronteiras de leitura/contrato e cria proteção contra regressão arquitetural. Ela sustenta melhora adicional de manutenibilidade sem alegar ganho de segurança/runtime que só PostgreSQL pode provar.
