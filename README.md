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
| `apps/api` | API pública: perfil, disponibilidade, login, agendamento | 51 testes e2e ✅ |
| `apps/web` | Página pública com SSR (Next.js) | — |

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

### O herói da página é a disponibilidade, não uma foto

Toda página de barbearia abre igual: foto grande, botão "AGENDE AGORA", agenda a
três toques de distância. Aqui a primeira coisa são os horários livres de hoje,
renderizados no servidor e já tocáveis.

Quem chega pelo link da bio já viu as fotos no Instagram — veio saber quando dá
para ir. Direção completa em [`docs/03-direcao-visual.md`](docs/03-direcao-visual.md).

### O HTML sai pronto do servidor

Nome, endereço, serviços, preços, horários e JSON-LD `HairSalon` vêm no HTML
inicial. O sistema analisado entrega uma casca com `<title>Agende online</title>`
e nada mais — nenhum buscador indexa a barbearia (defeito D6).

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
| [`docs/03-direcao-visual.md`](docs/03-direcao-visual.md) | Direção visual da página pública, antes do CSS |

## Agendar sem login

O fluxo público vai de serviço a comprovante em quatro passos — **sem código,
sem senha, sem conta**. Nome e celular bastam, que é como o concorrente
analisado opera e como o cliente de barbearia espera.

O código no WhatsApp continua existindo, mas só na fronteira que importa: **ver
histórico, cancelar e remarcar**. Sem ele, conhecer o telefone de alguém daria
poder sobre a agenda dessa pessoa.

O passo está marcado na URL (`?e=p|h|d`), não inferido do que já está
preenchido. Inferir quebrava o carrinho de múltiplos serviços: escolher um só
pulava direto para o passo seguinte, e escolher o segundo virava impossível.

O comprovante é lido da API pelo id, nunca reconstruído da URL. Repetir o que o
formulário enviou seria afirmar sem conferir — "Qualquer profissional" nunca
viraria um nome, e um horário cancelado continuaria dizendo "confirmado".

## Bloqueio pontual, combo e janela

Três coisas que o sistema sabia e não usava, fechadas depois do bloco 9:

**O barbeiro pode fechar uma hora do dia.** `schedule_exceptions` só sabia
"não trabalha" e "trabalha em outro horário" — faltava o caso mais comum, o
dentista às 14h. O motor aceitava `blocks` desde o bloco 1 e o repositório
passava lista vazia: teste verde, capacidade inexistente. Agora existe o tipo
`block`, e ele recorta a grade **e** recusa a gravação.

**O carrinho avisa quando o combo sai mais barato.** Na Domari, Cabelo
(Tesoura) + Barba avulsos somam R$ 84,00; o mesmo atendimento está no cardápio
por R$ 74,00. Quem montava à mão pagava R$ 10,00 a mais sem saber. A detecção
está em `packages/core/src/bundles.ts` e sugere uma troca só — a de maior
economia —, com link, não troca automática.

**Remarcar pode trocar de profissional.** Antes exigia cancelar e agendar de
novo, o que jogava fora o horário atual antes de saber se havia outro.

## Cancelar e remarcar

Ver histórico, cancelar e remarcar **exigem o código** no WhatsApp. É a fronteira
do produto: sem ela, conhecer o telefone de alguém daria poder sobre a agenda
dessa pessoa.

A sessão vai em cookie `httpOnly`, um por barbearia — no nome **e** no caminho.
`localStorage` guardaria a credencial de cancelamento ao alcance de qualquer
script; e um cookie de nome único faria quem tem sessão em duas barbearias ler o
token errado.

**As três regras da Parte 2 §2.7 da SPEC agora existem como coluna**, não como
texto: `cancel_min_hours`, `reschedule_min_hours` e `max_reschedules`. Antes a
página de confirmação prometia "cancele com 2 horas de antecedência" e nada
cumpria — dava para desmarcar um minuto antes. A decisão mora em
`packages/core/src/changes.ts`, sem relógio: recebe quantos minutos faltam.

A tela e a API decidem pela **mesma** função. Calcular a permissão de um jeito
na lista e de outro no servidor é como um botão aparece e o servidor o recusa.

