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
| `packages/core` | Motor de disponibilidade, vida do atendimento e permissões — lógica pura, sem banco e sem relógio | 220 testes ✅ |
| `packages/db` | Schema, migrações, RLS e cliente com escopo de tenant | 10 testes ✅ |
| `packages/scheduling` | Repositórios, disponibilidade, reserva e o dia do balcão | 85 testes ✅ |
| `packages/identity` | OTP, sessão do cliente e do gestor, contas de equipe, auditoria | 75 testes ✅ |
| `packages/ui` | Design system: tokens, tema, componentes acessíveis | 84 testes ✅ |
| `apps/api` | API pública e do painel: perfil, disponibilidade, login, agendamento, balcão, equipe | 125 testes ✅ |
| `apps/web` | Página pública, fluxo do cliente, balcão e equipe, com SSR (Next.js) | 19 testes ✅ |

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
| [`ROADMAP.md`](ROADMAP.md) | Os 78 blocos de execução e o escopo recomendado |
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

## Próximos passos

Bloco 13 de 78 — ver [`ROADMAP.md`](ROADMAP.md).

Admin: CRUD de catálogo, equipe, jornadas e recursos. O onboarding cria o
essencial em dez minutos; o dia a dia precisa editar — mudar preço, ajustar a
jornada de um barbeiro, desativar um serviço — e hoje isso é SQL.

## Responsividade é medida, não olhada

Toda tela serve aos dois aparelhos. Não existe "tela de celular" e "tela de PC"
neste produto — existe a mesma tela, que começa no piso de 360px e ganha
densidade quando há espaço.

Duas guardas, porque uma só não bastava:

- **Teste sobre o CSS** (`globals.test.ts`): `min-width` sempre, nenhuma largura
  fixa acima do piso, e nada escondido no celular para reaparecer no desktop.
  Existia só para `packages/ui` — e o arquivo que mais cresce, o das telas, era o
  que ninguém verificava.
- **Medição no navegador** (`scripts/medir-responsividade.js`): abre as quinze
  telas em 360 · 390 · 768 · 1280 e mede elemento a elemento — com fotos de
  verdade carregadas, porque imagem é o que mais estoura layout e medir a página
  sem elas mediria uma versão que não existe. O CSS pode estar
  correto e a grade estourar assim que entra conteúdo real — só a medição pega.

Foi ela que encontrou `← Voltar` com 21px de altura em quatro telas, contra o
piso de 44. Link **dentro de frase** é exceção, e por um motivo, não por
conveniência: a WCAG 2.5.8 isenta, porque esticar um link no meio de um parágrafo
abre buraco no texto. Link de navegação sozinho não é isso.

**Lacunas conhecidas** estão na tabela
[Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada), cada
uma com o que já existe, o que falta e em qual bloco entra.
