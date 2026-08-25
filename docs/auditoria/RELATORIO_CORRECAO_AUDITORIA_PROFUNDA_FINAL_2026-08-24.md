# Barberdock — correção da auditoria profunda e validação final

**Data:** 24/08/2026  
**Base de entrada:** `barberdock-ofensivo-final-verificado-2026-08-23`  
**Objetivo:** corrigir os achados adicionais encontrados nas continuações da auditoria ofensiva/profunda e consolidar uma nova baseline estática/contratual.

## 1. Veredito

Os achados confirmados nas continuações da auditoria foram corrigidos na árvore consolidada e receberam endurecimentos de regressão onde o ambiente permitiu. A versão resultante está apta a substituir a baseline anterior **no escopo estático/contratual/ofensivo**.

Ela **não deve ser chamada de full-stack aprovada**. O ambiente desta auditoria continua sem `pnpm`, Vitest instalado no workspace e PostgreSQL/`pg_isready`; por isso build real, typecheck oficial do workspace, migrations executadas em PostgreSQL, concorrência real de banco e E2E completo permanecem provas externas obrigatórias antes de produção.

## 2. Correções de autorização multiunidade

Foram fechadas as classes de defeito em que RLS por tenant era insuficiente para impedir operações entre filiais do mesmo tenant:

- recados: assumir, devolver, responder e encerrar passam a carregar/validar `locationId`;
- sinal de agendamento: consulta, registro e devolução passam a operar sob a unidade da sessão;
- avaliações: leitura e mutações administrativas passam a respeitar o recorte de unidade;
- Split/KYC: recebedores, repasses, venda e cadastro de recebedor passam a receber e validar `locationId`;
- profissional de outra filial não pode ser usado para iniciar/retomar KYC;
- testes de regressão foram adicionados para UUID cross-unit nos fluxos críticos.

## 3. Idempotência financeira e concorrência

As operações em que uma repetição pode mover dinheiro ou alterar saldo passaram a tratar a chave como identidade de uma intenção, e não apenas como string opcional:

- sangria/suprimento de caixa;
- transferências entre contas;
- vales/adiantamentos de profissional;
- recebimento de fiado;
- ajuste manual de fidelidade;
- troca self-service de plano;
- estornos financeiros afetados pela auditoria;
- KYC/recebedor.

O domínio passa a rejeitar chave ausente onde a operação exige idempotência e, nos fluxos endurecidos, associa a chave a um fingerprint do payload. Reutilizar a mesma chave com valor, destino, motivo, plano ou dados diferentes resulta em conflito em vez de falso sucesso.

Também foram adicionadas serializações/locks onde o simples índice único não fechava a corrida. Em fidelidade, por exemplo, o saldo é linearizado antes do ajuste para impedir duas retiradas simultâneas de consumirem o mesmo saldo observado.

## 4. Agenda, fila e lista de espera

- o retry concorrente de criação de agendamento após `23505` deixa de tentar consultar dentro de uma transação PostgreSQL já abortada;
- fila e lista de espera passam a incluir unidade na identidade idempotente;
- os fingerprints incluem a composição relevante do pedido;
- a mesma chave em duas unidades deixa de devolver a entrada da filial errada;
- a lista de espera deixa de considerar pedidos diferentes como equivalentes apenas por cliente/janela.

A migration `0108_auditoria_profunda.sql` atualiza os índices correspondentes e faz backfill de fingerprint para dados existentes.

## 5. Jobs e webhooks outbound

Foi implantado fencing explícito:

- `jobs` recebe `claim_token`; apenas a claim atual pode concluir ou falhar uma tarefa;
- liberar tarefa órfã invalida a claim anterior;
- `webhook_deliveries` recebe `claim_token` + `claim_expires_at`;
- a entrega reivindica atomicamente a lease antes da chamada externa;
- somente a claim atual grava o desfecho;
- a varredura ignora uma entrega ainda sob lease válida.

Isso fecha a corrida em que um worker antigo poderia sobrescrever o estado produzido por um worker novo e reduz duplicidade de POST entre réplicas.

## 6. Split/KYC

Além do recorte de unidade:

- a `Idempotency-Key` exigida pela API agora é realmente transportada até `cadastrarRecebedor()` e até o provider;
- o novo fingerprint KYC usa HMAC e não persiste os dados bancários em claro como fingerprint;
- `KYC_INTENT_HMAC_SECRET` é obrigatória em produção;
- `.env.example`, Docker Compose, scripts Linux/Windows/local e gerador de segredos foram atualizados;
- a ausência da chave em produção é tratada como configuração inválida/indisponibilidade, não como erro de entrada do usuário;
- o histórico de Split busca uma linha adicional para sinalizar truncamento e a UI informa quando o período possui mais registros do que a janela retornada.

**Limitação de produto mantida:** o projeto ainda possui `FakeSplitProvider` como implementação de Split; esta auditoria não transforma esse módulo em integração PSP real.

