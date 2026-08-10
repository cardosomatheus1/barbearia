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
| `packages/core` | Motor de disponibilidade, vida do atendimento, fila, exceções, comanda, comissão (com a taxa do adquirente), permissões, o vocabulário das transições e a régua de cobrança — lógica pura, sem banco e sem relógio | 596 testes ✅ |
| `packages/db` | Schema, migrações, RLS e cliente com escopo de tenant | 186 invariantes + 10 testes ✅ |
| `packages/scheduling` | Repositórios, disponibilidade, reserva, o dia do balcão, a fila e a agenda | 135 testes ✅ |
| `packages/identity` | OTP, sessão do cliente e do gestor, contas de equipe, permissões editáveis por papel, segundo fator (TOTP), convite do barbeiro e auditoria | 137 testes ✅ |
| `packages/catalog` | CRUD do cadastro: serviços, combos, equipe, jornadas e recursos | 23 testes ✅ |
| `packages/finance` | Comanda, checkout, caixa, fiado, comissão e a **cobrança online** (Pix, cartão e link pelo adquirente, com webhook e conciliação) — o dinheiro e os números do barbeiro, do banco para a tela | 130 testes ✅ |
| `packages/jobs` | Fila de trabalho, avisos ao cliente, falta automática, apuração diária, varredura de retenção e varredura de alerta — o que acontece sem ninguém esperando | 67 testes ✅ |
| `packages/crm` | A ficha do cliente, a importação de base e os direitos do titular: consentimento com histórico, exportação, anonimização e retenção | 88 testes ✅ |
| `packages/platform` | A camada de plataforma: planos, assinatura, cobrança, adquirente e conciliação, bloqueio de conta, métricas globais, recursos ligáveis, segundo fator do Super Admin, suporte assistido, papéis internos, o canal de alerta ao dono e o cliente Stripe das duas pontas | 149 testes ✅ |
| `packages/ui` | Design system: tokens, tema, componentes acessíveis | 85 testes ✅ |
| `apps/api` | API pública, do painel, **da plataforma** e os **dois** webhooks de adquirente: perfil, disponibilidade, login, agendamento, balcão, fila, agenda, equipe, cadastro, caixa, comanda, comissão, avisos, ficha do cliente, metas, plano, cobrança por Pix, direitos do titular e anonimização (LGPD) e o Super Admin | 375 testes ✅ |
| `apps/web` | Página pública, fluxo do cliente, painel da barbearia e **painel da plataforma** (`/plataforma`), com SSR (Next.js) | 81 testes ✅ |
| `apps/worker` | O segundo processo: consome a fila, manda os avisos, marca a falta, apura as métricas do dia e varre a retenção de dado pessoal | — |

Três dos testes de `core` são **guardas de arquitetura**: falham se alguém der
dependência ao core, importar algo externo nele ou usar `Date.now()` na lógica.

## Rodando o produto

### Windows

