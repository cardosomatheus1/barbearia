# Parte 2 — Motor de agendamento

← [SPEC.md](../../SPEC.md)

O agendamento é o coração do sistema. Esta é a parte onde o produto ganha ou perde
contra o incumbente.

Fórmula base:
> **Serviço + Profissional + Unidade + Recursos + Duração + Regras + Disponibilidade**

---

## 2.1 Agenda inteligente — configuração

Cada profissional tem:

jornada semanal · horários diferentes por dia · intervalo de almoço · férias ·
folgas · bloqueios · feriados · exceções · encaixes · atendimento externo ·
limite diário · recursos necessários

```
Segunda:  fechado
Terça:    09:00–19:00
Quarta:   09:00–19:00
Quinta:   10:00–22:00
Sexta:    10:00–22:00
Sábado:   08:00–18:00
Domingo:  09:00–13:00
```

### Exceções por data
```
15/08 — João trabalhará 08:00–13:00
24/12 — unidade fecha 16:00
```

Precedência (maior vence):
```
bloqueio pontual > exceção do profissional > exceção da unidade
> feriado > jornada semanal
```

> **Estado da implementação.** A precedência acima está resolvida e testada no
> motor, e `schedule_exceptions` tem os cinco tipos, índice e RLS desde o
> primeiro bloco. **Nada no produto escreve nessa tabela** — nem folga, nem
> feriado, nem bloqueio pontual. Só por SQL. A escrita e a tela entram no bloco
> 15 (agenda do admin), e o registro está em
> [`SPEC.md` §7.1 grupo A](../../SPEC.md#71-distância-entre-esta-spec-e-o-que-está-construído),
> classificado como dívida e não como sequência.

### Modelo
```
work_schedules       (professional_id, weekday, start, end, breaks[])
schedule_exceptions  (professional_id|location_id, date, type, start, end, reason)
```

`breaks[]` como array de `{start, end}` — suporta mais de um intervalo no dia
(almoço + janela fixa de descanso). O concorrente modelou isso corretamente e
simplesmente não usa; aqui o intervalo **aparece visualmente na grade**, para o
cliente entender por que há um buraco.

---

## 2.2 Serviços, duração e buffer

> **Resolve D1 e D4.**

Todo serviço tem três tempos:

```
buffer_before   preparo (ex.: 0 min)
duration        execução  (ex.: 40 min)
buffer_after    limpeza   (ex.: 5 min)
```

**Agenda ocupada = 45 min. Cliente vê "40 min".** O buffer é invisível ao cliente
e inegociável na alocação.

### Multi-serviço
```
Corte        40 min
Barba        30 min
Sobrancelha  10 min
─────────────────────
Duração      80 min
```

### Regra de combo
Combo pode ter duração menor que a soma das partes — mas **precisa ser declarado
explicitamente**, não inferido:

```
Corte + Barba (combo)
  componentes: [Corte, Barba]
  duração declarada: 60 min   (soma das partes: 70 min)
  economia: 10 min ✓ plausível
```

O validador (Parte 5 §5.7) **bloqueia** combo cuja duração seja menor que a soma
das partes menos uma tolerância. Foi exatamente esse cadastro sem trava que
produziu `Cabelo + Barba + Sobrancelha = 30 min por R$ 94` no concorrente — três
serviços em meia hora, impossível na prática.

---

## 2.3 Recursos

Um horário só existe quando há **profissional + recurso** simultaneamente
disponíveis.

Exemplos: cadeira · lavatório · sala VIP · equipamento · maca

```
services.required_resources = [
  {resource_type: "cadeira", quantity: 1},
  {resource_type: "lavatorio", quantity: 1, only_during: "first_10_min"}
]
```

`only_during` permite liberar o lavatório após a lavagem, para outro atendimento
usá-lo — sem isso, 3 barbeiros e 1 lavatório derrubam a capacidade a um terço
indevidamente.

Alocação automática no ato da reserva; realocação permitida enquanto o
agendamento não iniciou.

---

## 2.4 Availability engine — o núcleo

> **Resolve D1, D2, D3.** É aqui que o produto se diferencia tecnicamente.

### Endpoint
```
GET /availability
  ?location_id=...
  &service_ids[]=...
  &professional_id=...        (opcional — omitir = "qualquer profissional")
  &date_from=2026-08-08
  &date_to=2026-08-14
```

### Resposta
```json
{
  "timezone": "America/Bahia",
  "granularity_minutes": 5,
  "total_duration_minutes": 80,
  "days": [
    {
      "date": "2026-08-08",
      "slots": [
        { "start": "09:00", "end": "10:20", "professional_id": "123",
          "resources": ["cadeira-2"], "price": 95.00 },
        { "start": "10:25", "end": "11:45", "professional_id": "456",
          "resources": ["cadeira-1"], "price": 110.00 }
      ],
      "unavailable_reason": null
    },
    {
      "date": "2026-08-09",
      "slots": [],
      "unavailable_reason": "fully_booked",
      "waitlist_available": true
    }
  ]
}
```

### Por que a resposta é assim

| Decisão | Motivo |
|---|---|
| Retorna `end`, não só `start` | Cliente vê quando termina; UI não precisa recalcular |
| Retorna `professional_id` por slot | Habilita "qualquer profissional" sem N chamadas |
| Retorna `price` por slot | Preço varia por profissional e por smart pricing |
| Retorna `unavailable_reason` | **Resolve D3** — permite UI honesta e oferta de fila |
| Retorna `timezone` IANA | **Resolve D2** — nunca offset do cliente |
| `granularity_minutes` de 5 | **Resolve D1** — slot ancorado, não grade fixa |

### Algoritmo

```
1. Resolver duração total  = Σ (buffer_before + duration + buffer_after)
                             aplicando regra de combo quando houver
2. Determinar candidatos   = profissionais habilitados em TODOS os serviços
                             (filtro de habilidade — herdado do concorrente)
3. Para cada candidato:
   3.1 janelas = jornada do dia − breaks − exceções − bloqueios − feriados
   3.2 subtrair agendamentos existentes (com buffers)
   3.3 subtrair janelas sem recurso obrigatório livre
   3.4 aplicar limite diário de atendimentos
   3.5 gerar slots ANCORADOS:
       - primeiro slot = início da janela livre
       - próximos      = fim do anterior (encaixe justo)
       - mais alinhamentos na granularidade para legibilidade
   3.6 descartar slot cujo fim ultrapasse o fim da janela
4. Aplicar regras comerciais: antecedência mínima/máxima, dias e horários
   permitidos por assinatura, smart pricing
5. Mesclar candidatos, ordenar por horário, deduplicar
```

### Slot ancorado vs. grade fixa

O concorrente usa grade fixa de 15 min. Com jornada 09:00–18:00 e serviço de 20
min, oferece `09:00, 09:15, 09:30…` — se alguém reserva 09:15, os 15 min entre
09:00 e 09:15 viram buraco morto que nunca será vendido.

Slot ancorado gera o próximo slot **no fim do anterior**:

```
Grade fixa (concorrente)          Slot ancorado (este produto)
09:00 ─ 09:20 [reservado]         09:00 ─ 09:20 [reservado]
09:15 ✗ conflita                  09:20 ─ 09:40 ✓ oferecido
09:30 ─ 09:50 ✓                   09:40 ─ 10:00 ✓
      ↑ 10 min perdidos                 ↑ zero perda
```

Numa jornada de 9 horas com serviços de 20 min, a diferença é de **~2 atendimentos
por barbeiro por dia**. É a funcionalidade com maior retorno financeiro direto do
motor.

**Configurável por tenant:** `slot_strategy = anchored | grid`. Barbearia que
prefere horário "redondo" para o cliente memorizar pode escolher `grid`. O default
é `anchored`.

### Antecedência
```
min_lead_time_minutes   default 30   (não agendar para daqui a 5 min)
max_lead_days           default 60
same_day_cutoff         opcional     (ex.: sem online após 17h no mesmo dia)
```

### Timezone
> **Resolve D2.**

- A unidade tem `timezone` IANA (`America/Bahia`, `America/Sao_Paulo`).
- Todo cálculo de disponibilidade acontece **no fuso da unidade, no servidor**.
- Persistência em UTC (`timestamptz`).
- O cliente recebe strings locais já resolvidas e o `timezone` para exibir.
- O relógio do dispositivo do cliente **nunca** entra no cálculo.

Sem isso, cliente viajando ou com relógio errado vê grade deslocada — falha real
observada no concorrente.

### Performance
`/availability` é o endpoint mais chamado e mais caro. Requisitos:

- P95 < 800 ms para 7 dias × 5 profissionais (os demais endpoints: P95 < 500 ms)
- Cache em Redis por `(location, service_set, professional, date)`, TTL curto
- Invalidação por evento: `appointment.created/cancelled/updated`,
  `schedule.changed`, `block.created`
- Nunca N+1: agendamentos do intervalo carregados em uma query

---

## 2.5 "Qualquer profissional"

> **Resolve D7.**

Opção de primeira classe, **exibida por padrão e pré-selecionada**.

Quando `professional_id` é omitido, o motor oferece a união dos slots de todos os
candidatos, deduplicada por horário.

**Desempate** quando o mesmo horário existe em mais de um profissional
(`assignment_strategy` por tenant):

| Estratégia | Regra | Quando usar |
|---|---|---|
| `preferred_first` *(default)* | barbeiro habitual do cliente primeiro | maximiza satisfação e retenção |
| `balance_load` | quem tem menos atendimentos no dia | distribui renda na equipe |
| `maximize_density` | quem já tem atendimento adjacente | minimiza buraco na agenda |
| `round_robin` | rodízio | equipes que exigem igualdade |

O cliente vê apenas "10:20 — disponível". O nome do profissional é revelado na
confirmação, e ele pode trocar antes de fechar.

---

## 2.6 Fluxos de entrada

Três caminhos, todos suportados:

```
A) Barbearia → Unidade → Serviço → Profissional → Data → Horário
                                        ↑ ou "Qualquer profissional"

B) Serviço → profissionais que executam → horários

C) Profissional → serviços que ele faz → horários
```

O caminho **C** importa: boa parte do público segue o barbeiro, não a barbearia.
O perfil público do barbeiro (Parte 5) entra direto nesse fluxo.

### Deep link
```
/{slug}                         página da barbearia
/{slug}/s/{servico}             abre já no serviço selecionado
/{slug}/p/{profissional}        abre já no profissional
/{slug}/p/{prof}/s/{servico}    abre direto na grade de horários
```

Transforma o link da bio do Instagram em link de conversão em vez de link de
navegação. **O concorrente não tem isso.**

---

## 2.7 Reagendamento

> **Resolve D11.** No concorrente, "Reagendar" existe no i18n mas na prática é
> cancelar e refazer — o cliente perde o slot no meio do caminho e pode ficar sem
> nenhum.

Reagendamento é **operação atômica**:

```
1. Cliente escolhe o novo horário
2. Sistema reserva o novo (lock)
3. Só então libera o antigo
4. Se o novo falhar → o antigo permanece intacto
```

Nunca existe estado em que o cliente ficou sem agendamento por erro do sistema.

**Regras configuráveis:** limite de reagendamentos por agendamento (default 2),
antecedência mínima (default 2h), e se reagendar dentro da janela de cancelamento
consome ou preserva o sinal pago.

### Reagendamento em 1 clique (rebooking)
Após o atendimento, botão **Agendar novamente** pré-carrega unidade + serviço +
barbeiro e **sugere a data esperada de retorno**, calculada pelo ciclo médio real
do cliente (Parte 4 — CRM).

---

## 2.8 Agendamento recorrente

Cliente seleciona: semanal · quinzenal · mensal · intervalo personalizado

```
João · Corte · com Carlos · sexta 18:00 · a cada 15 dias
```

**Implementação:** gerar ocorrências concretas com horizonte rolante de 90 dias,
não regra infinita. Cada ocorrência é um `appointment` normal, editável e
cancelável individualmente, ligado por `recurrence_id`.

Ao cancelar, perguntar: **só esta** · **esta e as futuras** · **todas**.

Se uma ocorrência futura conflitar, o sistema não a descarta em silêncio: cria com
status `pending_conflict` e alerta a recepção para resolver.

---

## 2.9 Lista de espera inteligente

> Uma das três alavancas de maior retorno (SPEC §2.5). O concorrente **não tem**.

Quando não há horário:
> **"Avise-me se surgir uma vaga."**

O cliente informa: dia (ou faixa de dias) · período · profissional (opcional) ·
serviço

```
Sábado · 08:00–12:00 · qualquer barbeiro · Corte + Barba
```

### Gatilho
`appointment.cancelled` → o motor recalcula a janela liberada → busca entradas de
fila compatíveis → notifica.

### Dois modos

**First Come** — todos os compatíveis são notificados; o primeiro a confirmar leva.
Simples, converte rápido, pode frustrar.

**Priority Queue** *(default)* — ordena candidatos por score:

```
score = 0.35 × aderência do horário pedido
      + 0.25 × recorrência histórica do cliente
      + 0.20 × assinatura ativa
      + 0.10 × reliability score
      + 0.10 × ordem de entrada na fila
```

Notifica o topo com **janela exclusiva de 10 min**; sem resposta, passa ao
próximo. Assinante ter prioridade real na fila é benefício concreto e vendável do
clube (Parte 4).

### Requisitos
- Uma entrada de fila expira quando a data pedida passa.
- Cliente sai da fila com um toque, e sai automaticamente ao conseguir agendar.
- Limite de entradas ativas por cliente (default 3) — evita quem entra em tudo.
- Notificação de vaga **nunca** ignora o opt-out de marketing: é transacional, não
  promocional, mas o texto não pode virar propaganda.

---

## 2.10 Fila presencial / walk-in

Separada do agendamento — é outro objeto e outra tela.

| Cliente | Serviço | Preferência | Espera |
|---|---|---|---|
| João | Corte | Qualquer | 12 min |
| Carlos | Barba | Bruno | 18 min |

A estimativa vem da duração real média (não da cadastrada) dos atendimentos em
curso e da fila à frente.

Cliente recebe:
> **Você é o próximo.**

E pode acompanhar a posição pelo celular por link, sem app.

**Regra de convivência:** walk-in nunca sobrescreve agendamento confirmado. O
sistema encaixa walk-in apenas em buraco real, e mostra ao recepcionista quanto
tempo existe até o próximo agendado.

---

## 2.11 Check-in

Canais: recepção · QR Code · aplicativo · link · geolocalização aproximada
(opcional)

### Máquina de estados

```
                    ┌─────────► cancelled_customer
                    │
pending ──► confirmed ──► checked_in ──► waiting ──► in_progress ──► completed
   │            │              │                          │
   │            └──────────────┴─────────► no_show        └──► cancelled_business
   │
   └──► rescheduled ──► (novo appointment)
```

| Status | Significado |
|---|---|
| `pending` | criado, aguardando confirmação ou pagamento de sinal |
| `confirmed` | confirmado pelo cliente ou automaticamente |
| `checked_in` | cliente chegou |
| `waiting` | aguardando na recepção |
| `in_progress` | atendimento iniciado |
| `completed` | finalizado |
| `cancelled_customer` | cancelado pelo cliente |
| `cancelled_business` | cancelado pela barbearia |
| `no_show` | não compareceu |
| `rescheduled` | remarcado (aponta para o novo) |

**`cancelled_customer` e `cancelled_business` são separados de propósito:** só o
primeiro afeta o reliability score do cliente. Punir cliente por cancelamento da
barbearia é bug de produto.

`no_show` é aplicado automaticamente após X min do horário sem check-in
(configurável, default 20), com possibilidade de reversão manual pela recepção.

### Origem do agendamento
```
website · app · whatsapp · instagram · google · marketplace
recepcao · profissional · api · recorrencia · waitlist
```
Permite medir aquisição por canal e calcular o retorno do marketplace.

---

## 2.12 Prevenção de no-show

Configurável por estabelecimento, e — o diferencial — **por cliente**.

| Modalidade | Descrição |
|---|---|
| Sem garantia | cliente simplesmente agenda |
| Cartão de garantia | cartão registrado, cobrado só em caso de falta |
| Sinal fixo | ex.: R$ 20 |
| Percentual | ex.: 30% antecipado |
| Pagamento completo | 100% |

### Camada 1 — Lembrete (MVP, maior ROI)
- **24h antes** — fator decisivo, responde por boa parte da redução de 40–70%
- **2h antes** — captura o esquecimento de última hora
- Botões no WhatsApp: **Confirmar · Remarcar · Cancelar**

Um cancelamento 24h antes é receita recuperável via fila. Um no-show é perda
total. **O lembrete converte um no outro** — esse é o mecanismo, não o "aviso".

### Camada 2 — Sinal seletivo
Cobrar sinal de todo mundo espanta cliente novo; não cobrar de ninguém deixa a
agenda exposta. A regra é condicional:

```
exigir_sinal = (reliability_score < limiar)
            OR (ticket > valor_limite)
            OR (cliente_novo AND horario_de_pico)
            OR (servico.always_require_deposit)
```

### Camada 3 — Fila automática
Vaga aberta por cancelamento é preenchida sem intervenção (§2.9).

---

## 2.13 Reliability Score

Funcionalidade proprietária. Score de **0 a 100** por cliente, por empresa.

**Entradas:** total de agendamentos · comparecimentos · cancelamentos ·
antecedência de cada cancelamento · no-shows · atrasos

```
score = 100
      − 25 × taxa_no_show
      − 10 × taxa_cancelamento_tardio      (< 4h de antecedência)
      −  2 × taxa_cancelamento_antecipado  (≥ 24h — quase não pune)
      −  5 × taxa_atraso_relevante         (> 10 min)
      + 10 × bônus_histórico               (≥ 10 comparecimentos consecutivos)
```

### Regras de justiça — obrigatórias
1. **Cliente novo começa em 100**, não em 50. Presunção de boa-fé; o produto não
   pode punir quem ainda não tem histórico.
2. **Cancelamento com boa antecedência quase não pune.** O objetivo é *incentivar
   avisar cedo*. Punir cancelamento antecipado ensina o cliente a simplesmente não
   aparecer — o oposto do desejado.
3. **`cancelled_business` nunca conta.**
4. **Mínimo de 3 agendamentos** antes do score ter qualquer efeito.
5. **Score é interno.** Nunca exibido ao cliente, nunca exibido no site público.
   Score visível vira constrangimento e reclamação.
6. **Recuperável:** janela móvel de 12 meses. Quem faltou há um ano e voltou a
   comparecer recupera integralmente.
7. **Override manual** pelo gerente, com justificativa auditada.

### Uso
```
score < 60  → sinal obrigatório
score < 40  → sem agendamento online em horário de pico (só recepção)
score ≥ 85  → prioridade na fila de espera; dispensa de sinal mesmo em regra geral
```

---

## 2.14 UX da agenda (admin)

**Views:** Dia · Semana · Lista

Colunas por profissional. Cards coloridos por status.

```
┌──────────────────────┐
│ 10:00 · CONFIRMADO   │
│ Carlos Souza         │
│ Corte + Barba        │
│ João · R$ 74,00      │
└──────────────────────┘
```

**Drag-and-drop** para reagendar, sempre com confirmação:
> Alterar Carlos de 10:00 para 10:40?  **[Confirmar]**

Requisitos da grade:
- Intervalos e bloqueios visíveis, hachurados, com o motivo
- Buffer renderizado distinto da execução
- Buraco morto acima de X min destacado — vira sugestão de encaixe ou campanha
- Linha do "agora" e indicação de atraso acumulado do profissional

---

## 2.15 Concorrência e integridade

O concorrente faz checagem otimista antes de gravar e mostra
`"Este horário já não está mais disponível"`. É o mínimo, e é insuficiente sob
carga real.

Requisitos:

1. **Reserva sob lock** — `SELECT ... FOR UPDATE` na janela do profissional, ou
   constraint de exclusão no PostgreSQL:
   ```sql
   EXCLUDE USING gist (
     professional_id WITH =,
     tstzrange(start_at, end_at) WITH &&
   ) WHERE (status NOT IN ('cancelled_customer','cancelled_business','no_show'))
   ```
   O banco passa a ser a autoridade final. Overbooking vira impossível, não
   improvável.

2. **Idempotência** — `POST /appointments` aceita `Idempotency-Key`. Duplo toque
   em celular lento não gera dois agendamentos.

3. **Hold temporário** — ao entrar no pagamento do sinal, o slot fica em `hold`
   por 10 min. Sem isso o cliente perde o horário enquanto digita o cartão.

4. **Mensagem honesta na corrida** — reaproveitar o acerto do concorrente:
   > "Este horário já não está mais disponível. Tente em um outro horário."

   E ir além: **já oferecer os 3 horários mais próximos** e a entrada na fila.
