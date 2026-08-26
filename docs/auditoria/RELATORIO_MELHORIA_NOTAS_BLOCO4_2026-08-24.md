# Barberdock — melhoria de notas — Bloco 4

**Data:** 24/08/2026  
**Foco:** manutenibilidade e proteção de invariantes financeiros de comissão (`packages/finance/src/comissao.ts`).

## Objetivo

Eliminar o hotspot de 1.390 linhas sem alterar a API pública nem deslocar as fronteiras transacionais que protegem fechamento, estorno, vales, regras e comissão de assinaturas.

## Refatoração

O antigo `packages/finance/src/comissao.ts` tinha **1.390 linhas** e misturava contratos, lançamento/estorno, extrato/fechamento, regras/taxas e rentabilidade do clube.

Agora `comissao.ts` é uma fachada de **51 linhas** e as responsabilidades foram distribuídas em módulos coesos:

- `comissao-contratos.ts` — **56 linhas**: erros, tipos públicos e defaults financeiros;
- `comissao-lancamentos.ts` — **298 linhas**: lançamento/estorno, linha bruta e leitura de lançamentos abertos;
- `comissao-periodos.ts` — **406 linhas**: extrato, vales, fechamento e histórico;
- `comissao-configuracao.ts` — **363 linhas**: configuração, regras, validação de FK sob RLS e taxas do adquirente;
- `comissao-assinatura.ts` — **278 linhas**: modelo da assinatura, simulação, rentabilidade e alteração auditada.

O maior módulo resultante ficou com **406 linhas**. A lógica financeira não foi reduzida artificialmente: ela foi movida por responsabilidade, mantendo fechamento e desconto de vales dentro da mesma transação.

## Compatibilidade pública

A API pública de `comissao.ts` foi comparada pelo TypeScript antes/depois:

- exports antes: **30**;
- exports depois: **30**;
- removidos: **0**;
- adicionados acidentalmente: **0**.

A fachada permanece o contrato externo do pacote Finance.

## Invariantes preservados por guarda

Foi criado `scripts/verificar-finance-comissao-modulos.mjs` e integrado ao `scripts/verify.sh`.

A nova guarda exige:

- fachada pequena e limites de crescimento por responsabilidade;
- ausência de import circular via `comissao.ts`;
- grafo interno dos módulos de comissão acíclico;
- lançamento/estorno permanecendo em `comissao-lancamentos.ts`;
- fechamento e desconto de vales permanecendo em `comissao-periodos.ts`;
- regras/taxas permanecendo em `comissao-configuracao.ts`;
- clube/assinatura permanecendo em `comissao-assinatura.ts`;
- estorno partindo apenas de lançamentos positivos;
- preservação do contexto da assinatura no estorno;
- idempotência de lançamento com `ON CONFLICT DO NOTHING`;
- vales somente com status aberto e somente dos profissionais efetivamente pagos;
- `FOR UPDATE` dos vales durante o fechamento;
- carimbo dos exatos IDs usados no cálculo do fechamento;
- auditoria de `commission.closed`;
- validação de FKs recebidas sob RLS;
- teto defensivo de 30% para taxa de adquirente;
- proibição de taxa de adquirente sobre fiado;
- teto de 100% no modelo de comissão da assinatura;
- auditoria da mudança do modelo da assinatura.

## Validação executada neste runtime

- API pública: **30/30 exports preservados**;
- checagem semântica TypeScript isolada dos novos módulos: **OK**;
- grafo dos módulos de comissão: **sem ciclos**;
- nova guarda `verificar-finance-comissao-modulos.mjs`: **OK**;
- verificadores `verificar-*.mjs` executáveis sem dependências externas: **27/27**;
- auditoria ofensiva: **OK**;
- auditoria profunda: **OK**;
- invariantes de auditoria: **OK**;
- prontidão/R5/R6/R8/R9/R10/R11/R12/V0–V11 aplicáveis: **OK**;
- `scripts/verify.sh`: sintaxe Bash **OK**.

## Limitações do ambiente

O portão completo do repositório ainda não foi repetido após esta refatoração porque este runtime não dispõe do toolchain completo instalado do projeto (`pnpm`/`node_modules`) nem PostgreSQL.

Continuam pendentes em ambiente completo:

1. `pnpm --filter @barbearia/finance typecheck`;
2. build real do pacote Finance;
3. Vitest completo do Finance;
4. integrações Finance com PostgreSQL 16;
5. `scripts/verify.sh` integral, sem skips de banco.

Essas etapas não são classificadas como aprovadas nem reprovadas neste runtime.

## Efeito esperado na avaliação

O bloco remove mais um dos cinco hotspots citados na avaliação inicial e melhora especialmente **manutenibilidade**, **clareza arquitetural** e **proteção contra regressões financeiras**. Comanda, Booking, WhatsApp e Comissão agora têm fronteiras menores e guardas permanentes.
