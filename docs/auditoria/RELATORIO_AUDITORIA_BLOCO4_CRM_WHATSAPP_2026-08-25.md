# Barberdock — Auditoria por Blocos — Bloco 4: CRM / WhatsApp

**Data:** 25/08/2026  
**Base canônica:** `barberdock-auditoria-bloco3-financeiro-2026-08-24.zip`  
**Escopo:** campanhas, automações, mensagem avulsa, templates, provider Meta, webhook, lifecycle da conta, roteamento WABA, idempotência, cota promocional, concorrência e isolamento multi-tenant.

## Veredito

O Bloco 4 encontrou e corrigiu falhas reais nas fronteiras **banco → Meta → banco**, em decisões concorrentes de cota promocional, na submissão/conciliação de templates e no roteamento de eventos de ciclo de vida da WABA.

O ponto mais sensível era que alguns caminhos tratavam uma operação externa como se ela fosse atômica com o banco. Em particular, era possível marcar envio antes do provider, repetir uma mensagem quando a Meta já a aceitara mas o registro local falhava, ou duas origens promocionais decidirem simultaneamente que a cota ainda estava livre.

As correções ficaram verdes em todos os portões executáveis neste runtime. A migração 0113 e os testes SQL foram escritos e validados estruturalmente, mas **não foram executados contra PostgreSQL real** nesta sessão. Também não houve chamada real à Meta porque não há credenciais/canal de produção neste ambiente.

## Achados corrigidos

### 1. Conciliação de templates podia atravessar unidades do mesmo tenant — ALTO

`conciliarWhatsAppDaUnidade()` buscava templates em curso apenas pelo tenant. Uma unidade podia conciliar pendências pertencentes a outro número/unidade da mesma barbearia.

**Correção:** `templatesEmCurso()` agora recebe e aplica `locationId`; a conciliação permanece dentro da unidade correta.

### 2. Sucesso na Meta + falha ao persistir `wamid` podia gerar duplicata — CRÍTICO

A Meta podia aceitar a mensagem e, depois disso, o `INSERT` local em `whatsapp_messages` falhar. Tratar essa situação como falha comum permitia retry e segundo envio real.

**Correção:** falha local depois da confirmação externa vira `WhatsAppDeliveryUnknownError`. O chamador preserva o estado como **incerto** e não reenviável automaticamente.

### 3. Envio manual podia considerar sucesso sem `wamid` — ALTO

Um retorno `null` do provider podia atravessar o fluxo como se o envio estivesse concluído, apesar de não existir confirmação real de canal.

**Correção:** mensagem avulsa exige `wamid`; ausência de confirmação gera `sem_canal` e nada é carimbado como enviado.

### 4. Idempotência do envio manual tinha janela concorrente — ALTO

Duas requisições simultâneas podiam competir pela mesma intenção ou uma nova chave podia tentar repetir cliente + template enquanto o primeiro envio ainda estava em voo/incerto.

**Correção:** `whatsapp_manual_send_intents` é usado como claim persistente antes da rede. O fluxo diferencia `enviando`, `incerto` e `enviado`, valida fingerprint da intenção e rejeita reutilização incompatível da chave.

### 5. Campanha, automação e avulso não compartilhavam uma reserva de cota — CRÍTICO

As três origens consultavam o histórico promocional, mas a decisão era otimista: duas transações podiam ler a mesma contagem e ambas enviar.

**Correção:** novo módulo `disparo-promocional.ts` centraliza a reserva. Ele usa:

- advisory lock por **tenant + cliente**;
- `notification_send_intents` como ledger persistente;
- estados `sending`, `uncertain` e `sent`;
- dia local da unidade;
- teto promocional móvel de 30 dias;
- índice único diário por `tenant_id + customer_id + quota_date`.

### 6. Campanha/automação podiam registrar `sent_at` antes do provider — ALTO

O desenho anterior evitava duplicata, mas uma recusa explícita do provider ainda podia deixar o produto dizendo que a mensagem foi enviada.

**Correção:** o fluxo passa a ser **reservar → chamar provider → confirmar**. `sent_at` nasce somente depois de sucesso externo. Recusa explícita libera a reserva; timeout/desfecho ambíguo preserva a intenção como incerta.

### 7. Intenção em voo abandonada precisava de estado conservador — ALTO

Um processo pode cair depois de reservar a cota e antes de confirmar o provider. Reabrir automaticamente a vaga pode duplicar uma mensagem que a Meta talvez tenha recebido.

**Correção:** intenção `sending` antiga passa a `uncertain` depois do limite de voo. Estado incerto ocupa a cota e exige conciliação/ação segura em vez de retry automático.

### 8. Submissão concorrente de template podia criar duas operações na Meta — ALTO

