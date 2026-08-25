# Barberdock — Auditoria Final Cumulativa / Regressão Cross-Domain

**Data:** 25/08/2026  
**Base canônica:** `barberdock-auditoria-bloco6-platform-jobs-integracoes-2026-08-25.zip`  
**Escopo:** cruzamento dos Blocos 1–6, com foco em invariantes que atravessam Identidade, Scheduling, Financeiro, CRM/WhatsApp, Catálogo/Onboarding e Platform/Jobs/Integrações.

## Veredito

A auditoria final encontrou **7 classes de interação cross-domain que ainda mereciam correção**, mesmo com todas as guardas individuais dos seis blocos verdes. O padrão comum era TOCTOU entre uma decisão de disponibilidade e uma configuração administrativa alterada em paralelo.

As correções foram aplicadas sem criar migração nova: o banco permanece em **0115**, porque os achados finais eram de coordenação transacional/código e não exigiam mudança de schema.

**Código/arquitetura no escopo auditado:** fechado após a bateria executável.  
**Bloqueador conhecido de código:** nenhum após a regressão final disponível neste runtime.  
**Certificação PostgreSQL/Vitest/build/providers reais:** ainda depende de ambiente externo e não é chamada de PASS neste relatório.

## Achados finais e correções

### F1 — mudança de recursos podia atravessar uma reserva em andamento — ALTO

`resource_pools` e `service_resource_requirements` pertencem ao Catálogo, mas decidem capacidade da Agenda. Antes da auditoria final, uma reserva podia ler a configuração antiga, o administrador gravar a nova configuração e a reserva ainda commitar depois com uma decisão tomada sobre um snapshot obsoleto.

**Correção:** Scheduling passou a disputar o mesmo namespace `barberdock:catalog:resources:<tenant>` usado pelo Catálogo. Criação, hold, remarcação, walk-in, oferta da lista de espera e reativação de falta passam pela coordenação adequada quando dependem de recursos.

A leitura usa `pg_advisory_xact_lock_shared`; a escrita do Catálogo continua usando o lock exclusivo. Assim, reservas normais continuam concorrentes entre si e somente uma mudança real de configuração as cerca.

### F2 — walk-in podia correr contra mudança de jornada/profissional — ALTO

A criação normal, hold e remarcação já compartilhavam a trava `barberdock:professional-config:<professionalId>` com a edição da jornada. `seatQueueEntry`, porém, ainda criava um atendimento sem disputar essa trava.

**Correção:** walk-in agora segura a trava compartilhada do profissional, além da trava unidade+dia e da configuração de recursos/serviços, antes de decidir capacidade.

### F3 — walk-in podia furar habilidade e jornada atual — ALTO/FUNCIONAL

O fluxo de fila confirmava unidade, atividade e tipo do profissional, mas não provava que ele executava **todos** os serviços da pessoa nem que a janela completa do atendimento, incluindo buffers, cabia na jornada atual após breaks, exceções e bloqueios.

Isso contrariava a própria SPEC do motor, segundo a qual walk-in só entra em “buraco real”.

**Correção:** `seatQueueEntry` passou a reutilizar `loadDayContext`, `resolveWorkingDay` e `subtract`. O atendimento só é criado se:

- todos os serviços continuam ativos e válidos no balcão;
- o profissional continua habilitado para todos eles;
- a janela ocupada inteira cabe na jornada corrente;
- breaks, exceções e bloqueios não invalidam a janela;
- limites e recursos continuam disponíveis.

### F4 — oferta da lista de espera podia nascer de uma grade já inválida — ALTO

A oferta revalidava profissional livre, cota e recursos, mas ainda podia usar uma vaga derivada de cancelamento depois que jornada, skill, serviço ou bloqueio já haviam mudado.

**Correção:** antes de criar `slot_hold`, a oferta recupera os serviços da entrada, recarrega o contexto atual e recalcula a disponibilidade com `computeFromContext`. O hold só é criado se o mesmo profissional ainda oferece exatamente aquele início para os serviços do candidato.

A oferta também passou a disputar as travas compartilhadas de profissional, recursos e serviços.

### F5 — editar/desativar profissional podia atravessar booking já validado — ALTO

`updateProfessional` altera `kind`, `bookable_online`, `daily_limit` e habilidades. `setProfessionalActive` altera atividade. Esses campos participam diretamente da disponibilidade, mas as mutações ainda não disputavam o lock que Scheduling já usava para a jornada.

**Correção:** ambas as operações passam a adquirir o lock **exclusivo** `barberdock:professional-config:<professionalId>`. Scheduling usa a variante compartilhada. Ou a configuração entra primeiro e a Agenda recalcula, ou a decisão da Agenda termina antes da alteração administrativa.

### F6 — editar/desativar serviço ou readoção de franquia podia atravessar booking — ALTO

