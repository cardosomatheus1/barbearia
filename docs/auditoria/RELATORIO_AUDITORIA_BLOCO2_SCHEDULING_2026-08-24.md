# Barberdock — Auditoria por Blocos — Bloco 2: Scheduling / Agenda

**Data:** 24/08/2026  
**Base:** auditoria cumulativa após o Bloco 1 (Identidade)  
**Escopo:** disponibilidade, criação, holds, remarcação, cancelamento, agenda administrativa, fila presencial, lista de espera, oferta de vaga, recursos compartilhados, limite diário, canais público/balcão, idempotência e concorrência.

## Veredito

O domínio de Scheduling tinha uma boa defesa de overbooking por profissional, mas ainda havia decisões de capacidade protegidas apenas por leitura otimista. A auditoria encontrou condições reais de corrida em recursos compartilhados, remarcação, limite diário, lista de espera, bloqueios de agenda e reativação de faltas.

As correções foram aplicadas e guardadas estruturalmente. O que depende de PostgreSQL foi **implementado e testado em código**, mas não executado neste runtime por ausência de PostgreSQL/psql. Portanto, concorrência/RLS/migração 0110 não são classificados como certificados em runtime nesta sessão.

## Achados e correções

### A1 — duas remarcações do mesmo compromisso podiam criar dois sucessores — ALTO

**Antes:** duas transações podiam ler o mesmo agendamento ativo e ambas prosseguir. Havia também corrida entre cancelar e remarcar.

**Correção:** a linha original é lida com `FOR UPDATE OF a`; a transição para `rescheduled` exige status ativo e confirma exatamente uma linha afetada. Testes concorrentes cobrem remarcação × remarcação e cancelamento × remarcação.

### A2 — recursos compartilhados e limite diário eram decisões otimistas — ALTO

A exclusion constraint protege o mesmo profissional, mas não uma maca/cadeira compartilhada por profissionais diferentes nem o teto diário.

**Correção:** novo `travarDiaDaAgenda()` usa `pg_advisory_xact_lock` por **unidade + dia local**. Criação, hold, remarcação, fila, oferta e exceção disputam a mesma trava antes de decidir capacidade.

Foram adicionados casos concorrentes para recurso compartilhado e `daily_limit`.

### A3 — Idempotency-Key não provava que a intenção era a mesma — MÉDIO/ALTO

**Antes:** repetir a mesma chave com outro horário podia devolver o primeiro agendamento silenciosamente.

**Correção:** `appointments.idempotency_fingerprint` (migração 0110) congela profissional, serviços, data, início, cliente, origem e observação. Reuso com outra intenção vira `409 idempotencia_conflitante`.

Registros anteriores à 0110 com fingerprint nulo têm a intenção reconstruída da própria linha para preservar retries legítimos durante rollout sem transformar `NULL` em passe livre.

A lógica foi isolada em `booking-idempotencia.ts`; `booking.ts` voltou para ~1.258 linhas, abaixo da guarda de 1.300.

### A4 — `quantity > 1` de recurso era contado como uma única ocupação — ALTO

**Correção:** disponibilidade expande `appointment_resources.quantity` e `slot_hold_resources.quantity` com `generate_series`, de modo que duas unidades consumam duas posições de capacidade.

### A5 — holds seguravam o profissional, mas não os recursos — ALTO

**Correção:** migração `0110_scheduling_concorrencia_recursos.sql` cria `slot_hold_resources`, com `quantity`, PK, índice, RLS e `FORCE ROW LEVEL SECURITY`. `holdSlot` e ofertas da lista de espera persistem os recursos congelados no hold.

O Prisma schema foi atualizado para acompanhar a migração.

### A6 — walk-in/fila podia sentar cliente sem respeitar recurso e limite diário — ALTO

**Correção:** `seatQueueEntry` disputa a trava diária, conta agendamentos + holds para `daily_limit`, verifica pools de recurso e grava `appointment_resources` junto com o atendimento.

### A7 — “só pelo balcão” também bloqueava o próprio balcão — FUNCIONAL/MÉDIO

`bookable_online=false` deveria significar “não aparece no autoatendimento”, mas o repository aplicava o filtro em todos os canais.

**Correção:** `loadRangeContext/loadDayContext` recebem `atCounter`. Público continua exigindo `bookable_online`; balcão e remarcação administrativa podem usar serviço/profissional configurado como exclusivo da recepção.

### A8 — limite de 3 entradas na lista de espera estava sujeito a corrida — MÉDIO

Duas requisições com chaves diferentes podiam ler a mesma contagem e ambas criar a quarta entrada.

