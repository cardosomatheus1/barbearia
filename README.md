# Plataforma Inteligente de Gestão para Barbearias

Monorepo TypeScript. A especificação completa está em [`SPEC.md`](SPEC.md).

## Estado atual

Primeira fatia: **domínio Scheduling** — o motor de agendamento e as garantias de
integridade do banco.

| Pacote | O que é | Estado |
|---|---|---|
| `packages/core` | Motor de disponibilidade — lógica pura, sem banco e sem relógio | 88 testes ✅ |
| `packages/db` | Schema, migrações e testes de integridade | 13 invariantes ✅ |

## Rodando

```bash
pnpm install
pnpm --filter @barbearia/core test        # motor
pnpm --filter @barbearia/core typecheck

# Testes de banco exigem um Postgres 16+ com as extensões
# pgcrypto, citext e btree_gist disponíveis.
export ADMIN_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres"
pnpm --filter @barbearia/db test
```

## Decisões que valem conhecer antes de mexer

### O motor é função pura

`computeAvailability` não lê relógio, não acessa banco e não depende do fuso do
processo. Recebe minutos locais, devolve minutos locais. Toda conversão para
instante UTC acontece em `zone.ts`, na borda.

Consequência prática: a suíte roda idêntica sob `TZ=UTC` e `TZ=Asia/Tokyo`. Isso
é verificado — não é promessa.

### Slot ancorado em vez de grade fixa

Os sistemas existentes oferecem horários numa grade rígida de 15 minutos. Se um
atendimento termina às 09:20, a grade só oferece 09:30 e os 10 minutos morrem.

O modo `anchored` gera o primeiro slot no início da janela livre e um slot de
cauda no último início que ainda cabe, eliminando o desperdício nas duas pontas.
Numa jornada de 9 horas com serviços de 20 minutos, a diferença é da ordem de
dois atendimentos por profissional por dia.

O modo `grid` continua disponível por configuração — parte das barbearias prefere
horário redondo para o cliente memorizar.

### Duração de combo nunca é inferida

`Corte + Barba` ocupa a soma das partes, a menos que exista uma regra de combo
declarada. O sistema analisado em campo tinha `Cabelo + Barba + Sobrancelha`
cadastrado como 30 minutos por R$ 94 — três serviços em meia hora. A agenda
subestimava o tempo real e acumulava atraso ao longo do dia.

### Overbooking é impossível, não improvável

A constraint de exclusão em `appointments` faz o Postgres rejeitar qualquer
sobreposição no mesmo profissional. Checagem otimista na aplicação não resolve
corrida entre dois clientes; a constraint resolve.

```sql
EXCLUDE USING gist (
  professional_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status NOT IN ('cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled'))
```

O intervalo é semiaberto de propósito: um agendamento que começa exatamente onde
o anterior termina é encaixe justo, não conflito.

### Isolamento de tenant no banco, não só no código

RLS com `FORCE` em todas as tabelas de negócio. Um `WHERE tenant_id` esquecido no
repositório não vaza dados — o teste `OK 12` consulta deliberadamente sem filtro
e recebe zero linhas.

## Documentação

| Documento | Conteúdo |
|---|---|
| [`SPEC.md`](SPEC.md) | Visão, evidências de campo, roadmap, métricas |
| [`docs/spec/`](docs/spec/) | Especificação detalhada em 5 partes |
| [`docs/01-analise-salonsoft.md`](docs/01-analise-salonsoft.md) | Engenharia reversa do concorrente em produção |
| [`docs/02-benchmark-apps-barbearia.md`](docs/02-benchmark-apps-barbearia.md) | Matriz competitiva e preços de mercado |

## Próximos passos

1. Repositórios do domínio Scheduling: resolver jornada + exceções + bloqueios de
   uma data em `ProfessionalDay` (a entrada do motor).
2. `GET /availability` e `POST /appointments` com `Idempotency-Key`.
3. Reagendamento atômico — reserva o novo antes de liberar o antigo.
4. Página pública com SSR e deep link por serviço.
