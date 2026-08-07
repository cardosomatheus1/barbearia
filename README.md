# Plataforma Inteligente de Gestão para Barbearias

Monorepo TypeScript.

- [`SPEC.md`](SPEC.md) — o que o produto é
- [`ROADMAP.md`](ROADMAP.md) — em quantos blocos, em que ordem
- **[`CLAUDE.md`](CLAUDE.md) — as regras de engenharia. Vinculante para todo bloco.**

## Estado atual

Primeira fatia: **domínio Scheduling** — o motor de agendamento e as garantias de
integridade do banco.

| Pacote | O que é | Estado |
|---|---|---|
| `packages/core` | Motor de disponibilidade — lógica pura, sem banco e sem relógio | 118 testes ✅ |
| `packages/db` | Schema, migrações, RLS e cliente com escopo de tenant | 16 invariantes + 10 testes ✅ |
| `packages/scheduling` | Repositórios, disponibilidade e reserva | 44 testes ✅ |
| `packages/identity` | OTP por WhatsApp, sessão do cliente, consentimentos | 26 testes ✅ |
| `packages/ui` | Design system: tokens, tema, componentes acessíveis | 77 testes ✅ |
| `apps/api` | API pública: disponibilidade, login, agendamento | 35 testes e2e ✅ |

Três dos testes de `core` são **guardas de arquitetura**: falham se alguém der
dependência ao core, importar algo externo nele ou usar `Date.now()` na lógica.

## Rodando

```bash
pnpm install

# Portão único do Definition of Done: typecheck + build + todas as suítes.
export ADMIN_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres"
pnpm verify

# Ou por partes:
pnpm --filter @barbearia/core test        # motor, sem banco
pnpm -r typecheck

# Testes de banco exigem Postgres 16+ com pgcrypto, citext e btree_gist.
# Cada script cria e destrói o próprio banco descartável.
pnpm --filter @barbearia/db test          # invariantes do schema
pnpm --filter @barbearia/scheduling test  # pipeline banco -> motor
pnpm --filter @barbearia/api test         # e2e da API
```

`pnpm verify` **falha** se os testes de banco forem pulados por falta de
`ADMIN_DATABASE_URL`. Pular em silêncio seria o padrão perigoso.

O role da aplicação é criado por `scripts/bootstrap-role.sh`, que exige
`APP_DB_PASSWORD` e não tem default — os scripts de teste geram uma senha
efêmera por execução, então não há credencial no repositório.

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

### Reserva tem duas defesas, não uma

O horário pedido precisa constar da grade que o motor calcula — jornada, buffer,
recurso, limite diário, antecedência. E a constraint de exclusão rejeita
sobreposição no banco.

Nenhuma das duas basta sozinha. A validação tem uma janela entre calcular e
gravar; a constraint não sabe nada sobre expediente ou recurso. Sob corrida real,
uma das duas pega — e o teste aceita qualquer um dos dois códigos de erro, porque
ambos são respostas corretas e nenhum deles é overbooking.

### Mobile-first é regra verificada

Toda media query de layout usa `min-width`, e há teste que rejeita `max-width`.
O piso de projeto é 360px — o Android popular no Brasil, o aparelho em que o
cliente da barbearia realmente agenda.

Três defeitos comuns de página de barbearia no celular têm teste próprio:
rolagem horizontal da página, imagem estourando o recipiente, e botão principal
sob a barra de gestos do iPhone.

### Contraste é medido, não declarado

Cada par de cores que a interface usa está declarado em `CONTRAST_PAIRS` e
verificado contra a WCAG por teste. "Usamos cores acessíveis" sem medição é
opinião — e a primeira troca de paleta a quebra sem ninguém notar.

Isso já pagou: o âmbar do tema claro reprovou duas vezes antes de passar. A cor
final saiu de cálculo, não de gosto.

O CSS é gerado a partir dos tokens tipados, então não existe uma segunda lista
para ficar desatualizada.

### Agendar custa nome + celular. Só isso.

Sem senha, sem e-mail, sem app e **sem código**. O cliente escolhe serviço,
profissional e horário sem se identificar, informa nome e celular no fim, e
confirma. É o fluxo do sistema analisado — cujo componente envia o campo de
código sempre vazio e conclui sem verificação alguma.

O código entra só em **ver, cancelar e remarcar**. A fronteira está aí porque
criar um agendamento não exige provar posse do número, mas cancelar o
agendamento de outra pessoa, sim.

