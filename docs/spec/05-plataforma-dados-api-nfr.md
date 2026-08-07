# Parte 5 — Site público, marketplace, dados, API e plataforma

← [SPEC.md](../../SPEC.md)

---

## 5.1 Site público da barbearia

> **Resolve D6, D8, D9.** O concorrente entrega uma SPA cujo HTML inicial contém
> apenas `<title>Agende online</title>` — nome, serviços, preços e endereço são
> invisíveis ao Google. Para negócio local isso é caro: a página só funciona como
> destino de link, nunca como fonte de tráfego.

Muito mais que um agendador — é a landing page do negócio.

### Estrutura

**Header** — logo · nome · avaliação · endereço · **status aberto/fechado** · botão Agendar

**Hero** — foto principal · CTA **Agendar horário**

**Serviços** — cards com serviço · descrição · duração · preço inicial · foto

**Profissionais** — foto · nome · especialidade · nota · nº de avaliações · portfólio

**Portfólio** — cortes · barba · antes/depois *(só com consentimento de uso público — Parte 4 §4.2)*

**Avaliações** — apenas verificadas, de atendimento real

**Localização** — mapa

**Funcionamento** — horários por dia

**Informações** — estacionamento · acessibilidade · Wi-Fi · métodos de pagamento ·
política de cancelamento

**Assinaturas** — clubes disponíveis

**CTA fixo** — **Agendar agora**

### Requisitos técnicos obrigatórios

| Requisito | Motivo |
|---|---|
| **SSR/SSG** da página pública | **D6** — sem isso não há SEO nenhum |
| **JSON-LD** `LocalBusiness` + `Service` + `AggregateRating` | rich snippet no Google com nota, preço e horário |
| **`OpeningHoursSpecification`** | Google mostra "Aberto agora" |
| Meta tags OG/Twitter por página **e por serviço** | preview correto ao colar no WhatsApp/Instagram |
| **Deep link por serviço e por profissional** (Parte 2 §2.6) | link da bio vira conversão |
| **PWA instalável** | ícone na home sem loja de app |
| LCP < 2,5s em 4G | público majoritariamente mobile |
| **Bundle do cliente separado do admin** | **D10** — hoje o concorrente entrega o ERP inteiro a um visitante anônimo |
| Sitemap por tenant | indexação de todas as páginas de serviço |

### Status "aberto/fechado"
Calculado no servidor, no fuso da unidade, considerando jornada + feriado +
exceção. Mostrar "Abre amanhã às 09:00" quando fechado — é a informação que a
metade não-agendante da audiência veio buscar (**D8**).

---

## 5.2 Marketplace (Release 5)

Descoberta geográfica, no modelo Booksy/Fresha.

**Busca:** "Barbearias perto de mim"

**Filtros:** distância · preço · avaliação · **disponível hoje** · **disponível
agora** · serviço · profissional · assinatura · acessibilidade

### Card de resultado
```
[ foto ]
Box Seis                      ⭐ 4,9 · 842 avaliações
1,2 km · Corte a partir de R$ 55,00
Próximo horário: 17:40                       [ Agendar ]
```

`Próximo horário` como elemento principal do card é o que diferencia de diretório —
e exige que `/availability` seja rápido o bastante para rodar em lote (§5.6).

### Perfil público do barbeiro (opcional, por profissional)
```
João Silva                    ⭐ 4,92 · 1.842 atendimentos
Especialidades: fade · degradê · barba · corte social
[ portfólio ]  [ horários ]  [ Agendar com João ]
```

### Política comercial — decisão de posicionamento
**Comissão de marketplace incide exclusivamente sobre cliente novo trazido pela
plataforma.** Cliente que a barbearia já tinha na base nunca gera comissão, mesmo
que agende pelo app do marketplace.

Cobrar sobre base própria é a principal fonte de revolta contra Fresha (20% sobre
cliente novo) e Booksy — e é exatamente a brecha a explorar no discurso de venda.

Atribuição via `appointments.source` e `customer.acquired_via` (Parte 2 §2.11),
com janela de atribuição e regra de desempate documentadas no contrato.

---

## 5.3 Aplicativo do cliente

**Home**
```
Próximo agendamento
João · Box Seis · Hoje 18:30
[ Como chegar ]  [ Remarcar ]  [ Cancelar ]
```

**Áreas:** Agendar · Favoritos · Assinaturas · Fidelidade · Histórico · Perfil

### Experiência sem app — inegociável
Não obrigar download. Tudo funciona via web/PWA. Login por telefone + OTP.
App nativo pode existir depois, **nunca como pré-requisito**.

