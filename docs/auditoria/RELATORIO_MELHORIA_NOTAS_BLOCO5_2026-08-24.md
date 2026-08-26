# Barberdock — melhoria de notas — Bloco 5

**Data:** 24/08/2026  
**Foco:** manutenibilidade, honestidade de integração e hardening fiscal (`packages/finance/src/fiscal.ts`).

## Objetivo

Eliminar o hotspot fiscal de 1.266 linhas sem alterar a API pública e tornar explícitas as fronteiras entre configuração, criação da nota, ciclo de emissão/conciliação/cancelamento, entrega ao cliente e seleção do emissor.

O bloco também fecha um risco de configuração: o `FakeFiscalProvider` continua disponível para teste/desenvolvimento, mas passa a falhar alto se for selecionado em `NODE_ENV=production`.

## Refatoração

O antigo `packages/finance/src/fiscal.ts` tinha **1.266 linhas** e concentrava praticamente todo o domínio fiscal.

Agora `fiscal.ts` é uma fachada de **17 linhas** e as responsabilidades ficaram distribuídas em:

- `fiscal-emissor.ts` — **38 linhas**: catálogo de modos, leitura de ambiente, seleção do provider e trava de fake em produção;
- `fiscal-erros.ts` — **56 linhas**: erros e mensagens do repositório fiscal;
- `fiscal-configuracao.ts` — **133 linhas**: leitura/gravação da configuração, validação e auditoria;
- `fiscal-notas.ts` — **352 linhas**: projeções para tela, consultas e criação/enfileiramento da nota;
- `fiscal-emissao.ts` — **371 linhas**: emissão, consulta ao provider, gravação de resposta, conciliação e cancelamento;
- `fiscal-entrega.ts` — **255 linhas**: documento do tomador, fila de entrega e carimbo de notificação.

O maior módulo resultante ficou com **371 linhas**.

## Compatibilidade pública

A API pública de `fiscal.ts` foi comparada pelo TypeScript antes/depois:

- exports antes: **26**;
- exports depois: **26**;
- removidos: **0**;
- adicionados acidentalmente: **0**.

A fachada continua sendo o contrato externo do pacote Finance.

## Hardening do emissor

Antes deste bloco, `FISCAL_MODO=fake` era um valor válido independentemente do ambiente. Isso criava um risco operacional: uma instalação de produção poderia iniciar usando o emissor de mentira e aparentar ter integração fiscal ativa sem enviar nada a uma prefeitura.

Agora:

- `FISCAL_MODO` continua aceitando somente `nenhum` e `fake`;
- o padrão continua sendo `nenhum`;
- valores desconhecidos continuam falhando alto;
- `fake` continua disponível em teste/desenvolvimento;
- `fake` em `NODE_ENV=production` lança erro;
- a trava também se aplica quando alguém chama `emissorFiscal('fake')` diretamente, impedindo bypass da validação de ambiente.

Isso **não** transforma Fiscal em uma integração de produção. Na matriz de prontidão, as colunas de integração, E2E e produção permanecem em ❌ até existir um provider real e prova correspondente.

## Guarda permanente

Foi criado `scripts/verificar-finance-fiscal-modulos.mjs` e integrado ao `scripts/verify.sh`.

A guarda exige:

- fachada pequena e limites de crescimento por responsabilidade;
- ausência de dependência circular via `fiscal.ts`;
- grafo interno dos módulos fiscais acíclico;
- ambiente/provider restritos a `fiscal-emissor.ts`;
- catálogo de modos limitado a `nenhum`/`fake`;
- fake proibido em produção;
- validação central da configuração;
- prova da unidade sob RLS antes de salvar configuração;
- auditoria de alteração fiscal;
- emissão automática silenciosa quando não há emissor, sem bloquear fechamento da venda;
- pedido manual falhando explicitamente quando a integração está indisponível;
- estados que ocupam a venda vindo do catálogo central;
- criação da tarefa `fiscal.emitir` na mesma transação e com chave idempotente;
- comissão positiva congelada na base da nota;
- `FOR UPDATE` e estados não terminais preservados no ciclo de emissão;
- distinção entre `processando` com e sem `provider_invoice_id`;
- estado `cancelando` antes da chamada externa;
- erro ambíguo de cancelamento sem reabrir a nota prematuramente;
- validação do documento do tomador;
- auditoria sem persistir CPF/CNPJ em claro;
- entrega somente de notas autorizadas/não notificadas;
- carimbo condicional impedindo dupla entrega.

A auditoria ofensiva também foi atualizada para verificar os invariantes no novo módulo `fiscal-emissao.ts`, sem relaxar os critérios.

## Matriz de prontidão

A evidência do `ROADMAP.md` para Fiscal foi movida do antigo `fiscal.ts` para `fiscal-emissor.ts`.

A classificação permaneceu a mesma:

- Motor: ✅
- Tela: ✅
- Integração real: ❌
- E2E real: ❌
- Produção: ❌

Após a mudança, `scripts/verificar-prontidao.mjs` voltou a validar **8/8 funcionalidades** e suas evidências.

## Validação executada neste runtime

- API pública fiscal: **26/26 exports preservados**;
- TypeScript semântico isolado dos módulos fiscais: **OK**;
- transpilação sintática de `packages/finance/src`: **62/62 arquivos TS**;
- runtime do seletor de emissor: **10/10 cenários**;
- nova guarda `verificar-finance-fiscal-modulos.mjs`: **OK**;
- verificadores `verificar-*.mjs` executáveis sem Vitest: **32/32**;
- auditoria ofensiva: **OK**;
- auditoria profunda: **OK**;
- invariantes de auditoria: **OK**;
- matriz de prontidão: **OK**;
- R5/R6/R8/R9/R10/R11/R12/V0–V11 aplicáveis: **OK**;
- `scripts/verify.sh`: sintaxe Bash **OK**.

O arquivo `scripts/verificar-r11-modulos.test.mjs` não executou porque depende de `vitest`, ausente neste runtime. Isso é limitação do ambiente, não resultado de falha.

## Limitações do ambiente

O portão integral ainda não pode ser certificado aqui porque o ambiente não possui o toolchain instalado do workspace (`pnpm`/`node_modules`) nem PostgreSQL 16.

Continuam pendentes em ambiente completo:

1. `pnpm --filter @barbearia/finance typecheck`;
2. build real do pacote Finance;
3. Vitest completo do Finance;
4. testes de integração fiscal/Finance contra PostgreSQL 16;
5. `scripts/verify.sh` integral, sem skips de banco.

Essas etapas não são classificadas como aprovadas nem reprovadas neste runtime.

## Efeito esperado na avaliação

Comanda, Booking, WhatsApp, Comissão e Fiscal — os cinco hotspots de domínio inicialmente destacados — agora possuem fronteiras menores e guardas permanentes. Este bloco melhora principalmente **manutenibilidade**, **clareza arquitetural**, **segurança de configuração** e **honestidade da prontidão de integrações**, sem adicionar uma feature fiscal fictícia.