Consequência aceita conscientemente: dá para agendar com o telefone de outra
pessoa. É o que o mercado pratica, e a unidade que sofrer com isso liga
`require_otp_for_booking`. Informar telefone alheio nunca dá acesso ao histórico
nem permite cancelar o que já existe.

A sessão dura 90 dias, então quem já validou o número não repete o código.

O código nunca vai para log: `ConsoleMessagingProvider` imprime telefone
mascarado e mais nada. Log com código de uso único transforma acesso ao log em
acesso à conta.

### Isolamento tem dois níveis, não um

A RLS separa barbearias. Ela **não** separa clientes dentro da mesma barbearia —
para isso, toda operação disparada pelo cliente filtra por `customer_id`.

Pela mesma razão, a chave de idempotência é derivada de `tenant + cliente +
chave bruta`. A chave bruta vem do cliente e é livre: sem derivação, duas pessoas
mandando `"1"` colidiriam e a segunda receberia de volta o agendamento da
primeira.

### Preço e duração nunca vêm da requisição

O cliente informa data, profissional e início. O resto sai do catálogo. Aceitar
preço vindo do cliente seria deixá-lo escolher quanto paga.

### A conexão da aplicação não pode ignorar RLS

`assertRlsEnforced()` roda na subida da API e recusa iniciar se o role for
superusuário ou tiver `BYPASSRLS`. Uma conexão assim desliga o isolamento
silenciosamente: nada falha, nada avisa, e cada barbearia passa a enxergar a base
inteira.

Isso não é hipotético — foi exatamente o que aconteceu no arnês de testes deste
bloco, onde os testes de isolamento passavam sem provar nada.

### Disponibilidade é carregada por intervalo, não por dia

`GET /availability` aceita `dateFrom`/`dateTo`. O contexto do intervalo inteiro é
carregado numa leva e recortado por dia — consultar dia a dia num laço seria N+1
entre datas, e a meta é 7 dias × 5 profissionais abaixo de 800 ms.

O intervalo tem teto de 14 dias. Sem ele, um único pedido varre anos de agenda.

### Slug resolve antes de existir tenant

A RLS filtra por `app.tenant_id`, mas para descobrir o tenant a API precisa
consultar o slug — que é o que ela ainda não resolveu. `tenant_slugs` é a única
tabela com leitura pública, e **só leitura**: escrita continua restrita ao dono.
O `tenant_id` resolvido nunca sai da API.

### Contenção de recurso recorta a janela, não filtra o slot

Quando a única cadeira libera às 09:20, o slot seguinte nasce às 09:20. Filtrar
candidatos depois de gerá-los produziria o mesmo desperdício da grade fixa por
outra via: a janela do barbeiro ancoraria em 09:00 e o passo pularia para 09:30.

`saturatedRanges` calcula as faixas em que o recurso não comporta mais a
exigência, e elas são subtraídas da janela **antes** da geração.

### Isolamento de tenant no banco, não só no código

RLS com `FORCE` em todas as tabelas de negócio, via `app.tenant_id` fixado dentro
da transação. Não existe acesso ao banco fora de `withTenant`, porque o pool
reaproveita conexões e uma sessão herdaria o tenant da requisição anterior.

O role da aplicação é `NOBYPASSRLS` de propósito. As consultas do repositório
deliberadamente não repetem `tenant_id` no `WHERE` — quem filtra é a política.

## Documentação

| Documento | Conteúdo |
|---|---|
| [`SPEC.md`](SPEC.md) | Visão, evidências de campo, métricas |
| [`ROADMAP.md`](ROADMAP.md) | Os 76 blocos de execução e o escopo recomendado |
| [`docs/spec/`](docs/spec/) | Especificação detalhada em 5 partes |
| [`docs/01-analise-salonsoft.md`](docs/01-analise-salonsoft.md) | Engenharia reversa do concorrente em produção |
| [`docs/02-benchmark-apps-barbearia.md`](docs/02-benchmark-apps-barbearia.md) | Matriz competitiva e preços de mercado |

## Próximos passos

Bloco 3 de 76 — ver [`ROADMAP.md`](ROADMAP.md).

API com middleware de tenant e `GET /availability`. O pipeline banco → motor já
funciona ponta a ponta; falta expô-lo.

**Lacuna conhecida:** bloqueios pontuais (barbeiro fechar uma hora específica)
ainda não têm tabela. O motor já aceita `blocks`; o repositório passa vazio. Vem
com o bloco 12, a agenda do admin.
