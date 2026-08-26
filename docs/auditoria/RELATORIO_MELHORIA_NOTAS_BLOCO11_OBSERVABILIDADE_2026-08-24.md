# Barberdock — Bloco 11: observabilidade e diagnóstico de produção

**Data:** 24/08/2026  
**Base:** Bloco 10 — robustez operacional

## Objetivo

Aumentar a capacidade de diagnosticar incidentes reais sem transformar logs em uma segunda base de dados pessoais. O foco foi a cadeia API → worker → fila → provedores, preservando o que já existia de health/readiness e request ID.

## Diagnóstico inicial

A API já possuía uma base forte:

- `x-request-id` validado, devolvido na resposta e incluído no log estruturado;
- rota normalizada, sem query string e com ids genéricos;
- `/health` separado de `/health/pronto`;
- readiness conferindo banco e `rolbypassrls`.

O principal gap estava no worker e nos provedores:

- `apps/worker/src/main.ts` ainda emitia `console.log/error` em formatos diferentes;
- não havia trilha por tarefa com `tarefaId`, tentativa, duração e desfecho;
- erros fatais do worker podiam imprimir o objeto de erro inteiro;
- recusas da Meta persistiam a mensagem devolvida pelo provedor no log;
- conciliação financeira imprimia o objeto de erro cru;
- `jobs.last_error` recebia `erro.message` bruto do worker.

## Implementação

### 1. Logger estruturado do worker

Criado `apps/worker/src/log.ts`.

Cada linha é JSON e contém somente escalares operacionais, por exemplo:

- processo;
- nível;
- evento;
- `tenantId` quando aplicável;
- contagens;
- ids técnicos;
- versão/instância quando disponíveis.

Erro desconhecido é reduzido a:

- `erroTipo`;
- `erroCodigo`, somente quando segue alfabeto/tamanho seguros.

Mensagem e stack não entram.

### 2. Ciclo observável por tarefa

Criado `packages/jobs/src/observabilidade.ts`.

A rodada agora pode emitir:

- `inicio`;
- `concluida`;
- `reagendada`;
- `falhou`.

O envelope contém:

- `tarefaId`;
- `tenantId`;
- `kind`;
- tentativa atual;
- máximo de tentativas;
- duração para desfechos;
- tipo/código seguro de erro para retry/falha.

O `apps/worker` conecta esse callback ao logger estruturado.

### 3. `jobs.last_error` sem mensagem bruta

Antes, o worker chamava `falharTarefa` com `erro.message`.

Agora usa `resumoPersistivelDoErro`, que persiste somente algo equivalente a:

`ProviderError:ETIMEDOUT`

Assim telefone, texto de WhatsApp, resposta de PSP e outros conteúdos variáveis não sobrevivem no campo operacional da fila.

### 4. Logs da Meta sanitizados

`whatsapp-meta.ts` e `whatsapp-signup.ts` preservam os dados úteis para suporte:

- passo/path;
- HTTP status;
- código/subcódigo;
- tipo;
- `fbtrace_id`.

A mensagem textual devolvida pela Meta não é mais gravada no log.

### 5. Logs financeiros sanitizados

Falhas de conciliação/conclusão de cobrança preservam `chargeId` e classificação técnica do erro, sem imprimir o objeto de exceção inteiro.

### 6. Guarda permanente

Criados:

- `scripts/verificar-observabilidade.mjs`;
- `scripts/verificar-observabilidade.test.mjs`.

O guard entrou no `scripts/verify.sh` e cobre também a infraestrutura já existente de request ID/readiness.

## Validação executada neste runtime

- observabilidade estrutural: **PASS**;
- negativos da guarda: **7/7 mutações detectadas**;
- sanitização/classificação em runtime: **9/9 invariantes**;
- TypeScript dos 9 arquivos alterados: **9/9 sem erro sintático**;
- verificadores diretos do repositório: **35/35**;
- testes `.test.mjs` executáveis sem Vitest: **12/12**;
- `scripts/verify.sh`: sintaxe **OK**.

Os 23 scripts que importam Vitest não puderam ser executados neste runtime porque `node_modules/vitest` não está disponível. As suítes PostgreSQL também continuam dependentes do ambiente externo já declarado pelo projeto.

## Resultado arquitetural

A API já conseguia dizer “qual requisição falhou”. Agora o worker consegue dizer “qual tarefa de qual tenant falhou, em qual tentativa, por quanto tempo e se será repetida”, sem guardar o conteúdo da operação.

Isto reduz significativamente o tempo de diagnóstico esperado para falhas de:

- WhatsApp/Meta;
- cobranças;
- fiscal;
- campanhas;
- retenção/LGPD;
- split;
- jobs em retry ou falha terminal.

## Limite correto

Este bloco melhora observabilidade e segurança operacional, mas não substitui:

- execução do worker contra PostgreSQL real;
- agregador de logs real;
- alertas reais de infraestrutura;
- smoke com Meta/Stripe/S3;
- teste de incidente em ambiente publicado.
