# Barberdock — auditoria ofensiva final

**Data:** 23/08/2026  
**Base:** `barberdock-final-profundo-corrigido-2026-08-23`  
**Objetivo:** procurar falhas que permanecem invisíveis a guardas de estrutura, com foco em dinheiro externo, falhas parciais, idempotência, multiunidade, webhooks, RLS e escala.

## 1. Veredito

A árvore consolidada permaneceu estruturalmente consistente e recebeu correções adicionais encontradas pela auditoria ofensiva. Não foi encontrado novo IDOR cross-tenant confirmado na revisão estática de FKs/RLS. Os riscos mais relevantes encontrados nesta fase estavam em **falhas distribuídas**: o provedor externo pode aceitar uma ação enquanto a resposta se perde, e o estado local precisa continuar recuperável e idempotente.

A versão pode ser promovida como **nova baseline estática/contratual**, mas **não** como full-stack aprovado: PostgreSQL real, Vitest completo, typecheck/build com dependências e E2E continuam bloqueados pelo ambiente.

## 2. Correções financeiras e de pagamento

- estorno administrativo de venda online agora chama o adquirente antes de desfazer a venda local;
- Checkout Session `cs_...` é resolvida para `payment_intent` antes do refund;
- refund externo é idempotente e recuperável quando a resposta se perde;
- pagamento órfão ou pago com divergência é devolvido automaticamente;
- falha do primeiro refund é recuperada pela reentrega do mesmo evento;
- cobrança `pago` bloqueia segunda emissão enquanto ainda não foi aplicada à venda;
- cobrança já reembolsada deixa de bloquear nova cobrança e não volta a ser recolhida pelo fechamento tardio;
- cancelamento do balcão não encerra localmente a cobrança antes de o cancelamento externo ser confirmado;
- criação de cobrança com resposta ambígua reapresenta a **mesma cobrança**, com a mesma chave, em vez de abrir outra;
- conciliação de cobrança viva se reagenda, em vez de ser one-shot;
- idempotência de cobrança/fechamento respeita `locationId`;
- fechamento tardio de pagamento sem caixa deriva o mesmo split do fechamento imediato;
- régua Stripe usa chave por **tentativa**, não por fatura inteira;
- optimistic lock impede dois workers de consumirem dois degraus da régua na mesma tentativa;
- estorno de crédito da plataforma persiste cobrança de origem e pode reconciliar `pending`;
- endpoint administrativo de estorno da plataforma exige `Idempotency-Key`, persistida e protegida por índice único, inclusive em concorrência.

## 3. Split/KYC

- criação de recebedor/KYC exige idempotência no contrato;
- a chave ativa é persistida antes da rede e reutilizada depois de queda/reload;
- repasse em voo congela chave, recebedor e pagamento originais;
- recuperação reapresenta exatamente a mesma requisição;
- se um clawback provisório foi criado durante estorno e o adquirente depois confirma que o repasse **não ocorreu**, uma compensação positiva append-only corrige a comissão sem apagar histórico.

## 4. Fiscal

- emissão `processando` sem `provider_invoice_id` é retomada com a mesma identidade/idempotência;
- cancelamento com resposta de rede ambígua permanece `cancelando` e é resolvido pela conciliação, em vez de voltar prematuramente para `autorizada`.

## 5. WhatsApp / Meta

- chamada à Graph API possui timeout explícito e redirect manual;
- mensagem manual exige `Idempotency-Key` e registra intenção antes da rede;
- estado ambíguo bloqueia reenvio cego após refresh/duplo clique;
- lembretes e “sua vez” usam intenção `sending/uncertain/sent` antes da rede;
- convite promocional de retorno passou a usar a mesma proteção at-most-once: uma resposta ambígua da Meta não é reenviada automaticamente;
- o convite de retorno não mantém transação PostgreSQL aberta enquanto espera a Meta;
- inbound do webhook continua deduplicado globalmente por `wamid` e prova o agendamento sob tenant + cliente antes de agir;
- `ACCOUNT_OFFBOARDED` é idempotente;
- evento `failed` atrasado não pode sobrescrever uma mensagem já `entregue`/`lida`;
- a assinatura HMAC da Meta usa corpo cru e comparação em tempo constante.

