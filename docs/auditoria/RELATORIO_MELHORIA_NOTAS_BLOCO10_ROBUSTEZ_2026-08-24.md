# Barberdock — Bloco 10 — robustez operacional e recuperação de falhas

**Data:** 24/08/2026  
**Base:** `barberdock-melhoria-notas-bloco9-v8-global-2026-08-24.zip`

## Objetivo

Reduzir falhas típicas de operação real sem adicionar feature: duplo toque, resposta perdida depois de gravação, API/proxy indisponível e repetição cega de operação após uma falha ambígua.

## Alterações aplicadas

### 1. Feedback de envio nos fluxos críticos do admin

Foi criado `apps/web/src/app/admin/botao-de-envio.tsx`, usando `useFormStatus` para:

- indicar que o POST foi aceito;
- desabilitar o submit enquanto a Server Action está pendente;
- anunciar `aria-busy`;
- impedir o segundo toque durante a mesma submissão.

Aplicado em:

- abertura de caixa;
- sangria/suprimento;
- fechamento de caixa;
- inclusão de item na comanda;
- venda de pacote na comanda;
- geração de Pix/cartão/link;
- fechamento/recebimento manual da comanda.

A proteção **não** foi colocada no agendamento público: o R5 exige que essa superfície continue server-only. O público preserva funcionamento sem JavaScript e usa idempotência no servidor para agendamento/lista de espera.

### 2. Item da comanda idempotente de ponta a ponta

Foi criado `packages/db/migrations/0109_item_da_comanda_idempotente.sql`.

O caminho agora é:

`tela → Server Action → Idempotency-Key → controller → chave escopada por operador → advisory lock → fingerprint → índice único em order_items`.

A repetição da mesma intenção devolve a comanda sem criar uma segunda linha. Reutilizar a mesma chave para conteúdo diferente resulta em `idempotencia_conflitante`.

Foram adicionados dois testes de integração ao Finance:

- replay da mesma inclusão mantém **1 item**;
- mesma chave com payload diferente é recusada.

Esses testes dependem de PostgreSQL e continuam aguardando o portão de banco real.

### 3. Falha de transporte deixa de virar exceção crua

O cliente administrativo (`admin-api/core.ts`) e o cliente da plataforma agora convertem recusa de conexão/erro de transporte em:

- `api_timeout`, quando há timeout;
- `api_indisponivel`, quando a API não pode ser alcançada.

O upload de mídia ganhou o mesmo comportamento.

O proxy `/media/...` passa a responder **503** em falha de transporte e **504** em timeout, em vez de relançar exceção.

### 4. API pública com degradação uniforme

`apps/web/src/lib/api.ts` ganhou `fetchPublicoSeguro`.

Todas as chamadas públicas passam por essa borda: uma falha de rede vira um Response 503/504 com o mesmo contrato de erro da API. Assim, leitura degrada para estado indisponível e mutação devolve código recuperável, sem retry automático de escrita.

Agendamento e lista de espera mostram mensagem específica e informam que repetir o mesmo pedido não cria duplicata.

### 5. Error boundary do painel

Foi criado `apps/web/src/app/admin/error.tsx`.

A mensagem evita o conselho perigoso de “repita imediatamente”: se a conexão caiu depois de a gravação concluir, a pessoa é orientada a **conferir o resultado antes de repetir** cobrança, fechamento ou lançamento.

## Guardas permanentes

Novos arquivos:

- `scripts/verificar-robustez-operacional.mjs`
- `scripts/verificar-robustez-operacional.test.mjs`

A guarda verifica o caminho completo de idempotência, o estado pending, a degradação de transporte, 503 de mídia e a orientação de recuperação.

O meta-teste detectou **8/8 regressões artificiais**.

O `verify.sh` agora executa ambos.

## Validação executada neste ambiente

- verificadores `verificar-*.mjs`: **43 aprovados / 0 falhas / 1 skip**;
- skip: somente `verificar-r11-modulos.test.mjs`, que importa `vitest`, indisponível no runtime;
- testes autônomos `scripts/*.test.mjs`: **11 aprovados / 0 falhas / 23 skips por ausência de Vitest**;
- runtime do cliente admin: **2/2** — conexão recusada sanitizada + timeout tipado;
- runtime da API pública: **2/2** — agendamento/lista de espera degradam para `api_indisponivel`;
- `BotaoDeEnvio`: **typecheck isolado OK**;
- sintaxe TypeScript ampla Web + API + Finance: **379/379 arquivos OK**;
- R5: **OK**, superfície pública continua server-only;
- migrações existentes no repositório após este bloco: **109**.

## Limitação que permanece

A migração `0109` e os dois novos testes de idempotência do item **não foram executados contra PostgreSQL real neste runtime**. Portanto a implementação está pronta e estruturalmente validada, mas a certificação de banco continua pendente junto do restante do portão PostgreSQL/RLS/E2E.

## Efeito esperado nas notas

Estimativa conservadora, condicionada à passagem do portão PostgreSQL da migração 0109:

- Testabilidade: ~9,8 → **~9,8/9,9**;
- Prontidão técnica: ~8,2 → **~8,3/8,4**;
- UX operacional: ~9,2 → **~9,25/9,3**;
- Segurança/confiabilidade operacional sem banco: **melhora qualitativa**, principalmente por não transformar resposta perdida em repetição cega.
