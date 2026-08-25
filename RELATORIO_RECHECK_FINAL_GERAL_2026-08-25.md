# Barberdock — Recheck Final Geral

**Data:** 25/08/2026  
**Base:** `barberdock-auditoria-final-cumulativa-2026-08-25.zip`  
**Objetivo:** uma revisão independente depois do fechamento dos Blocos 1–6 e da Auditoria Final Cross-Domain, procurando problemas que as guardas já existentes pudessem não enxergar.

## Veredito

O recheck encontrou **3 classes adicionais de achado**. As três foram corrigidas. Depois das correções, todas as guardas executáveis deste runtime permanecem verdes.

**Bloqueador conhecido de código após o recheck:** nenhum no escopo auditado.  
**Dependências externas ainda não certificadas:** PostgreSQL/Vitest/build/E2E e providers reais; o fallback SMS do OTP permanece lacuna declarada até contratação de um provedor.

## O que foi revisto de forma independente

Além das guardas anteriores, a revisão procurou:

- `TODO/FIXME/HACK` relevantes em código produtivo;
- caches e estruturas globais que crescem com entrada pública;
- providers fake/console ligados diretamente em produção;
- `queryRawUnsafe/executeRawUnsafe` fora de testes;
- rotas e mutações fora de `withTenant`/`semTenant` justificado;
- RLS e funções `SECURITY DEFINER`;
- ordem de advisory locks entre Agenda, Catálogo, recursos e jornada;
- todos os emissores produtivos de `appointments` e `slot_holds`;
- consistência da sequência de migrações;
- divergência entre SPEC/ROADMAP e o caminho realmente executado.

Não foi encontrado ciclo concreto de lock entre as travas cross-domain introduzidas anteriormente. Os usos de raw SQL unsafe encontrados estão restritos a utilitários de teste.

## Achados e correções

### R1 — cache público de slugs não tinha teto real — ALTO / disponibilidade

`TenantService` dizia limitar o cache a 10.000 entradas, mas ao ultrapassar o número apenas removia entradas **expiradas**. Um burst distribuído de slugs aleatórios durante o TTL de 60 s mantinha todas as entradas vivas e permitia ao `Map` crescer sem limite.

**Correção:**

- `maxCacheEntries = 10_000` explícito;
- remoção de expirados;
- se ainda estiver acima do teto, remoção determinística das entradas mais antigas pela ordem do `Map`;
- mesma política aplicada ao cache de bloqueios.

Assim, cache negativo continua protegendo o banco contra varredura de slugs, sem trocar pressão de banco por crescimento de memória.

### R2 — OTP/senha de primeiro acesso usavam ConsoleMessagingProvider em produção — CRÍTICO / funcional

O `AppModule` injetava `ConsoleMessagingProvider` incondicionalmente. Esse provider registrava no log que a mensagem havia sido enviada, sem enviar OTP ou senha para o usuário. O preflight de produção também não detectava a situação.

Isso contradizia a SPEC, que exige login do cliente por telefone + OTP no WhatsApp. A existência da abstração e dos testes de compensação não substituía um canal real.

**Correção:**

- criado `MetaIdentityMessagingProvider`, separado do WhatsApp de CRM das barbearias;
- a identidade usa uma **WABA/número central da plataforma Barberdock**, para que login não dependa de cada barbearia ter conectado o próprio WhatsApp;
- envio via WhatsApp Cloud API com templates `AUTHENTICATION` e botão OTP/Copy Code;
- `ConsoleMessagingProvider` recusa `NODE_ENV=production`;
- `AppModule` usa `identityMessagingProviderFromEnv()` e não injeta console diretamente;
- preflight exige em produção:
  - `IDENTITY_MESSAGING_MODO=meta`;
  - `IDENTITY_WHATSAPP_PHONE_NUMBER_ID`;
  - `IDENTITY_WHATSAPP_ACCESS_TOKEN`;
  - `IDENTITY_WHATSAPP_OTP_TEMPLATE`;
  - `IDENTITY_WHATSAPP_STAFF_TEMPLATE`;
- nomes de template e `phone_number_id` são validados;
- timeout/reset/2xx sem `wamid` viram `MessagingDeliveryUnknownError`;
- em desfecho incerto o desafio OTP **não é revertido**, porque a Meta pode já tê-lo aceitado; cooldown continua valendo;
- recusa definitiva continua executando a compensação já existente.