> Evidência: o principal argumento contra o AppBarber no mercado é justamente
> forçar o cliente a baixar um app. A maioria prefere agendar pelo navegador do
> celular sem instalar nada. O concorrente analisado acerta nisso — e essa
> vantagem não pode ser perdida.

---

## 5.4 Notificações

**Canais:** WhatsApp · push · e-mail · SMS

**Eventos:** confirmação · lembrete · cancelamento · alteração · vaga na fila de
espera · aniversário · retorno · pagamento · assinatura · promoção

### Classificação obrigatória
Toda notificação é **transacional** ou **promocional**. Opt-out de marketing
silencia apenas as promocionais. Confundir as duas é violação de LGPD e é o erro
mais comum do setor.

**Preferência por canal e por tipo**, controlada pelo cliente.

---

## 5.5 Modelo de dados

```
── Identidade e estrutura ──
tenants · tenant_slugs · brands · locations · users · roles · permissions
role_permissions · user_roles · feature_flags · audit_logs

── Pessoas ──
professionals · professional_services · customers · customer_preferences
customer_notes · customer_photos · customer_consents · customer_scores

── Catálogo ──
services · service_categories · service_components · service_resources
resources · resource_types

── Agenda ──
work_schedules · schedule_exceptions · blocks
appointments · appointment_services · appointment_recurrences
waitlist_entries · walkin_queue · slot_holds

── Vendas ──
orders · order_items · payments · payment_splits · refunds
commissions · commission_rules · commission_closings
cash_sessions · cash_movements · financial_transactions
customer_balances · advances

── Estoque ──
products · product_categories · stock_locations · inventory_movements
service_consumption · suppliers · purchase_orders · purchase_order_items

── Recorrência ──
membership_plans · memberships · membership_usage · membership_invoices
packages · package_purchases · package_usage
loyalty_accounts · loyalty_transactions · referrals

── Relacionamento ──
reviews · review_recoveries · campaigns · campaign_targets
messages · message_templates · notifications · notification_preferences

── Fiscal e inteligência ──
invoices · fiscal_settings · ai_insights · ai_audit_log
```

### Convenções
- `tenant_id` em toda tabela de negócio (Parte 1 §1.1), com RLS no PostgreSQL.
- IDs públicos são UUID/ULID, nunca sequenciais.
- Datas em `timestamptz`, sempre UTC; fuso da unidade aplicado na leitura.
- Dinheiro em `numeric(12,2)` ou inteiro de centavos — **nunca** float.
- Soft delete só onde há exigência legal; no resto, deletar de verdade (LGPD).

### `appointments` — modelo base
```
id                 uuid pk
tenant_id          uuid
location_id        uuid
customer_id        uuid
professional_id    uuid
start_at           timestamptz
end_at             timestamptz          -- inclui buffers
service_end_at     timestamptz          -- fim visível ao cliente
status             enum                 -- Parte 2 §2.11
source             enum                 -- Parte 2 §2.11
recurrence_id      uuid null
rescheduled_from   uuid null
notes              text
subtotal           numeric(12,2)
discount           numeric(12,2)
total              numeric(12,2)
deposit_required   numeric(12,2)
deposit_paid       numeric(12,2)
created_at         timestamptz
updated_at         timestamptz
```

Com a constraint de exclusão anti-overbooking da Parte 2 §2.15.

**`end_at` vs `service_end_at`:** o primeiro inclui buffer e governa a alocação; o
segundo é o que o cliente vê. Separar os dois é o que permite buffer invisível sem
mentir para o cliente.

---

## 5.6 API

REST na v1.

```
POST   /auth/otp                        envia código
POST   /auth/verify                     valida e retorna sessão

GET    /locations
GET    /services
GET    /professionals
GET    /availability                    ← núcleo (Parte 2 §2.4)

POST   /appointments                    (Idempotency-Key obrigatório)
PATCH  /appointments/{id}
POST   /appointments/{id}/cancel
POST   /appointments/{id}/reschedule    ← atômico (Parte 2 §2.7)
POST   /appointments/{id}/check-in

POST   /waitlist
DELETE /waitlist/{id}

POST   /orders
POST   /orders/{id}/items
POST   /payments
POST   /payments/{id}/refund

POST   /memberships
GET    /memberships/{id}/usage

GET    /analytics/dashboard
```

### Padrões obrigatórios
- Versionamento em path (`/v1`).
- `Idempotency-Key` em todo POST que move dinheiro ou cria agendamento.
- Paginação por cursor, nunca offset (base grande + concorrência).
- Erros padronizados com `code` estável, `message` humano e `field` quando aplicável.
- Rate limit por tenant e por IP; limites mais duros em `/auth/otp` e
  `/availability`.
- Webhooks assinados (HMAC) para integração de terceiro.