A grade de remarcação tem rota própria (`GET .../appointments/:id/availability`,
com sessão) porque precisa ignorar o horário atual do cliente na ocupação —
exatamente o que a gravação faz. Com a estratégia `anchored` isso não é detalhe:
o horário atual ancorava a grade pública, a gravação recomeçava do início da
jornada, e **todo** horário oferecido era recusado.

## Conta de gestor e onboarding

Até o bloco 9 só o cliente final tinha identidade. Catálogo, equipe e jornada
entravam por SQL — o que faz um produto instalado à mão, não um SaaS.

**A conta cria a própria barbearia sem caminho privilegiado.** A política de
`tenants` compara o `id` com `app.tenant_id`, então `withTenant(novoId)` deixa o
role restrito inserir o próprio tenant. Não existe `BYPASSRLS` em lugar nenhum
do fluxo, e há teste que consulta sem filtro e espera uma linha só.

**Senha em scrypt do próprio Node**, com os parâmetros dentro do hash
(`scrypt$N$r$p$salt$derivada`) — subir o custo depois não invalida senha
cadastrada. Argon2id seria a escolha de manual, mas entra como dependência
nativa compilada; scrypt entrega a mesma classe de proteção sem ampliar a
superfície de build.

**Login por e-mail acontece antes de existir tenant no contexto**, e a RLS não
devolve linha sem ele. Daí `staff_directory`, um índice entre tenants — que
guarda HMAC do e-mail, não o endereço. Em claro, ele seria a lista de donos de
barbearia da plataforma, pronta para spam e engenharia social.

**As seis etapas gravam uma a uma.** Quem cadastra faz isso no celular entre um
cliente e outro; abandonar no passo 4 não pode custar os passos 1 a 3. O
contador só sobe, então voltar para corrigir o endereço não reabre o cadastro.

**O catálogo sugerido resolve o defeito D4 na origem.** Duração e buffer já vêm
coerentes, e o combo declara a soma real das partes. Se o dono encurtar um combo
abaixo do que as partes levam, a API recusa e diz **qual** — foi exatamente
assim que a agenda do sistema analisado nasceu devendo 15 minutos por cliente.

**Não publica pela metade:** sem serviço, sem equipe ou sem jornada, o link não
vai ao ar. Um link que abre "nenhum horário disponível" é pior que link nenhum —
o cliente conclui que a barbearia fechou e não volta.

### Duas coisas que o cadastro aberto tornou perigosas

O `/security-review` apontou as duas, e as duas nasceram do mesmo fato: campos
que antes só entravam por SQL passaram a entrar por HTTP, de qualquer um.

**O JSON-LD virava injeção de script.** `JSON.stringify` escapa aspas, mas não
escapa `<` — e o bloco é escrito com `dangerouslySetInnerHTML` dentro de
`<script>`. Um nome de barbearia com `</script><script>…` fechava o bloco e
executava na origem verdadeira da plataforma. Enquanto o catálogo só entrava por
SQL era teórico; com o cadastro aberto virou uma requisição. Agora passa por
`jsonLdScript`, que escapa `<`, `>`, `&` e os separadores de linha, com teste que
alimenta `</script>` e confere que o JSON continua idêntico ao ler de volta.

**O cadastro dizia quem já é cliente da plataforma.** E-mail livre respondia 201,
e-mail já cadastrado respondia 409 — oráculo para montar lista de donos de
barbearia e mandar phishing. É a mesma lista que o HMAC em `staff_directory`
existe para proteger, entregue por HTTP sem precisar de dump. Agora as duas
respostas são idênticas (202, mesmo corpo) e nenhuma traz sessão; o passo
seguinte é o login, nos dois casos. Custa uma tela a mais e fecha o oráculo.

## Próximos passos

Bloco 11 de 76 — ver [`ROADMAP.md`](ROADMAP.md).

Admin: CRUD de catálogo, equipe, jornadas e recursos. O onboarding cria o
essencial; o dia a dia precisa editar.

**Lacunas conhecidas** estão na tabela
[Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada), cada
uma com o que já existe, o que falta e em qual bloco entra.