Duração, buffers, `bookable_online`, atividade e composição de combo mudam a grade. `updateService`, `setServiceActive` e a readoção de item de franquia podiam atualizar esses dados enquanto uma reserva trabalhava com o snapshot anterior.

**Correção:** criado namespace de leitura/escrita `barberdock:catalog:services:<tenant>`:

- Scheduling usa `pg_advisory_xact_lock_shared` antes de resolver capacidade;
- `updateService` e `setServiceActive` usam `travarCatalogoDoTenant(tx, 'services')` exclusivo;
- a readoção de franquia que pode atualizar duração/nome do serviço também usa o mesmo lock exclusivo.

### F7 — fencing correto não deve destruir concorrência saudável — ARQUITETURA/PERFORMANCE

A primeira versão da correção final usava locks exclusivos também nos leitores de Agenda. Isso seria correto quanto à integridade, mas serializaria reservas sem necessidade, inclusive entre datas/unidades em algumas configurações.

**Correção:** os locks de **leitura de configuração** no Scheduling foram convertidos para `pg_advisory_xact_lock_shared`; os escritores permanecem exclusivos. A solução final preserva integridade sem transformar toda leitura de catálogo em mutex global.

## Guarda permanente final

Foram adicionados:

- `scripts/verificar-auditoria-final-cross-domain.mjs`;
- `scripts/verificar-auditoria-final-cross-domain.test.mjs`;
- os dois portões ao `scripts/verify.sh`.

A guarda final cobre, entre outros:

- namespace idêntico Catálogo × Agenda para jornada/profissional;
- locks compartilhados nos leitores e exclusivos nos escritores;
- namespace de recursos Catálogo × Agenda;
- namespace de serviços Catálogo × Agenda;
- criação/hold/remarcação sob recursos + serviços;
- walk-in sob dia + profissional + recursos + serviços;
- walk-in revalidando skill e jornada;
- oferta da lista de espera sob os mesmos fences e recalculando a grade;
- `undo_no_show` serializando configuração de recursos antes da revalidação;
- atomicidade PSP × fatura mantida;
- claim `pending -> failed` do estorno mantido;
- FK `(tenant_id, endpoint_id)` de webhook mantida;
- sequência canônica `0110 → 0115` sem versão duplicada;
- presença do portão final no `verify.sh`.

A prova negativa da auditoria final recebeu **22 mutações regressivas; 22/22 foram detectadas**.

## Regressão cumulativa executada

Após todos os achados finais:

- **46/46 guardas diretas aplicáveis: PASS**;
- **26/26 arquivos Node autônomos: PASS**;
- **213/213 asserções Node: PASS**;
- auditoria final negativa: **22/22 PASS**;
- parse sintático TypeScript/TSX: **780/780 PASS**;
- shell `bash -n`: **30/30 PASS**;
- YAML operacional/CI: **7/7 PASS**;
- migrações numeradas: **115**, `0001 → 0115`, **zero versões duplicadas**;
- `verificar-prontidao.mjs`: **8 funcionalidades**, matriz/evidências coerentes;
- guardas acumuladas dos Blocos 1–6 permanecem verdes.

O `verificar-configuracao-producao.mjs` recusou corretamente este runtime porque os secrets reais de produção não estão presentes. Isso é comportamento esperado e não foi convertido em PASS artificial.

## O que não foi executado neste runtime

Este ambiente não fornece PostgreSQL/`psql`/`pg_isready`, Docker/Podman, `pnpm` ou `node_modules` do workspace. Assim, permanecem fora da certificação desta sessão:

- aplicação real das 115 migrações em PostgreSQL 16;
- provas SQL e testes concorrentes que dependem de banco real;
- **25 arquivos `.test.mjs` que importam Vitest diretamente**;
- suíte Vitest TypeScript completa;
- `pnpm -r typecheck`, `pnpm -r test`, build e E2E completos;
- smoke real com Meta, Stripe/PSP, emissor fiscal, split e demais providers.

Esses itens são **portões de certificação runtime/go-live**, não evidência de um bloqueador de código conhecido nesta auditoria.

## Integrações declaradamente externas

Continuam válidas as dependências já registradas no Bloco 6:

- split real depende de adquirente/conta com split habilitado;
- fiscal real depende de emissor contratado e credenciais;
- clube recorrente depende do caminho real de tokenização/cobrança;
- Meta/Stripe/PSP e demais integrações exigem credenciais e smoke em ambiente apropriado.

A auditoria final não substitui essas integrações por fakes para produzir um falso “100% produção”.

## Classificação final da auditoria por blocos

**Auditoria dependente de código dos Blocos 1–6:** concluída.  
**Regressão cross-domain disponível neste runtime:** verde.  
**Bloqueador conhecido de código após a bateria disponível:** nenhum.  
**Produto certificado em produção:** ainda não — faltam os portões externos de PostgreSQL, dependências/build/E2E e providers reais descritos acima.

O ZIP desta auditoria final passa a ser a **base canônica** para qualquer evolução posterior.