Clique duas vezes em **`RODAR-NO-WINDOWS.cmd`**. Ele exige só o
[Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado — e
diz isso, com o endereço, se não achar.

Não há como rodar por clique duplo sem Docker: `.sh` não é executável no
Windows, o PowerShell não tem `bash`, e o caminho manual seria instalar Node 22,
pnpm e PostgreSQL 16 com três extensões.

### Sem instalar nada: no navegador, pelo GitHub

Se a máquina é corporativa e o administrador bloqueia instalação — Docker
inclusive —, o projeto roda no **GitHub Codespaces**, que é um computador na
nuvem com editor no navegador:

1. Abra o repositório no GitHub.
2. Botão verde **Code** → aba **Codespaces** → **Create codespace on ...**
3. Espere a preparação (uns três minutos na primeira vez) e, no terminal que
   abre embaixo, rode:

   ```bash
   scripts/rodar-local.sh
   ```

4. Quando aparecer `web pronto`, o Codespaces abre a porta **3001** sozinho —
   ou clique nela na aba **PORTS**.

O `.devcontainer/` já traz Node 22, pnpm, o cliente do Postgres e um
PostgreSQL 16 ao lado. A conta gratuita do GitHub inclui horas de Codespaces
por mês.

### Com Docker, em qualquer sistema

```bash
scripts/docker.sh        # Linux e macOS; no Windows, o .cmd acima
```

Sobe PostgreSQL, API, worker e web, aplica as migrações e semeia a barbearia de
demonstração. Nada é instalado na máquina além do Docker. Depois:
**<http://localhost:3001>**.

Para recomeçar do zero: `scripts/docker.sh --zerar`.

Os segredos são sorteados no primeiro uso e guardados em `.env`, fora do Git —
o compose **recusa subir** sem eles, com a mensagem do que fazer, em vez de
usar um valor fixo que estaria publicado no repositório.

### Sem Docker, com as ferramentas na máquina

```bash
scripts/rodar-local.sh
```

Confere Node, pnpm e Postgres, instala as dependências, cria o banco e o role
restrito, aplica as migrações, sorteia os segredos que a aplicação exige (e
recusa default para), constrói tudo, semeia a barbearia de demonstração e sobe
API, worker e web. Ctrl+C derruba os três.

No fim ele imprime os endereços e as credenciais:

| Entrar como | E-mail | Senha |
|---|---|---|
| dono | `teste@teste.com` | `testeteste` |
| barbeiro (tela própria, `/admin/meu-dia`) | `barbeiro@teste.com` | `testeteste` |

A senha tem dez caracteres porque `MIN_PASSWORD` são dez no domínio, e o
e-mail tem formato de e-mail porque o login valida isso na borda — a
demonstração não é motivo para afrouxar nenhum dos dois.

As telas de dinheiro exigem segundo fator, que o script liga e cujo segredo ele
imprime **uma vez**. Cadastre num aplicativo autenticador — ou, onde não dá
para instalar aplicativo (máquina corporativa, Codespaces), peça o código de
seis dígitos na linha de comando:

```bash
node scripts/codigo-2fa.mjs SEUSEGREDOBASE32
```

Ele é uma calculadora de TOTP: recebe o segredo que já foi impresso e faz a
conta que o celular faria. Não lê o banco nem decifra nada — um script que
fosse buscar o segredo cifrado seria ferramenta de extração com nome amigável.
Perdeu o segredo? `scripts/rodar-local.sh --zerar` recomeça e imprime outro.

Rodar de novo reaproveita o banco; `--zerar` recomeça limpo.

| Precisa de | Onde conseguir |
|---|---|
| Node 22+ | <https://nodejs.org> |
| pnpm | `corepack enable` |
| PostgreSQL 16+, com `pgcrypto`, `citext` e `btree_gist` | `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16` |

Sem Postgres de pé o script explica como subir um e para — em vez de falhar
adiante com "Connection refused", que não diz o que fazer.

Os segredos vão para `.env.local`, fora do Git. **Apagar esse arquivo obriga a
recriar o banco**: o índice de login é um HMAC com o `STAFF_EMAIL_PEPPER`, e
trocá-lo invalida as contas existentes.

### Rodando os testes

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

### Primeira conta da plataforma

Não há rota de cadastro para ela, e isso é decisão: um `POST` público de criação
de Super Admin é um caminho para qualquer pessoa na internet virar
administradora de todas as barbearias, e nenhum "só a primeira conta" resolve —
no dia em que a primeira for apagada, a porta reabre.

```bash
DATABASE_URL=... STAFF_EMAIL_PEPPER=... \
  node scripts/criar-super-admin.mjs "Nome" email@dominio
```

A senha é lida da entrada padrão, sem eco. Depois disso, `/plataforma/entrar`.

### Variáveis que a API exige

Nenhuma tem valor padrão, e é de propósito: as duas protegem dado, e um padrão
fraco em silêncio subiria o sistema funcionando com a proteção desligada.

| Variável | Para quê | Como gerar |
|---|---|---|
| `STAFF_EMAIL_PEPPER` | HMAC do e-mail em `staff_directory`, que é tabela sem RLS por natureza | `openssl rand -hex 32` |
| `MFA_SECRET_KEY` | AES-256-GCM do segredo TOTP guardado em `staff_users` **e em `platform_admins`** | `openssl rand -base64 32` (32 bytes) |
| `PSP_WEBHOOK_SECRET` | HMAC do webhook do adquirente, que é a única rota sem sessão com efeito sobre dinheiro | o provedor gera, no painel dele |
| `STRIPE_SECRET_KEY` | falar com a Stripe. Só exigida quando `PSP_MODO=stripe` | o painel da Stripe |
| `STRIPE_WEBHOOK_SECRET` | HMAC do webhook da Stripe, que é a **segunda** rota sem sessão com efeito sobre dinheiro | a Stripe gera um por endereço cadastrado |

Os dois segredos de webhook ausentes **recusam** todo webhook — nunca liberam. É
o que separa "a rota está fechada" de "a rota está aberta e ninguém percebeu":
um padrão vazio faria toda assinatura conferir.

E são **dois**, não um: a Stripe gera um segredo por endereço cadastrado, e
reaproveitar o do bloco 29 faria a conferência falhar de um jeito que parece
código quebrado.

### Qual adquirente está no ar: `PSP_MODO`

Uma variável, três valores, e **uma única função no produto que os lê**
(`adquirenteDaPlataforma`/`adquirenteDaComanda`, em `packages/platform`). O
motivo de ser uma só: dois processos cobram — a API e o worker —, e cada um
escolhendo por si significa ligar a Stripe num e esquecer no outro, com a régua
debitando de verdade enquanto o estorno devolve dinheiro de mentira.

| `PSP_MODO` | O que acontece |
|---|---|
| ausente ou `nenhum` | **padrão.** Nada é debitado sozinho; quem quita fatura é o Super Admin registrando o que viu no extrato. O estorno de crédito recusa com `no_acquirer` em vez de fingir |
| `fake` | provedor de mentira, que **recusa por padrão** — é o que exerce a régua de retentativa inteira em desenvolvimento |
| `stripe` | a Stripe de verdade, nas duas direções. Exige `STRIPE_SECRET_KEY` |

Valor desconhecido **falha alto** em vez de virar `nenhum`. Um `PSP_MODO=stripe_test`
lido com tolerância faria a plataforma parar de cobrar sem ninguém perceber por
um ciclo inteiro de faturamento.

Trocar `MFA_SECRET_KEY` invalida todos os segundos fatores cadastrados: os
segredos ficam indecifráveis e cada gestor precisa cadastrar de novo. Ela é
chave de dado em repouso, não credencial rotacionável sem plano.

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

### A plataforma vê todas as barbearias sem afrouxar nenhuma política

O Super Admin precisa do contrário do que o produto inteiro garante. A saída
tentadora — afrouxar a política de `tenants` sob alguma condição — seria fatal
e não pelo motivo óbvio: como nenhuma consulta repete `tenant_id` no `WHERE`,
afrouxar alargaria em silêncio todas as que já existem.

A saída são **tabelas novas de plataforma**, com `USING (true)` e nada de
pessoa dentro: `tenant_platform`, `plans`, `tenant_metrics_daily`,
`tenant_lifecycle`, `feature_flags`, `support_sessions`, `subscriptions`. O
Super Admin nunca lê `appointments`, `customers` ou `orders`.

`billing_customers`, `psp_events` e `refunds` (bloco 29) fecham a lista. O
evento bruto do adquirente é o mais fechado de todos — nem a barbearia dona da
fatura o lê, porque o que há nele é identificador do provedor, que não serve
para nenhuma tela dela.

`invoices` (bloco 28) entra nesse conjunto com **leitura mais estrita**: a
plataforma lê todas, e cada barbearia lê só as próprias. A diferença tem motivo
— as outras guardam plano, contagem e preço de tabela; o extrato guarda
histórico de pagamento com data e método, e isso é informação de negócio de
quem a recebeu. Escrever continua sendo só da plataforma, senão a barbearia se
daria baixa sozinha.

O que ele precisa saber sobre a operação de cada barbearia — ocupação, no-show,
adoção — chega por **agregado que a própria barbearia escreve**, por dentro do
próprio tenant, numa tarefa da fila. Varredura de plataforma sobre tabela com
RLS não funciona: ela devolve zero linhas, e o bloco 20 já descobriu isso na
falta automática.

### Entrar na conta de um cliente deixa rastro dos dois lados

`platform_audit` registra o ato do Super Admin. O `audit_log` **da barbearia**
registra que entraram na conta dela, e cada tela aberta durante a sessão. A SPEC
§1.2 pede que o tenant possa consultar esse log, e uma trilha só do nosso lado
não cumpre isso.

A sessão de suporte dura trinta minutos, exige o segundo fator provado, e é
somente leitura — a lista do que ela alcança está em `PERMISSOES_DO_SUPORTE`
(`packages/core`), e quem aplica é a mesma `PermissaoGuard` de toda rota do
painel. Não há lista de rotas proibidas: a rota que alguém escrever no bloco 44
nasce coberta.

## Documentação

| Documento | Conteúdo |
|---|---|
| [`SPEC.md`](SPEC.md) | Visão, evidências de campo, métricas |
| [`ROADMAP.md`](ROADMAP.md) | Os 79 blocos de execução e o escopo recomendado |
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

## O balcão é a terceira superfície

Cliente e gestor tinham tela. Quem passa o dia com o notebook aberto — marcando
presença, atendendo quem chegou sem marcar, descobrindo quem faltou — não tinha.
Até o bloco 10 a barbearia publicava a página, recebia agendamento no banco e
**não tinha nenhuma tela que mostrasse o dia**: na prática o dono abria a página
do cliente para adivinhar o que estava marcado.

`/admin/dia` responde à pergunta que a recepção faz à tela o dia inteiro — quem
está aí agora e o que faço com essa pessoa.

### A máquina de estados existia desde o bloco 1 e ninguém a percorria

`appointment_status` tem dez valores desde a primeira migração. Todo agendamento
nascia `pending` e morria `pending`: `checked_in`, `in_progress`, `completed` e
`no_show` eram enum sem caminho. Agora as transições vivem em
`packages/core/src/attendance.ts` — lógica pura, testável, com o "agora" entrando
por parâmetro — e a decisão é tomada **dentro da transação que escreve**. Duas
pessoas no balcão tocando o mesmo cartão: a segunda recebe 409, não uma
sobrescrita silenciosa.

Duas escolhas da tabela de transições merecem nota:

- **`pending` aceita `check_in` direto.** Quem chega sem ter confirmado é o caso
  comum, não a exceção.
- **`checked_in` ainda aceita `no_show`.** Parece contraditório — a pessoa
  chegou —, mas é quem cansou de esperar e foi embora. Sem isso a recepção teria
  que cancelar em nome da casa, e o registro diria que a culpa foi dela.

Desfazer uma falta pode falhar, e é bom que falhe: enquanto o horário estava
`no_show` a constraint de exclusão o ignorava, então a vaga pode ter sido dada a
outro cliente. O banco recusa com `23P01` e a tela diz para marcar um novo.

### A antecedência mínima é regra do site, não do balcão

Ela existe para o cliente não marcar às 14:05 um horário de 14:10 que ninguém vai
preparar. Com a pessoa de pé na frente da recepcionista, vira obstáculo. O flag
`atCounter` desliga a antecedência mínima e a janela máxima de agendamento — e
vale para a **grade e para a gravação juntas**. Aplicar em uma só é como o
operador clicaria num horário oferecido e levaria 409 de volta.

O que `atCounter` **não** desliga é o corte do "agora": oferecer 09:00 às 23:00
não é flexibilidade, é lixo na tela.

### A busca de cliente não pode virar exportação da base

`GET /v1/admin/customers?q=` acha pelo trecho do nome ou pelos últimos dígitos do
celular — que é como a recepção pergunta. Três guardas:

- **Piso de três caracteres.** Uma letra devolveria quase a base a cada tecla.
- **Curinga do LIKE neutralizado.** Sem escapar, `%` sozinho devolve todo mundo.
- **Telefone nunca sai inteiro.** Nem na busca, nem no painel do dia — a tela do
  balcão fica virada para o salão. O painel mostra os quatro últimos dígitos; a
  busca, o número mascarado.

É por isso que marcar para um cliente já cadastrado manda o **id**, não o
telefone: o balcão nunca teve o número completo para digitar de volta. E o id
passa por conferência antes do `INSERT` — a chave estrangeira de
`appointments.customer_id` não conhece tenant, e a checagem de integridade do
Postgres não passa pela RLS. Sem essa consulta, o id de um cliente de outra
barbearia seria gravado sem erro. Há teste que prova os dois lados.

### Duas dependências novas no banco, com motivo

`pg_trgm` e `unaccent`, na migração 0015. Sem trigrama, buscar por trecho de nome
é varredura sequencial; sem `unaccent`, "joao" não acha "João" — e metade dos
nomes brasileiros tem acento que ninguém digita no balcão. `unaccent()` é STABLE
e não entra em índice, então a migração cria `sem_acento()` com o dicionário
fixado, que é a receita da própria documentação do Postgres.

O índice de telefone é sobre `reverse(phone_e164)`, porque sufixo vira prefixo e
é isso que um B-tree sabe fazer. Ele **não** leva `tenant_id` na frente: a
consulta não filtra por tenant (a RLS faz isso), e coluna líder sem predicado
inutiliza o índice. Medido em 40 mil clientes: com `(tenant_id, ...)` o plano era
Seq Scan em 11,3 ms; sem ela, Index Scan em 0,12 ms.

### O painel é claro, e isso estava escrito havia cinco blocos

Os tokens declaravam o tema claro como "o padrão do admin" desde o design
system — e ninguém o aplicava. O balcão é o que torna isso concreto: a tela fica
horas ligada e fundo escuro cansa em sessão longa. Os dois temas passam pela
mesma verificação de contraste, então a troca não abre buraco de acessibilidade.

## A página tinha uma promessa em aberto: a foto

`docs/03-direcao-visual.md` sempre disse que o herói é a disponibilidade e que
"a foto continua presente logo abaixo". A primeira metade foi construída no
bloco 7. A segunda ficou no documento: a página passou dez blocos **sem uma
única imagem**, num negócio em que a escolha do cliente é visual antes de ser
qualquer outra coisa.

A causa não era desenho. As colunas `cover_url`, `photo_url` e `logo_url`
existiam desde a primeira migração e o perfil público já as devolvia — faltava
**por onde preenchê-las**. É o mesmo defeito que `blocks` teve por oito blocos,
com o agravante de estar à vista de qualquer visitante.

`/admin/fotos` fecha a origem do dado. Enquanto não há armazenamento próprio, o
endereço é colado: a barbearia já publicou essas fotos em algum lugar, e esperar
por infraestrutura de upload deixaria a página como cardápio de texto por mais
oito blocos. A lacuna está declarada com a dependência real, que é armazenamento
de objeto.

### `https` e mais nada

`imagemPublica` (em `packages/core`) decide o que entra. Só `https`, por três
motivos em ordem: `javascript:` não executa num `src` de `<img>`, mas a mesma
coluna alimenta `og:image` e uma lista fechada custa menos que rastrear
consumidor; `data:` transformaria a coluna em depósito de arquivo; e `http:`
simples é bloqueado como conteúdo misto, então aceitar seria prometer uma imagem
que nunca aparece.

Escrito com expressão regular, não com `new URL()` — `URL` vem do DOM ou do
`@types/node`, e `packages/core` não depende de nenhum dos dois. Há teste que
falha se alguém der dependência a este pacote.

URL recusada vira `null`, não erro: a foto é opcional, e um endereço ruim num
campo não pode impedir de salvar os outros oito.

### Toda imagem declara o próprio tamanho

`width` e `height` no HTML, junto com `aspect-ratio` no CSS. Sem eles o navegador
não reserva o espaço e a foto empurra a grade de horários ao carregar — o toque
errado no horário errado, com o cliente em pé na rua.

## A régua de horários estava se sabotando

A grade sai ordenada por horário, então os primeiros catorze de um dia com 126
vagas eram `12:30 12:35 12:40 12:45` — a mesma hora repetida, com o mesmo
barbeiro, seguida de "e mais 122 horários". A tese da página é "escolha quando",
e a régua mostrava uma fila.

`horariosEmDestaque` mostra seis horários espalhados pelo dia, com as duas
pontas presas: o primeiro livre responde "dá para ir agora?" e o último desenha
o fim do expediente. E `horariosRestantes` conta **horários distintos**, não
vagas — "e mais 122" quando existem 40 horários com três barbeiros cada é número
inflado, e número inflado numa página de venda custa a confiança no resto dela.

O nome do barbeiro saiu do cartão pelo mesmo motivo: repetia seis vezes o mesmo,
porque a grade vem colapsada e o primeiro da fila ganha todos. Sugeria que só
ele estava livre.

## O notebook não tinha layout, tinha a mesma coluna esticada

Em 1280 a linha ia de "Pezinho" na margem esquerda a "R$ 15,00" na direita, com
mil pixels de nada no meio, e o olho atravessava a tela para ligar o serviço ao
preço. O wireframe da direção visual era só de celular, e "ganha densidade
quando há espaço" (CLAUDE.md §5) nunca tinha sido construído para esta página.

A partir de 768 o cardápio fica à esquerda e equipe, endereço, horários e
cancelamento viram coluna de referência à direita. Isso conserta a hierarquia de
quebra: as cinco seções tinham exatamente o mesmo peso, e a política de
cancelamento gritava tanto quanto o preço do corte.

## Papel decidindo alguma coisa

`staff_users.role` existia desde o bloco 10 e **nunca foi lido para decidir
nada**. Toda conta de gestor tinha poder de dono, então abrir o balcão para a
recepcionista entregava junto o faturamento, o catálogo e a base de clientes —
e a saída prática era ela usar a conta do dono, que é o pior dos dois mundos.

### Permissão é dado, não constante

A SPEC (Parte 1 §1.3) pede permissões granulares e papéis editáveis pelo
proprietário. Guardar o mapa no código faria "o gerente passa a ver faturamento"
virar deploy; `role_permissions` é por barbearia, então é uma linha. O bloco 30
precisa só de tela.

O catálogo aparece em dois lugares de propósito: em `packages/core` e numa
`CHECK` do banco. A duplicação é o que impede uma permissão inventada de ser
concedida numa correção manual de madrugada — e há teste que lê a `CHECK` do
`pg_constraint` e falha se as duas listas divergirem. Ele já pegou uma.

Uma permissão saiu do nosso lado: `appointments.attend`. A SPEC descreve a
recepcionista e o barbeiro fazendo check-in no §1.2 e não tem permissão para
isso no §1.3 — operar o balcão só caberia sob `appointments.view`, que é um
write guardado por permissão de leitura.

### A guarda recusa por padrão

Rota que não declara `@Exige(...)` não é rota liberada: é rota que esqueceu de
declarar. A guarda nega, e um teste varre os controllers e reprova qualquer
método sem declaração — por classe, não por arquivo, porque `signup` e `login`
moram no mesmo arquivo das rotas do painel e não ficam atrás de guarda nenhuma.

Outro teste mantém uma regra do `CLAUDE.md` que era só texto: **MFA obrigatório
para quem tem `finance.*`**. Não há segundo fator ainda, então nenhuma rota pode
exigir uma dessas. Quando a primeira tela de caixa chegar, o teste fica vermelho
e obriga a decisão junto — não seis blocos depois.

### A senha de primeiro acesso morre no primeiro uso

Quem cria a conta é o dono, com a pessoa do lado; não há canal transacional até
o bloco 20. A senha é **gerada** (`randomInt` do `node:crypto`, alfabeto sem
`0`/`O`/`1`/`l`), aparece uma vez, e a conta nasce com `must_change_password`.
Chega à tela por cookie `httpOnly` de dois minutos, não por parâmetro de URL:
parâmetro acaba no `Location`, no `Referer` de toda requisição da página, no log
do proxy e no histórico do navegador do balcão — que é máquina compartilhada.
Enquanto isso for verdade, a guarda recusa tudo menos a rota que a destranca —
e essa rota ainda exige a senha atual, que é o que impede alguém no navegador
aberto de outra pessoa de ficar com a conta.

### Desligar tira do sistema agora

Desativar alguém revoga as sessões abertas **na mesma transação**. Sem isso quem
acabou de ser demitido segue com o balcão aberto no navegador até o token
expirar — exatamente quando não deveria mais estar lá. Reemitir a senha faz o
mesmo.

O dono é protegido nos três caminhos: não dá para criar um segundo, promover
alguém a dono, nem desligar o que existe. Seria a única conta com `team.manage`
se trancando para fora do próprio negócio, sem volta pela aplicação.

### O que a `/security-review` encontrou

Quatro achados, todos corrigidos antes de fechar o bloco. Dois merecem registro
porque são a mesma classe de defeito que este projeto já tinha visto:

**`appointments.view_all_professionals` não decidia nada.** Estava no catálogo,
era negada ao barbeiro no padrão de fábrica, e o painel devolvia a agenda da
casa inteira sob `appointments.view` — que todo papel tem. A tela de equipe
ainda descrevia o papel como "a própria agenda e a própria comissão". Permissão
que não decide é promessa que a tela quebra, e é o mesmo padrão do `blocks` e
das colunas de foto: o mecanismo existe, ninguém o liga.

O recorte agora sai de `staff.professionalId` e vai **na consulta**, nunca em
parâmetro de requisição — aceitar da URL seria pedir ao barbeiro que escolhesse
o que ele pode ver. Vale também para mover atendimento: sem isso, marcar falta
no cliente do colega era uma requisição, e a lista de ontem já dava o id.

**O faturamento do dia saiu do painel.** Ele é `finance.view`, que a recepção e
o barbeiro não têm, e vinha sob `appointments.view`. Dava para escondê-lo com um
`if` no handler, mas isso seria decidir sobre dinheiro sem o segundo fator que o
`CLAUDE.md` exige — contornando pelo lado a regra que o teste de MFA protege. O
número volta no bloco 18, com o caixa.

Os outros dois: `resetStaffPassword` era a única operação de equipe sem a guarda
do dono (inalcançável hoje, tomada de conta no dia em que um gerente receber
`team.manage`), e `POST /v1/admin/team` respondia "e-mail já existe" para conta
de **qualquer** barbearia — reconstruindo por HTTP a lista que o cadastro
público paga caro para esconder.

### A trilha é append-only por permissão, não por convenção

`audit_log` nasce com `REVOKE UPDATE, DELETE ... FROM barbearia_app`. Trilha que
a aplicação reescreve não prova nada, e quem chegasse ao role apagaria o próprio
rastro. Há teste que tenta apagar e espera falhar.

Grava dentro da transação que muda o estado, com o par antes/depois — saber que
alguém mudou uma permissão sem saber de quê para quê não fecha investigação — e
nunca guarda senha nem hash.

## O onboarding cria; o cadastro edita

São operações diferentes e o código passou doze blocos com só a primeira.

As seis etapas do onboarding **substituem** o conjunto: `PUT /v1/admin/services`
apaga tudo e recria. Isso é certo para quem está abrindo — a pessoa está
corrigindo o que acabou de digitar. É errado a partir do dia seguinte, porque
`appointment_services` guarda o preço e a duração praticados no momento da
reserva e aponta para `services.id`. Recriar o catálogo troca todos os ids e
desfaz esse vínculo: o histórico de vendas perde a que serviço cada linha se
refere.

`packages/catalog` edita **no lugar**. Há teste que grava um agendamento, muda o
preço do serviço e confere que a linha vendida continua com o valor antigo e o
mesmo id.

### Desativar não é apagar, e a tela diz o que se perde

Serviço e profissional saem de circulação com `active = false`. Nunca `DELETE` —
apagar arrastaria o histórico junto.

O que muda a decisão é o número que vem com a resposta: quantos clientes **já
têm hora marcada** com aquele serviço ou com aquela pessoa. Desativar não
cancela nada, e sem esse número a recepção descobriria pelo cliente que chegou.

### A coerência do combo é verificada contra o catálogo inteiro, não contra a edição

`validateCombos` já existia em `packages/core` desde o bloco 3 e recusava um
"corte + barba" de 40 minutos quando as partes somam 55. A armadilha estava no
outro lado: **alongar uma parte** também quebra o combo, e quem edita "corte" não
está pensando em combo nenhum.

Por isso `exigirCombosCoerentes` monta o catálogo inteiro a partir do banco, com
a alteração pendente aplicada por cima, e valida esse conjunto. Aumentar o corte
de 30 para 45 minutos é recusado se existe um combo que não comporta mais a
soma. Há teste; ele fica vermelho se a validação passar a olhar só o que mudou.

### Encolher a jornada é legítimo. Fazê-lo às cegas, não.

`work_schedules` é por profissional desde o bloco 1, e o onboarding gravava a
mesma grade para a equipe inteira. O barbeiro que passou a folgar na segunda
continuava aparecendo na segunda, e a barbearia descobria pelo cliente que
chegou e não encontrou ninguém.

Gravar a jornada tem dois tempos quando há conflito: a primeira chamada devolve
a lista de quem ficaria fora do horário e **não grava**; a segunda, com
`confirmarConflitos`, grava. A comparação roda no fuso da unidade e confere as
duas pontas do atendimento — um corte que começa às 11:50 e termina 12:20 não
cabe numa jornada que fecha ao meio-dia — além dos intervalos.

### Recursos: o motor sabia e não tinha por onde ser avisado

`resource_pools` e `service_resource_requirements` existem desde o bloco 1, com
índice, RLS e a lógica de recorte de janela testada. **Nada nunca escreveu nas
duas tabelas.**

Em concreto: barbearia com dois barbeiros e um lavatório oferecia dois horários
simultâneos de lavagem, e o segundo cliente esperava de cabelo molhado. Campo que
o motor aceita e ninguém preenche é mentira do sistema — a mesma coisa que
`blocks` foi por oito blocos.

O tipo é texto livre de propósito: "cadeira", "lavatório" e "sala de barba" são
vocabulário da barbearia, não enum do sistema. O que a tela garante é que o nome
usado no serviço seja um dos cadastrados — exigir recurso inexistente sumiria com
o serviço da grade sem explicação.

### O recipiente que rola precisava ser bloco contentor

A medição acusou rolagem horizontal na tela de jornada em 360 e 390px, e o
suspeito óbvio — a tabela de sete dias — estava certo dentro de `.ui-scroll-x`.

O culpado era cada `<label class="ui-visually-hidden">` da tabela. `overflow` não
segura descendente `position: absolute` cujo bloco contentor está fora dele: os
rótulos de leitor de tela eram posicionados contra a página, na coordenada que
têm dentro da tabela de 682px. Um deles ia parar em x=420 e levava o documento a
424px de largura numa tela de 360.

`.ui-scroll-x` ganhou `position: relative` no design system, com teste. Vale para
toda tela que use o recipiente — a correção não é desta página.

### O que a `/security-review` encontrou desta vez

**A chave estrangeira do Postgres não passa pela RLS.** A documentação é
explícita: a checagem de integridade referencial sempre ignora row security.

`professional_services` e `service_combo_components` recebiam `service_id` vindo
direto do corpo da requisição. O `tenant_id` da linha saía de
`current_setting('app.tenant_id')`, então a política de `WITH CHECK` aprovava; a
única coisa que poderia reprovar era a FK, e ela não olha. Confirmado num banco
descartável com o role real `NOBYPASSRLS`: `INSERT 0 1` com o serviço de outra
barbearia.

O estrago não é leitura — a RLS ainda filtra o `JOIN`, então nenhum atributo do
serviço alheio volta. É oráculo de existência (id inexistente estoura, id de
outra barbearia responde 201) e referência atravessada que a outra barbearia
apaga em cascata sem saber que existia.

Duas coisas valem registrar sobre por que passou:

- **É exatamente o que `identificar()` faz no balcão**, com o comentário
  explicando o motivo. O padrão estava escrito no repositório e o pacote novo
  foi o primeiro caminho de escrita a não segui-lo. Dentro do mesmo pacote,
  `setServiceResources` e `saveSchedule` reconferem; `gravarHabilidades` e
  `gravarCombo` não reconferiam.
- **O teste de isolamento existia e passava.** Ele mandava o id alheio na
  **URL**, que é resolvida por `SELECT` sob RLS. Nenhum caso mandava no
  **corpo**, que é o único caminho que não passa por `SELECT` nenhum. Os dois
  testes novos mandam no corpo e ficam vermelhos contra o código anterior.

A checagem recusa em vez de descartar em silêncio, e a mensagem não distingue
"não existe" de "é de outra barbearia" — a diferença é justamente o que o
oráculo procurava.

## A fila é outro objeto, não um agendamento improvisado

A SPEC (Parte 2 §2.10) diz isso em uma linha e a razão é estrutural.

Um agendamento **ocupa janela**: tem `starts_at`, entra na constraint de
exclusão que impede overbooking, e é subtraído da grade. Quem chegou na porta
não tem horário — tem ordem de chegada e uma estimativa que muda a cada corte
que termina. Modelar walk-in como `appointment` obrigaria a inventar um horário
falso, e esse horário passaria a bloquear a agenda de quem quer marcar pelo
site.

O caminho é o inverso: a entrada da fila **vira** agendamento no instante em que
a pessoa senta, com a hora real e `source: 'walk_in'`. Aí sim ocupa janela,
entra na comanda e conta na comissão. A fila em si nunca vira dinheiro — ela é a
sala de espera.

### "Livre" e "cabe" são coisas diferentes

O número que faltava à recepção não é "o Ruan está livre". É **quanto tempo
existe até o próximo marcado dele**.

Cadeira livre com quinze minutos até o próximo cliente não comporta um corte de
trinta, e é exatamente assim que a barbearia começa o dia quinze minutos
atrasada e termina uma hora. `custoDoEncaixe` devolve, por cadeira, se cabe,
quanto sobra e quanto invadiria — e não decide por ninguém, porque às vezes o
certo é encaixar mesmo assim e avisar o próximo.

### A regra de convivência é imposta pelo banco

> Walk-in nunca sobrescreve agendamento confirmado.

Quem garante isso é a constraint de exclusão sobre a janela do profissional, não
um `if` no serviço. Um `if` teria a janela entre a checagem e o `INSERT` — e é
justamente com o cliente de pé na frente da recepção que duas pessoas tocam o
botão ao mesmo tempo. A violação vira 409 com o motivo: "este profissional tem
cliente marcado nesse horário".

### A estimativa vem da duração real, e isso tinha uma armadilha

A SPEC exige a **duração real média, não a cadastrada**. O corte que o catálogo
diz durar 30 minutos leva 40 na cadeira daquele barbeiro, e é o 40 que faz a
estimativa bater. `started_at` e `completed_at` existem desde o bloco 11
justamente para isto.

Duas defesas em `duracaoEsperada`, cada uma por uma falha provável:

- **Amostra mínima.** Um atendimento medido não é média; com dois ou três
  registros, um dia atípico vira a estimativa de todo mundo.
- **Teto e piso em torno da cadastrada.** `completed_at` é preenchido quando
  alguém toca o botão, e o botão é tocado tarde — recepção movimentada "conclui"
  o atendimento das 14h às 17h. Sem limite, esse registro sozinho jogaria a fila
  para três horas de espera. O limite não conserta o dado ruim; impede que ele
  contamine a conta enquanto ninguém percebe.

### Quem aceita qualquer um passa na frente

A fila é ordenada por chegada, mas **não é fila única**: cada pessoa só entra na
cadeira que pode atendê-la. Quem pediu o Bruno espera o Bruno; quem aceita
qualquer um pega quem liberar primeiro, inclusive passando na frente.

É o que acontece de fato no salão, e bloquear deixaria uma cadeira parada com
gente esperando. A estimativa de quem espera o Bruno já contém esse efeito — a
alternativa produz o número que a barbearia mais odeia ter que explicar.

### O link do celular é credencial, e é tratado como tal

A SPEC pede acompanhar a posição "por link, sem app". Esse link é bearer: quem o
tiver vê a posição daquela pessoa.

- 32 bytes de `randomBytes`, não `Math.random` nem UUID.
- O banco guarda **só o SHA-256**. O valor em claro existe uma vez, na resposta
  de quem acabou de entrar na fila. Não é recuperável — reemitir invalidaria o
  link que a pessoa já está olhando.
- `GET /v1/admin/queue` **não devolve token nenhum**. Devolvê-lo transformaria a
  tela do balcão numa lista de chaves para a posição de cada cliente.
- Ele viaja para a tela num cookie `httpOnly` de três minutos, nunca na URL: o
  endereço do painel para no histórico do balcão, que é máquina compartilhada.
- A página pública é `noindex` e mostra o mínimo: a posição de quem tem o link,
  o próprio nome e a frase. Nenhum nome de outra pessoa, nenhum telefone,
  nenhuma lista.
- Token inválido e token de outra barbearia respondem **igual**. A diferença
  diria a quem varre links que aquele existe em algum lugar.

### A média era ilimitada, e isso não era um índice faltando

A primeira versão da consulta lia **todo o passado da barbearia** a cada carga da
tela da fila. O plano era Seq Scan, e o reflexo — criar um índice em
`appointment_services.service_id` — estava errado: a consulta agregava sem
filtro nenhum, e para isso varrer é o plano certo. O defeito não era o índice
ausente, era a consulta não ter recorte.

A média passou a olhar **90 dias**, e isso é correção antes de ser desempenho: o
barbeiro que ficou mais rápido este ano não deve ser julgado pelo ano passado, e
uma média de três anos leva um tempo enorme para reagir a qualquer mudança real.

Medido em banco descartável com 34 mil atendimentos: **40,9 ms → 8,8 ms**, com
Index Scan no lugar do Seq Scan. O número importa menos que a curva — antes, o
custo crescia para sempre.

### O harness de invariantes escondia falha

O `packages/db` roda provas em SQL e filtrava a saída do `psql` por cano
(`| grep NOTICE`). Um arquivo que abortasse na primeira linha não imprimia
NOTICE nenhuma, o `grep` não casava nada, e a única pista era o código de saída.

Foi assim que a prova nova da fila ficou minutos parecendo "não ter rodado". A
saída passou a ir para arquivo, e a falha imprime as últimas linhas do erro.

## A dívida mais antiga do projeto fechou

`schedule_exceptions` existia desde o **bloco 1**: cinco tipos, alvo por
profissional ou por unidade, índice parcial, RLS, e a precedência resolvida e
testada — bloqueio vence exceção do profissional, que vence a da unidade, que
vence o feriado, que vence a jornada semanal.

**Nada nunca escreveu nela.** Quatorze blocos de motor com teste verde, e o
barbeiro sem como avisar que ia faltar na sexta. Era a terceira aparição do
mesmo padrão, depois de `blocks` — que é a mesma tabela com outro `kind` — e de
`resource_pools`, fechado no bloco 13.

O teste que faltava não era do motor. Era do caminho inteiro: cria o bloqueio
pela mesma porta que a tela usa, e confere que **a grade pública perde aqueles
horários** e que a reserva passa a recusá-los. Ele fica vermelho se a escrita
for para a data errada — provado.

Com isso o grupo A da [§7.1 da SPEC](SPEC.md#71-distância-entre-esta-spec-e-o-que-está-construído)
ficou vazio: hoje nenhum campo que o motor lê está sem porta de entrada.

### Bloquear não cancela ninguém

Fechar as 14h de sexta com três clientes marcados ali é operação legítima — o
dentista existe. Fazê-lo sem ver os nomes não é.

A primeira chamada devolve quem ficaria dentro do bloqueio e **não grava**; a
segunda, com confirmação, grava. E grava só a exceção: o agendamento continua
lá, dentro de um horário fechado, porque cancelar em nome da casa é decisão de
gente. Semiaberto como todo intervalo do sistema — o corte que termina às 14h
não conflita com o bloqueio que começa às 14h.

### A assimetria era a escalada

Criar tem duas rotas de propósito: bloquear uma hora é `appointments.create`
(trabalho de recepção, dez vezes por semana), e folga, férias, feriado e horário
diferente são `settings.manage` (mudam o funcionamento da barbearia).

Só que **apagar** exigia apenas `appointments.create`. A recepcionista não
conseguia criar um feriado e apagava o que o dono criou — reabrindo a barbearia
no dia em que ela deveria estar fechada, sem nenhuma permissão a mais.

A guarda da rota é estática e declara o piso; o tipo só se conhece depois de ler
a linha. A simetria mora no domínio, e há teste que a prova.

### Arrastar não entrou, e o motivo está escrito

A SPEC §2.14 pede drag-and-drop. O que entrou foi **mover** — formulário com dia,
hora e profissional no cartão de cada compromisso, passando pelo mesmo motor da
página pública e recusando choque pela constraint de exclusão.

Duas razões, nesta ordem:

- **A WCAG 2.5.7 exige alternativa de um ponteiro para qualquer arraste.** Mover
  teria que existir de qualquer forma; arrastar é acabamento sobre ele, não a
  funcionalidade.
- Seria o **primeiro componente de cliente do produto**, que hoje é inteiro
  renderizado no servidor. Essa decisão merece bloco próprio e pacote medido,
  não entrar de carona numa tela.

Está na tabela de lacunas com esse texto. O verificador não deixa o bloco 15
fechar sem que ela aponte para outro lugar.

### O que a `/security-review` encontrou

Três achados, os três meus, e o padrão entre eles vale mais que cada um:
**a permissão estava certa na criação e ausente em toda operação vizinha.**

- **A lista de conflitos era um oráculo.** A primeira chamada devolve quem
  ficaria dentro do bloqueio e não grava — então quem enxerga só a própria
  agenda pedia um bloqueio e recebia de volta o livro da casa: nome de cliente,
  hora e id. Sem criar nada, sem aparecer em lugar nenhum. O recorte de
  permissão que `applyAttendance` aplica não chegava até aqui.
- **Mover não tinha recorte.** `appointments.reschedule` está no papel do
  barbeiro por padrão. Com o id em mãos — que o oráculo acima entregava — ele
  remarcava o cliente do colega, ou o empurrava para um terceiro. RLS separa
  barbearias, não profissionais dentro de uma.
- **Bloqueio das 00:00 às 24:00 é um feriado com outra etiqueta.** A rota
  recusava o `kind`, e o meu teste conferia a **grafia**. O motor subtrai
  bloqueio da unidade do dia de todo mundo: a barbearia sumia da grade pública
  sem ninguém ter `settings.manage`.

O terceiro produziu a lição mais útil. Ao escrever o teste da correção, ele
passou verde com a correção **desligada** — porque a faixa que eu bloqueava não
continha o agendamento. Um teste que parece prova e não é, exatamente como o que
ele estava consertando.

A correção do terceiro é um teto de duração, não uma proibição de alvo: exigir
profissional impediria a recepcionista de fechar uma hora para a reunião, que é
trabalho legítimo. **Limite assumido e escrito:** seis bloqueios de quatro horas
cobrem o dia. A diferença é que ficam seis linhas hachuradas, datadas e com
motivo na agenda — não um `holiday` silencioso.

### O mesmo defeito de CSS pela terceira vez virou teste

`min-width: auto` em item de grade: o `.ui-scroll-x` clipa a rolagem, mas o
elemento continua sendo item de grade, a faixa cresce até o min-content do
conteúdo largo, e a página inteira passa a rolar de lado. Aconteceu no cadastro,
na fila e agora na agenda — e as três vezes quem pegou foi a medição no
navegador.

Regra do projeto: não abstrair antes do terceiro caso. Chegou. Agora há teste:
toda classe que aparece ao lado de `ui-scroll-x` no markup precisa declarar
`min-width: 0`. Ele achou **mais sete** recipientes na mesma condição, latentes,
passando por sorte do contexto.

E encontrou um defeito no próprio conjunto de testes de CSS: o casamento de
regra tratava **comentário** como seletor, então um comentário que citava uma
classe fazia essa classe herdar o corpo da regra seguinte. Foi assim que a
guarda nova aprovou `.colunas` por causa do comentário que a explicava — o teste
passou a testar a própria documentação. Vale para o teste de imagens também, que
usa a mesma técnica desde o bloco 11.

**Limite declarado:** a guarda cobre o recipiente, não os ancestrais dele. Na
agenda, o elemento que envolve o `.colunas` precisou do mesmo `min-width: 0`, e
disso quem avisou foi a medição. As duas se completam e nenhuma substitui a
outra.

## Próximos passos

Ver [`ROADMAP.md`](ROADMAP.md) — ele é a fonte do que está feito e do que vem.
Esta seção dizia "bloco 16 de 78" e envelheceu catorze blocos sem ninguém
perceber: contador repetido em dois arquivos é contador que diverge.

`app-pro`: a agenda do barbeiro, o próximo cliente e as preferências dele.

## Responsividade é medida, não olhada

Toda tela serve aos dois aparelhos. Não existe "tela de celular" e "tela de PC"
neste produto — existe a mesma tela, que começa no piso de 360px e ganha
densidade quando há espaço.

Duas guardas, porque uma só não bastava:

- **Teste sobre o CSS** (`globals.test.ts`): `min-width` sempre, nenhuma largura
  fixa acima do piso, e nada escondido no celular para reaparecer no desktop.
  Existia só para `packages/ui` — e o arquivo que mais cresce, o das telas, era o
  que ninguém verificava.
- **Medição no navegador** (`scripts/medir-responsividade.js`): abre as quarenta
  e duas telas em 360 · 390 · 768 · 1280 e mede elemento a elemento — com fotos de
  verdade carregadas, porque imagem é o que mais estoura layout e medir a página
  sem elas mediria uma versão que não existe. O CSS pode estar
  correto e a grade estourar assim que entra conteúdo real — só a medição pega.

  Antes de medir, ela confere que a tela **carregou**: que o caminho final é o
  pedido e que não é a caixa de "não deu para carregar". Uma tela que não abriu
  passa em qualquer largura — não rola, não estoura, não tem alvo pequeno —, e no
  bloco 21 foi exatamente isso que aconteceu: o banco da demonstração estava duas
  migrações atrás e trinta e cinco telas devolveram "ok" sem ninguém ter visto
  nenhuma.

Foi ela que encontrou `← Voltar` com 21px de altura em quatro telas, contra o
piso de 44. Link **dentro de frase** é exceção, e por um motivo, não por
conveniência: a WCAG 2.5.8 isenta, porque esticar um link no meio de um parágrafo
abre buraco no texto. Link de navegação sozinho não é isso.

## Lacuna esquecida agora é suíte vermelha

A tabela de lacunas era documento, e documento apodrece. Nada no repositório lia
o `ROADMAP.md`: dava para fechar o bloco 20 com **quatro** lacunas apontando
para ele, e nada acusava. Era o mesmo defeito que este projeto já encontrou seis
vezes — janela de cancelamento, `blocks`, tamanho de imagem, MFA para dinheiro,
permissão que não decidia nada, `schedule_exceptions`: regra escrita e não
verificada.

`scripts/verificar-lacunas.mjs` roda como **primeiro passo** do `pnpm verify` e
reprova em seis casos. O que importa é o quarto:

> **Bloco marcado ✅ não pode ter lacuna apontando para ele.**

Com isso, esquecer deixa de ser possível e vira portão vermelho. Para fechar o
bloco 15 é preciso ou entregar a folga e o bloqueio pontual, ou reapontar a
lacuna para outro bloco — com o motivo escrito. Os outros cinco: o contador
bate com o número de ✅; as quatro colunas de cada lacuna dizem alguma coisa;
"sem bloco" exige justificativa; o bloco apontado existe; e a §7.1 da SPEC
continua lá, apontando para a tabela.

A guarda sozinha só reprova no fim, e descobrir uma lacuna no fechamento é
retrabalho. Por isso o mesmo script responde à pergunta de abertura:

```bash
node scripts/verificar-lacunas.mjs 20
```

> Bloco 20 — Notificações: confirmação, lembrete 24h/2h, retorno (fila + worker)
> **4 lacunas apontam para este bloco.**

O que sai dali entra no escopo, e é o primeiro passo de `## Ao começar um bloco`
no `CLAUDE.md`.

A primeira versão desta guarda tinha exatamente o defeito que ela existe para
pegar: lia só a primeira das três tabelas de blocos do ROADMAP e concluiu que o
bloco 30 "não existe".

## Bloco 18 — o dinheiro

### A trava que existia para ficar vermelha

Desde o bloco 12 havia um teste afirmando que **nenhuma rota podia exigir
`finance.*`**, porque o `CLAUDE.md` exige MFA para essas permissões e não havia
MFA. Parece um teste absurdo — ele proibia um recurso do produto. Era o
contrário: era o que mantinha a regra verdadeira em vez de escrita, e ficou
vermelho exatamente no dia previsto, obrigando a decisão a ser tomada junto com
a primeira tela de dinheiro e não seis blocos depois.

Hoje ele afirma o oposto, e é mais forte: **toda** permissão do grupo de
dinheiro cobra o segundo fator.

### A exigência é derivada, não declarada

A tentação era um decorador `@ExigeSegundoFator()` ao lado do `@Exige(...)`.
Seria a mesma classe de defeito que a rota sem `@Exige`: uma rota de dinheiro
nova, sem o segundo decorador, e a regra deixa de valer justamente onde mais
importa — sem nada ficar vermelho.

A `PermissaoGuard` deriva a exigência da permissão que a rota já declara. Quem
escreve `@Exige('cashier.withdraw')` cobrou o segundo fator, queira ou não. E
mora dentro dela, não numa guarda separada, porque esta é obrigatória em toda
rota do painel (rota sem `@Exige` é recusada) — não existe caminho que passe ao
lado.

`cashier.*` entrou no grupo de dinheiro neste bloco. O grupo nasceu como "o
prefixo `finance.`" porque era o único que havia, mas o nome dele sempre disse
"move ou revela dinheiro", e `cashier.withdraw` é literalmente tirar dinheiro da
gaveta. Segundo fator para *ver* o faturamento e nenhum para *levar* a sangria
seria o inverso do risco.

### A prova é por sessão, e vence

Conferir o código só no login protegeria o momento de entrar e nada depois. O
notebook do balcão fica logado o dia inteiro, e é ali que alguém encosta para
dar uma sangria. `staff_sessions.mfa_verified_at` guarda quando **aquele
aparelho** provou, com validade de 30 minutos: curto o bastante para a máquina
esquecida não ser porta aberta, longo o bastante para não pedir código entre uma
comanda e a seguinte. Fosse por operação, a recepção digitaria dez vezes por
hora e o desfecho real seria colar o autenticador de alguém na parede.

### Sem caixa aberto não se fecha comanda

Parece rigor e é o contrário: a venda precisa saber **em qual gaveta** entrou.
Sem isso, a divergência do fechamento não tem dono — que é a única coisa que
controle de caixa existe para dar.

### Fiado é forma de pagamento, não estado da comanda

A comanda fecha; o que fica em aberto é a **conta do cliente**. Modelar fiado
como comanda aberta faria o faturamento do dia esperar o cliente voltar. E
`entraNaGaveta` o exclui: fiado não é dinheiro agora, e somá-lo ao caixa faria a
gaveta nunca bater. Quando o cliente volta e paga, entra como `debt_payment`,
separado de `sale` — no mesmo balde, o faturamento contaria o mesmo corte duas
vezes.

### O bug que o próprio teste pegou

`verifyPassword` devolve `{ valid, needsRehash }`, e a primeira versão da
verificação de código de recuperação fazia `if (await verifyPassword(...))` — um
`if` sobre um objeto, sempre verdadeiro. **Qualquer texto** era aceito como
código de recuperação: bypass completo do segundo fator, com o primeiro já
vencido. O teste "código inventado não acha nada" ficou vermelho na primeira
execução.

### Um teste que falhava sozinho, e o motivo não era o código

O e2e do caixa liga o MFA e prova o código. Ele gerava o segundo código a partir
de `now + 31s` — e falhava umas duas vezes em dez. Quando a confirmação caía
perto do fim de uma janela de trinta segundos, trinta e um segundos adiante já
eram *dois* passos à frente, fora da tolerância de ±1 que o servidor aplica ao
relógio real, que não andou junto. A correção não foi no código: foi somar 1 ao
número do passo em vez de inventar um relógio. Está escrito no teste.

### O que a `/security-review` encontrou no bloco do dinheiro

Quatro coisas, e as quatro eram minhas.

**Fechar comanda validava antes de travar.** `exigirAberta` lia a comanda sem
`FOR UPDATE`, e o `UPDATE … SET status = 'paid'` não tinha `WHERE status =
'open'`. Dois toques simultâneos no "Receber" — celular lento na recepção, que é
o caso que a idempotência existe para cobrir — passavam os dois: dois
pagamentos, dois movimentos de caixa e duas linhas num extrato que é append-only
e não dá para corrigir. O mesmo instantâneo velho furava o limite de fiado:
cada transação via a dívida de antes da outra e as duas concluíam que cabia.

Agora a linha é travada, o saldo é relido sob trava e o `UPDATE` carrega o
`AND status = 'open'` — a garantia que não depende de ninguém ter lembrado de
travar.

**O `Idempotency-Key` do fechamento era decorativo.** A rota aceitava o
cabeçalho, validava o tamanho e **não o passava adiante**. O formulário da tela
ainda trazia um comentário explicando a proteção que não existia. É a regra do
projeto ao contrário: campo que o sistema aceita e ninguém usa é mentira. Hoje
ele é gravado em `orders.close_idempotency_key` e a repetição devolve a comanda
paga em vez de um 409 — que soava como falha para uma operação que deu certo.

**Uma permissão de leitura autorizava toda a escrita de dinheiro.** Comanda,
item, fechamento e recebimento de fiado estavam sob `finance.view`. O efeito
prático era pior que o teórico: a recepcionista tem `cashier.open` e não tem
`finance.view`, então ela conseguia abrir o caixa e não conseguia registrar uma
única venda. Operar o balcão passou para `cashier.open`; **desconto** ficou em
`finance.view` de propósito, que é o que dono e gerente têm e a recepção não —
um desconto de 100% é a mesma capacidade que um estorno.

**Três eventos de auditoria declarados e nunca emitidos.** `mfa.enabled`,
`mfa.disabled` e `mfa.recovery_used` entraram no vocabulário com um comentário
explicando por que importavam, e nenhuma das três era chamada. A que mais doía é
a terceira: código do aplicativo e código de recuperação entram pelo mesmo
endpoint, e a única diferença visível de fora é um booleano na resposta — que
vai para quem acabou de usar o código. Um cartão de recuperação achado numa
gaveta destrancava o caixa por trinta minutos e o único rastro no sistema era um
contador caindo de 8 para 7, que nenhuma tela mostra.

Junto: `desligarMfa` limpava a prova só da sessão que chamou. Inofensivo hoje,
porque sem `totp_confirmed_at` a guarda já recusa — mas bastaria cadastrar um
autenticador novo para as outras sessões voltarem a valer carregando prova feita
contra o fator antigo.

**E um laço sem saída**, que a revisão pegou como observação e era o mais fácil
de sofrer na prática: a tela perguntava `mfaVerifiedAt !== null` e a guarda
aplicava a janela de trinta minutos. Passado esse tempo, `/admin/seguranca` dizia
"confirmado neste aparelho" e escondia o campo do código, enquanto o caixa
recusava e mandava de volta para lá. Sem sair e entrar de novo, não havia como
destravar. Hoje as duas chamam `segundoFatorValido` — a regra do projeto de que
a permissão exibida sai da mesma função que a API aplica, custando caro por não
ter sido seguida.

## Bloco 19 — a comissão

### O lançamento guarda a base, nunca o valor

Faixa progressiva depende do acumulado: a alíquota do corte de terça só é
conhecida no fim do mês, e um estorno no dia 28 pode derrubar a faixa de tudo o
que veio antes. Se o valor fosse gravado na venda, ele teria que ser reescrito a
cada nova venda do período — e reescrever comissão é exatamente o que destrói a
confiança no sistema.

Então o lançamento guarda **base + regra**, e o valor é derivado. É isso que
permite o estorno corrigir o passado sem alterar uma linha sequer.

### A regra é copiada para dentro do lançamento

Mudar a alíquota em outubro não pode mudar o que foi feito em setembro. Mesma
decisão do preço em `order_items`: referenciar o catálogo reescreveria o
passado, e o relatório impresso na sexta não bateria com o da segunda.

### Faixa progressiva é marginal

Os primeiros R$ 5.000 a 40%, e só o que passa disso a 45%. A alternativa — a
alíquota da faixa alcançada valendo para tudo — é **outra regra**, e produz um
degrau em que vender um real a mais aumenta a comissão em centenas. Se a
barbearia quiser o degrau, isso é uma modalidade nova e explícita.

Um teste afirma a propriedade que define "progressiva": a função é contínua nas
fronteiras.

### O desconto é rateado entre os itens

A comanda tem um desconto só; a comissão é por item, e itens podem ser de
barbeiros diferentes. Sem ratear, o desconto cairia inteiro sobre o primeiro da
lista e quem cortou o cabelo pagaria sozinho a cortesia dada na conta toda.

O rateio é proporcional e a soma das partes é **exatamente** o desconto —
arredondar cada parte para baixo faria um centavo sumir da conta da casa a cada
comanda. A sobra vai para o item de maior valor, deterministicamente, para que
dois relatórios do mesmo mês não divirjam por um centavo.

### Fechar é congelar, e o carimbo é o que segura

O fechamento calcula, grava o valor por profissional e carimba os lançamentos.
Depois disso eles não entram em conta nenhuma de novo.

O índice único de período só pega o duplicado exato. O que impede pagar duas
vezes por períodos **sobrepostos** é o filtro de carimbo — e, na corrida, a
trigger: o segundo `UPDATE` espera a trava do primeiro, relê a linha já
carimbada e recusa, derrubando a transação inteira.

Vale registrar como o teste dessa regra quase não provou nada. A primeira versão
punha a venda no dia 10 com os períodos 01–30 e 15–15/10: fora da sobreposição,
então o filtro de data já bastava e o teste passava mesmo com o carimbo
ignorado. Movi a venda para o dia 20.

### Duas fontes para "quando esta venda aconteceu"

Um teste de integração falhou dizendo que "quem ficou sem regra" via um mês
vazio. A causa não era o teste: `commission_entries.earned_on` guardava o dia da
**unidade**, e a consulta de itens sem regra filtrava por `orders.closed_at`,
que é o instante em UTC. Dois relógios para o mesmo período — e a divergência só
apareceria perto da meia-noite, que é o horário em que barbearia fecha.

`orders.business_day` passou a existir para haver uma resposta só.

### Falta de regra ≠ comissão zero

A tela lista **quem vendeu e nenhuma regra alcançou**. Sem isso, as duas
situações são o mesmo número na tela, e o barbeiro descobre no dia do acerto
olhando um valor menor do que esperava, sem nada explicando o porquê.

### Segundo fator protege o dinheiro dos outros

`commission.view_all` e `commission.edit_rules` entraram no grupo que exige MFA:
a primeira é ver a folha inteira, a segunda é mudar quanto cada um recebe.

`commission.view_own` ficou **fora**, e está escrito como exceção com nome
próprio para poder ser discutido. É o barbeiro olhando o próprio holerite. Pôr
um código de seis dígitos entre ele e a primeira tela que abre todo dia é como a
barbearia acaba procurando como desligar a proteção inteira.

### O que a `/security-review` encontrou no bloco da comissão

Um defeito, e ele invertia o controle nos dois sentidos.

`GET /v1/admin/commission` declarava `@Exige('commission.view_own')` e decidia
**por dentro** se devolvia a folha da casa ou só o holerite de quem perguntou.
A `PermissaoGuard` deriva a exigência de segundo fator da permissão
**declarada** — então a rota era liberada pela permissão barata e servia o dado
da cara. O dono lia quanto cada barbeiro ganhou sem digitar código nenhum, com a
sessão do balcão que fica aberta o dia inteiro, enquanto a rota ao lado, de
mudar a regra, exigia o segundo fator.

E o outro lado, que não era de segurança: o **gerente** tem `view_all` e não tem
`view_own`. A exigência conjuntiva o trancava para fora exatamente da tela que a
permissão dele existe para abrir.

A correção não foi um `if` a mais: são duas rotas. `/mine` serve o próprio
holerite sem segundo fator; a raiz serve a folha e declara `view_all`, que está
no grupo de dinheiro. A invariante que a guarda depende volta a valer — **o que
o `@Exige` diz é o que a rota faz**.

A lição para o próximo bloco: quando uma rota decide por dentro *quanto* devolve,
a permissão declarada deixa de descrevê-la — e toda garantia derivada dela para
de valer junto.

**Lacunas conhecidas** estão na tabela
[Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada), cada
uma com o que já existe, o que falta e em qual bloco entra.

## Bloco 20 — o primeiro processo que roda sem ninguém esperando

Até aqui todo efeito deste produto acontecia enquanto alguém olhava a tela. O
lembrete de 24 horas não cabe nesse modelo: ninguém está esperando resposta às
9h da manhã de ontem. Daí uma fila de trabalho e um segundo processo.

### A fila é uma tabela, não um Redis

O trabalho nasce **dentro da mesma transação** que cria o fato que o origina. Se
o corte entra, o lembrete entra; se a transação volta atrás, o lembrete some
junto. Com uma fila fora do banco isso vira entrega em dois lugares — problema
que uma barbearia não tem escala para justificar. Postgres com
`FOR UPDATE SKIP LOCKED` sustenta ordem de milhares de tarefas por minuto.

O que impede a mensagem dupla é o índice único sobre a chave de idempotência,
não um `SELECT` antes de inserir — que teria janela de corrida entre a consulta
e a escrita. E falha não some: tentativa tem teto e espera crescente (1, 2, 4…
minutos, teto de uma hora); esgotado o teto, a tarefa vira `failed` e fica
visível. Mensagem que ninguém enviou e ninguém soube é a pior das duas falhas
possíveis, porque a barbearia acha que avisou.

### A tabela `jobs` não tem RLS, e é de propósito

Ela é infraestrutura: o worker precisa ver a próxima tarefa **antes** de saber
de quem ela é. Quem protege o dado de negócio continua sendo a RLS das tabelas
que a tarefa toca — o handler abre `withTenant` com o tenant da própria tarefa,
e dali para dentro nada muda. O `payload` guarda id, nunca conteúdo: nome e
telefone são lidos sob RLS na hora de executar.

### A varredura que não podia existir

A primeira versão da falta automática era uma varredura de plataforma, sem
tenant, atravessando barbearias. Ela não podia funcionar, e o teste pegou:
`appointments` tem RLS, e sem tenant no contexto a consulta devolve zero linhas
**sempre**.

A correção foi melhor que o remendo. A falta virou **uma tarefa por
agendamento**, criada junto com ele, com `run_after` no instante exato em que a
tolerância vence: mais precisa que varrer de minuto em minuto, sem gastar nada
quando não há ninguém atrasado, e passando pela RLS como qualquer outra escrita.
Sobrou a regra, agora no schema: `jobs.tenant_id` é `NOT NULL` — quem não tem
tenant não tem o que fazer ali.

A mesma impossibilidade decidiu a mensagem de retorno, que é a única tarefa
periódica do produto: `locations` também tem RLS, então nenhum processo sem
tenant descobre quem quer a mensagem. A cadeia nasce quando a barbearia **liga**
o aviso na tela e se mantém sozinha, cada varredura criando a próxima — e para
quando ela desliga.

### A tolerância conta da hora combinada

`marcarFalta` mede a partir de `service_starts_at`, não de `starts_at`. Os dois
diferem quando o serviço tem preparo antes: `starts_at` é quando a cadeira fica
ocupada. Contar dali puniria o cliente por um tempo que não é dele — e faria o
status virar num instante diferente do que o painel do dia mostra, que conta da
hora combinada desde o bloco 11.

### A senha de primeiro acesso não entra na fila

Todo o resto do bloco passa pela fila. A senha não, e a razão é a mesma que
justifica `jobs` não ter RLS: a tabela é durável e legível sem tenant no
contexto. Enfileirar a senha em claro a transformaria num segredo em repouso.
Ela sai inline depois do commit, como o OTP desde o bloco 4, e continua voltando
na resposta — porque o provedor pode estar fora do ar e o dono precisa poder ler
em voz alta para quem está do lado dele. O registro guarda que saiu, com
telefone mascarado; nunca o que saiu.

### O que o cliente recebe, e o que ele nunca recebe

A janela de silêncio (21h–8h) e o fuso saem da **unidade**, nunca do aparelho —
mesmo defeito D2 do sistema analisado. A confirmação sai na hora de marcar, não
na hora do corte. Consentimento de marketing é separado do necessário para
executar o serviço: quem recusa promoção continua recebendo o lembrete do
próprio corte, e o convite de retorno — a única mensagem promocional daqui —
respeita opt-in, teto mensal e prazo mínimo de sete dias.

Cancelar ou remarcar apaga as tarefas pendentes daquele agendamento, **inclusive
a falta**. E o handler reconfere o estado na hora de enviar: são duas defesas
porque cancelamento e envio podem se cruzar no mesmo segundo.

### A tela diz o que não saiu, com o motivo

`/admin/avisos` liga e desliga cada aviso e mostra os últimos envios — os que
saíram e os que **não** saíram, com o motivo em português. "O cliente foi
avisado?" é pergunta de discussão sobre falta, e "não, porque não tinha
telefone" é uma resposta; uma lista só de sucessos não é.

O registro é append-only por `REVOKE`, como `audit_log` e o extrato do cliente:
resposta que pode ser reescrita não responde nada.

### O que a medição encontrou desta vez

O ramo de erro. Nove telas do painel tinham a saída do estado de erro como um
`<a>` cru — 16px de altura, contra o piso de 44. Nenhuma medição pegava, porque
o caminho feliz nunca renderiza aquele ramo; a tela de avisos foi a primeira
cujo erro apareceu na régua, e a correção valeu para as nove.

## Bloco 16 — a quarta superfície, e duas colunas que estavam vazias

O barbeiro era o único dos quatro perfis da SPEC sem tela. Ele entrava no painel
do balcão — que funciona para ele, porque a API já recortava a agenda pela
cadeira dele desde o bloco 12 — e via uma tabela de cinco cadeiras feita para um
notebook aberto o dia inteiro. Funcionar não é servir.

### Duas colunas que existiam há quatro blocos sem nada atrás

`customers.view_notes` é permissão desde o bloco 12. O papel `professional` a
recebe por padrão, a `PermissaoGuard` a aplica, a recepção é excluída dela de
propósito — e não havia uma única coluna de anotação no schema. É o defeito de
`blocks` ao contrário: lá o motor aceitava um campo que ninguém preenchia, aqui
a permissão é que estava vazia.

`staff_users.professional_id` idem: coluna, chave estrangeira e recorte da
agenda prontos, e nada que ligasse a cadeira à conta. Sem esse caminho o
barbeiro usa a conta do dono — o incidente exato que o bloco 12 existia para
impedir.

### Uma cadeira, uma conta

`professional_id` era livre. Duas contas na mesma cadeira veriam a mesma agenda
como "minha", e a comissão do bloco 19 — que sai de `professional_id` — passaria
a ter dois donos. Índice único parcial, que ignora o nulo de quem não é
barbeiro. E agenda de estação ou sala não recebe convite: mandar senha de acesso
para "Cadeira 2" cria conta que ninguém usa e ninguém desliga, que foi o defeito
D12 do sistema analisado.

### O recorte do barbeiro é outro recorte, não um filtro

A recepção pergunta "como está o salão?"; o barbeiro pergunta "quem é o próximo
e o que ele gosta?". `recortarMeuDia` separa quem está na cadeira **agora** de
quem entra **depois**, e devolve o tempo entre os dois **assinado** — "atrasado
12 min" e "começa em 12 min" levam a decisões opostas, e zerar no piso
transformaria o primeiro no segundo.

### A ficha: estruturada onde vira filtro, livre onde vira gente

Os seis campos da SPEC §4.1 respondem perguntas de operação — quantos preferem
silêncio, que produto evitar ao repor estoque. O texto livre existe ao lado
porque nenhuma lista fechada cobre "o redemoinho do lado direito abre para
cima". Só `conversa` é fechado, e por um motivo: ele muda o comportamento de
quem atende e precisa ser legível de relance com a mesma palavra sempre —
"quieto", "não gosta de conversa" e "silêncio" leem como três coisas para quem
está com pressa.

Na tela, **o que evitar vem primeiro**, apesar de ser o campo menos preenchido:
é o único cuja falha machuca. E a anotação aparece com quem escreveu e quando —
ninguém confia numa anotação sem dono.

### O que a `/security-review` encontrou, e o que ela ensinou sobre o portão

Um defeito, e ele era uma regressão contra uma regra que este repositório já
tinha escrita **e** já tinha mecanismo para cumprir.

O convite mandava a senha de primeiro acesso na URL
(`?convidado=...`). `sessao-gestor.ts` explica desde o bloco 12 por que isso não
pode: senha em parâmetro de consulta fica no histórico e no autocompletar do
balcão — máquina compartilhada — e viaja no `Referer` de toda requisição da
página. E "morre no primeiro uso" é mais fraco do que parece, porque
`must_change_password` bloqueia o painel, não o login: quem lê a URL primeiro
fica com a conta. O mecanismo certo, `guardarSenhaDeUmaVez`, existia ao lado.

O portão não pegou porque nada lia aquela regra. Agora lê
(`senha-na-url.test.ts`) — e a primeira versão **desse teste** também não pegava:
ela conferia linha a linha, e `new URLSearchParams({` e `convidado: senhaInicial,`
são linhas diferentes. Só a versão que parte o arquivo por instrução ficou
vermelha. Teste que só pega o vazamento escrito numa linha só não pega vazamento
nenhum.

## Bloco 17 — o número que muda o que se faz hoje

A SPEC §4.21 pede indicadores e metas para o barbeiro. Os indicadores já eram
deriváveis; **meta não é** — é um número que alguém escolhe, e foi a única coisa
desta parte da SPEC que precisou de tabela.

**Meta é do mês, não da pessoa.** Uma linha por profissional e por mês:
dezembro não tem a meta de fevereiro, e comparar o realizado de março contra um
número que mudou em abril é como se perde a confiança no indicador. Sem
renovação automática — meta que se renova sozinha vira número que ninguém
escolheu. A tela sugere a do mês anterior preenchida, que é diferente de decidir
por alguém.

**Um número sem referência não muda comportamento.** "R$ 12.400" não diz nada;
"82% da meta, e faltam 9 dias" diz. Daí o ritmo — quanto deveria ter faturado
até hoje. Sem ele o barbeiro descobre no dia 30 que estava atrás desde o dia 8.
E o tom da frase muda com o estado: cobrar quem já bateu é o jeito mais rápido
de fazer alguém parar de olhar a tela.

**O `rebooking rate` é medido contra o instante do atendimento**, não contra
agora. Perguntar "tem agendamento futuro hoje?" contaria quem voltou em novembro
por outro motivo, e a taxa de setembro mudaria toda vez que alguém abrisse a
tela.

**A comparação é com o próprio passado, nunca com o colega.** Não há nome de
outra pessoa na tela do barbeiro, e não é omissão: a SPEC §4.21 é explícita
sobre por quê, e o ranking ficou declarado como lacuna — entregar o motor de
ranking antes de existir demanda seria construir o que a SPEC pede para manter
desligado.

### Três guardas que nasceram de erros deste bloco

**Crase dentro de consulta SQL.** Fecha o *tagged template*, e o erro sai como
`TS1005` em cima de uma linha de prosa. Aconteceu três vezes em três blocos.
Agora há teste — e ele nasceu errado duas vezes: a primeira versão procurava a
crase logo depois de `$queryRaw` e não via `$queryRaw<Linha[]>`; a segunda lia
só arquivos rastreados, e não via o arquivo recém-escrito, que é onde o defeito
nasce. A terceira pegou o erro que eu cometi enquanto escrevia o comentário
sobre não cometê-lo.

**Token de CSS que não existe.** `var(--space-10)` num `padding` de três valores
não faz o terceiro cair no padrão: invalida a **declaração inteira**, e o
`padding` vira zero — inclusive as laterais, que estavam certas. A escala vai
até `--space-8`. A régua pegou no navegador, e só porque a barra de navegação
transbordou: o sintoma apareceu num elemento que não tinha defeito. Agora
`globals.test.ts` confere todo `var()` contra os tokens declarados — e o teste
achou um segundo caso na hora, um token que só existia no `style` inline do
componente.

**`destinoDoBalcao` saiu de `acoes.ts`.** A guarda contra redirecionamento
aberto vivia num arquivo `'use server'`, que não dá para importar num teste.
Quatro blocos sem cobertura — e foi assim que ela deixou de aceitar
`/admin/meu-dia` sem ninguém notar, fazendo o barbeiro rodar dois
redirecionamentos a cada botão. Agora mora em `lib/destino.ts`, ao lado de
`destinoSeguro`, com sete casos incluindo prefixo parecido (`/admin/diabolico`).

### O que a `/security-review` encontrou

Nada de segurança. Apontou um defeito de robustez que virou teste: `2026-99-01`
passava pelo formato, atravessava a borda inteira e só morria no Postgres —
virando 500 sobre entrada que a borda tinha obrigação de recusar com 400.

---

## Bloco 21 — o número que vira decisão, e o cadastro que atrapalha a agenda

Três coisas entram juntas porque respondem à mesma pergunta do dono: **o que
está acontecendo, e o que eu conserto hoje.**

### Número sem comparação não gera decisão

É a frase da SPEC §5.9, e ela decide o formato de tudo no painel: "R$ 5.820" não
diz nada; "R$ 5.820, 12% acima do sábado passado" diz.

A comparação é com **o mesmo dia da semana**, não com ontem. Barbearia tem
semana com forma — sábado é o dobro de terça, segunda muitas vezes é fechada —,
então sábado contra sexta produziria alta toda semana e queda toda segunda.
Ruído que ninguém consegue usar.

Ocupação é **tempo**, não contagem: um corte de 30 e uma coloração de 120 não
ocupam a casa do mesmo jeito. O denominador são os minutos de jornada daquele
dia da semana — e num dia sem jornada nenhuma a ocupação é zero, não infinito.

Cliente novo é quem apareceu **hoje pela primeira vez**, medido pelo primeiro
atendimento concluído. Contar cadastro criado hoje contaria também quem a
recepção digitou de novo por engano.

### Duas rotas para o painel, porque são duas permissões

`reports.operational` é da recepção e da gerência; `finance.view` está no grupo
de dinheiro e exige segundo fator. Uma rota só, decidindo por dentro o que
devolve conforme quem pergunta, faria a permissão declarada deixar de descrever
a rota — o defeito que a `/security-review` encontrou no bloco 19.

A tela pede as duas e desenha o que conseguiu. Não esconde bloco atrás de
cadeado: a SPEC §5.9 proíbe explicitamente ("não ficam cinza com cadeado").

### O validador: dez regras, uma delas exigindo uma coluna nova

`packages/core/src/validador.ts` é lógica pura, com teste que roda sem banco. A
regra V1 — "combo com duração menor que a soma das partes **menos a tolerância
declarada**" — não podia existir, porque a tolerância não existia. Sem ela, a
regra acusaria todo combo legítimo: cortar e fazer a barba na sequência é
genuinamente mais rápido que os dois atendimentos separados.

O padrão é **zero**, de propósito. Combo cadastrado sem ninguém pensar no assunto
tem que aparecer no validador — é o defeito D4, o mais caro encontrado em campo.
E há teto de uma hora: acima disso a "tolerância" deixou de descrever o ganho da
sequência e virou um jeito de calar o validador.

A leitura do banco é **três consultas**, não uma por serviço. Uma consulta por
serviço para descobrir quem o executa e quanto ele leva de fato seria N+1 numa
tela que o dono abre justamente quando o cardápio está grande. A duração real é
`percentile_cont(0.5)` — a mediana, não a média: um atendimento que parou pelo
telefone puxa a média e não move a mediana. E só entram atendimentos com **um
serviço só**, senão a mediana do corte viraria a do corte com barba.

### A trilha guarda *quanto*, e foi isso que a primeira versão não conferiu

A tela da trilha fecha uma lacuna aberta desde o bloco 12. A primeira versão
serviu a trilha inteira sob `settings.manage`, com uma justificativa escrita no
próprio arquivo: "a trilha guarda *quem fez o quê*, nunca a senha nem o hash de
ninguém".

A frase é verdadeira e a categoria conferida era a errada. `cash.closed` guarda o
esperado, o contado e a divergência da gaveta. `order.discount` guarda o valor
perdoado. `debt.received` guarda o saldo do cliente. `commission.closed` guarda o
total da folha do período. A trilha não guarda segredo — guarda **quanto**.

Como a exigência de segundo fator é **derivada** do `@Exige`, e `settings.manage`
não está no grupo do dinheiro, a rota entregava o caixa e a folha sem MFA para a
mesma conta que `/dashboard/revenue` tinha barrado um minuto antes. Foi a
`/security-review` que pegou.

O conserto é a partição do vocabulário em `packages/identity/src/audit.ts`: uma
lista de gestão (conta, papel, permissão, segundo fator) e uma de dinheiro
(caixa, comanda, fiado, comissão), duas rotas, duas permissões — e a tela com
duas abas, porque a fronteira de permissão é real e vale mostrá-la. `listAudit`
passou a **exigir** a lista de ações: o parâmetro opcional com padrão "todas" é o
que faria a próxima rota nascer entregando o caixa por esquecimento.

O que segura isso daqui para frente é `audit.test.ts`, que lê o tipo
`AuditAction` do arquivo de origem e reprova quando uma ação nova não está em
exatamente um dos dois lados. Ação auditada num bloco futuro fica vermelha até
alguém decidir de que lado ela fica.

### Duas telas que passaram sem existir

A medição de responsividade devolveu "ok" para trinta e cinco telas contra um
banco de demonstração duas migrações atrás — todas mostrando caixa de erro, que
não rola, não estoura e não tem alvo pequeno. A medição agora confere primeiro se
a tela **carregou**: caminho final igual ao pedido, e sem o texto de falha. E
largura que nem chegou a ser medida deixou de contar como aprovada.

Na mesma linha, uma tela medida contra um servidor com build velho não foi
medida. Aconteceu aqui: o `next-server` de uma hora antes continuou de pé depois
de um `pkill` que só matou o processo pai, e a aba nova da trilha "passou" sem
existir no bundle servido.

### `.achado` já era de outra coisa

O diagnóstico do catálogo chama seus itens de `defeito` no CSS, apesar de o tipo
se chamar `Achado`. `.achado` já é a linha de resultado da busca de cliente no
balcão — flex, uma linha, alinhada ao centro. Reaproveitar o nome herdaria aquele
layout em silêncio, e a tela quebraria sem ninguém tocar num arquivo dela.

---

## Bloco 22 — trazer a base do sistema antigo

> "Barbearia estabelecida não começa do zero: ela tem base de clientes,
> histórico e agenda futura. **Sem importador, a venda morre na objeção 'vou
> perder meus clientes'.**" — SPEC §5.8

### Um parser de CSV escrito à mão, e o motivo

O formato cabe em duzentas linhas, e o que ele exige não é conformidade com a
RFC 4180 — é **tolerância a exportador mal-educado**, que nenhuma das fontes da
SPEC respeita. Uma biblioteca traria a RFC e não traria o que falta: separador
`;` (padrão do Excel em português, porque a vírgula é o separador decimal), BOM
do Windows, CR sozinho de exportador antigo de Mac, e linha com o número errado
de colunas. E `packages/core` não depende de nada por regra.

Duas decisões que só aparecem com arquivo de verdade:

- **A detecção do separador conta fora de aspas.** `"Nome, Sobrenome";Telefone`
  tem duas vírgulas dentro de um campo e um `;` de verdade; contar cru escolhe a
  vírgula e devolve lixo.
- **Linha curta vira campo vazio, não erro.** Numa base de mil clientes existe
  sempre a linha estragada, e derrubar o arquivo inteiro por causa dela é o
  comportamento que faz a barbearia desistir da migração.

### O telefone é a identidade, e chega em três formatos

`(71) 98888-7777`, `71988887777` e `+55 71 98888-7777` são a mesma pessoa — é
assim que a base sai de um sistema usado por seis anos por gente diferente. A
deduplicação é por E.164, que já era a chave desde o bloco 1.

Mesmo telefone com **nome diferente** não é duplicata: é marido e mulher no
mesmo celular, e escolher sozinho apagaria um dos dois. Vira conflito, com as
duas grafias na tela, e fica de fora.

### Aniversário só pode entrar no formato que não é ambíguo

`dd/mm/aaaa` e `aaaa-mm-dd` entram; `mm/dd/aaaa` não. Não há como distinguir
`03/04/1990` de `04/03/1990` sem perguntar, e adivinhar erra em silêncio numa
data que ninguém confere — o cliente descobre quando recebe "feliz aniversário"
no mês errado.

### O importador nunca liga o consentimento de marketing

É o que impede o erro que a SPEC nomeia: "importar 1.200 clientes e mandar 1.200
mensagens de 'sentimos sua falta' no primeiro dia é o erro que queima o número de
WhatsApp e a conta da barbearia".

Não é uma exceção na varredura — é a consequência de uma regra que já existia:
consentimento precisa de data, IP e versão do texto, e nada disso atravessa uma
exportação. Nenhuma coluna do arquivo o liga.

**O teste disso nasceu errado e passou assim mesmo.** A primeira versão dava aos
clientes importados nenhum histórico, e a varredura os pulava por "nunca veio" —
não por consentimento. Ele ficava verde com a regra de consentimento arrancada
dos dois lugares onde ela mora. Agora cada importado tem uma visita antiga
concluída, e a única coisa que o segura é o `accepts_marketing` falso.

### Reversível quer dizer saber o que foi criado

`customers.import_id` marca **só quem a importação criou**. Cliente que já
existia e teve o aniversário preenchido não recebe a marca: desfazer não pode
apagar gente que estava aqui antes.

E a reversão **recusa inteira** quando algum importado já marcou horário, abriu
comanda ou entrou na fila. "Desfeita inteira" é a palavra da SPEC; um desfazer
parcial deixaria a base num meio-termo que ninguém pediu, e apagar o cliente
levaria junto o agendamento de amanhã.

### A cópia dos dados pessoais tem prazo, e é o banco que cobra

Entre conferir e aplicar, o preview guarda os quatro campos que viram cliente —
nunca o CSV inteiro, que costuma trazer CPF, endereço e nome da mãe. Ao aplicar,
a cópia some, e há `CHECK` que recusa marcar `applied` sem limpá-la: a regra de
retenção está onde não dá para esquecer.

### O endereço antigo continua funcionando

`tenant_slugs` é a única tabela do produto com `SELECT` público — a API resolve
`/{slug}` antes de existir tenant no contexto. Consequência direta: quem separa
as barbearias na listagem é o `WHERE`, não a política, e é a única consulta do
código que repete `tenant_id` de propósito. Está escrito na função.

### O que a `/security-review` encontrou

Nada de segurança — e ela verificou o que este bloco tinha de mais arriscado: o
`DELETE` em massa da reversão, o `unnest` do `INSERT` em lote, o endereço público
e o arquivo enviado.

Apontou uma coisa que não é vulnerabilidade e é violação de regra deste
repositório: **`observacao` era detectada, aparada e jogada fora**. Campo que o
motor aceita e ninguém preenche é mentira (CLAUDE.md §4). Agora a observação do
sistema antigo vira a anotação da ficha — sem sobrescrever a que o barbeiro
escreveu com o cliente na cadeira, que vale mais que a herdada.

Apontou também que um preview **abandonado** guardava a cópia dos dados pessoais
para sempre: `payload` some ao aplicar, e faltava o caso de quem confere e
desiste. A faxina pega carona na importação seguinte, e não virou tarefa na fila
porque `imports` tem RLS — varredura de plataforma não enxergaria linha nenhuma
sem tenant no contexto.

### O que a medição e o boot pegaram

- **`input[type=file]` dimensiona pelo nome do arquivo escolhido.** Um nome real
  (`clientes-agenda-antiga-exportacao-final.csv`) estourava os 360px e levava a
  página junto. Só apareceu porque a medição prepara o arquivo com nome de
  verdade.
- **A API não subia.** `import { json } from 'express'` compila e passa em todo
  o e2e — que monta a aplicação sem passar por `main.ts` — e quebra no
  `node dist/main.js`, porque `express` chega por dentro do
  `@nestjs/platform-express` e não é dependência declarada. O limite de corpo
  agora vem do `useBodyParser` do Nest.
- **A crase dentro de SQL, pela quarta vez.** Desta vez o guarda do bloco 17
  apontou arquivo e linha antes do build.

---

## Barber Dock — a marca chegou, e o CSS inteiro mudou com ela

Até aqui a direção visual era escolha do projeto na falta de identidade: âmbar
sobre quase-preto primeiro, depois o verde-menta da cadeira esmaltada. As duas
caíram quando chegou o **Barber Dock** — logo, selo e dois mocks. Marca do
cliente ganha de direção inventada.

### Trocar a marca foi trocar um arquivo

`packages/ui/src/tokens/tokens.ts` — e as trinta e poucas telas mudaram juntas,
sem nenhuma saber que a cor mudou. Era exatamente para isso que os tokens eram
semânticos desde o bloco 6, e é a primeira vez que a promessa foi cobrada.

Os quarenta e dois pares de contraste declarados continuaram passando, com folga:
o mais apertado é 3,39 contra o mínimo de 3.

### O pergaminho é o acento, e o vermelho quase não aparece

No selo o vermelho é um detalhe e o creme é o campo inteiro. Além disso —
**vermelho já significa "cancelar", "faltou" e "erro"** em trinta telas: um
"Agendar" vermelho ao lado de um "Cancelar" vermelho é toque errado no balcão,
com cliente na frente. O vermelho ficou onde o selo o põe: tarja de seção, o
traço sob a palavra do título, e o que remove dinheiro.

### As fontes vêm do nosso domínio, não do Google

Oswald e DM Sans entram pelo `next/font`, que baixa no build e serve junto com a
aplicação. O `@import` do Google Fonts — que é como o mock chega — faria o
navegador de cada cliente pedir a fonte a um terceiro e entregar o IP dele
junto: dado pessoal saindo da barbearia a cada visita, por causa de uma fonte.

### A escala de produto não servia para vender

A primeira versão da landing usou a escala existente e ficou apertada. O que faz
uma página parecer cara é ar, e ar não sai de uma escala desenhada para caber
comanda em 360px. Entraram `space-9/10/11` e `font-size-4xl/5xl/6xl`, marcados
como escala de página de venda — nenhuma tela de operação usa os seis.

### O que a landing não tem, e por quê

- **Zero JavaScript de cliente.** As abas do mock viraram faixa que rola, o
  "revelar ao rolar" saiu e a paleta de comandos não entrou. O que ficou de
  movimento é ambiente e some inteiro em `prefers-reduced-motion`.
- **Nenhum depoimento.** Inventar nome de barbearia satisfeita é fabricar prova.
  No lugar deles está o que é verificável: os defeitos medidos em campo
  (`SPEC.md` §2.2), com o efeito de cada um no dia e o que fazemos diferente.
- **Nenhum preço.** Não há decisão comercial tomada, e inventar tabela seria a
  mesma fabricação.

### O casco: as internas ganharam a moldura do mock

A primeira passada mudou cor e letra e parou aí — as telas continuaram sendo
uma coluna solta no meio da página. Agora existe `casco.tsx`: trilho de
navegação agrupado, coluna de contexto com a casa e quem está logado, e a área
de trabalho com a malha fina do estaleiro. Vive em `admin/layout.tsx`, então
entrou nas trinta e poucas telas de uma vez.

Sem um byte de JavaScript. O item ativo sai do CSS: cada tela declara
`data-secao` no próprio `<main>` e o casco acende com `:has()`, em vez de virar
componente de cliente só para ler a rota.

**O tema do admin virou escuro, e isso reverte uma decisão anterior.** O
argumento do claro continua de pé (o balcão fica horas com a tela ligada), mas a
marca chegou e o desenho que veio com ela é escuro. Direção do cliente ganha de
escolha do projeto. É um atributo, e os dois temas passam pela mesma verificação
de contraste — voltar é uma linha.

### O menu virou o do mock: módulos no trilho, telas no contexto

A primeira versão do casco listava os onze destinos e pronto — parecia um índice,
não um sistema. A estrutura certa é a do mock e é uma decisão de informação, não
de enfeite: **o trilho são os três módulos** (Operação, Dinheiro, A casa) e **o
contexto são as telas de dentro do módulo aberto**, cada uma com uma frase do que
faz. Um link mora num lugar só.

O módulo aberto acende com fundo em degradê e um filete creme→vermelho — a única
peça da moldura que usa as duas cores da marca juntas. Quem escolhe é `:has()`
sobre o `data-secao` que cada tela declara.

Duas armadilhas no caminho, as duas de CSS gerado por script:

- **`A, B, C::after` aplica o pseudo só em `C`.** O filete do item ativo só
  aparecia na última das quinze seções. Cada seletor precisa do seu `::after`.
- **Substituir por regex num arquivo de 3.600 linhas comeu um bloco inteiro** —
  a regra de fundo do estado ativo, com a chave de fechamento junto. O build
  apontou `Unexpected }` trinta linhas adiante. A saída foi reescrever o bloco do
  casco inteiro a partir de uma marca conhecida, sem regex.

### Painéis, selos e o anel

Depois do casco, o que faltava era o miolo. Três primitivas, e como moram nas
classes que as trinta telas já usam, entraram de uma vez:

- **`.quadro`** — o painel do mock: cabeçalho com título, subtítulo e ação à
  direita, corpo separado por linha. É o que separa uma tela de sistema de uma
  folha de formulário.
- **`.selo`** — a pílula de estado, com borda e fundo da própria cor. Cor **e**
  texto, nunca cor sozinha: um em doze homens não distingue verde de vermelho, e
  barbearia é público de homem.
- **`.anel`** — o gráfico de fração em `conic-gradient`, com o número escrito no
  meio. Zero SVG, zero JavaScript, e legível para quem não enxerga o arco.

O anel só aparece na **ocupação**, e é uma decisão: é a única métrica do painel
que é fração de um todo conhecido — minutos vendidos sobre minutos de jornada.
As outras são contagem, e contagem em anel é desenho sem denominador.

**Gráfico de série ficou de fora, declarado como lacuna.** A API devolve dois
pontos: hoje e o mesmo dia da semana passada. Desenhar uma linha com dois pontos
é inventar tendência onde existe uma comparação.

### O "R$ NaN" que estava lá desde o bloco 11

Abrir o balcão num navegador com conta de verdade mostrou **R$ NaN** no total do
dia. A causa não era a conta: `apps/web/src/lib/admin-api.ts` declarava
`totals.realizadoCents`, e a API **nunca mandou o campo** — de propósito. `/day`
é rota de `appointments.view`; faturamento é `finance.view`, com segundo fator.
Há teste na API, escrito no bloco 12, que reprova se o número aparecer ali.

O tipo mentia, e o TypeScript garantia que a tela lia um campo que nunca
chegava. A primeira correção foi a errada — adicionei o campo à API, e o teste
do bloco 12 reprovou na hora, com o motivo escrito. O certo era tirar o número
da tela: ele mora em `/admin/painel`, para quem pode vê-lo.

### Três coisas que a régua pegou

- **`.marca` já existia.** O selo nas portas do sistema herdou, calado, a pílula
  de caixa de seleção que oito telas usam para marcar dia da semana — e apareceu
  dentro de uma cápsula branca. Virou `.selo-produto`. Mesma armadilha do
  `.achado` no bloco 21, segunda vez no mesmo mês.
- **Esconder no celular, duas vezes.** As âncoras de seção e depois a boia
  decorativa entraram com `display: none` no piso. A guarda reprovou as duas; as
  âncoras viraram faixa que rola, e a boia acabou removida — enfeite que não
  significa nada não merece nem refluir.
- **A medição não conhecia `overflow: hidden`.** Ela aceitava só `auto` como
  recipiente que contém transbordo, e acusava a faixa que corre e a janela que
  sangra de propósito. Os três valores impedem a página de rolar, que é o que a
  regra proíbe — e a rolagem da página continua conferida em separado.