---

## 5.7 Validador de integridade de catálogo

> **Resolve D4 e D5** — os defeitos mais caros encontrados no concorrente.

Roda no onboarding, a cada alteração de catálogo e em varredura diária. Emite
alerta acionável no dashboard.

### Regras

| # | Regra | Severidade |
|---|---|---|
| V1 | Combo com duração < soma das partes − tolerância declarada | **bloqueia** |
| V2 | Combo com preço ≥ soma das partes (combo sem vantagem) | aviso |
| V3 | Serviço em categoria incoerente com o nome | aviso |
| V4 | > 40% dos serviços em "Outros" | aviso |
| V5 | Serviço sem profissional habilitado | **bloqueia publicação** |
| V6 | Serviço sem descrição ou sem foto | aviso |
| V7 | Duração fora de 2σ da mediana real medida | aviso |
| V8 | Serviço sem buffer numa categoria que costuma ter | aviso |
| V9 | Profissional com jornada > 12h/dia em 7 dias | aviso — provável agenda de balcão (**D12**) |
| V10 | Preço zerado ou nulo | **bloqueia** |

### V7 — duração real vs. cadastrada
O sistema mede o tempo real (`in_progress` → `completed`) e compara com o
cadastro:

```
⚠ Cabelo + Barba
  Cadastrado: 30 min
  Real (últimos 40 atendimentos): 43 min — mediana
  Impacto: ~13 min de atraso por atendimento
           ≈ 1h05 de atraso acumulado por dia
  [ Ajustar para 45 min ]
```

**Este alerta sozinho justifica a migração** para uma barbearia que hoje sofre com
atraso crônico e não sabe a causa. É o achado D4 transformado em funcionalidade.

---

## 5.8 Migração e importação

> Ausente da SPEC v1.0 e **crítico para go-to-market**. Barbearia estabelecida não
> começa do zero: ela tem base de clientes, histórico e agenda futura. Sem
> importador, a venda morre na objeção "vou perder meus clientes".

### Fontes prioritárias
SalonSoft · AppBarber · Trinks · Belle · planilha CSV/Excel · Google Agenda ·
agenda de papel (digitação assistida)

### Escopo mínimo
| Dado | Prioridade |
|---|---|
| Clientes (nome, telefone, aniversário) | **crítico** |
| Agendamentos futuros | **crítico** — não podem se perder na virada |
| Serviços e preços | alto |
| Profissionais e jornadas | alto |
| Histórico de atendimento | médio — alimenta ciclo e segmentação desde o dia 1 |
| Saldo de pacote e assinatura ativa | **crítico** se existir — cliente pagou |
| Fiado em aberto | **crítico** se existir |

### Requisitos
- **Deduplicação por telefone normalizado** (E.164), com revisão manual dos
  conflitos.
- Preview antes de aplicar: "1.240 clientes, 38 duplicados, 12 telefones
  inválidos".
- **Reversível** — importação errada é desfeita inteira.
- Idempotente: reimportar o mesmo arquivo não duplica.
- Ao importar histórico, **não disparar automação retroativa**. Importar 1.200
  clientes e mandar 1.200 mensagens de "sentimos sua falta" no primeiro dia é o
  erro que queima o número de WhatsApp e a conta da barbearia.
- Período de operação paralela: agenda antiga em leitura, nova em escrita, por 1–2
  semanas.

### Slug legado
Ao migrar de outro sistema, permitir cadastrar o slug antigo em `tenant_slugs`
para o link da bio continuar funcionando (Parte 1 §1.5).

---

## 5.9 Arquitetura técnica

### Stack recomendada (v1)
| Camada | Escolha |
|---|---|
| Frontend | Next.js / React — **SSR obrigatório na página pública** (§5.1) |
| Mobile | PWA |
| Backend | FastAPI, NestJS ou equivalente |
| Banco | PostgreSQL |
| Cache | Redis |
| Filas | Redis Queue / RabbitMQ / SQS |
| Arquivos | storage S3-compatible, URLs assinadas |
| Analytics | PostgreSQL + camada de eventos; warehouse depois |

### Estratégia
**Modular monolith bem estruturado.** Não começar com dezenas de microsserviços.

**Domínios:** Identity · Scheduling · CRM · Sales · Payments · Membership ·
Inventory · Finance · Marketing · Analytics

Cada domínio tem fronteira explícita, comunicação por interface e eventos, e
schema próprio no banco. Extrair microsserviço só quando escala **ou** organização
justificar — e o candidato natural é Scheduling, por ser o mais chamado.

### Separação de bundles
> **Resolve D10.**

