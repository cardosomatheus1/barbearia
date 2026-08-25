# Barberdock — melhoria de notas — Bloco 8: hardening de produção e integrações

**Data:** 24/08/2026  
**Base:** versão cumulativa após Bloco 7 + landing Super Copy + CTA editorial.

## Objetivo

Reduzir risco operacional antes do piloto sem fingir que testes simulados substituem provedores reais. O foco foi configuração de produção, Stripe, S3 e Meta/WhatsApp.

## Mudanças aplicadas

### 1. PSP fake proibido em produção

`packages/platform/src/adquirente.ts` agora usa a mesma filosofia já aplicada ao fiscal:

- `PSP_MODO=fake` continua disponível em desenvolvimento/teste;
- em `NODE_ENV=production`, `fake` falha alto;
- a trava vale também quando o modo é passado diretamente às fábricas, não apenas quando vem da variável de ambiente.

Isso evita que uma instalação pareça cobrar online enquanto usa dinheiro de mentira.

### 2. Stripe com timeout, redirect seguro e erro sanitizado

`packages/platform/src/stripe.ts` passou a:

- usar `AbortSignal.timeout(15_000)`;
- usar `redirect: 'manual'`, evitando apresentar `Authorization` a um destino de redirect;
- transformar falhas de rede em `StripeTransportError` genérico, sem repetir mensagem potencialmente sensível do transporte;
- transformar resposta não JSON em `StripeError` com código `stripe_invalid_response`;
- preservar a falha explícita `STRIPE_SECRET_KEY é obrigatória...` antes da tentativa de rede.

A política de não retentar automaticamente foi mantida; a conciliação continua sendo a rede de segurança do domínio.

### 3. S3 mais seguro em produção

`apps/api/src/media/storage.ts` agora:

- rejeita endpoint com usuário/senha, query ou fragmento embutidos;
- em produção, bloqueia `http://` por padrão;
- permite HTTP apenas com `MEDIA_S3_ALLOW_HTTP=1`, pensado para MinIO interno conscientemente sem TLS;
- sanitiza erro de rede usando apenas o nome do erro, sem propagar mensagem bruta.

`.env.example`, `deploy/compose.yml` e `deploy/configurar-midia-s3.sh` foram atualizados para refletir o opt-in explícito.

### 4. Preflight de produção antes das migrações

Novo:

- `scripts/verificar-configuracao-producao.mjs`
- `scripts/verificar-configuracao-producao.test.mjs`

O `preparar` do compose executa o preflight **antes de criar banco/aplicar migrações**.

Ele recusa, entre outros:

- PSP fake em produção;
- Stripe sem chave/webhook;
- chave Stripe `sk_test_`/`rk_test_` em produção;
- Fiscal fake;
- S3 incompleto;
- S3 HTTP sem opt-in;
- endpoint S3 com segredo/query embutidos;
- `WHATSAPP_MODO=meta` sem cofre/segredos do webhook;
- Embedded Signup com `META_APP_*` preenchidos pela metade;
- coexistência sem credenciais completas;
- `META_APP_SECRET` e `WHATSAPP_APP_SECRET` divergentes;
- `WEB_URL` público sem HTTPS ou apontando para localhost.

### 5. Guarda permanente de hardening

Novos:

- `scripts/verificar-hardening-integracoes.mjs`
- `scripts/verificar-hardening-integracoes.test.mjs`

O `scripts/verify.sh` passou a incluir os dois novos portões.

## Testes adicionados às suítes existentes

Foram ampliados testes de:

- `packages/platform/src/stripe.test.ts`;
- `packages/platform/src/adquirente.test.ts`;
- `apps/api/src/media/storage.test.ts`.

Eles cobram timeout/redirect, falha de transporte, resposta inválida, fake em produção e política de HTTP do S3.

## Validação executada neste runtime

### Preflight

- **13/13 cenários** ✅

### Guarda de regressão

- estado atual protegido ✅
- **5 mutações críticas + estado atual = 6/6** ✅

As mutações removem deliberadamente timeout, redirect, trava de PSP fake, bloqueio S3 HTTP e chamada do preflight no deploy.

### Runtime real sem provedor externo

Código TypeScript real foi transpilado e executado diretamente:

1. Stripe usa redirect manual + timeout ✅
2. Stripe sanitiza falha de transporte ✅
3. Stripe tipa resposta inválida ✅
4. S3 PUT/GET/DELETE assinados contra transporte simulado ✅
5. S3 HTTP bloqueado em produção ✅
6. S3 HTTP liberado somente com opt-in ✅
7. S3 recusa credencial/query no endpoint ✅
8. S3 sanitiza erro de rede ✅

**8/8**.

Também foi revalidado que ausência de `STRIPE_SECRET_KEY` continua falhando pelo nome da variável e não é mascarada como erro de transporte.

### Guardas do repositório

- **32/32 `verificar-*.mjs` diretos:** OK
- **8/8 `verificar-*.test.mjs` executáveis via `node --test`:** OK
- **1 teste** continua não executável neste runtime por importar `vitest`, ausente no ambiente; não é falha do código.

Entre os verdes: R9 mídia, auditoria ofensiva, auditoria profunda, prontidão, hardening e configuração de produção.

### Sintaxe

- 6 arquivos TS/testes alterados transpilaram sem erro sintático ✅
- `deploy/configurar-midia-s3.sh` ✅
- `scripts/verify.sh` ✅
- `deploy/compose.yml` parseado como YAML ✅

## Impacto esperado nas notas

Estimativa conservadora, sem contar como prova externa aquilo que não foi executado:

- **Integrações para produção:** ~7,8 → **~8,1–8,3**
- **Segurança comprovável sem banco:** ~8,0 → **~8,2–8,4**
- **Prontidão técnica certificável neste ambiente:** ~8,0 → **~8,2**
- **Testabilidade:** mantém faixa **~9,7–9,8**, agora com preflight e regressões negativas adicionais.

## Limite desta rodada

Este bloco **não** transforma em aprovado:

- smoke S3 contra bucket real;
- Meta/WhatsApp contra conta real;
- Stripe contra conta real;
- PostgreSQL/RLS/E2E integral;
- V8 humano;
- R12 com barbearias reais.

O ganho é reduzir drasticamente a chance de chegar a esses testes com configuração obviamente insegura ou incompleta.
