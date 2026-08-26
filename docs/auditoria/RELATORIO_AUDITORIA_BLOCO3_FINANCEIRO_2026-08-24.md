# Barberdock — Auditoria por Blocos — Bloco 3: Financeiro operacional

**Data:** 24/08/2026  
**Base:** `barberdock-auditoria-bloco2-scheduling-2026-08-24.zip`  
**Escopo:** comanda, caixa, pagamentos, fiado, pacotes, assinatura e estornos.

## Veredito

A auditoria encontrou **16 classes de falha** de concorrência, consistência econômica e integração entre camadas. Não eram apenas problemas de organização: algumas podiam produzir total congelado incorreto, crédito artificial, devolução externa duplicada ou benefício de pacote sem a contrapartida financeira correta.

As correções ficaram verdes nos portões executáveis deste runtime. Os cenários novos que dependem de PostgreSQL/Vitest estão implementados, mas **não são apresentados como aprovados em runtime** porque este ambiente continua sem PostgreSQL e sem a instalação das dependências do workspace.

## Achados corrigidos

### 1. Mutações concorrentes da comanda podiam congelar total incorreto — ALTO

Adicionar/remover item e alterar desconto/gorjeta não compartilhavam a trava da própria `orders`. Duas transações podiam gravar linhas válidas e cada uma recalcular o total sem enxergar a outra.

**Correção:** toda mutação monetária da comanda serializa pela linha da venda antes de recalcular.

### 2. Fechamento idempotente não validava a intenção — ALTO

A mesma `Idempotency-Key` podia reaparecer com pagamentos/benefícios diferentes e receber o resultado anterior.

**Correção:** `orders.close_idempotency_fingerprint` (migração 0111), fingerprint da intenção e advisory lock da chave.

### 3. Abertura concorrente de caixa dependia da constraint — MÉDIO

Duas aberturas simultâneas podiam decidir que não havia caixa aberto e uma terminar em erro bruto do banco.

**Correção:** advisory lock por tenant + unidade + abertura de caixa.

### 4. Estado `refunded` existia no banco, mas não no contrato `Comanda` — MÉDIO

**Correção:** o contrato TypeScript passou a representar o estado real persistido.

### 5. Fiado parcialmente recebido podia virar crédito artificial no estorno — CRÍTICO

Exemplo: R$100 fiado, R$60 já recebidos. Somar novamente os R$100 originais no estorno podia produzir R$60 de crédito sem existir informação segura para devolver o recebimento pelo meio correto.

**Correção:** reconstrução FIFO do razão sob trava do cliente; qualquer recebimento posterior daquela dívida bloqueia o estorno automático (`fiado_ja_recebido`).

### 6. Estorno em dinheiro podia existir sem saída física correspondente — ALTO

**Correção:** exige caixa aberto, sessão travada e saldo físico suficiente antes de registrar a devolução.

### 7. Duas requisições podiam chamar o adquirente para o mesmo estorno — CRÍTICO

**Correção:** `order_charges.refund_pending_at` (migração 0111), lease persistente de 15 minutos e `estorno_em_curso` para a concorrente.

### 8. Falha ambígua de rede podia reabrir imediatamente o estorno — ALTO

Um timeout não prova que o PSP não devolveu o dinheiro.

**Correção:** falha ambígua não limpa o lease; o contrato do provider exige idempotência para `pagamentoId + valorCents`, e as implementações Stripe/Fake usam chave determinística.

### 9. Estornar venda que criou pacote deixava o pacote utilizável — CRÍTICO

O dinheiro podia voltar enquanto `customer_package` continuava ativo.

**Correção:** pacotes criados pela venda são validados e invalidados na mesma transação do estorno. Uso/reembolso separado bloqueia o estorno integral.

### 10. Corrida pacote × estorno pendente — CRÍTICO

Uso, transferência ou reembolso podiam decidir com snapshot antigo enquanto esperavam a trava.

**Correção:** protocolo `FOR UPDATE → releitura em snapshot novo → decisão`, incluindo `refund_pending_at`.

### 11. Item `Pacote × N` cobrava N e entregava 1 — ALTO

**Correção:** o fechamento cria exatamente `order_items.quantity` compras do pacote.

### 12. Desconto geral em venda de pacote podia criar base de reembolso maior que a entrada — ALTO

**Correção:** pacote não aceita desconto geral da comanda; promoção deve alterar o preço do próprio catálogo.

### 13. Pagamento por assinatura existia no domínio, mas não atravessava a borda — MÉDIO/FUNCIONAL

**Correção:** `servicoDaAssinatura` agora percorre schema → controller → cliente Web → Server Action → formulário → domínio.

### 14. Comanda de cortesia R$0 ficava presa em `open` — MÉDIO/FUNCIONAL

**Correção:** a borda aceita pagamentos vazios; somente o domínio decide se total zero pode concluir. Total positivo continua recusado por falta de pagamento.

### 15. Venda de pacote podia ser estornada depois de o benefício ter sido transferido — ALTO

Era possível o comprador original receber o dinheiro de volta enquanto o pacote já pertencia a outra pessoa; o destinatário então perderia o benefício por uma operação financeira que não fez.