```
app-public    site público + agendamento do cliente   (SSR, leve)
app-admin     gestão da barbearia                     (SPA)
app-pro       agenda do barbeiro                      (PWA)
```

Três aplicações, um backend. Nunca entregar o bundle do ERP a um visitante
anônimo — o concorrente faz isso hoje, expondo todo o mapa de API e pesando no
celular do cliente.

---

## 5.10 Arquitetura orientada a eventos

```
appointment.created            appointment.confirmed
appointment.cancelled          appointment.completed
appointment.rescheduled        customer.checked_in
customer.no_show               payment.completed
payment.failed                 payment.refunded
membership.started             membership.payment_failed
membership.cancelled           package.depleted
review.created                 review.negative
stock.low                      stock.expiring
customer.churn_risk_changed    customer.segment_changed
waitlist.slot_available        commission.closed
```

**Consumers:** WhatsApp · notificações · comissão · fidelidade · CRM · IA ·
estoque · fila de espera · fiscal · analytics

### Requisitos
- **Idempotência por `event_id`** em todo consumer. Evento entregue duas vezes não
  pode gerar comissão dobrada nem duas mensagens.
- Outbox pattern: publicar evento na mesma transação da escrita, nunca depois.
- Dead letter queue com alerta.
- Ordenação garantida por agregado (`appointment_id`), não global.
- Reprocessamento seguro — replay de evento é ferramenta de suporte.

---

## 5.11 Integrações — abstrações

Nunca acoplar ao fornecedor. Interface primeiro, implementação depois.

```
PaymentProvider    múltiplos adquirentes; Pix, cartão, link
WhatsAppProvider   API oficial
FiscalProvider     NFS-e / NF-e (Parte 3 §3.11)
EmailProvider      transacional
StorageProvider    fotos e documentos
MapsProvider       Google Maps ou equivalente
CalendarProvider   Google Calendar / Apple (futuro)
SmsProvider        fallback de OTP
```

Cada provider tem implementação `fake` para testes e ambiente de desenvolvimento.

---

## 5.12 Requisitos não funcionais

### Disponibilidade
Meta inicial: **99,9%**.
Janela de manutenção nunca entre sexta 16h e sábado 20h — é o pico do setor.

### Performance
| Endpoint | Meta |
|---|---|
| APIs comuns | P95 < 500 ms |
| `/availability` | P95 < 800 ms (7 dias × 5 profissionais) |
| Página pública (LCP, 4G) | < 2,5 s |
| PDV — comanda a pagamento | < 1 s percebido |

### Segurança
TLS · criptografia de dados sensíveis em repouso · MFA para papéis financeiros ·
rate limiting · proteção contra brute force · **segregação de tenant com RLS** ·
backups · logs · rotação de segredos · varredura de dependências

Atenção específica ao endpoint de OTP (Parte 1 §1.6): é a porta de entrada tanto
para custo de mensagem quanto para enumeração de base.

### Backup
PITR do banco. **Teste de restauração mensal** — backup não testado não é backup.

### Observabilidade
logs estruturados · métricas · tracing distribuído · alertas

**Alertas de negócio, não só de infra:** queda na taxa de conversão do
agendamento, pico de erro de pagamento, fila de mensagens travada, queda no volume
de agendamento por tenant. Um bug que derruba a conversão em 30% não aciona alerta
de CPU — e é muito mais grave.

---

## 5.13 UX do admin

**Menu principal**
```
Início · Agenda · Clientes · Comandas · Caixa · Equipe · Assinaturas
Produtos · Estoque · Marketing · Financeiro · Relatórios · IA · Configurações
```

Itens somem conforme plano e permissão (SPEC §3 — complexidade progressiva). Não
ficam cinza com cadeado.

### Dashboard do proprietário
```
── Hoje ─────────────────────────────────────
Faturamento          R$ 5.820,00      ↑ 12%
Agendamentos                  84
Ocupação                     87%
Ticket médio         R$    69,28      ↑  3%
No-show                     3,2%      ↓ 1,1pp
Assinaturas ativas           342
Novos clientes                12
```

Toda métrica traz comparação com o período anterior. Número sem comparação não
gera decisão.

### Dashboard de crescimento
novos clientes · recorrência · retenção · churn · frequência · LTV · CAC
(quando disponível) · ocupação · **receita por cadeira** · **receita por hora** ·
receita por profissional

### Heatmap de ocupação
```
Horário   Seg    Ter    Qua    Qui    Sex    Sáb
09        30%    20%    40%    55%    70%   100%
14        40%    25%    45%    60%    90%   100%
19        80%    70%    85%   100%   100%     —
```

Célula fria é clicável e vira campanha direcionada (Parte 4 §4.18) — o heatmap não
é relatório, é ponto de partida de ação.
