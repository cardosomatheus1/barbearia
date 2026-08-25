# Barberdock — relatório final da auditoria profunda e correções

**Data:** 23/08/2026  
**Baseline de origem:** `barberdock-merged-final-auditado-2026-08-23.zip`  
**Árvore corrigida:** `barberdock-merged-final`  
**Escopo:** fechamento da auditoria semântica posterior às auditorias de regressão, com foco em integridade financeira, autorização, multiunidade, timezone, resiliência, precisão numérica e invariantes cumulativos.

## 1. Parecer executivo

A última rodada encontrou uma classe de defeitos que não era bem coberta pelas guardas estruturais anteriores: funções individualmente válidas que, quando combinadas, produziam uma leitura econômica incorreta. Os principais exemplos estavam no DRE de pacotes e assinaturas, no reconhecimento de saldo expirado de pacote e no arredondamento de centavos.

Esses defeitos foram corrigidos na árvore final. Também foram endurecidos contratos de autorização (`customers.view_notes`), recorte temporal por unidade, timeout das chamadas internas, compensação de OTP, idempotência futura do clube e conversão segura de agregados monetários.

Durante a passada final apareceu ainda um caso-limite novo: no próprio dia do vencimento de um pacote, o saldo poderia ser reconhecido como receita pela data de vencimento e continuar simultaneamente no passivo antes do horário exato de expiração. O reconhecimento agora exige `expires_at <= agora`, eliminando a sobreposição.

A auditoria estática/contratual final está aprovada. Isso não equivale a aprovação full-stack: continuam pendentes, por indisponibilidade do ambiente, o `pnpm verify` integral, typecheck com dependências, Vitest completo, PostgreSQL/RLS/E2E, `next build` e R12 humano.

## 2. Correções financeiras

### 2.1 DRE de pacotes — dupla contagem eliminada

O DRE não soma mais `package_uses` sobre o valor cheio do item de serviço. O item da comanda continua sendo a fonte econômica do serviço/da comissão, enquanto a utilização do pacote serve para movimentar receita diferida/passivo e não para criar uma segunda receita.

Com isso, um corte de R$ 50 pago por pacote não aparece como R$ 100 de receita, e um serviço de R$ 70 coberto por R$ 50 de pacote + R$ 20 de complemento não aparece como R$ 120.

### 2.2 Clube/assinatura — dupla receita eliminada

Pagamentos de serviço feitos por benefício de assinatura são retirados da linha de receita de serviços. A mensalidade paga é reconhecida em `receitaAssinaturas`, enquanto apenas valores realmente cobrados fora do benefício permanecem como receita adicional de serviço.

### 2.3 Centavos indivisíveis de pacote

`PacoteDoCliente` preserva `precoCents`. O resto da divisão inteira é atribuído à primeira utilização. A mesma matemática é usada no consumo, passivo diferido e reembolso proporcional.

Exemplo de R$ 50,01 / 5: primeira unidade = R$ 10,01; quatro seguintes = R$ 10,00. A soma reconhecida continua exatamente R$ 50,01.

### 2.4 Saldo vencido / breakage

O saldo não utilizado deixa de apenas desaparecer do passivo. A receita de vencimento é derivada de `price_cents - usos reconhecidos`, respeitando reembolso e unidade.

Na passada final foi acrescentada a condição temporal `expires_at <= agora`, para impedir que, antes do horário exato de vencimento no mesmo dia, o mesmo saldo apareça simultaneamente como receita de vencimento e como obrigação ainda ativa.

### 2.5 Multiunidade de pacote

Venda, utilização, passivo diferido, vencimento e card de receita de pacote são recortados pela unidade ativa. O consolidado é calculado explicitamente quando necessário, sem reutilizar silenciosamente um valor do tenant inteiro dentro de uma tela de filial.

### 2.6 Assinaturas históricas sem unidade

Faturas legadas com `location_id IS NULL` entram no consolidado, mas não são atribuídas a todas as unidades individualmente. Isso elimina a duplicação em que a mesma mensalidade podia aparecer na matriz e na filial.

### 2.7 Timezone da assinatura

A competência de mensalidade deixou de ser derivada por UTC. O DRE usa o timezone da unidade, coerente com o princípio de `business_day` do restante do financeiro.

### 2.8 Precisão de agregados monetários

Foram removidos rebaixamentos `SUM(... )::int` para valores monetários relevantes. PostgreSQL mantém agregados em `bigint`, e a borda TypeScript utiliza helpers que exigem `Number.isSafeInteger()` antes da conversão.

O endurecimento foi aplicado também a métricas globais, MRR histórico da plataforma e comissões agregadas do marketplace. Não ficaram ocorrências residuais de `SUM(... )::int` em código de produção de `packages/finance`/`packages/platform`.

## 3. Autorização e privacidade

As rotas de Segmentos, Churn e Insights foram alinhadas ao contrato de que `customers.view` permite localizar/identificar cliente, enquanto informações derivadas de relacionamento exigem `customers.view_notes`.

A UI foi ajustada para não apresentar ou buscar dados agregados protegidos quando o papel não possui a combinação de permissões exigida pela API.

## 4. Resiliência e integrações internas

### 4.1 Timeout Next → API

Foi introduzido `fetch-com-timeout.ts` para chamadas server-side internas, usando `AbortSignal.timeout` e composição com signal externo quando aplicável. Leitura, mutação e upload passam a falhar de forma controlada em vez de depender de timeout implícito da pilha.