Foi feito um smoke local do provider com transporte injetado: corpo + botão recebem o mesmo código, 2xx sem `wamid` vira estado incerto, console é bloqueado em produção e o factory cria o provider Meta quando configurado.

**Observação de produto:** o fallback SMS descrito na SPEC ainda não tem fornecedor contratado/implementação real. Ele foi registrado explicitamente na tabela de lacunas do ROADMAP; o canal principal WhatsApp agora existe de fato.

### R3 — `tenant_platform` protegia taxas/bloqueio, mas não `plan_id` e `blocked_reason` — MÉDIO/ALTO / defesa em profundidade

A política da tabela é ampla por desenho e o gatilho `tenant_platform_termo_comercial()` é a barreira de coluna. A versão anterior recusava mudanças tenant-side de taxas e `blocked_at`, mas não de:

- `plan_id`;
- `blocked_reason`.

O fluxo legítimo de troca de plano já usa `semTenant` depois de rateio, idempotência e validações, portanto não há motivo para permitir alteração direta dessas colunas em contexto de barbearia.

**Correção:** nova migração:

`packages/db/migrations/0116_recheck_final_hardening.sql`

Ela redefine o gatilho para proteger também `plan_id` e `blocked_reason`. Foi criado:

`packages/db/test/0116_recheck_final_hardening.test.sql`

para provar em PostgreSQL real que a plataforma mantém esses termos e o tenant não os reescreve diretamente.

## Guardas permanentes

Adicionados:

- `scripts/verificar-recheck-final.mjs`;
- `scripts/verificar-recheck-final.test.mjs`;
- ambos no `scripts/verify.sh`.

A guarda específica foi submetida a **11 mutações regressivas; 11/11 foram detectadas**, incluindo:

- remoção do teto duro do cache;
- retirada do limitador do cache de slug;
- retorno do `ConsoleMessagingProvider` direto ao AppModule;
- console permitido em produção;
- remoção do provider Meta de identidade;
- template OTP desligado do ambiente;
- desfecho incerto voltando a invalidar OTP;
- preflight permitindo console;
- `plan_id` fora do gatilho;
- `blocked_reason` fora do gatilho;
- recheck removido do `verify.sh`.

A guarda Final Cross-Domain foi atualizada para reconhecer o novo head `0116` sem apagar a exigência das migrações `0110–0115`.

## Validação executável final

Após todas as correções do recheck:

- guardas diretas aplicáveis: **47/47 PASS**;
- testes Node autônomos sem Vitest: **27/27 arquivos PASS**;
- asserções Node agregadas: **227/227 PASS**;
- mutações negativas do Recheck Final: **11/11 PASS**;
- parse/transpile sintático TS/TSX: **780/780 PASS**;
- smoke local do provider Meta de identidade: **PASS**;
- shell `bash -n`: **30/30 PASS**;
- YAML: **7/7 PASS**;
- migrações numeradas: **116**, de `0001` a `0116`, **zero versões duplicadas**;
- `verificar-lacunas.mjs`: **41 lacunas declaradas, todas com destino válido**;
- `verificar-prontidao.mjs`: **8 funcionalidades, matriz/evidências coerentes**;
- `verificar-r8-comercial.mjs`: **PASS**.

## Limitações que continuam externas a este runtime

Este ambiente ainda não possui o conjunto necessário para certificar end-to-end:

- PostgreSQL/`psql`/`pg_isready`;
- Docker/Podman;
- `pnpm` e `node_modules` do workspace;
- credenciais WABA central reais e templates `AUTHENTICATION` aprovados;
- conta/credenciais reais dos demais providers de go-live.

Consequentemente ainda precisam ser executados fora desta sessão:

1. aplicar as **116 migrações** em PostgreSQL 16 limpo;
2. rodar `packages/db/test/0116_recheck_final_hardening.test.sql` e as demais provas SQL;
3. executar `pnpm -r typecheck`, suíte Vitest, build e E2E completos;
4. fazer smoke real do OTP com a WABA central e os dois templates aprovados;
5. fazer os smokes externos já declarados para PSP/Stripe, fiscal, split, Meta CRM etc., conforme a prontidão de cada provider.

## Classificação final

**Código/arquitetura após o recheck:** fechado no escopo auditado.  
**Guardas disponíveis neste runtime:** verdes.  
**Bloqueador conhecido de código:** nenhum após as três correções.  
**Certificação de produção:** ainda depende dos portões externos acima.

Este pacote **substitui** o ZIP da Auditoria Final Cumulativa como base canônica.