Duas requisições do mesmo `location + nome + idioma` podiam ambas enxergar `meta_id` ausente e submeter o mesmo template externamente.

**Correção:** novo `whatsapp-template-submissao.ts` faz `FOR UPDATE`, cria `submission_claim` persistente e muda `submission_state` para `sending` **antes** da chamada externa.

### 9. Timeout de template era confundido com recusa explícita — ALTO

Falha de transporte não prova que a Meta rejeitou a submissão. Liberar imediatamente uma nova tentativa podia criar duplicata.

**Correção:** `submission_state` diferencia `idle`, `sending` e `uncertain`. Erro de transporte mantém o claim como incerto; recusa explícita volta a `idle`. A conciliação evita competir com submissões recentes em voo.

### 10. Webhook de lifecycle tratava número visível como `phone_number_id` — CRÍTICO/ISOLAMENTO

Eventos de mensagem carregam `metadata.phone_number_id`, mas eventos de ciclo de vida da conta são roteados pela WABA em `entry.id`. Usar `phone_number` visível como id opaco podia descartar ou rotear incorretamente offboarding/reconexão.

**Correção:** mensagens continuam roteadas por `whatsapp_numbers/phone_number_id`; lifecycle passa por `whatsapp_wabas/waba_id` usando `entry.id`.

### 11. Lifecycle estava incompleto e número suspenso podia nunca voltar — ALTO/FUNCIONAL

O fluxo não cobria corretamente `PARTNER_REMOVED` e `ACCOUNT_RECONNECTED`, e a conciliação só promovia `aguardando_verificacao`, deixando `suspenso` sem caminho consistente de recuperação.

**Correção:** suporte a:

- `ACCOUNT_OFFBOARDED` → suspende a unidade;
- `PARTNER_REMOVED` → suspende a unidade;
- `ACCOUNT_RECONNECTED` → volta para `aguardando_verificacao`;
- conciliação aceita `aguardando_verificacao` **ou** `suspenso` quando a Meta volta a provar a posse.

### 12. Roteamento público da WABA precisava ser mínimo e sem PII — ALTO/ISOLAMENTO

O webhook precisa resolver tenant antes de poder usar RLS, mas colocar telefone visível/token/conversa nessa tabela tornaria esses dados legíveis entre tenants.

**Correção:** `whatsapp_wabas` e `whatsapp_waba_owners` guardam somente identificadores opacos e ids internos. `display_phone` é consultado apenas **depois** que tenant + unidade já foram resolvidos e a RLS está ativa.

### 13. Uma mesma WABA não podia pertencer a dois tenants — CRÍTICO/ISOLAMENTO

Uma PK apenas por `waba_id + location_id` permitiria conceitualmente que a mesma WABA fosse registrada por tenants diferentes em unidades diferentes.

**Correção:** `whatsapp_waba_owners` torna `waba_id` propriedade de exatamente um tenant; `whatsapp_wabas` possui FK composta `(waba_id, tenant_id)` para esse owner.

### 14. Compatibilidade da intenção promocional com a migração 0106 — DEFESA EM PROFUNDIDADE

A tabela `notification_send_intents` já possuía identidade `UNIQUE (tenant_id, intent_key)` desde a migração 0106. A primeira versão do novo helper dependia da RLS para resolver consultas por `intent_key` isolado.

**Correção final:** o Bloco 4 passou a usar explicitamente `tenant_id + intent_key` nas leituras/updates e `ON CONFLICT (tenant_id, intent_key) DO NOTHING`. A prova SQL também verifica que a mesma `intent_key` pode existir em tenants distintos, mas não duplicar dentro do mesmo tenant.

## Migração nova

### 0113 — CRM/WhatsApp concorrência e lifecycle

`packages/db/migrations/0113_crm_whatsapp_concorrencia.sql`

Inclui:

- `customer_id`, `quota_at`, `quota_date`, `notification_id` e `wamid` em `notification_send_intents`;
- coerência da reserva promocional;
- índice de cota por cliente;
- unicidade diária promocional por tenant + cliente + dia local;
- `whatsapp_waba_owners`;
- `whatsapp_wabas`;
- RLS + FORCE RLS nas tabelas de roteamento WABA;
- remoção do índice antigo de automação baseado em dia UTC;
- `submission_state`, `submission_claim` e `submission_updated_at` em `whatsapp_templates`;
- constraints de coerência do claim de template.

O repositório passa a ter **113 migrações numeradas, sem duplicidade de versão**.

## Prova SQL preparada

`packages/db/test/0113_crm_whatsapp_concorrencia.test.sql` verifica, quando executado em PostgreSQL:

1. colunas do ledger promocional;
2. colunas do claim de template;
3. RLS/FORCE RLS do roteamento WABA;
4. uma WABA pertencendo a exatamente um tenant;
5. cardinalidade `(tenant_id, intent_key)` herdada da 0106;
6. segunda reserva promocional do mesmo cliente/dia sendo recusada;
7. leitura pré-tenant apenas do roteamento opaco e impossibilidade de tenant rival anexar sua unidade à WABA alheia.

## Arquitetura

As correções não foram usadas para relaxar os tetos modulares existentes. Foram extraídos módulos específicos:

- `whatsapp.ts`: 57 pela métrica da guarda;
- `whatsapp-cadastro.ts`: 443;
- `whatsapp-templates.ts`: 346;
- `whatsapp-mensagens.ts`: 618;
- `whatsapp-assinatura.ts`: 78;
- `whatsapp-roteamento.ts`: 41;
- `whatsapp-lifecycle.ts`: 70;
- `whatsapp-template-submissao.ts`: 123;
- `disparo-promocional.ts`: 195.

`scripts/verificar-crm-whatsapp-modulos.mjs` passou sem aumentar os limites para esconder crescimento.

## Guardas permanentes

Foram adicionados:

- `scripts/verificar-auditoria-crm-whatsapp.mjs`;
- `scripts/verificar-auditoria-crm-whatsapp.test.mjs`;
- execução dos dois portões em `scripts/verify.sh`.

A guarda negativa do Bloco 4 foi submetida a **21 mutações regressivas; 21/21 foram detectadas**. Entre elas:

- remoção do advisory lock promocional;
- perda do ledger persistente;
- retorno a `ON CONFLICT` não qualificado por tenant;
- leitura de intenção sem tenant explícito;
- regressão para dia UTC;
- sucesso sem `wamid`;
- campanha/worker sem reserva pré-provider;
- perda do estado ambíguo pós-Meta;
- conciliação de template sem unidade;
- remoção de `FOR UPDATE` no claim;
- perda do estado incerto de template;
- lifecycle voltando a tratar `phone_number` como id;
- remoção do roteamento por WABA;
- remoção de `PARTNER_REMOVED`;
- suspensão sem caminho de reativação;
- WABA sem owner único;
- cadastro sem reivindicação do owner;
- introdução de telefone visível na tabela pública;
- remoção do índice diário promocional;
- remoção do claim persistente da migração.

## Validação executável final

- guardas diretas aplicáveis: **43/43 PASS**;
- `verificar-configuracao-producao.mjs`: recusou corretamente este ambiente sem secrets de produção e não entra no 43/43;
- testes Node autônomos sem dependência de Vitest: **23/23 arquivos PASS**;
- asserções Node agregadas: **144/144 PASS**;
- auditoria CRM/WhatsApp negativa: **21/21 mutações detectadas**;
- auditorias acumuladas de Identidade/Scheduling/Financeiro continuam verdes nas guardas diretas;
- parse sintático TS/TSX: **779/779**;
- shell `bash -n`: **30/30 arquivos**;
- YAML operacional/CI: **7/7**;
- migrações SQL numeradas: **113**, de `0001` a `0113`, **zero versões duplicadas**;
- guarda modular CRM/WhatsApp: PASS.

## Limitação honesta

Este runtime não possui PostgreSQL/`psql` nem o conjunto de dependências do workspace necessário para a suíte Vitest completa. Também não há credenciais reais da Meta.

Portanto, nesta rodada **não** foram executados:

- aplicação real da migração 0113 em PostgreSQL 16;
- `packages/db/test/0113_crm_whatsapp_concorrencia.test.sql` contra banco real;
- testes concorrentes/integration tests que dependem de banco/Vitest;
- chamadas reais de envio/submissão/webhook contra a conta Meta de produção.

Isso não é classificado como bloqueador conhecido de código do Bloco 4; é o portão externo de certificação runtime.

## Próximo portão externo

1. subir PostgreSQL 16 com as 113 migrações;
2. executar `packages/db/test/0113_crm_whatsapp_concorrencia.test.sql`;
3. instalar o workspace e executar a suíte CRM/API/worker/Vitest completa;
4. testar uma WABA sandbox/real com envio, timeout simulado, template, `ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED` e `ACCOUNT_RECONNECTED`;
5. executar `scripts/verify.sh` integral com secrets de teste adequados.

## Classificação final do bloco

**Código/arquitetura CRM/WhatsApp:** fechado no escopo auditado e significativamente mais defensivo contra concorrência, duplicidade e vazamento cross-tenant.  
**Guardas executáveis deste runtime:** verdes.  
**Bloqueador conhecido de código:** nenhum após a bateria disponível.  
**Certificação PostgreSQL/Meta real:** pendente do ambiente externo descrito acima.