## 6. Stripe/PSP webhooks

- assinatura continua com HMAC sobre corpo cru + timestamp e janela de cinco minutos;
- replay é deduplicado por `event_id` e as máquinas de estado continuam idempotentes;
- cabeçalho com múltiplas assinaturas `v1` agora aceita **qualquer** assinatura válida, cobrindo rotação de webhook secret;
- eventos Stripe que não representam desfecho (`payment_intent.created`, etc.) continuam ignorados sem consumir o evento terminal futuro.

A cobrança da plataforma ainda depende deliberadamente da conciliação como rede de segurança se o processo morrer depois de registrar o evento e antes de concluir todos os efeitos. A conciliação existe e roda antes da régua; isso foi mantido como desenho, não classificado como regressão.

## 7. RLS, multi-tenant e IDs externos

Na inspeção estática:

- as tabelas operacionais com `tenant_id` permanecem protegidas por RLS/FORCE RLS, salvo exceções deliberadas de roteamento público/cross-tenant;
- agenda, fila, recados, transferências e outros fluxos críticos relêem IDs externos sob tenant antes da gravação;
- não foi confirmado novo IDOR cross-tenant nesta rodada;
- cobrança, fechamento, mídia e KYC tiveram recortes de unidade/idempotência endurecidos.

Essa conclusão **não substitui** testes reais de PostgreSQL/RLS com dois tenants.

## 8. Performance

A porta de Clientes foi alterada para não carregar a base inteira e paginar apenas em memória. Busca/ordenação/paginação principal descem para PostgreSQL e os enriquecimentos caros ficam limitados à janela retornada. A segmentação também foi reorganizada para agregações em conjunto em vez de subconsultas correlacionadas por cliente.

## 9. Métricas

O painel da plataforma passou a preferir o último `business_day` **realmente consolidado** em `tenant_metrics_daily`; o corte de 09:00 UTC fica apenas como fallback quando ainda não há apuração. Isso evita mostrar zero para um dia que teoricamente deveria ter sido apurado, mas cujo worker atrasou/falhou.

## 10. Decisão contábil mantida

O DRE histórico atualmente remove uma venda do período original quando ela é estornada, enquanto a reversão de comissão é lançada no período do estorno. Há teste explícito exigindo esse comportamento. Não foi alterado silenciosamente nesta auditoria; deve ser tratado como **decisão de produto/contabilidade** caso se queira fechamento histórico imutável por competência.

## 11. Validação executada na árvore final

- **23** guardas `verificar-*.mjs` executáveis: **23 OK / 0 falhas**;
- scripts de teste independentes: **4 OK / 1 indisponível** por depender de Vitest;
- **742 TS/TSX**: **0 erro de parse**;
- **2.436** declarações de import interno/alias: **0 caminho ausente**;
- **7.277** imports nomeados/default: **0 símbolo local ausente**;
- **70/70** `.mjs` com sintaxe válida;
- **29/29** scripts shell com sintaxe válida;
- **46/46** JSON válidos;
- **6/6** YAML válidos.

O `scripts/verify.sh` oficial foi executado. Todas as fases estáticas acima ficaram verdes e o portão parou em **build dos pacotes** porque `pnpm` não existe no ambiente. PostgreSQL também não pôde ser iniciado porque `pg_isready` não está instalado.

## 12. O que ainda não está provado

- `pnpm install --frozen-lockfile`;
- typecheck semântico completo do workspace;
- build dos pacotes e `next build`;
- Vitest completo;
- migrations do zero e incrementais em PostgreSQL real;
- testes RLS com dois tenants reais;
- concorrência real de banco (`FOR UPDATE`, índices parciais, duas conexões simultâneas);
- E2E Browser → Next → API → PostgreSQL → Worker → providers;
- R12 com pessoas reais.

A ausência dessas provas **não é aprovação**. A baseline está aprovada apenas no escopo estático/contratual/ofensivo que este ambiente permite.