Não foi introduzido retry automático de mutações, evitando duplicação de efeitos colaterais.

### 4.2 OTP

A solicitação de OTP agora preserva o estado anterior e, se a entrega externa falhar, executa compensação condicional. Se ainda for o desafio recém-gerado, restaura exatamente o desafio anterior ou remove o novo quando não havia anterior.

Isso impede que falha do provedor invalide um código válido e consuma cooldown/contadores por uma mensagem não entregue. A compensação não sobrescreve um desafio mais novo criado concorrentemente.

### 4.3 Idempotência de cobrança do clube

O contrato de `CobrancaDoClubeProvider` passa a receber uma `idempotencyKey` derivada de tenant, fatura e tentativa. Isso prepara a integração futura com adquirente real para proteger o efeito externo, e não apenas o update otimista posterior no banco.

## 5. Timezone residual

Alertas de demanda passaram a recortar `created_at` pelo `timezone` de cada unidade. Datas importantes da superfície pública de “Meus agendamentos” passaram a formatar explicitamente no timezone da barbearia, evitando dependência do timezone do processo/container.

## 6. Guardas e prevenção de regressão

Foi criado `scripts/verificar-auditoria-profunda.mjs` e integrado ao `scripts/verify.sh`.

Esse portão reprova, entre outros, retorno de:

- perda de centavos no pacote;
- ausência de receita de vencimento;
- reconhecimento de vencimento antes do horário exato;
- dupla contagem de pacote/assinatura no DRE;
- mensalidade recortada por UTC;
- mensalidade legada duplicada entre unidades;
- bypass de `customers.view_notes`;
- fetch interno sem timeout;
- OTP sem compensação;
- alerta diário baseado em UTC;
- datas públicas sem timezone explícito nas superfícies protegidas pelo portão;
- provider de clube sem chave de idempotência;
- conversão insegura de agregados monetários relevantes;
- reintrodução de `SUM(... )::int` monetário nas áreas auditadas.

As guardas cumulativas anteriores permanecem presentes; nenhuma evidência/arquivo da baseline consolidada foi removido.

## 7. Delta em relação à baseline consolidada

Antes de anexar as evidências finais à árvore, a comparação registrou:

- baseline: 1.109 arquivos;
- árvore corrigida: 1.113 arquivos;
- 4 arquivos novos de implementação/guarda;
- 44 arquivos modificados;
- 0 arquivos removidos.

Arquivos novos de implementação/guarda:

- `apps/web/src/lib/fetch-com-timeout.ts`;
- `packages/finance/src/inteiro-seguro.ts`;
- `packages/platform/src/inteiro-seguro.ts`;
- `scripts/verificar-auditoria-profunda.mjs`.

As evidências da auditoria foram adicionadas posteriormente em `docs/auditoria/evidencias/auditoria-profunda-final-2026-08-23/` e, portanto, aumentam a contagem final do pacote sem representar mudança funcional adicional.

## 8. Verificações finais executadas

Na árvore antes do empacotamento:

- TypeScript/TSX: **739 arquivos**, **0 erro de parse**;
- imports internos/aliases: **2.423 declarações**, **0 caminho quebrado**;
- imports nomeados/default: **7.257**, **0 símbolo local ausente**;
- propriedades diretas duplicadas em interfaces/types/classes/object literals: **0**;
- guardas `verificar-*.mjs`: **26 aprovadas, 0 falhas, 1 indisponível**;
- única indisponível: `verificar-r11-modulos.test.mjs`, que importa Vitest e não pode rodar sem `node_modules`;
- testes Node independentes de Vitest: **17/17 aprovados**;
- scripts `.mjs`: **69/69 sintaticamente válidos**;
- scripts `.sh`: **29/29 válidos por `bash -n`**;
- JSON: **46/46 válidos**;
- YAML/YML: **6/6 válidos**;
- busca residual de `SUM(... )::int` monetário em finance/platform de produção: **0**;
- busca residual de conversão direta do MRR agregado nos pontos auditados: **0**.

As evidências textuais correspondentes estão dentro do pacote.

## 9. Limites que permanecem honestamente abertos

Este ambiente possui Node, mas não tem o workspace instalado e não consegue obter as dependências externas. Portanto não foi possível promover como “aprovado”:

- `pnpm install --frozen-lockfile`;
- `pnpm verify` integral;
- typecheck semântico do workspace com todas as dependências;
- suítes Vitest de domínio/API/integration;
- migrations reais e RLS em PostgreSQL;
- concorrência transacional em banco real;
- `next build`/bundle/chunks;
- API + worker + web em execução conjunta;
- R12 com pessoas reais/barbearias reais.

A ausência dessas provas não é convertida em aprovação por inferência.

## 10. Parecer final

**Integridade da árvore/merge:** aprovada estaticamente.  
**Contratos e imports:** aprovados nas verificações disponíveis.  
**Correções financeiras da auditoria profunda:** implementadas e protegidas por guardas.  
**Autorização semântica auditada:** corrigida.  
**Timezone/resiliência auditados:** corrigidos nos pontos encontrados.  
**Pronto para nova baseline de desenvolvimento:** sim.  
**Pronto para declarar validação full-stack/produção:** não, até completar o portão real de dependências, banco, build, E2E e uso humano.

A próxima etapa recomendada não é nova refatoração de produto. É executar esta mesma árvore em ambiente completo e tentar quebrar especificamente os cenários financeiros e multi-tenant que agora possuem testes de integração preparados.
