# Barberdock — melhoria de notas — Bloco 3

**Data:** 24/08/2026  
**Foco:** manutenibilidade e hardening testável do canal WhatsApp (`packages/crm/src/whatsapp.ts`).

## Objetivo

Eliminar o hotspot de 1.490 linhas sem alterar a API pública e reforçar uma superfície externa sensível — a assinatura do webhook da Meta — no que pode ser provado sem credenciais ou banco reais.

## Refatoração

O antigo `packages/crm/src/whatsapp.ts` tinha **1.490 linhas** e misturava cadastro/credencial, templates, envio, inbound, execução de respostas, assinatura criptográfica e resolução pública de tenant.

Agora ele é uma fachada de **50 linhas** e as responsabilidades foram distribuídas em módulos coesos:

- `whatsapp-erros.ts` — 49 linhas: contrato de falhas e erro estável;
- `whatsapp-cadastro.ts` — 406 linhas: cadastro, token cifrado, conciliação e leitura segura;
- `whatsapp-templates.ts` — 361 linhas: catálogo/submissão/resposta de templates e botões;
- `whatsapp-mensagens.ts` — 604 linhas: envio, status, inbound, idempotência e execução da resposta;
- `whatsapp-assinatura.ts` — 77 linhas: HMAC-SHA256 e validação `X-Hub-Signature-256`;
- `whatsapp-roteamento.ts` — 26 linhas: resolução pública `phone_number_id -> tenant/location`.

O maior módulo resultante ficou com **604 linhas**. A refatoração não reduz artificialmente a quantidade total de lógica; reduz acoplamento e tamanho cognitivo por responsabilidade.

## Compatibilidade pública

A API pública de `whatsapp.ts` foi comparada por AST antes/depois:

- exports antes: **29**;
- exports depois: **29**;
- removidos: **0**;
- adicionados acidentalmente: **0**.

A fachada continua sendo o contrato usado por API, worker, `whatsapp-meta.ts`, `whatsapp-signup.ts` e testes existentes.

## Hardening adicional

A assinatura do webhook da Meta foi isolada em módulo puro e ganhou `whatsapp-assinatura.test.ts`, com cobertura para:

1. vetor HMAC-SHA256 conhecido;
2. assinatura válida;
3. segredo ausente;
4. cabeçalho ausente;
5. algoritmo/formato inválido;
6. valor não hexadecimal;
7. assinatura incorreta/curta sem vazar exceção de `timingSafeEqual`;
8. alteração de um byte do corpo invalidando assinatura válida.

Neste runtime, a lógica do módulo real também foi transpilada e executada diretamente: **7/7 cenários funcionais passaram**.

## Guardas permanentes

Foi criado `scripts/verificar-crm-whatsapp-modulos.mjs` e incluído em `scripts/verify.sh`.

A guarda exige:

- limites de crescimento por módulo;
- fachada pequena;
- ausência de dependência circular com `whatsapp.ts`;
- chave dedicada `WHATSAPP_TOKEN_KEY`;
- leitura do cadastro expondo apenas `temToken`, não a credencial;
- falha alta para token inválido;
- limites de botões da Meta;
- destino de link derivado da própria barbearia;
- fallback quando o canal não está disponível;
- idempotência por `wamid`;
- prova do cliente pelo telefone antes de associar agendamento inbound;
- opt-out sem exigir agendamento;
- prefixo `sha256=` e hexadecimal na assinatura;
- comparação com `timingSafeEqual`;
- `semTenant` restrito ao roteamento que devolve somente ids.

O guard ofensivo existente também foi atualizado para seguir verificando a regra de progressão de status em `whatsapp-mensagens.ts`, sem depender da antiga localização física em `whatsapp.ts`.

## Validação executada neste runtime

- API pública: **29/29 exports preservados**;
- grafo dos módulos WhatsApp: **9 módulos, sem ciclos**;
- checagem semântica isolada dos novos módulos: **OK**;
- transpilação sintática de todo `packages/crm/src`: **48/48 arquivos TS**;
- assinatura do webhook executada sobre o código real transpilado: **7/7 cenários**;
- verificadores `verificar-*.mjs` executáveis sem dependências externas: **26/26**;
- auditoria ofensiva: **OK**;
- auditoria profunda: **OK**;
- invariantes de auditoria: **OK**;
- guardas de prontidão/R5/R6/R8/R9/R10/R11/R12/V0–V11 aplicáveis: **OK**;
- `scripts/verify.sh`: sintaxe Bash **OK**.

## Limitações do ambiente

O portão completo ainda não pôde ser repetido após esta refatoração porque este runtime não possui `pnpm`/`node_modules` do projeto nem PostgreSQL. Portanto permanecem para um ambiente completo:

1. `pnpm --filter @barbearia/crm typecheck`;
2. build do pacote CRM;
3. Vitest, incluindo o novo `whatsapp-assinatura.test.ts` e os testes Meta/Signup;
4. integração CRM com PostgreSQL 16;
5. `scripts/verify.sh` integral;
6. smoke da integração Meta real.

Essas limitações não são classificadas como aprovação nem reprovação.

## Efeito esperado na avaliação

Este bloco sustenta melhora adicional principalmente em **manutenibilidade** e, em menor grau, em **segurança defensiva/testabilidade da integração**. O antigo hotspot de 1.490 linhas deixa de existir como unidade cognitiva, mantendo a API estável e adicionando proteção permanente contra regressão arquitetural.