**Correção:** qualquer registro em `package_transfers` para pacote criado pela venda bloqueia o estorno integral com `pacote_vendido_ja_transferido`. A transferência já consolidou mudança de propriedade e exige tratamento separado.

### 16. Catálogo do pacote podia mudar entre “Adicionar” e “Receber” — CRÍTICO/ECONÔMICO

O preço já era congelado no `order_item`, mas o fechamento relia **serviço, quantidade, validade e transferibilidade** do catálogo corrente. Assim, a recepção podia adicionar um pacote de 5 cortes/R$250 e, após uma edição do catálogo, receber R$250 mas entregar 8 unidades, outro serviço ou outra regra de validade/transferência.

**Correção:** migração 0112 congela no item da comanda:

- `package_snapshot_service_id`;
- `package_snapshot_quantity`;
- `package_snapshot_validity_days`;
- `package_snapshot_transferable`.

O preço continua sendo `unit_price_cents`, já congelado. O fechamento **não relê mais o catálogo** para construir `customer_packages`. O FK de `order_items.package_id` também passou de `ON DELETE SET NULL` para `ON DELETE RESTRICT`: pacote vendido deve ser desativado, não apagado por baixo da evidência da venda.

Foi adicionado teste PostgreSQL que altera serviço, quantidade, preço, validade, transferibilidade e desativa o catálogo **depois** de o item entrar na comanda; o fechamento deve entregar os termos originalmente aceitos.

## Arquitetura

As correções não foram usadas como justificativa para deixar o hotspot crescer.

- `comanda.ts`: **1.499 linhas**;
- `comanda-pacote.ts`: **71 linhas**;
- `comanda-fechamento.ts`: **54 linhas**;
- `comanda-leitura.ts`: 324 linhas de conteúdo / 325 pela métrica da guarda;
- `comanda-fiado.ts`: 307 / 308;
- `comanda-tipos.ts`: 80 / 81.

O snapshot/leitura de pacote foi extraído para `comanda-pacote.ts`; a guarda modular continua limitando `comanda.ts` a 1.500 linhas e proíbe dependência circular.

## Migrações novas

### 0111 — concorrência do fechamento/estorno

- `orders.close_idempotency_fingerprint`;
- `order_charges.refund_pending_at`;
- índice parcial de refund pendente.

Prova SQL: `packages/db/test/0111_finance_estorno_concorrencia.test.sql`.

### 0112 — pacote congelado na comanda

- snapshot estrutural dos termos mutáveis do pacote em `order_items`;
- constraints de quantidade/validade/coerência;
- backfill das comandas existentes na migração;
- `package_id` passa a `ON DELETE RESTRICT`.

Prova SQL: `packages/db/test/0112_pacote_congelado_na_comanda.test.sql`.

O repositório passa a ter **112 migrações**.

## Testes de integração PostgreSQL adicionados

Os testes cobrem, entre outros:

- fiado parcialmente recebido bloqueando estorno;
- concorrência de dois estornos online;
- invalidação de pacote vendido pela venda estornada;
- pacote já usado impedindo estorno integral;
- pacote já transferido impedindo estorno da venda de origem;
- catálogo de pacote alterado após inclusão na comanda sem alterar o benefício entregue.

Esses cenários estão escritos, mas aguardam PostgreSQL real.

## Guardas permanentes

`scripts/verificar-auditoria-financeiro.mjs` faz parte do `verify.sh` e cobra concorrência, idempotência, caixa, fiado, estorno, pacote, assinatura, cortesia e snapshot do catálogo.

A guarda foi submetida a **17 mutações negativas**, todas detectadas.

## Validação executável final

- guardas diretos aplicáveis: **42/42 PASS**;
- `verificar-configuracao-producao.mjs`: não aplicável sem o conjunto de secrets/env de produção;
- testes Node autônomos sem Vitest: **22/22 arquivos PASS**;
- asserções Node agregadas: **123/123 PASS**;
- auditoria financeira negativa: **17/17 mutações detectadas**;
- parse sintático TS/TSX global: **776/776**;
- shell: **30 arquivos OK**;
- `verify.sh`: sintaxe OK;
- YAML operacional/CI: **5/5 OK**.

## Limitação honesta

O runtime desta conversa não fornece PostgreSQL/`psql` e o workspace não possui as dependências instaladas para executar Vitest. Portanto:

- as migrações 0111/0112 estão implementadas, mas não aplicadas aqui em PostgreSQL real;
- os testes concorrentes/financeiros que usam banco estão escritos, mas não foram executados nesta rodada;
- o bloco está fechado em código/guardas executáveis, **não certificado end-to-end contra o banco real**.

## Próximo portão externo deste bloco

1. PostgreSQL 16 com as 112 migrações;
2. `packages/db/test/0111_finance_estorno_concorrencia.test.sql`;
3. `packages/db/test/0112_pacote_congelado_na_comanda.test.sql`;
4. suíte Finance/Vitest completa;
5. `scripts/verify.sh` integral sem skips de banco.