**Correção:** advisory lock por **tenant + customer** antes da contagem. A borda pública também passou a recusar serviço/profissional `bookable_online=false` e profissionais que não sejam `professional/external`.

### A9 — bloqueio de agenda e nova reserva podiam decidir sobre snapshots diferentes — ALTO

**Correção:** `createException` usa a mesma trava unidade+dia da criação. Se a reserva vencer a corrida, a exceção volta com conflitos; se o bloqueio vencer, a nova reserva recalcula a grade e é recusada.

### A10 — oferta da lista de espera podia usar uma vaga que já mudou — ALTO

Entre cancelamento e execução do job, profissional, cota ou recursos podem mudar.

**Correção:** antes de oferecer, o worker revalida profissional livre/ativo, limite diário e recursos; o hold exclusivo congela também os recursos. Conflito ao gravar oferta limpa o hold candidato.

### A11 — `holdId` era aceito pela API pública sem existir emissor público de hold — ALTO

Isso criava uma superfície para fazer o motor ignorar/excluir um hold conhecido do mesmo tenant.

**Correção:** `holdId` foi removido de `createAppointmentSchema` e do controller público. Ele continua sendo um detalhe interno usado, por exemplo, ao aceitar uma oferta.

Além disso, o domínio agora bloqueia o hold com `FOR UPDATE` e só o consome se profissional, janela ocupada e conjunto/quantidade de recursos forem exatamente os do slot resolvido. Hold expirado ou reaproveitado vira `hold_invalido`.

### A12 — “Desfazer falta” podia reativar recurso já reaproveitado — ALTO

A exclusion constraint pega outro cliente no **mesmo profissional**, mas não uma maca compartilhada que outro profissional recebeu depois que o primeiro foi marcado `no_show`.

**Correção:** `undo_no_show` descobre o dia local, disputa a trava unidade+dia e revalida `appointment_resources` contra outros agendamentos ativos e holds antes de voltar para `checked_in`.

## Banco / migração

Nova migração:

`packages/db/migrations/0110_scheduling_concorrencia_recursos.sql`

Inclui:

- `appointments.idempotency_fingerprint`;
- `slot_hold_resources`;
- `quantity > 0`;
- índice por tenant/tipo;
- RLS + FORCE RLS;
- privilégio explícito da role da aplicação.

Foi criado `packages/db/test/0110_scheduling_concorrencia_recursos.test.sql` para verificar coluna, quantity, RLS forçada e isolamento de tenant quando o portão PostgreSQL puder executar.

## Guardas permanentes

`scripts/verificar-auditoria-scheduling.mjs` agora cobra, entre outros:

- lock por unidade+dia;
- lock da linha em remarcação;
- fingerprint de idempotência;
- recursos/quantity de holds;
- persistência de recursos de walk-in;
- distinção público × balcão;
- serialização da lista de espera;
- revalidação da oferta;
- remoção de `holdId` da API pública;
- validação interna do hold;
- revalidação de recursos em `undo_no_show`;
- alinhamento básico do Prisma schema com a migração 0110.

A guarda foi submetida a **11 mutações negativas; 11/11 foram detectadas**.

## Validação executável nesta sessão

- Guardas diretos aplicáveis: **41/41 PASS**.
- `verificar-configuracao-producao.mjs`: não contado como guard direto porque, sem variáveis de produção, sua função correta é recusar; seus cenários autônomos foram executados na bateria Node.
- Arquivos `*.test.mjs` que não dependem de Vitest: **21/21 arquivos PASS, 106 testes**.
- Arquivos que importam Vitest: **25 não executados** por ausência da dependência no runtime.
- Auditoria Scheduling negativa: **11/11 PASS**.
- Transpilação sintática TypeScript/TSX ampla: **773/773**, zero erro/crash.
- Scheduling isolado: **33/33 TS**, zero erro sintático.
- API isolada: **131/131 TS**, zero erro sintático.
- `verify.sh`, `migrate.sh`, `test.sh`: sintaxe shell OK.
- YAML principal: OK.

## Limitação que permanece

Os testes de concorrência, a migração 0110, RLS e os novos casos de integração exigem PostgreSQL 16. O ambiente atual não fornece `postgres`, `psql`, `pg_isready`, Docker ou Podman. Assim, esses casos estão **escritos e estruturalmente validados, mas não executados contra banco real**.

## Classificação do bloco

**Código/arquitetura de Scheduling após correções:** forte e significativamente mais defensivo sob concorrência.

**Certificação runtime de concorrência:** pendente do portão PostgreSQL.

**Bloqueador conhecido de código neste bloco:** nenhum após a bateria disponível.
