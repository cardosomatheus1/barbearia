# Barberdock — melhoria de notas — Bloco 6: honestidade do E2E financeiro

**Data:** 24/08/2026  
**Base:** versão cumulativa após modularizações, Super Copy e imagem editorial da landing.

## Achado

O percurso `balcão fecha uma venda` em `scripts/percorrer.mjs` tinha um falso positivo importante.

Antes ele:

1. contava `orders` com status `paid`;
2. fazia login;
3. abria `/admin/comanda`;
4. contava novamente;
5. só falhava se a quantidade tivesse diminuído.

Portanto `depois === antes` era aceito como sucesso mesmo sem abrir caixa, criar comanda, adicionar item, receber pagamento ou fechar caixa.

## Correção

O percurso agora executa a cadeia financeira pela interface:

1. entra como dono pela tela de login;
2. abre `/admin/caixa`;
3. se necessário, abre o caixa pela interface com R$ 200,00;
4. abre uma **comanda avulsa** pela tela;
5. confirma no banco que a comanda nasceu `open`;
6. abre `Acrescentar item` e adiciona um item livre de **R$ 37,90**;
7. confirma o item e o total persistidos;
8. recebe **R$ 50,00 em dinheiro**;
9. exige na interface o estado `Pago com` e o troco de **R$ 12,10**;
10. confirma no banco:
   - `orders.status = paid`;
   - total = 3.790 centavos;
   - troco = 1.210 centavos;
   - sessão de caixa vinculada;
   - um pagamento `cash` de 5.000 centavos;
   - um movimento `sale` líquido de 3.790 centavos;
11. volta ao caixa e lê da própria interface o valor esperado na gaveta;
12. fecha o caixa pela tela com esse valor;
13. exige `cash_sessions.status = closed` e `difference_cents = 0`;
14. exige que a interface confirme que a gaveta bateu.

## Correção do arnês

`Acrescentar item` redireciona corretamente para a mesma URL da comanda. O helper genérico esperava mudança de URL e, portanto, acusaria falha mesmo com o produto funcionando.

Nesse passo o percurso agora espera `.item-comanda` aparecer, que é o sinal correto da operação.

## Guarda permanente

Foi criado `scripts/verificar-percurso-venda-e2e.mjs`.

Ele impede que o percurso volte a ter nome maior que a prova e cobra estruturalmente:

- caixa;
- comanda avulsa;
- item;
- R$ 37,90;
- pagamento em dinheiro de R$ 50,00;
- troco de R$ 12,10;
- `order_items`;
- `order_payments`;
- `cash_movements`;
- fechamento da sessão com divergência zero;
- ausência da comparação fraca antiga.

A guarda foi incorporada ao `scripts/verify.sh`.

## Teste da própria guarda

Foi criado `scripts/verificar-percurso-venda-e2e.test.mjs`, sem dependência de Vitest.

Quatro mutações negativas foram aplicadas e todas foram recusadas:

1. remoção da prova de total/troco/sessão;
2. remoção da conferência de movimento de caixa;
3. remoção do fechamento do caixa;
4. reintrodução da comparação fraca `depois < antes`.

**Resultado: 4/4.**

## Achado secundário — R8

A bateria ampla encontrou um meta-teste R8 desatualizado pela nova copy da landing. O guard principal estava correto, mas o teste negativo tentava remover a frase antiga `Avisos no WhatsApp...`, que já havia virado `Lembretes no WhatsApp...`.

O teste foi atualizado para:

- mutar a frase atual;
- falhar explicitamente se a fixture deixar de existir;
- sempre limpar o diretório temporário.

**R8 testes negativos: 4/4.**

## Validação disponível neste runtime

- `node --check scripts/percorrer.mjs` ✅
- `node scripts/verificar-percurso-venda-e2e.mjs` ✅
- `node scripts/verificar-percurso-venda-e2e.test.mjs` → **4/4** ✅
- `node scripts/verificar-r8-comercial.test.mjs` → **4/4** ✅
- `bash -n scripts/verify.sh` ✅
- verificadores `verificar-*.mjs` executáveis sem dependência indisponível: **34/34** ✅
- `verificar-r11-modulos.test.mjs`: não executado porque importa `vitest`, ausente neste runtime.

## Limitação que permanece

O percurso financeiro completo **não foi executado em navegador + PostgreSQL nesta rodada**, porque este runtime continua sem PostgreSQL/`psql` e sem o ambiente completo do `scripts/medicao.sh`.

Assim, a mudança aumenta a qualidade e a honestidade da suíte, mas não deve ser registrada como E2E runtime aprovado até o próximo ambiente executar `scripts/medicao.sh`/`scripts/verify.sh` com PostgreSQL 16.