## 7. RBAC e franquia

- `franchise.manage` foi removida do conjunto padrão do owner;
- a permissão permanece entitlement concedido somente a uma franqueadora real;
- a migration faz backfill das permissões atuais do **owner** para tenants antigos;
- não há backfill cego de `manager`, `receptionist` ou `professional`, preservando customizações deliberadas do cliente;
- owners que receberam `franchise.manage` indevidamente perdem a permissão, exceto tenants efetivamente registrados como franqueadora;
- retry de criação/configuração de franquia passa a reparar a permissão esperada.

## 8. Troca de plano

Foi criada `subscription_change_intents`, protegida por RLS e append-only para o role da aplicação. A intenção persiste o resultado tanto de upgrade quanto de downgrade, de forma que uma repetição legítima devolve o mesmo resultado e uma chave reutilizada com outro plano produz conflito.

Isso cobre o caso que uma idempotência baseada apenas em `invoice` não cobria: downgrade pode gerar crédito sem gerar fatura.

## 9. Migration nova

Arquivo: `packages/db/migrations/0108_auditoria_profunda.sql`.

Ela inclui:

- fingerprints de idempotência financeira;
- idempotência de fidelidade;
- fingerprints e índices por unidade de fila/lista de espera;
- fingerprint KYC;
- fencing de jobs;
- lease/fencing de webhooks outbound;
- reconciliação de permissões do owner;
- correção de `franchise.manage`;
- `subscription_change_intents` com RLS e privilégios append-only.

A migration foi revisada estaticamente contra os nomes de tabelas e índices das migrations anteriores. **Ela não foi executada contra PostgreSQL real neste ambiente.**

## 10. Validação executada na árvore final

### Guardas do projeto

- `verificar-*.mjs` executáveis, excluindo arquivos `.test.mjs`: **23 OK / 0 falhas**;
- o guarda ofensivo agora verifica a ligação real do KYC entre controller, domínio e provider, em vez de apenas procurar palavras-chave soltas.

### Scripts de teste independentes

- `.test.mjs` que rodam sem Vitest: **5 OK / 0 falhas**;
- `.test.mjs` que importam Vitest: **23 indisponíveis** por ausência da dependência;
- nenhuma falha funcional foi contabilizada entre os scripts que puderam executar.

### Sintaxe e estrutura

- TS/TSX: **742 arquivos / 0 erros de parse**;
- JS/MJS/CJS: **71 arquivos / 0 erros de sintaxe**;
- shell: **29 arquivos / 0 erros de sintaxe**;
- JSON: **46 válidos / 0 inválidos**;
- YAML: **6 válidos / 0 inválidos**;
- checagem AST focada em imports internos: **2.062 declarações**, **5.452 imports nomeados/default analisados**, **0 caminhos ausentes**, **0 símbolos ausentes**;
- `git diff --check`: **OK** (somente aviso de normalização LF/CRLF no `.cmd`).

### Segredos de deploy

O gerador `deploy/segredos.sh` foi executado manualmente contra `.env` vazio e novamente contra o mesmo arquivo:

- segredos obrigatórios: **9**;
- ausentes após a primeira execução: **0**;
- segredos curtos: **0**;
- segredos alterados indevidamente na segunda execução: **0**;
- `KYC_INTENT_HMAC_SECRET`: **64 caracteres hexadecimais**.

### `scripts/verify.sh`

Executado sobre esta árvore final.

Resultado:

- os portões estáticos anteriores ao build ficaram verdes;
- PostgreSQL não pôde ser iniciado porque `pg_isready` não existe no ambiente;
- a etapa `build dos pacotes` parou em `pnpm: command not found`;
- o script encerrou com código 1 e, corretamente, não executou as suítes seguintes como se o build tivesse passado.

## 11. O que continua sem prova neste ambiente

Antes de promoção para produção ainda é necessário executar, em ambiente com dependências e PostgreSQL reais:

1. `pnpm install --frozen-lockfile`;
2. typecheck oficial de todos os workspaces;
3. build dos pacotes e `next build`;
4. Vitest completo;
5. migrations do zero e upgrade incremental até `0108` em PostgreSQL real;
6. testes RLS com dois tenants e duas unidades reais;
7. concorrência com duas conexões PostgreSQL para locks, índices e fencing;
8. E2E Browser → Next → API → PostgreSQL → Worker → providers;
9. validação dos providers reais configurados para o ambiente de produção.

## 12. Decisão de release

**Aprovado:** nova baseline estática/contratual/ofensiva corrigida.  
**Não aprovado:** selo de produção/full-stack enquanto as provas da seção 11 não forem executadas.

Essa distinção é intencional: os defeitos encontrados nesta continuação mostraram que uma árvore com parse/imports/guardas verdes ainda pode esconder problemas de autorização por unidade, concorrência e ligação semântica entre camadas.
