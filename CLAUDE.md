# Regras do projeto

Vinculante para todo bloco do [`ROADMAP.md`](ROADMAP.md). Nenhum bloco é dado
como concluído sem cumprir as quatro regras abaixo e o
[Definition of Done](#definition-of-done).

Estas regras não são estilo. Cada uma existe por um defeito concreto encontrado
no sistema analisado em campo (`docs/01-analise-salonsoft.md`) ou por um erro
cometido e corrigido neste repositório.

---

## 1. Testes

**Todo bloco entrega teste junto com o código. Não existe "testo depois".**

### O que precisa de teste

| Tipo de código | Nível exigido |
|---|---|
| Lógica de domínio (cálculo, regra, decisão) | unitário, sem banco, sem rede |
| Garantia imposta pelo banco (constraint, RLS, trigger) | integração contra Postgres real |
| Repositório e query | integração — a query real, não um mock |
| Endpoint | integração, incluindo caminho de erro e de autorização |
| Interface | teste de comportamento, não de snapshot de markup |

### Regras

- **Nunca mocar o que se quer provar.** A constraint anti-overbooking e a RLS são
  garantias do Postgres; mock não prova nada sobre elas. Por isso
  `packages/db/test` e `packages/scheduling` rodam contra banco de verdade.
- **Teste determinístico.** Nada de `Date.now()`, `Math.random()` ou fuso do
  processo dentro da lógica. Relógio entra por parâmetro (`now`), fuso vem da
  unidade. A suíte de `core` roda idêntica sob `TZ=UTC` e `TZ=Asia/Tokyo` — isso
  é verificado, não prometido.
- **Teste tem que poder falhar.** Antes de aceitar um teste verde, confirme que
  ele fica vermelho quando a regra é quebrada.
- **Quando um teste falha, o suspeito é o código — não o teste.** No bloco 1 uma
  expectativa "errada" revelou desperdício real no fim da janela; no bloco 2, o
  mesmo padrão apareceu em recurso. Investigue antes de ajustar a expectativa.
  Se ajustar a expectativa, explique por quê no próprio teste.
- **Caminho triste é obrigatório:** entrada inválida, concorrência, permissão
  negada, tenant errado, recurso inexistente.
- **Nome de teste descreve a regra**, não a função. `"exceção do profissional
  vence o feriado da unidade"`, não `"resolveWorkingDay works"`.
- Cobertura não é meta. Regra sem teste é que é problema.

---

## 2. Cibersegurança

**Aplicável a todo bloco que toque dado, autenticação, dinheiro ou entrada
externa.** Na prática: quase todos.

### Isolamento multi-tenant

- `tenant_id` em toda tabela de negócio, com **RLS `FORCE`** e política de
  `USING` **e** `WITH CHECK`.
- Acesso ao banco **somente** via `withTenant`. O pool reaproveita conexões: sem
  `set_config(..., true)` dentro da transação, uma requisição herda o tenant da
  anterior.
- O role da aplicação é `NOBYPASSRLS` e não tem DDL.
- Repositório **não** repete `tenant_id` no `WHERE` — quem filtra é a política.
  Assim um `WHERE` esquecido não vaza; e existe teste que consulta sem filtro e
  espera zero linhas.

### Entrada e autenticação

- **Validar toda entrada externa na borda**, com schema. Nunca confiar em id,
  data, fuso ou valor vindo do cliente.
- **O fuso vem da unidade, nunca do dispositivo.** Foi assim que o sistema
  analisado errou a grade para cliente com relógio torto (defeito D2).
- **Rate limit por telefone e por IP** em OTP, login e `/availability`. O
  endpoint de OTP é porta de entrada para custo de mensagem e para enumeração de
  base.
- **Não revelar existência de cadastro.** `verifica_celular` responde igual para
  telefone existente e inexistente.
- OTP: 6 dígitos, TTL 5 min, máximo 5 tentativas, invalidação no acerto,
  cooldown progressivo no reenvio.
- MFA para papéis com permissão `finance.*` — e para `cashier.*`, que move
  dinheiro de verdade. A `PermissaoGuard` **deriva** a exigência da permissão
  declarada na rota: não há decorador separado a esquecer. A prova é por sessão
  e vence em 30 minutos, porque o balcão fica logado o dia inteiro.

  **Quem decide se a cobrança acontece é a barbearia** (`tenants.
  require_mfa_for_money`, bloco 37), e ela **nasce desligada**. Imposto, o
  segundo fator produzia o oposto do que queria: a barbearia que instalava o
  produto na terça e tentava abrir o caixa na quarta encontrava "ative o segundo
  fator" sobre uma conta recém-criada, sem aplicativo autenticador e com o
  cliente na cadeira — e passava a operar o balcão na conta do dono.

  O interruptor decide **se**, nunca **quais** rotas: isso continua derivado da
  permissão, e uma rota de dinheiro escrita daqui a dez blocos continua nascendo
  coberta. Um interruptor que escolhesse rotas seria a lista que a derivação
  existe para eliminar.

### Dinheiro e efeitos colaterais

- **`Idempotency-Key` em todo POST** que cria agendamento ou move dinheiro.
- **Chave de idempotência é escopada por cliente**, nunca só por tenant. Ela vem
  do cliente e é livre: duas pessoas mandando `"1"` colidiriam, e a segunda
  receberia de volta o agendamento da primeira — com o id, que basta para
  cancelá-lo.
- **RLS separa barbearias, não separa clientes dentro de uma.** Toda operação
  disparada pelo cliente final (cancelar, reagendar, ver histórico) filtra
  também por `customer_id`.
- **Consumidor de evento e webhook é idempotente por id.** Entrega duplicada não
  pode gerar comissão dobrada nem baixa de estoque em duplicidade.
- Webhook do PSP é a fonte da verdade, com reconciliação por polling como rede
  de segurança.
- Valor monetário em centavos inteiros. **Nunca `float`.**

### Dados pessoais (LGPD)

- Consentimento de marketing é **separado** do necessário para executar o
  serviço, com data, IP e versão do texto.
- Foto de cliente exige consentimento específico; uso público exige outro.
- `customers.export`, acesso a foto, impersonação e alteração de permissão são
  **sempre auditados**.
- Log de auditoria é append-only.

### Sempre

- Segredo nunca no repositório. Configuração por variável de ambiente. Variável
  que protege dado (`STAFF_EMAIL_PEPPER`, `MFA_SECRET_KEY`) falha alto quando
  ausente — nunca cai num padrão fraco em silêncio.
- Sem SQL concatenado com entrada de usuário — parâmetro sempre.
- Id público é UUID/ULID. Id sequencial em URL permite enumerar a base.
- Erro para o cliente é genérico; o detalhe vai para o log.
- Dependência nova entra só com motivo declarado no commit.

**Ao fechar um bloco que mexa em auth, pagamento, dado pessoal ou permissão,
rode `/security-review` antes do commit.**

---

## 3. Otimização

**Medir antes de otimizar. Mas não entregar lentidão conhecida.**

### Metas (SPEC Parte 5 §5.12)

| Alvo | Meta |
|---|---|
| APIs comuns | P95 < 500 ms |
| `GET /availability` | P95 < 800 ms (7 dias × 5 profissionais) |
| Página pública, LCP em 4G | < 2,5 s |
| PDV: comanda → pagamento | < 1 s percebido |

### Regras

- **Zero N+1.** Carga do intervalo em uma query. Se precisar de laço sobre
  registros com ida ao banco dentro, está errado.
- **Índice junto com a query que o exige**, no mesmo bloco. Índice parcial
  quando o filtro é sempre o mesmo (ex.: status não-terminal).
- **Cache invalidado por evento**, nunca só por TTL. `/availability` invalida em
  `appointment.created/cancelled/updated`, `schedule.changed`, `block.created`.
- **Não desperdiçar capacidade.** Este produto vende agenda: buraco morto é
  dinheiro perdido. Três vezes o mesmo padrão apareceu (grade fixa, fim de
  janela, contenção de recurso) — sempre que houver janela livre, pergunte se
  algum pedaço dela está sendo descartado sem necessidade.
- **Paginação por cursor**, nunca offset.
- Bundle do cliente separado do admin. Não entregar o ERP inteiro a visitante
  anônimo (defeito D10).
- Otimização entra com número antes e depois. Sem medição, não entra.

---

## 4. Arquitetura e clean code

### Direção de dependência

```
                 ┌── scheduling ──┐
                 ├── identity ────┤
core  ←──────────┤                ├──  api  ←  web
                 ├── onboarding ──┤
                 ├── catalog ─────┤
                 └── finance ─────┘
  ↑                      ↓
  └───────────────── db (Prisma/SQL)
```

`onboarding` depende de `scheduling` e `identity` porque a etapa final precisa
provar que a barbearia tem grade — e é isso que separa um formulário de um
produto. A seta nunca volta: `scheduling` não sabe que existe onboarding.

`catalog` depende só de `core` e `db`, e é de propósito: ele **edita** o mesmo
cadastro que `onboarding` **cria**, e as duas operações são diferentes o
bastante para não compartilharem código. O onboarding substitui o conjunto
inteiro, o que é certo para quem está abrindo e errado a partir do dia seguinte
— `appointment_services` aponta para `services.id`, e recriar o catálogo
desfaz o vínculo com o que já foi vendido.

`platform` depende de `jobs` por uma coisa só: `enfileirarPara()`. A régua de
cobrança precisa enfileirar o aviso ao dono **dentro** da transação que muda o
estado da fatura — mandar depois do commit cria a janela em que a barbearia foi
bloqueada e ninguém soube. É o mesmo precedente de `finance → identity`, e a
seta não volta: `jobs` continua sem saber que existe plataforma, e recebe o que
precisa da camada de cima por injeção no `Contexto` do worker.

`finance` depende de `jobs` pela mesma razão de `platform`: `enfileirarPara()`.
A tarefa que vai conferir uma cobrança de Pix precisa nascer **dentro** da
transação que a cria — enfileirar depois do commit abre a janela em que o QR
Code existe e nada está marcado para vencê-lo, e a comanda fica presa para
sempre, porque só uma cobrança viva é permitida por vez. A seta não volta:
`jobs` continua sem saber que existe comanda, e recebe do `Contexto` do worker
a função que sabe.

`jobs` **não** depende de `crm`, e a varredura de retenção mora lá. O handler
recebe `varrerRetencao` injetada no `Contexto`, como o `provider` de mensagem e
a régua de cobrança: quem monta o processo (`apps/worker`) liga as duas pontas.
Obrigatória e não opcional no tipo — opcional, ela seria esquecida no primeiro
worker novo e a lei deixaria de ser cumprida sem nada ficar vermelho.

`crm` depende de `jobs` pela mesma razão de `platform` e de `finance`:
`enfileirar()`. A resposta a um recado do cliente sai por mensagem, e a tarefa
que a entrega precisa nascer **dentro da transação** que grava a resposta —
enfileirar depois do commit abre a janela em que o balcão lê "respondido" e o
cliente nunca recebe nada, que é a única coisa que aquele canal entrega. A seta
não volta: `jobs` continua sem saber que existe recado, e recebe do `Contexto`
do worker a função que sabe.

`crm` depende de `identity` pelo mesmo motivo de `finance`: `audit()`. A trilha
do consentimento registrado pelo balcão e a do pedido de titular encerrado
precisam ser gravadas **dentro** da transação que muda o estado — a exportação
é a única exceção, e ela é escrita: exportar é uma leitura longa de nove
tabelas, e segurar a transação aberta para escrever uma linha no fim aumentaria
a janela sem ganhar nada, porque o que importa é o registro existir e não ser
atômico com um `SELECT`.

`finance` depende de `identity` por uma coisa só: `audit()`. A trilha precisa
ser gravada **dentro da transação** que move o dinheiro, então ela não pode ser
chamada de fora — e é o mesmo precedente de `onboarding`, que já dependia de
`identity`. Nenhuma seta volta: `identity` não sabe que existe caixa.

- **Faixa progressiva é marginal**, como imposto de renda. A alternativa — a
  alíquota da faixa alcançada valendo sobre tudo — é outra regra, com degrau, e
  entra como modalidade nova e explícita se alguém quiser.
- **`packages/core` não depende de nada.** Sem banco, sem rede, sem relógio, sem
  framework. É lógica pura e é onde mora a regra de negócio. Há teste que falha
  se alguém adicionar dependência a ele.
- Domínio não conhece framework. Controller não tem regra de negócio — traduz
  HTTP para caso de uso e volta.
- Integração externa entra por **abstração** (`PaymentProvider`,
  `WhatsAppProvider`, `FiscalProvider`), cada uma com implementação `fake` para
  teste e desenvolvimento.
- Modular monolith com fronteira explícita por domínio. Microsserviço só quando
  escala ou organização justificar.

### Fonte da verdade

- **O schema é o SQL em `packages/db/migrations`.** Prisma é introspectado
  (`pnpm db:pull`). Constraint de exclusão, RLS e as checks não têm
  representação em Prisma — um `migrate dev` as apagaria.
- Migração é aditiva e reversível. **Nunca editar migração já aplicada em
  ambiente compartilhado ou produção** — antes do primeiro deploy elas ainda são
  maleáveis, depois disso a correção vem em migração nova.
- Migração roda em produção: nada de `CREATE ROLE ... PASSWORD` nem qualquer
  credencial dentro dela. Bootstrap de role fica em `scripts/bootstrap-role.sh`,
  parametrizado por ambiente.

### Código

- **TypeScript estrito**, com `noUncheckedIndexedAccess` e
  `exactOptionalPropertyTypes`. Sem `any`. Sem `!` para calar o compilador —
  trate o caso.
- Nome em português no domínio (`profissional`, `comanda`, `fiado`), inglês nas
  primitivas técnicas. Não misturar dentro do mesmo conceito.
- **Comentário explica *por quê*, não *o quê*.** Se o código precisa de
  comentário para dizer o que faz, reescreva o código. Todo comentário que
  justifica uma decisão contra-intuitiva deve dizer o que aconteceria sem ela.
- Função faz uma coisa. Se o nome precisa de "e", separe.
- Erro é explícito no tipo de retorno ou lançado — nunca `null` silencioso para
  significar falha.
- Não abstrair antes do terceiro caso.
- **Campo que o motor aceita e ninguém preenche é mentira.** Se o domínio expõe
  uma entrada, o bloco que a introduz entrega a origem do dado junto. `blocks`
  ficou oito blocos como parâmetro aceito e sempre vazio: o motor tinha teste
  verde e o barbeiro não conseguia fechar uma hora do dia. Adiar a **tela de
  cadastro** para o bloco do admin é legítimo; adiar o mecanismo não é.
- Configuração de negócio é dado (coluna, feature flag), não constante no código.

---

## 5. Responsividade e acabamento visual

**Aplicável a todo bloco que produza interface.**

### Antes de escrever CSS, invoque `frontend-design`

A skill oficial da Anthropic está instalada em
`.claude/skills/frontend-design/`. **Todo bloco que produza tela nova começa por
ela** — é o que impede o resultado de parecer template.

As duas coisas se complementam e nenhuma substitui a outra:

- **Esta seção define o piso** — responsivo a partir de 360px, contraste medido,
  toque de 44px, foco visível, sem rolagem horizontal. Obrigações, várias com
  teste.
- **A skill define o teto** — direção estética, tipografia com personalidade,
  elemento assinatura.

Em conflito, o piso vence: layout marcante que quebra em 360px ou reprova no
contraste não entra.

**Alerta que já se aplica aqui:** a skill lista três aparências em que design de
IA costuma cair, e a segunda é "fundo quase preto com um único acento vivo" —
descrição superficial do tema escuro do bloco 6. O âmbar tem lastro (couro,
latão, o setor) e passou por verificação, mas paleta não diferencia. A
personalidade tem que vir de tipografia, estrutura e do elemento assinatura.

### Mobile-first, sem exceção

- **O piso de projeto é 360px.** É o Android popular no Brasil, o aparelho em
  que o cliente da barbearia realmente agenda — em pé, na rua, com uma mão.
  Nada pode quebrar abaixo disso.
- **Toda media query de layout usa `min-width`.** `max-width` significa
  "desfazer o que fiz para tela grande", o que inverte a ordem de trabalho e
  deixa o celular como caso excepcional. Há teste que rejeita — no design system
  **e** em `apps/web/src/app/globals.css`, que é onde o CSS das telas realmente
  mora. Por um tempo só o primeiro era verificado, e o arquivo que mais cresce
  era o que ninguém olhava.
- **Larguras de conferência:** 360 · 390 · 768 · 1280. Uma tela que só foi
  olhada no notebook não foi olhada — e o inverso também vale.
- **Toda tela serve aos dois aparelhos.** Não existe "tela de celular" e "tela
  de PC" neste produto: existe a mesma tela, que começa no piso e ganha densidade
  quando há espaço. Vale inclusive para o balcão, cujo aparelho principal é o
  notebook — quando ele está ocupado, a recepção atende pelo celular.
- **Medição, não olhômetro.** `node scripts/medir-responsividade.js` abre cada
  tela nas quatro larguras e mede elemento a elemento: rolagem horizontal,
  transbordo e alvo de toque. Rodar antes de fechar bloco que produza interface.
- **Todo bloco com interface entrega os prints no fim.** Medição verde diz que
  nada quebrou; ela não diz se a tela ficou boa. Quem decide isso é quem olha, e
  para olhar precisa ver — descrever a tela em prosa não substitui a imagem, e
  nenhuma das duas classes de defeito que este documento cataloga (§5 e §6)
  aparece num relatório de "ok".

  ```bash
  MEDICAO_PRINTS=/tmp/prints scripts/medicao.sh
  ```

  A variável já existe e a medição fotografa cada tela nas quatro larguras. O
  que se envia é o **conjunto das telas novas ou alteradas pelo bloco**, na
  largura de 390px e na de 1280px — o celular do cliente e o notebook do balcão.
  Print só de uma das duas esconde metade do problema.
- **Nunca esconder conteúdo no celular — refluir.** `display: none` em tela
  pequena é decisão de que aquilo não importava; se não importa, tire de todas.

### O que nunca pode acontecer

- **Rolagem horizontal na página.** É o defeito mais comum em página de
  barbearia no celular. Conteúdo largo — tabela, grade de horários, diagrama —
  rola dentro do próprio recipiente (`.ui-scroll-x`), nunca leva a página junto.
  Há teste **e** medição no navegador: o teste lê o CSS, a medição vê o layout
  montado, e só a segunda pega grade que estoura com conteúdo real.
- **Imagem sem limite de largura.** `max-width: 100%` sempre, `aspect-ratio`
  declarado no CSS **e** `width`/`height` no `<img>` — sem os dois últimos o
  navegador não reserva o espaço e a foto empurra o conteúdo ao carregar. Há
  teste para os dois em `apps/web/src/app/globals.test.ts`; ele nasceu só no
  bloco 11, quando entrou a primeira imagem do produto.
- **Página sem foto é página fraca, e a culpa costuma ser da origem do dado.**
  A página pública passou dez blocos sem uma única imagem com as colunas de foto
  prontas desde o bloco 1 — faltava por onde preenchê-las. Antes de mexer no CSS
  de uma tela que parece pobre, confira se o dado que a enriqueceria tem
  cadastro.
- **Ação principal sob a barra de gestos.** Barra fixa no rodapé soma
  `env(safe-area-inset-bottom)`. Sem isso o botão "Agendar" fica inalcançável no
  iPhone. Há teste.
- **Alvo de toque abaixo de 44px.** Vale para botão, campo, horário na grade,
  link de navegação e qualquer alvo autônomo — **em qualquer largura**, não só
  no celular: mouse impreciso e limitação motora não são exclusividade do
  aparelho pequeno.

  A única exceção é **link dentro de frase** ("é só *escolher o horário*"), que
  a própria WCAG 2.5.8 isenta: esticar um link no meio de um parágrafo abre
  buraco no texto e piora a leitura. Link de navegação sozinho no topo da tela
  **não** é isso — foi assim que `← Voltar` ficou com 21px em quatro telas até
  a medição pegar.

### Componente responsivo ao recipiente, não à tela

Cartão de serviço aparece em coluna única no celular, em duas no tablet e dentro
de uma barra lateral estreita no admin. Quem decide o formato é a largura
disponível — `@container` —, não a largura da janela.

### Acabamento

O que separa uma página que parece profissional de uma que parece template:

- **Uma ação primária por tela.** Se tudo é destaque, nada é. No fluxo de
  agendamento, a cada passo existe exatamente um botão em `accent`.
- **Ritmo vem da escala.** Todo espaçamento sai de `space`. Valor avulso
  (`13px`, `0.85rem`) é o que faz uma tela parecer montada às pressas.
- **Hierarquia por tamanho e peso, antes de cor.** Cor é o último recurso, não
  o primeiro — e é o que menos funciona para quem tem baixa visão.
- **Foto faz o trabalho pesado.** Em barbearia a escolha é visual: corte,
  ambiente, barbeiro. Layout que depende só de texto vai parecer pobre por mais
  bem espaçado que esteja.
- **Estado vazio, carregando e erro são desenhados**, não improvisados. "Nenhum
  horário disponível" é uma tela, com o que fazer em seguida — não uma lista
  vazia.
- **Conteúdo real desde o primeiro protótipo.** Nada de texto de preenchimento:
  nome de serviço longo, preço de quatro dígitos e nome composto de barbeiro são
  o que quebram layout, e só aparecem com conteúdo verdadeiro.
- **Densidade é diferente por app.** A página pública respira — o cliente entra
  uma vez por mês. O admin é denso — a recepção passa o dia ali e rolagem custa
  tempo.
- **Movimento com propósito e curto.** Transição existe para explicar de onde
  algo veio. Acima de 200 ms vira espera, e `prefers-reduced-motion` desliga.

### Referência de qualidade

O alvo não é "melhor que o concorrente analisado" — a página dele não tem
endereço, mapa, foto de serviço nem descrição (defeitos D8 e D9). O alvo é a
faixa de Booksy e Fresha, documentada em
[`docs/02-benchmark-apps-barbearia.md`](docs/02-benchmark-apps-barbearia.md) §5.

---

## 6. Regra de negócio e coerência do fluxo

**Funcionar sem quebrar não é o mesmo que estar certo.** Esta seção existe
porque o bloco 35 passou no portão inteiro — 123 testes, `pnpm verify` verde,
medição verde, revisão de segurança feita — e ainda assim entregou uma tela em
que nenhuma aba acendia, três telas listadas numa barra que elas não desenham,
e um indicador que nunca sai de `—` porque a fila não fecha ninguém.

Teste prova que o código faz o que ele diz. **Nada ali prova que o que ele diz
faz sentido para quem opera o balcão.** Isso é obrigação separada, e é desta
seção.

### Ao fechar um bloco, percorra o fluxo inteiro como quem trabalha

Não a função nova: o **caminho** de que ela faz parte, do começo ao fim, com a
cabeça de quem faz aquilo trinta vezes por dia. As perguntas, em ordem:

1. **Onde a pessoa entra e para onde ela vai depois?** Toda tela nova tem que
   ter volta. Se a barra de navegação lista um destino, aquele destino desenha
   a mesma barra — senão é caminho de ida sem volta, e no celular o trilho
   lateral é justamente o que menos convida.
2. **A mesma coisa tem o mesmo nome em todo lugar?** "Iniciar", "Começar" e
   "Sentou" eram três botões para a mesma transição, em três telas do mesmo
   produto. Quando a recepção diz "já iniciei o Ruan" e o barbeiro procura
   "Começar", o treinamento vira folclore. Vocabulário de transição mora em
   `packages/core`, não escrito na tela.
3. **O estado tem saída?** Todo estado não-terminal precisa de pelo menos um
   caminho para fora, e ele precisa existir **na tela**, não só no domínio.
   `in_service` na fila era alcançável e não tinha botão para `done`: a entrada
   sumia da tela e nunca fechava.
4. **O dado que a tela precisa já está no banco?** Antes de dizer "falta
   dado", confira. `appointments.started_at` existia desde a migração 0014, com
   comentário dizendo "base da duração real", e era descartado antes de chegar
   à tela — a linha de quem está sendo atendido era a única do painel sem
   nenhuma frase de contexto.
5. **O número que a tela promete chega a aparecer alguma vez?** Indicador que é
   sempre `—` é pior que indicador ausente: ele ocupa espaço prometendo uma
   resposta que nunca vem, e quem opera aprende a não olhar.
6. **Duas telas que mostram o mesmo fato concordam?** Se o trilho diz "você
   está em Comanda" e a barra abaixo não acende nada, uma das duas está
   mentindo.

### O que é defeito de negócio, e por que ele não aparece em teste

| Defeito | Por que o teste não pega |
|---|---|
| Botão que leva a lugar nenhum | O teste exercita a rota, não o caminho até ela |
| Nome diferente para a mesma ação | Cada tela é testada sozinha, e sozinha ela é coerente |
| Estado sem saída na interface | O domínio aceita a transição; ninguém testou que existe botão |
| Dado que existe e não é lido | Nada fica vermelho por um `SELECT` que não foi escrito |
| Indicador que nunca preenche | O cálculo está certo; a entrada é que nunca chega |

Todos os cinco estavam no produto ao mesmo tempo, e nenhum apareceu no portão.

### O que vira teste, e o que vira leitura

Parte disto é automatizável, e o que for **tem que virar teste** — senão volta:

- toda `atual` passada a uma barra casa com um item dela;
- toda tela listada numa barra renderiza aquela barra;
- rótulo de ação e de estado sai de um mapa único, e a tela não escreve texto
  de transição à mão;
- toda seção registrada em `secoes.ts` tem regra de CSS que a acende — derivada
  do registro, **nunca** de uma lista escrita à mão ao lado. Foi assim que
  `lgpd` e `plano` ficaram sem acender com o teste verde.

O resto é leitura, e leitura feita **de propósito**: percorrer o fluxo na tela,
nas quatro larguras, fazendo as seis perguntas acima. Vinte minutos no fim do
bloco. É o mesmo custo da medição de responsividade, e pega outra classe de
defeito.

### Quando o achado não couber no bloco

Vale a mesma regra das lacunas: entra na tabela
[Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada), com o
que existe, o que falta e em qual bloco entra. **Defeito de fluxo descoberto e
não escrito é defeito que vai ser redescoberto** — e da segunda vez ele já terá
sido usado por alguém.

---

## Definition of Done

Um bloco só está concluído quando **todos** os itens passam:

- [ ] `pnpm verify` verde (typecheck + testes + build em todos os pacotes)
- [ ] Regra nova tem teste que falha se a regra for quebrada
- [ ] Caminho triste coberto: entrada inválida, concorrência, permissão, tenant
- [ ] Isolamento de tenant preservado — acesso via `withTenant`, nada fora
- [ ] Entrada externa validada na borda
- [ ] `Idempotency-Key` onde cria agendamento ou move dinheiro
- [ ] Sem N+1; índice criado junto com a query que o exige
- [ ] `packages/core` continua sem dependências
- [ ] Nenhum segredo no repositório
- [ ] `/security-review` rodado, se o bloco tocou auth, dinheiro, dado pessoal ou permissão
- [ ] README atualizado se alguma decisão de arquitetura mudou
- [ ] Interface conferida em 360, 390, 768 e 1280 — sem rolagem horizontal
- [ ] **Prints das telas novas ou alteradas enviados**, em 390 e 1280. Medição
      verde diz que nada quebrou; ela não diz se ficou bom
- [ ] Estado vazio, carregando e erro desenhados
- [ ] **Fluxo percorrido como quem opera** (§6): toda tela tem volta, a mesma ação
      tem o mesmo nome em todo lugar, todo estado tem saída na interface, e nenhum
      indicador da tela é sempre `—`
- [ ] Lacuna conhecida declarada por escrito, **com dependência e bloco**, na tabela
      [Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada)
- [ ] **Nenhuma lacuna aponta para o bloco que está fechando.** Se aponta, ou ela
      é entregue agora, ou muda de bloco com o motivo escrito — nunca some em
      silêncio. `scripts/verificar-lacunas.mjs` reprova, e roda no `pnpm verify`
- [ ] `ROADMAP.md` com o bloco marcado e o contador atualizado

---

## Comandos

`pnpm verify` fecha o bloco; `pnpm -r typecheck` e `pnpm -r build` estão no
`package.json`, e cada pacote roda sozinho com `pnpm --filter @barbearia/<nome>
test`. O que não se adivinha é o ambiente:

Testes de banco exigem Postgres 16+ com `pgcrypto`, `citext` e `btree_gist`.
Cada script cria e destrói o próprio banco descartável.

```bash
export ADMIN_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres"
```

---

## Convenções deste código

| Assunto | Convenção |
|---|---|
| Dinheiro | centavos inteiros (`price_cents`), nunca float |
| Data/hora no banco | `timestamptz`, sempre UTC |
| Data/hora no domínio | minutos locais desde a meia-noite; conversão só em `zone.ts` |
| Intervalo | semiaberto `[início, fim)` — encostar não é sobrepor |
| Id público | UUID/ULID, nunca sequencial |
| Telefone | E.164 normalizado, chave de deduplicação |
| Importação de base | idempotente pelo **sha256 do conteúdo**, nunca pelo nome do arquivo; reversível por `import_id`, que marca só quem ela criou |
| Consentimento de marketing | nunca importável — precisa de data, IP e versão do texto, e nada disso atravessa uma exportação |
| Cópia de dado pessoal fora de `customers` | com prazo escrito no schema: `imports.payload` é apagado ao aplicar, e há `CHECK` que recusa o contrário |
| Slug | permanente; renomear adiciona em `tenant_slugs`, nunca substitui |
| Status de cancelamento | `cancelled_customer` ≠ `cancelled_business` — só o primeiro pune o cliente |
| Sessão do cliente no navegador | cookie `httpOnly`, um por barbearia no nome **e** no caminho |
| Sessão do gestor | cookie `httpOnly` `sameSite=strict` em `/admin`; token `<tenantId>.<segredo>` |
| Senha | scrypt do `node:crypto`, parâmetros dentro do hash; nunca uma dependência nova para isso |
| E-mail em tabela sem RLS | HMAC com segredo de ambiente, nunca em claro |
| Permissão exibida na tela | sai da mesma função que a API aplica — nunca recalculada na view |
| Permissão numa rota | declarada com `@Exige(...)`; rota sem declaração é **recusada**, não liberada |
| Papel | conjunto nomeado de permissões em `role_permissions`, por barbearia e **editável pela tela** desde o bloco 30 — nunca `if (role === 'owner')` |
| Papel do dono | não se edita: é a única conta que não pode ficar trancada para fora do próprio negócio. A recusa é na borda (enum sem `owner`) **e** no domínio |
| Conceder permissão | ninguém concede o que não tem, e o que o ator tem sai do **banco**, nunca do parâmetro. Sem isso, delegar `team.manage` é delegar tudo |
| Escrita e leitura | permissões diferentes: `customers.view_notes` lê a anotação, `customers.edit_notes` escreve. Escrita guardada por permissão de leitura é defeito, não economia |
| Desconto | `finance.discount` diz **quem**; `tenants.max_discount_bps` diz **quanto**. Sem o teto, conceder desconto é conceder estorno com outro nome |
| Conta de barbeiro | uma cadeira, uma conta — índice único parcial em `staff_users(professional_id)`; o papel do convite é sempre `professional` e nunca vem do corpo |
| Senha de primeiro acesso na tela | cookie `httpOnly` de dois minutos com caminho restrito (`guardarSenhaDeUmaVez`), **nunca** parâmetro de consulta — há teste que lê o código e reprova |
| Meta do profissional | por mês, nunca acumulada na pessoa; sem renovação automática — a tela sugere a do mês anterior preenchida |
| Indicador do barbeiro | comparado com o **próprio** passado, nunca com o colega (SPEC §4.21); ranking é lacuna declarada, e a SPEC manda vir desligado |
| Comentário dentro de consulta SQL | `--` e **sem crase** — crase fecha o tagged template; há teste que reprova |
| Espaçamento em CSS | sempre `var(--space-N)` **existente**; token inexistente invalida a declaração inteira, e há teste que confere |
| Trabalho fora de requisição | tarefa em `jobs`, enfileirada **dentro** da transação que cria o fato; nunca depois |
| Tarefa de fila | sempre com `tenant_id`; o handler abre `withTenant` com ele. `jobs` não tem RLS, e por isso o `payload` guarda id, nunca conteúdo |
| Credencial entregue por mensagem | inline depois do commit, como o OTP — **nunca** pela fila, que é durável e legível sem tenant |
| Fuso e janela de silêncio do aviso | da unidade, nunca do aparelho; entre 21h e 8h nada sai |
| Evento auditado | gravado por `audit()` **dentro da transação** que muda o estado; `audit_log` é append-only por `REVOKE` |
| Segundo fator | TOTP RFC 6238 do `node:crypto`; segredo cifrado com AES-256-GCM; passo consumido gravado; código de recuperação some ao ser usado |
| Webhook do adquirente | HMAC-SHA256 sobre `${instante}.${corpo cru}`, janela de 5 min, comparação em tempo constante; segredo ausente **recusa**. Reentrega é normal e responde 2xx |
| Cartão | só token do provedor, marca e os quatro últimos; não existe coluna para PAN nem CVV, e há invariante que reprova se alguém criar uma |
| Cobrança pendente | Pix e boleto respondem depois: `pendente` ≠ recusa, e não gasta degrau da escada de retentativa |
| Comissão | lançamento guarda **base + regra copiada**, nunca o valor; o valor é derivado, porque faixa depende do acumulado do período |
| Taxa do adquirente | alíquota **por meio de pagamento** em pontos-base (319 = 3,19%), porque é assim que ele cobra — uma média não bate com extrato nenhum. Congelada na venda (`orders.fee_cents`): renegociar a maquininha em maio não muda comissão paga em abril. Linha ausente é zero, e `bruto` ignora taxa e desconto, senão "bruto" quer dizer "bruto menos uma coisa" |
| Padrão de configuração que mexe em dinheiro | é sempre o comportamento **anterior**. `fee_treatment` nasce `absorvida` porque um padrão `rateada` faria toda barbearia já instalada ver a comissão de todo mundo cair no dia da migração, sem ninguém ter decidido nada |
| Comissão fechada | imutável por trigger e `REVOKE`; estorno é lançamento novo com sinal negativo no período aberto, jamais `DELETE` |
| Dia de uma venda | `orders.business_day`, o dia **da unidade** — `closed_at` responde "que instante", não "de que dia é este dinheiro" |
| Alíquota | pontos-base inteiros (4000 = 40%), nunca fração |
| Força bruta no login | escada de espera **por conta**, no banco e portanto compartilhada entre processos: cinco erros livres, depois dobra a partir de 30s até o teto de 30 min, e esquece em 24h. Conferida **antes** de derivar a senha — depois, o servidor pagaria o scrypt de cada tentativa bloqueada. Teto por IP continua existindo e resolve outra coisa: ele não segura adivinhação (mil endereços são baratos) e aperta a barbearia inteira atrás do mesmo NAT |
| Papel na plataforma | `viewer` lê, `operator` age sobre a conta de uma barbearia. Conta nova nasce `viewer`. A polaridade do `@AgeNaConta` é o **inverso** do `@Exige`: aqui a ausência libera a leitura, porque toda conta de plataforma já lê tudo — o que se separa é o que se **faz**. Há teste que percorre o controller e cobra o decorador em todo `@Post`, `@Put` e `@Delete` sobre `barbearias/` e `faturas/` |
| Aviso ao dono | crítico e retenção ligados, aviso desligado; um por regra por dia; nada entre 21h e 8h **da unidade**. Alerta que dispara à toa é alerta que se aprende a ignorar, e um canal ignorado é pior que canal nenhum. A retenção tem interruptor próprio porque é obrigação legal, não sinal operacional |
| Prova do segundo fator | por **sessão** (`staff_sessions.mfa_verified_at`), com validade de 30 min — nunca só no login |
| Consentimento | histórico append-only em `customer_consents`: revogar é **inserir** a revogação, nunca apagar a concessão. `customers.accepts_marketing` é espelho derivado por gatilho, e só avança se a decisão for a mais recente — importação fora de ordem não ressuscita aceite revogado |
| Versão do texto aceito | obrigatória e **sem padrão**, uma por finalidade, saindo de `politica.ts` e nunca do formulário. Aceite sem dizer o que a pessoa leu não é prova; um `'v1'` silencioso é pior, porque tem cara de prova |
| Permissão de rota que agrega | declara **todas** as permissões do que ela devolve, e não a mais próxima do nome. A exportação do titular exige `customers.export` + `finance.view` + `customers.view_notes`, porque o arquivo contém o razão do fiado e a anotação privada — com uma só, ela virava o caminho mais curto para as outras duas, e o segundo fator derivado deixava de ser cobrado. Achado da `/security-review` do bloco 31 |
| Exportação de dado pessoal | lista de consultas **escrita**, nunca varredura de catálogo — e há teste que reprova quando uma tabela nova com `customer_id` fica de fora. Sessão e trilha não entram: a primeira é credencial viva, a segunda traz o nome de terceiros |
| Encarregado de dados | por barbearia (`tenants.dpo_name/dpo_email`) e **público** — LGPD art. 41 §1 manda divulgar identidade e contato. A barbearia é controladora; a plataforma é operadora e não responde por dado que não é dela |
| Anonimização | **anonimizar, não apagar**: o direito à exclusão e a obrigação fiscal de guarda são as duas verdadeiras ao mesmo tempo, e um `DELETE` levaria a venda junto. A pessoa sai de dentro do cadastro; a linha e os centavos ficam. Único caminho: a função `anonimizar_cliente` — `SECURITY DEFINER`, porque metade do dado mora em tabela append-only, e com filtro de tenant **escrito dentro dela**, porque `SECURITY DEFINER` roda como dono e a RLS pode não valer |
| Permissão de destruir | `customers.anonymize`, própria e só do dono por padrão. É a única operação irreversível do produto, e não acompanha `settings.manage`: responder pedido de LGPD e apagar a base são tarefas diferentes |
| Retenção | cinco anos sem **interação** — atendimento, comanda, fiado, fila —, nunca `updated_at`, que a importação de base mexe em mil e duzentos cadastros de uma vez. Aviso prévio de trinta dias, e uma visita nova cancela a saída: a pergunta "já voltou?" vem **antes** de "o prazo venceu?" |
| Pedido do titular | prazo gravado na criação, nunca calculado na leitura; um aberto por pessoa e por tipo (índice único parcial), então pedir de novo devolve o mesmo pedido em vez de reiniciar a contagem; recusa exige motivo escrito, no domínio e por `CHECK` |
| Adquirente ligado | uma variável (`PSP_MODO`) e **uma função** que a lê, para os dois processos. Valor desconhecido falha alto: lido com tolerância, ele viraria "sem adquirente" e a plataforma pararia de cobrar por um ciclo inteiro de faturamento sem ninguém perceber |
| Chave de idempotência que vai ao adquirente | escopada **dentro** do provedor, nunca só na borda. O espaço de idempotência dele é o da conta, que é uma só para todas as barbearias — duas recepcionistas mandando `"1"` fariam a segunda receber o copia-e-cola da primeira |
| Estorno | sai **de uma cobrança**, nunca "da conta": adquirente nenhum aceita a segunda coisa. Recusado antes de debitar o crédito quando não há qual; recusa definitiva (4xx) devolve o crédito, indisponibilidade (5xx) **não** — ela é ambígua, e devolver pagaria a barbearia duas vezes |
| Id de cobrança vazio | nunca. `psp_charge_id` só é escrito enquanto é nulo, e string vazia não é nulo: ela amarraria a fatura a nada para sempre. Guarda no código e `CHECK` no banco |
| Cobrança online da comanda | uma viva por comanda, por índice único parcial. A linha nasce **antes** da chamada ao adquirente — a ordem inversa perde a cobrança inteira se o processo cair — e a chave que vai para ele é o **id da linha**, para a retentativa reencontrar a mesma cobrança em vez de criar a segunda |
| Comanda com cobrança viva | não aceita item novo, remoção nem desconto. O valor foi congelado na emissão e o cliente está com o código na mão: mudar a conta faria ele pagar R$ 49 numa comanda de R$ 69, e **nada** fecharia. O caminho é explícito — cancelar, mexer, cobrar de novo |
| Webhook da Stripe | segredo **próprio** (`STRIPE_WEBHOOK_SECRET`), porque ela gera um por endereço. O metadado abre o tenant; quem confirma é o id do pagamento, procurado **dentro** dele — evento assinado apontando para a barbearia errada não encontra nada |
| Evento do adquirente que não diz estado | ignorado **sem** consumir a entrega. Registrá-lo como consumido faria a reentrega do evento de verdade, que traz o mesmo id, encontrar tudo gravado e não fazer nada |
| Score de confiabilidade | de 0 a 100, **interno** e nunca mostrado ao cliente (SPEC §2.13 regra 5) — nem ao dono: a tela pergunta "de quem falta quantas vezes em dez você quer sinal?", porque ninguém consegue explicar no balcão por que 72 cobra e 74 não. Os pesos são quatro vezes os do texto da SPEC, e o desvio está escrito: com os literais, o pior cliente possível fica em 75 e os três cortes de uso da própria seção — 60, 40 e 85 — nunca disparam |
| Sinal do agendamento | decidido **dentro da transação** que cria o horário, com o ticket que o catálogo resolveu, e congelado com o motivo. Recalculado na leitura, ele mudaria de valor entre a tela e o balcão. Atravessa a remarcação inteiro: recalcular perderia o dinheiro já pago, ou deixaria escapar da cobrança quem remarca — e quem mais remarca é quem o sinal existe para conter |
| Sinal pago | mora numa linha só. Remarcar tira da antiga e põe na nova na mesma instrução, e a leitura recusa `rescheduled`: com o valor positivo nas duas, o id do primeiro e-mail de confirmação e o do horário atual devolveriam o mesmo dinheiro duas vezes |
| Dobro no registro de sinal | impedido pelo **estado**, não por chave: `deposit_paid_cents = 0` no `WHERE` segura o segundo toque de outro aparelho, de outra sessão e com chave nova — que é o que uma chave gerada pelo cliente não garante |
| Override do score | permissão própria (`customers.reliability_override`), nunca `customers.edit`: com a segunda, dispensar um conhecido do sinal seria edição de cadastro qualquer, sem passar por dinheiro e portanto sem segundo fator. Motivo escrito obrigatório, com piso na borda, no domínio e por `CHECK` |
| Coluna nova em `customers` | ou é apagada por `anonimizar_cliente`, ou entra na lista de permitidas do teste com o motivo escrito. A varredura de catálogo é a ferramenta certa **aqui** — ao contrário da exportação do titular, que é lista escrita —, porque o que se quer pegar é a coluna que ninguém pensou. Ela nasceu no bloco 37 e já pegou duas de blocos anteriores |
| Campo opcional na borda que a tela não manda | ausente significa "não mexa", nunca "desligue". Escrever o padrão por omissão faz uma edição sem relação apagar em silêncio uma decisão que alguém tomou — foi assim que corrigir uma descrição desligava a exigência de sinal da coloração |
| Lista de espera | não é a fila da porta. `queue_entries` é quem **está na barbearia agora**, ordenada por chegada; `waitlist_entries` é quem foi embora sem conseguir marcar, e ordena por compatibilidade com uma vaga que ainda não existe. Os nomes se parecem e as duas não compartilham nada |
| Vaga que abre num cancelamento | perguntada **dentro da transação** que a abriu, nas duas portas — a do cliente e a do balcão. Depois do commit existe a janela em que o horário está livre e ninguém sabe, e é nela que outro cliente marca pelo site |
| Casamento de vaga com pedido | `contains`, nunca `overlaps`. Quem pediu "até meio-dia" está dizendo que precisa ir embora ao meio-dia; uma vaga que começa 11:40 põe a pessoa na cadeira até 12:10, e o aviso vira ligação inútil |
| Faixa de dias pedida | tem teto nas **duas** pontas, e a segunda foi achado de revisão. Só o começo conferido deixava "de hoje até 2099" passar — e isso nunca expira, porque a varredura só fecha o que já passou |
| Id de outra tabela vindo do corpo | conferido **sob RLS antes de gravar**, e a contagem tem que bater com o pedido: a checagem de integridade referencial do Postgres ignora row security, então a chave estrangeira aceita id de outra barbearia. Só somar duração não pega — um pedido com um serviço legítimo e dois alheios dá soma positiva |
| Rota pública que reencontra cliente pelo telefone | não devolve nada do cadastro. `resolveGuestCustomer` acha o cliente existente, então devolver a entrada — ou "você já está em três listas" — vira oráculo: com uma lista de números se descobre quem é cliente de quem. É o precedente do OTP, que responde igual para telefone existente e inexistente |
| Pix confirmado sem caixa aberto | a cobrança fica `pago` e a comanda fica **aberta**. Desde o bloco 18 nenhuma venda entra sem gaveta, porque a divergência do fechamento precisa ter dono — e recusar o pagamento seria pior, porque o cliente já pagou |
| Convite de vaga | uma oferta viva por vaga **e** por pessoa, por índice parcial. O horário fica segurado por um `slot_holds` que nasce **antes** da oferta — sem ele, "exclusivo" é uma palavra na mensagem, e qualquer visitante da página pública marca aquele horário nos dez minutos em que a pessoa decide |
| Resgate de convite | gravado **dentro** da transação travada, num estado próprio (`aceitando`). `FOR UPDATE` sem escrita não separa nada: a trava cai no commit e o segundo pedido relê o mesmo `aberta`. Sem o estado, o duplo toque no link só era barrado na constraint de exclusão — com "horário indisponível" para quem tinha exclusividade sobre ele |
| Janela ocupada e início do serviço | a vaga guardada é a **ocupada**, com buffers, porque é ela que precisa ser segurada; o que se anuncia e o que o motor de reserva recebe é o **início do serviço**, gravado à parte (`service_starts_at`) e calculado com o buffer de quem **vai receber** a vaga. Guardar só um dos dois faz a mensagem prometer 8h50 para um corte das 9h |
| Filtro da aplicação e índice parcial | dizem a mesma coisa, ou a gravação recusa o que a leitura aceitou. O filtro que olhava o prazo e o índice que olhava só o estado discordavam entre o vencimento e a varredura, e o `ON CONFLICT DO NOTHING` — que não distingue os dois índices — descartava a vaga inteira em silêncio |
| Sair de uma lista de espera | cancela o convite aberto e apaga o hold, na mesma transação. Sem isso a pessoa diz "não quero mais" e continua com um link resgatável, com o horário fora da grade por uma espera que já não existe |
| Convite sem a mensagem | o aceite tem **duas portas**: o token do link, para quem não tem sessão, e a entrada da lista, para quem já está autenticada. O token existe em claro uma vez, dentro da mensagem — se ela não chega, a pessoa vê "abriu um horário para você" e não tem como pegá-lo. Pela entrada, o filtro por `customer_id` é obrigatório: a RLS separa barbearias e não separa clientes dentro de uma |
| Recado do cliente | sem conta e sem nome: a reclamação mais valiosa é a de quem desistiu da fila e foi embora, e essa pessoa não vai criar cadastro para reclamar. Anônimo é resultado legítimo, não caso degradado — e a tela diz que sem contato não há resposta |
| Apagar reclamação | não existe. `REVOKE DELETE` na tabela, e nenhuma permissão de apagar no catálogo: o limite ético da SPEC §4.10 escrito onde não depende de ninguém lembrar. Encerrar é **estado**, e o texto continua contando para a leitura do trimestre |
| Rota pública que cria cadastro por telefone | confere `require_otp_for_booking` antes, sempre. Sem isso ela vira a porta lateral para criar cadastro com telefone alheio — o recado registra anônimo em vez de recusar, porque recusar transformaria o interruptor de segurança do agendamento num silenciador de reclamação |
| Assumir um item de fila | é sempre **para si**, e o corpo não escolhe por quem. Com `responsavelId` vindo da requisição, o botão "Assumir" mandava vazio e devolvia o recado à triagem — e alguém penduraria a própria reclamação no colega |
| Fidelidade | **um modelo por barbearia**, e é a chave primária que garante: "você tem 340 pontos, 3 visitas e R$ 12 de cashback" é a frase que ninguém entende no balcão |
| Saldo de fidelidade | livro-razão append-only, com o **modo congelado em cada lançamento**. Saldo é número que alguém sobrescreve, e a pergunta que chega é "por que caiu?"; e trocar de pontos para cashback em maio não pode transformar 300 pontos de abril em R$ 300 |
| Acúmulo de fidelidade | sobre o que a pessoa **pagou de verdade** — o que saiu do próprio saldo não gera saldo novo. Sem isso o corte grátis gera o crédito do próximo corte grátis, que é o laço que a SPEC §4.8 nomeia em uma linha |
| Resgate de fidelidade | forma de pagamento, nunca desconto. Desconto é a casa abrindo mão de receita, com permissão e teto próprios; resgate é o cliente gastando crédito que já é dele — como desconto, o teto do bloco 30 barraria o cliente de usar o próprio saldo. E **nunca vira troco**: numa conta paga com dinheiro e crédito, o troco em espécie faria a barbearia comprar de volta o próprio programa |
| Criar saldo à mão | `finance.loyalty_adjust`, com prefixo `finance.` de propósito: o segundo fator é derivado do prefixo, e criar saldo é criar valor gastável no balcão da operação seguinte. Motivo escrito obrigatório, na borda, no domínio e por `CHECK` |
| Filtro de varredura por tipo | recorta pelo **fato**, não pelo nome do tipo. `kind = 'acumulo'` na varredura de vencimento fazia o saldo ajustado à mão sumir da leitura sem nunca aparecer no extrato; `amount > 0` é o que descreve a coisa |
| `@container` numa tela nova | o recipiente é o **ancestral**, e ele precisa declarar `container-type`. Um elemento não responde sobre si mesmo: sem a declaração no pai, a regra nunca casa e a tela fica na versão estreita em qualquer largura — sem nada ficar vermelho |
| Provedor de mensagem no worker | **um só**, criado onde o processo é montado. Instanciar o de console dentro de um caminho faz daquele caminho o único que não troca junto — e o convite de vaga carrega o token em claro, que é credencial, no log |
| Venda de pacote | derivada dos **itens** da comanda, nunca de uma lista no corpo do fechamento. Duas fontes para o mesmo fato deixavam um item de R$ 1 fechar a conta e congelar cinco unidades de R$ 50 — dinheiro criado do nada, resgatável como crédito pelo reembolso proporcional e por fora do teto de desconto. Cada metade era internamente coerente, e por isso nada ficava vermelho |
| Preço de item que vende catálogo | lido do catálogo dentro da transação, nunca do corpo. `precoUnitarioCents` de um item de pacote é ignorado, e a tela não tem campo de preço |
| Serviço coberto pelo pacote | conferido contra os itens **desta** comanda. Só o valor bater não basta: uma barba de R$ 50 queimava uma unidade do pacote de corte, com o cliente perdendo um corte pago e a receita reconhecida no serviço errado |
| Leitura que decide gravação | trava a linha (`FOR UPDATE`), e a trava é do caminho que grava — não do que mostra. Sem ela, duas comandas do mesmo cliente fechando juntas leem "usados = 4" as duas e gravam as duas: cinco compradas, seis consumidas. O índice único de `package_uses` é por comanda e não pega duas comandas diferentes |
| Invariante que protege valor | não mora só na aplicação. O gatilho que recusa consumir mais unidades do que foram compradas existe porque uma cláusula de trava é perdível numa reescrita, e a garantia de que ninguém recebe serviço que não pagou é grande demais para depender disso |
| `UPDATE` guardado por estado | confere as linhas afetadas antes de mover dinheiro. A trava é quem impede o segundo reembolso hoje; descartar a contagem deixa a segunda camada inerte, e um `UPDATE` que não pegou ninguém vira crédito lançado no razão |
| Receita de venda antecipada | diferida, reconhecida no consumo. `package_uses` é tabela e não contador porque o **quando** de cada reconhecimento é a informação — sem ela o DRE mostra um mês excelente seguido de meses falsamente ruins (SPEC §4.7) |
| Casar dado de duas telas | por id, nunca pelo nome. A recepção edita a descrição do item, e um "Corte + escova" deixaria de casar com o pacote de corte em silêncio |
| Mensalidade do clube | uma fatura por ciclo, com o valor **congelado na emissão** e índice único `(assinatura, início do ciclo)`. É ele que torna a emissão idempotente: o worker roda a cada volta do laço, e um `SELECT` antes do `INSERT` tem janela que cobra o assinante dezenas de vezes pelo mesmo mês |
| Cobrança que falha | vira aviso, **nunca corte imediato**. O caminho é cobra, falha, marca inadimplente — que continua usando o plano —, retenta em D+1/D+3/D+7 e só pausa aos quinze dias. Cortar no primeiro erro de cartão gera cancelamento por raiva, não por preço, e o cartão que falhou na terça costuma passar na quinta |
| Recusa definitiva do adquirente | para a escada e **não** para o relógio. Contra um cartão cancelado, D+1, D+3 e D+7 são três chamadas que já sabem a resposta, e cada recusa registrada piora a taxa de aprovação da conta da barbearia — que é o número pelo qual o adquirente a precifica. Os quinze dias continuam correndo |
| Cancelamento de assinatura pelo cliente | vale do **fim do ciclo pago**, com a data congelada no pedido, e tem botão de desfazer. Cortar no dia do pedido seria ficar com o dinheiro do mês e não entregar o serviço; recalcular a data na leitura faria "vale até 30/08" mudar se alguém mexesse na adesão |
| Assinatura cancelada | não guarda cartão, e a régua **não** a enxerga. Credencial de pagamento some com a pessoa, como token de sessão — e o filtro por estado da assinatura é a camada que não depende de ninguém ter lembrado de limpar a coluna. Achado da `/security-review` do bloco 47: a fatura já emitida continua aberta, e sem as duas o token era apresentado ao adquirente por mais quinze dias, em silêncio |
| Split de pagamento | **derivado da comissão**, e por isso não existe alíquota de split em lugar nenhum do schema — há invariante que reprova a coluna. O que o profissional recebe sai de `commission_entries`, pela mesma função que a margem por serviço usa. Duas fontes de verdade para o mesmo número é o que a SPEC §3.5 proíbe em letras |
| Valor de uma fatia do split | guardado, e é a exceção da regra: em toda parte deste código o valor é derivado, aqui ele registra o que **de fato** saiu para a conta de terceiro. Recalcular na leitura faria o extrato divergir do banco do profissional, que é a única coisa que ele confere |
| Soma das partes do split | é o pagamento, ao centavo. Um centavo a mais e o adquirente recusa a chamada inteira; um a menos fica preso na conta da plataforma para sempre. Conferida antes de gravar, e se não fechar o split não é gravado pela metade — a casa fica com tudo e o motivo é encontrável |
| A casa no split | é a **residual**: recebe o pagamento menos as outras partes, e é dela que sai a taxa do adquirente. Ratear a taxa antes faria a comissão do barbeiro mudar conforme o meio de pagamento que o cliente escolheu no balcão |
| Termo comercial da plataforma | mora em `tenant_platform`, escrito só por `packages/platform` — nunca em `tenants`. `split_enabled` é da barbearia (é o dinheiro dela); `platform_fee_bps` é do produto, e numa coluna de `tenants` a rota do painel deixava o cliente definir o preço que paga: zerá-la desligava a receita sem nada falhar. Achado da `/security-review` do bloco 49 |
| Chave estrangeira em tabela append-only | nunca `CASCADE`, e a varredura é de catálogo — `tenant_id` é a única exceção. Ação referencial roda com os direitos do dono e **não** passa pelo `REVOKE`: apagar a venda levaria junto o registro do dinheiro que saiu para terceiro, sem trilha e sem erro |
| KYC do profissional | **não bloqueia a venda**, e é a frase mais importante da SPEC §3.5. Sem cadastro aprovado a parte dele fica retida, o dinheiro cai inteiro na casa e a comissão sai no fechamento como sempre. O caminho óbvio — recusar a venda até ele estar aprovado — produz a barbearia descobrindo no balcão, com o cliente na frente, que não consegue cobrar |
| Dado bancário do profissional | atravessa para o adquirente e **não é gravado**: quem tem obrigação regulatória de guardá-lo é ele. Deste lado fica a referência opaca, como o token do cartão — e há invariante que reprova coluna de CPF, agência ou conta em `professionals`. A trilha registra o estado, nunca os dados |
| Chamada ao adquirente que move dinheiro | tem **estado próprio** enquanto está em voo (`liquidando`), não só `FOR UPDATE`. A trava cai no commit e a chamada acontece fora da transação: sem o estado, o estorno da venda entrava na janela, lia `pendente` e concluía que ninguém devia nada — com o adquirente confirmando a transferência segundos depois. É o precedente de `aceitando` no bloco 39 |
| Chave de idempotência de repasse | **estável por fatia**, ao contrário da chave de cobrança, que varia por tentativa. A diferença é a direção do dinheiro: retentar um cartão recusado é uma cobrança nova; retentar um repasse ambíguo com chave nova é pagar o barbeiro duas vezes |
| Desfecho ambíguo do adquirente | conta como **saiu**. Cobrar de quem não recebeu é conserto de um lançamento; não cobrar de quem recebeu é dinheiro que ninguém procura |
| Estorno de repasse já liquidado | vira dívida do profissional, lançada como comissão negativa no período aberto — o mecanismo que a SPEC §3.4 já manda usar para estorno e que o barbeiro já entende. Inventar cobrança nova faria ele aprender uma segunda linguagem para a mesma coisa, e o valor ficaria fora do fechamento, que é onde ele confere o mês |
| Comissão sobre assinatura | três modelos (`por_uso`, `rateio`, `hibrido`) e o padrão é `por_uso`, que é o comportamento anterior. O lançamento guarda **de qual assinatura veio e por quanto ela foi vendida**; quem aplica o modelo é `packages/core`, na leitura — rateio e teto dependem do acumulado do período, como a faixa progressiva, e trocar de modelo não reescreve lançamento nenhum |
| Rateio da mensalidade | a base é a mensalidade repartida entre os atendimentos, e ela soma **exata** ao centavo, com a sobra no último. A comissão é arredondada por lançamento, como em todo o produto, porque cada lançamento pode ter regra própria — distribuir um total já arredondado exigiria uma segunda maneira de calcular comissão |
| Teto do híbrido | encolhe todas as bases daquela assinatura na mesma proporção, nunca zera o último atendimento. Com o corte, quem atendeu no dia 28 receberia zero por um limite que os colegas gastaram, e a conta dele dependeria da ordem em que os outros trabalharam |
| Qual item da comanda o plano cobriu | por `order_item_id`, nunca por serviço. Uma comanda com dois cortes e um coberto marcaria os dois, e a comissão do corte pago em dinheiro entraria no rateio da mensalidade — teste de pertinência não é teste de contagem |
| Margem, sobra e insumo numa rota | `finance.view_profit`, nunca só `finance.view`. O gerente padrão tem a segunda e não a primeira, e é assim que o dono delega a operação sem entregar a estratégia. Há teste que **deriva** dos tipos de retorno de `core` e `finance` quais funções revelam resultado e cobra a permissão em toda rota que as chame — lista escrita ao lado seria a que ninguém atualiza |
| Trocar o modelo de comissão da assinatura | exige `commission.edit_rules` **junto** de `finance.subscription_manage`. Ela reescreve a base de todo lançamento do período aberto e é registrada como `commission.rule_changed`: com só a segunda, que o gerente tem, um teto de 0% zerava a comissão da equipe por uma rota chamada "modelo". Achado da `/security-review` do bloco 48 |
| Anotação interna sobre um cliente | nunca compartilha campo com dado que o cliente lê. O motivo de perdoar uma mensalidade tem coluna própria (`void_reason`), separada da recusa do adquirente (`last_error`) — e a projeção do self-service é uma forma **própria**, não a do balcão: duas telas com públicos diferentes lendo o mesmo objeto fazem todo campo novo chegar ao cliente sem ninguém decidir isso |
| Restrição de horário do plano | guarda o **proibido**, nunca o permitido. A barbearia abre setenta horas e bloqueia quatro; guardar o permitido faria toda mudança de horário de funcionamento exigir reescrever o plano — e um plano que esqueceu de liberar a terça nova some da grade sem ninguém saber |
| Cota de plano família | é **da assinatura**, não da pessoa: dois cortes valem para a família inteira. O uso grava **quem** usou, senão "3 de 5" numa família de quatro é número que ninguém confere |
| Exportação com nome de terceiro | o vínculo de dependente entra sem o nome de quem banca. É a mesma razão de a trilha ficar de fora: terceiro num arquivo que o titular leva embora |
| Cooldown da assinatura | conta do **último uso de todos**, sem recorte de ciclo. Recortar pelo ciclo faz o intervalo sumir toda vez que o mês vira entre dois cortes: quem cortou no dia 28 corta de novo no dia 30. A cota é do ciclo; o cooldown não é, e os dois entram no domínio como números separados |
| Ilimitado | é `null`, nunca um número grande. Um `9999` é cota disfarçada: responde "quantos faltam" com um número sem sentido, e a tela teria que saber que aquele valor específico significa outra coisa |
| Ciclo de assinatura | ancorado no **dia da adesão**, não no dia 1º. Ancorar no calendário daria meio mês de graça a quem assina no dia 28. O dia 31 vira o último dia do mês curto e volta a 31 depois — é o que toda assinatura do mundo faz, e o que ninguém lembra de testar |
| Assinatura em atraso | continua usando o benefício (SPEC §4.6): cortar no primeiro erro de cartão gera cancelamento por raiva, não por preço. `suspensa` é o degrau seguinte, e aí sim para |
| Duas coisas com o mesmo nome de negócio | tabelas separadas. `subscriptions` é o que a barbearia paga à plataforma; `club_subscriptions` é o que o cliente paga à barbearia. A SPEC chama as duas de MRR, e confundi-las no schema seria confundi-las em toda consulta daqui para a frente |
| Contagem numa rota de leitura aberta | é dinheiro quando multiplicada. "Quantos assinam cada plano" × preço **é** o faturamento recorrente, e sob `appointments.view` era o caminho mais curto para o que `finance.view` guarda. Rota separada para a versão contada |
| Termo de score constante | é código morto com teste verde. `assinante` entrou falso para todo mundo no bloco 38 e ficou sete blocos assim: não alterava a ordem de ninguém, e o efeito era o score caber em 0,8. Termo que não varia ou é entregue ou é removido |
| Estoque | saldo **derivado** da soma dos movimentos, nunca coluna. Um contador responde "quantos tem"; a pergunta do balcão é "por que só tem 12 se eu comprei 20?", e só uma linha por entrada, venda, consumo e perda responde isso |
| Movimento de estoque | append-only por `REVOKE`. Corrigir contagem é lançar `ajuste` com motivo escrito, **ao lado** do erro — nunca reescrever a linha |
| Revenda e consumo interno | tipos diferentes, e sem a distinção não existe margem real: o shampoo do serviço viraria receita zero e custo nenhum, e o corte pareceria render mais do que rende |
| Custo que alimenta relatório fechado | congelado no movimento (`unit_cost_cents`), nunca lido do cadastro na hora do relatório. Subir o preço do shampoo em março mudava a margem de janeiro, e refazer a ficha reescrevia o custo de todo atendimento passado — inclusive de períodos de comissão já fechados |
| Exceção dentro de `fecharComanda` | não existe por motivo de estoque. Ela roda na transação do webhook do Pix: uma exceção ali volta atrás com o **dinheiro sem registro nenhum**, o adquirente reentrega por dias e a varredura para no meio do laço. É a lição do bloco 35, e o bloco 44 quase a repetiu |
| Regra de negócio em SQL | não. A comissão calculada dentro da consulta lia coluna inexistente e não teria como aplicar faixa progressiva, que depende do acumulado do período. O SQL carrega; a conta é de `packages/core`, onde o teste alcança |
| Quantidade de item na baixa | `= ANY(ids)` é teste de pertinência, não de contagem: uma comanda com dois cortes consumia **uma** ficha. Quem baixa estoque recebe a quantidade, nunca só a lista de ids |
| Custo rateado entre serviços da mesma comanda | por peso da receita, como a taxa do adquirente. Atribuir ao primeiro item faria o corte carregar o insumo da barba |
| Publicação de avaliação | derivada do relógio, nunca coluna. Nota boa publica na hora; nota baixa segura 48h e vai ao ar **de qualquer forma**, tratada ou não. Uma coluna `publicada` estaria errada todo minuto entre o fim da janela e a varredura passar — e é justamente aí que o gestor abre a tela para ver se ainda dá tempo |
| Janela de recuperação | é de conserto, não de censura (SPEC §4.10). `estaPublicada` **não olha** a resolução: se resolver escondesse a nota, deixar o alerta parado no painel viraria o jeito de nunca publicar, e o produto viria com um filtro embutido. A tela diz isso em letras, ao lado do contador |
| Apagar avaliação | não existe, e em três camadas: sem permissão no catálogo, sem `DELETE` para a aplicação, e gatilho que recusa reescrever nota e comentário. `UPDATE SET rating = 5` é apagar a avaliação ruim com outro nome |
| Ação referencial e `REVOKE` | `ON DELETE CASCADE` roda com os direitos do dono da tabela e **não passa** pelo `REVOKE DELETE`. Numa tabela que ninguém pode apagar, toda chave estrangeira é `SET NULL` — senão apagar a linha vizinha vira o caminho de destruição que a revogação existia para fechar |
| Coluna congelada | ou o gatilho a cobre, ou o comentário que diz "congelada" é decoração. `professional_id` decide **de quem** é a nota 1, e ficou de fora da primeira versão: reatribuir moveria as notas ruins para quem saiu e limparia a média de quem ficou. Desatar para nulo é legítimo — é o que a própria chave estrangeira faz —, reapontar não |
| Média mostrada ao gestor | conta **tudo**, publicado ou não (SPEC §4.10). Uma média que só somasse o que está no ar seria o painel mentindo para quem decide contratar e demitir. A pública é outro número, e a distância entre os dois é a informação |
| Nota exibida em página indexada | só o primeiro nome de quem escreveu, e só a partir de um mínimo de avaliações. "5,0 de uma avaliação" é ruído estatístico com cara de excelência |
| Permissão nova na tela de permissões | a tela agrupa por **prefixo**: prefixo que não casa com nenhum grupo não desenha caixa, e a permissão só é concedível por `UPDATE` no banco. `feedback.view` e `feedback.manage` ficaram três blocos assim, com a suíte verde. Há teste que deriva do catálogo |
| DRE | **derivado**, nunca tabela. Cada linha sai do fato já gravado — venda paga, movimento de estoque com custo congelado, taxa da venda, conta paga. Uma tabela de resultado seria um número que alguém sobrescreve, e a pergunta que chega nunca é "quanto deu", é *"por que caiu?"*. Mesma decisão do saldo de estoque e do de fidelidade |
| Comparativo de relatório | contra uma janela do **mesmo tamanho**, nunca "o mês anterior". Para um recorte de sete dias ou de quarenta, a queda que a tela mostraria seria só a diferença de duração. E o **sentido** vem do domínio: despesa que sobe é piora, receita que sobe é melhora — uma seta verde para cima em "Comissões" é a tela dizendo o contrário do número |
| Divisão que pode ter denominador zero num relatório | devolve `null`, nunca `Infinity`. "Margem de ∞%" é o que apareceria em toda barbearia no primeiro mês — justamente quando o dono abre o relatório pela primeira vez |
| Vale ao profissional | **empréstimo, não despesa**: o dinheiro sai da gaveta hoje e volta como desconto na folha. Lançá-lo como custo no DRE contaria o mesmo dinheiro duas vezes. O teto é o que ele **já fez** no período aberto, lido do banco dentro da transação — o vale é descontado inteiro ou não é, e adiantar acima da comissão produz um acerto que paga zero e uma diferença sem mecanismo de cobrança |
| Vale cancelado que saiu da gaveta | devolve o dinheiro à gaveta na mesma transação, e exige caixa aberto. Só virar o estado apagava a dívida com o `withdrawal` de pé: o fechamento do dia batia ao centavo, a folha não descontava nada e o teto voltava inteiro — dava para repetir conceder-cancelar até esvaziar a gaveta. Achado da `/security-review` do bloco 52 |
| Vale consumido por um fechamento | só de quem entra numa **linha** daquele fechamento. Sem o filtro, a folha de agosto consumia o vale de julho de quem tirou agosto de férias: virava `descontado`, ficava imutável pelo gatilho, e nenhuma linha registrava o desconto — a dívida era destruída em silêncio e julho pagava a comissão cheia |
| Estorno de venda | estado próprio (`refunded`), nunca `cancelled`: a cancelada nunca foi cobrada, a estornada foi cobrada e devolvida. Desfaz comissão, repasse, estoque, fidelidade acumulada, fiado e caixa numa transação — e **não** devolve a unidade de pacote nem o crédito resgatado, porque o serviço foi prestado |
| Passar um pacote adiante | movem-se as **unidades restantes**; a receita já reconhecida em `package_uses` fica com o primeiro dono, com a data em que foi reconhecida. Reatribuí-la reescreveria o resultado de um mês fechado. `transferable` é lido da **compra**, nunca do catálogo: ligar a opção hoje não torna transferível o que foi vendido ontem como intransferível |
| Varredura que deriva permissão de tipo | segue herança **e composição**, até o ponto fixo. Só herança deixava o DRE de fora — `DreComparado` contém um `Dre`, e é a rota mais óbvia do produto para `finance.view_profit`. A ancoragem é o `:` que abre a declaração do campo, e não a menção solta, que era o que acusava a comanda inteira |
| Conta a pagar e a receber | **uma tabela com `direction`**, não duas. Elas têm a mesma forma — vencimento, valor, categoria, quem, pago ou não —, e duas tabelas iguais significam duas consultas para "o que vence esta semana" e dois lugares para esquecer de mexer no bloco seguinte. É o oposto de `subscriptions` × `club_subscriptions`: lá são dois **fatos** com o mesmo nome de negócio; aqui é o mesmo fato em dois sentidos |
| Conta vencida | derivada do dia **da unidade**, nunca coluna. Uma coluna `vencida` estaria errada todo minuto entre a virada do dia e a varredura passar, e é justamente aí que alguém abre a tela para ver o que atrasou. E `<`, nunca `<=`: quem vence hoje é pago hoje, e pintar de vermelho a conta do dia às 8h ensina que o vermelho não quer dizer nada |
| Conta paga pela gaveta | não volta atrás. O dinheiro saiu e `cash_movements` registrou, que é append-only desde o bloco 18 — desfazer faria o extrato do caixa e a lista do financeiro contarem histórias diferentes sobre a mesma nota de cem, com o fechamento acusando falta que ninguém explica. Quem pagou por fora da gaveta pode desfazer: ali não há segundo registro para contradizer |
| Transferência entre contas | é **um** fato com duas colunas, não dois lançamentos com sinal. Parti-la em dois deixaria "de onde veio este dinheiro?" com duas respostas independentes que alguém dessincroniza. E os **dois** lados tocam a gaveta quando ela é ponta: registrar só a saída fazia o depósito na gaveta sumir do fechamento — achado da `/security-review` do bloco 51 |
| Chave estrangeira para `locations` em tabela de dinheiro | `RESTRICT`, nunca `CASCADE` — e a exceção é só `tenant_id`. É a mesma razão do append-only: ação referencial roda com os direitos do dono da tabela e não passa pelo `REVOKE DELETE`. **A lista de exceções de uma varredura é o lugar mais perigoso do teste**: a primeira versão isentava `location_id` e desligava a conferência justamente para a chave que a violava |
| Toque duplo em operação de dinheiro | barrado por **estado** quando existe um, por chave quando não existe. Saldo inicial de fiado é a primeira linha do extrato e o próprio extrato o barra; transferência não tem estado que a distinga da repetição — dois depósitos de R$ 500 no mesmo dia são caso legítimo — e por isso exige `Idempotency-Key`, escopada por operador |
| Limite de fiado | `finance.credit_limit`, nunca `customers.edit`. Com a segunda, autorizar alguém a levar R$ 500 em serviço sem pagar seria edição de cadastro qualquer, sem passar por dinheiro e portanto sem segundo fator — o mesmo defeito que a revisão do bloco 37 achou no override do score. E não vem no papel de gerente por padrão: pagar o que a casa deve é operação, decidir quem leva corte sem pagar é risco |
| Saldo herdado do sistema antigo | uma linha por pessoa, digitada com o motivo, no razão que já existe — **nunca coluna de planilha**. Uma coluna mal mapeada criaria mil e duzentas dívidas sem nenhum porquê escrito, e o extrato do fiado é exatamente o documento que precisa explicar cada centavo quando o cliente discorda. É o precedente do consentimento de marketing, que também não é importável |
| Indicador do barbeiro que é dele | sai de `commission.view_own`, que já significa "os meus números". `reviews.view` dá as avaliações da casa inteira, e a nota do colega na tela do outro é a briga que a primeira permissão existe para evitar |
| Regra municipal | não entra no código, e é decisão escrita na SPEC §5.11. São ~5.500 municípios com regra própria: absorvê-los faz o time manter integração fiscal em vez de produto. O que mora aqui é o contrato `FiscalProvider` e o vocabulário de estado; quem sabe se Salvador exige RPS numerado é o emissor contratado |
| Certificado digital | **nunca** neste lado. O A1 e a senha ficam no emissor, que tem obrigação regulatória de guardá-los, e aqui fica a referência opaca — é o precedente do token do cartão e do id de recebedor do adquirente. Há invariante que reprova uma coluna de certificado ou senha em `fiscal_settings` |
| Emissão de nota | **nunca** bloqueia a venda, como o KYC do bloco 50. A nota nasce `pendente` dentro da transação que fecha a comanda, a fila fala com a prefeitura, e o balcão vê o estado na comanda. Recusar o fechamento até a nota sair produz a barbearia descobrindo no balcão, com o cliente na frente, que não consegue cobrar |
| Chave que vai ao emissor | é a da **linha da nota**, nunca a da venda. Depois de uma rejeição, a barbearia corrige o cadastro e emite de novo sobre a mesma comanda: com a chave da venda, o emissor devolveria a nota rejeitada de antes e a correção nunca chegaria à prefeitura |
| Cancelamento de nota | tem estado próprio em voo (`cancelando`), não só `FOR UPDATE`. A trava cai no commit e a viagem à prefeitura acontece fora da transação — sem o estado, dois toques mandavam o cancelamento duas vezes, o segundo contra um RPS já cancelado. É o precedente de `aceitando` no bloco 39 e de `liquidando` no bloco 50 |
| Estado que ocupa uma venda | mora **uma vez**, em `core`, e o índice parcial que o impõe cita a mesma lista. Escritos duas vezes à mão, os dois divergiram em `cancelando`: pedir nota com um cancelamento em voo passava por toda a validação para morrer na constraint — erro de banco no balcão, e exceção **dentro** de `fecharComanda`, que roda na transação do webhook do Pix |
| Botão de refazer uma operação | derivado da mesma pergunta que o domínio faz, nunca de "já existe um registro?". A tela dizia "corrija e emita de novo" sobre nenhum botão, porque a condição escrita era a presença da nota e não o estado dela — estado sem saída na interface (§6, pergunta 3) |
| Permissão fiscal | fora do grupo que deriva segundo fator: a nota não move centavo, e cobrar TOTP para conferir se a nota do cliente saiu são trinta confirmações por dia. A listagem por período é a exceção e declara `finance.view` junto — trezentas notas com valor são o faturamento do mês por outro caminho —, e a repartição do Salão-Parceiro sai só para `commission.view_all`, porque é a comissão do profissional naquela venda |
| CPF do tomador | mora em `customers`, informado **uma vez** e congelado na nota no momento da emissão. Corrigi-lo em março não reescreve a nota de janeiro, que é o documento que foi à prefeitura. Sai na anonimização por dois caminhos — a coluna do cadastro e a cópia dentro da nota já emitida —, e só o primeiro a varredura de catálogo pega sozinha |
| Dado pessoal na trilha | a trilha registra **que mudou**, nunca o valor. `customers.tax_id_changed` guarda `{ tinha: true }`: o CPF em `audit_log` seria uma segunda cópia numa tabela append-only que a anonimização não alcança e que a exportação do titular deixa de fora de propósito |
| Campo que o balcão preenche | mora onde o balcão trabalha. O CPF do tomador está na **comanda** e não na ficha do cliente, porque a ficha exige `customers.view_notes`, que a recepção não tem por padrão — e é a recepção que ouve "põe meu CPF na nota" com a maquininha na mão |
| Documento mostrado na tela | pontuado (`529.982.247-25`), e só os dígitos vão ao emissor. Quem digita está conferindo contra um documento pontuado na mão do cliente, e comparar onze algarismos corridos com um RG na mesa é onde o erro de um dígito passa |
| Mensagem transacional de madrugada | espera as 8h da unidade, como todo o resto. A nota é transacional e o cliente acabou de sair — a tentação é mandar na hora —, mas o que chega às 22h47 é uma mensagem no celular de quem foi dormir, pelo **mesmo número** que manda o lembrete que reduz falta em 40% |
| Carimbo de entrega | gravado **antes** de a mensagem sair, com o estado no `WHERE` e a contagem conferida. Carimbar depois perde o carimbo se o processo cair, e a volta seguinte remanda. Entre repetir e não mandar, o produto escolhe não mandar: o link continua na tela e a recepção manda quando pedirem |
| Varredura que alcança o que a tarefa perdeu | existe mesmo quando a tarefa se reprograma sozinha. `fiscal.emitir` acompanha **uma** nota e morre com ela; a entrega é sobre o conjunto, e é ela que alcança a nota cuja tarefa se perdeu — aquela ficaria com o link gravado e nunca sairia, sem erro e sem alerta |
| Rota que devolve cadastro de cliente | declara `customers.view` junto da permissão do próprio assunto. A rota da nota passou a devolver nome e CPF lidos do cadastro vivo sob `fiscal.view` sozinha: um papel "Contador" — configuração natural desde que os papéis viraram editáveis — colhia o CPF de todo cliente que já pediu nota. Achado da `/security-review` do bloco 54, e é a terceira vez que a regra da rota que agrega é quebrada |
| Teste de corrida entre duas transações | ou é determinístico, ou não é teste. O de dupla entrega passava **com e sem** o conserto: as duas transações se serializavam sozinhas. O que prende a regra é o provedor falhando — se o carimbo veio antes, a volta seguinte não remanda |
| Número do WhatsApp | é o **da barbearia**, verificado na Meta, nunca o da plataforma (SPEC §4.12). A mensagem que chega de número desconhecido é a que o cliente bloqueia; o da casa ele já tem na agenda. O custo é a verificação de empresa entrar no caminho de quem se cadastra — etapa que dá para abandonar no meio —, e por isso o estado é explícito e o produto opera sem ela |
| Credencial por barbearia | cifrada com AES-256-GCM em **chave própria de ambiente**, nunca a de outra finalidade. Com uma chave só, girar a do segundo fator — operação normal de segurança — deixaria ilegível o token de WhatsApp de todas as barbearias ao mesmo tempo, e o defeito apareceria como "a mensagem parou de sair" dias depois |
| Segredo que a tela guarda | a leitura devolve **se** ele existe, nunca o valor, e o campo vazio significa "não mexa". Devolvê-lo faria toda abertura da tela mandar credencial viva pela rede, para dentro de um HTML que fica no histórico do navegador; escrever nulo por omissão apagaria o token quando alguém corrigisse um campo vizinho |
| Template de mensagem | é cadastro com estado, não string no código. A Meta aprova, recusa e **pausa** o que já tinha aprovado quando o índice de qualidade cai — um texto no código estaria certo hoje e errado no dia em que ela pedisse mudança, e não haveria onde ler por que a mensagem parou de sair |
| Botões da mensagem | derivados do **tipo do aviso**, nunca escolhidos no formulário: o que a Meta aprova precisa ser o que o motor manda. O lembrete de 2h não oferece remarcar — não há grade para remanejar no mesmo dia, e oferecer produz a frustração de tentar e não ter |
| Id que volta pelo aparelho do cliente | provado **sob RLS e por cliente** antes de virar coluna. A checagem de integridade referencial do Postgres roda como dono da tabela e ignora row security: a chave estrangeira aceita o horário de outra barbearia sem reclamar. Não casou, grava nulo — a linha fica, porque o rastro do caso suspeito é o que não se pode perder |
| Tabela de roteamento de webhook | sem RLS, de propósito, e é a exceção que `tenant_slugs` já abriu: o webhook chega **antes** de existir tenant no contexto, e consultar tabela com row security sem tenant devolve zero linhas sempre e em silêncio. Ela guarda só ids opacos; tudo que tem dado mora atrás da RLS e é lido depois |
| Assinatura de webhook | a conta é **do provedor**, e não se reaproveita. A Stripe assina instante + corpo e permite janela de tempo; a Meta assina só o corpo cru, sem instante, então não há janela — quem substitui é a idempotência por id de mensagem, que por isso vive no banco e não só no código |
| Canal indisponível no motor de aviso | devolve nulo, nunca lança. Quem chama tem canal de reserva (SPEC §4.12), e transformar "WhatsApp não configurado" em exceção faria a tarefa da fila morrer em vez de cair para o outro caminho |
| Recusa do domínio dentro de tarefa de fila | vira desfecho gravado, não exceção. "Cancelou fora do prazo" é resposta legítima: relançá-la faria a tarefa ser retentada até esgotar — chamadas que já sabem a resposta — e a linha ficaria para sempre sem desfecho na caixa de entrada |
| Automação de marketing | motor de **eventos**, nunca lista estática: a lista envelhece no dia seguinte ao de ser montada, e quem a montou precisa lembrar de montá-la de novo. A varredura pergunta ao banco quem cruzou a condição hoje |
| Automação sem objetivo | não existe. Toda regra declara o que promete produzir e em quanto tempo, e o disparo guarda se produziu — sem isso ela é uma mensagem que ninguém consegue defender nem matar, some no meio do custo e fica ligada para sempre (SPEC §4.11) |
| Janela de atribuição | tem as **duas** pontas. Sem a de baixo, um agendamento feito antes da mensagem seria creditado a ela; sem a de cima, a automação leva crédito por um corte de dois meses depois, que a pessoa faria de qualquer jeito. Atribuição frouxa é pior que nenhuma, porque tem número |
| Deduplicação de mensagem | por **cliente e dia**, nunca por regra. Cinco automações razoáveis mandariam cinco mensagens na terça, cada uma correta sozinha e o conjunto sendo spam. O índice é parcial no enviado: o disparo pulado não ocupa a vaga de ninguém |
| Disparo que não saiu | é gravado com o motivo, como `notifications.reason`. "Nada foi enviado" sem motivo transforma toda pergunta do dono numa investigação |
| Atraso de automação | conta do **fato**, não da varredura. Ela roda de hora em hora e pode achar um fato de trinta minutos atrás; contar de agora empurraria "duas horas depois do corte" para duas horas depois da varredura, e o texto prometeria o que já não é verdade |
| Violação de constraint dentro de transação | não se trata com `catch` ali dentro: no Postgres a transação aborta e toda instrução seguinte é recusada. A condição vai **na própria instrução** (`NOT EXISTS`), e o índice único fica como última linha de defesa entre processos — tratada fora da transação, que é o único lugar em que dá |
| Gatilho ou opção que ainda não funciona | aparece na tela **marcado**, nunca escondido. Escondê-lo faz a SPEC parecer entregue; mostrá-lo sem aviso faz a barbearia ligá-lo e concluir que o produto está quebrado |
| Caixa de seleção | 44px como todo alvo de toque, em qualquer largura. O padrão do navegador dá 13px, e a primeira tela do produto a usar uma caixa reprovou na medição — a regra no design system é o que impede a próxima de repetir |
| Rótulo que muda por opção do seletor | vai **dentro da opção**, não numa dica abaixo. A dica teria que listar todos os significados de uma vez, e vira parágrafo que ninguém lê; o produto não tem componente de cliente para trocar o texto ao mexer no seletor |
| Heatmap de ocupação | não é relatório, é ponto de partida de ação (SPEC §5.9): a célula fria é clicável e vira campanha. Hora fechada devolve `null`, nunca zero por cento — zero diria "esta hora está vazia, faça algo" sobre uma hora em que a casa não abre, e seria a célula mais vermelha de um heatmap ingênuo |
| Horário de pico | **derivado do movimento medido**, nunca cadastrado. Uma caixa onde o dono declara suas horas cheias é mais um campo que ninguém preenche — foi por isso que o quarto termo do sinal ficou lacuna do bloco 39 ao 57. Derivado, o dono não adivinha e a definição não é burlável por engano |
| Público de campanha | **congelado na criação**, nunca recalculado do filtro. Guardar o filtro faria "quantos receberam" mudar toda vez que alguém fosse cadastrado — e a receita atribuída, que é lida contra esse conjunto, mudaria junto. O filtro é como se chegou ao público; o público é o fato |
| Receita atribuída | congelada no momento da atribuição, e é a exceção da regra de valor derivado — mesma razão do split. Recalcular na leitura faria o relatório de março mudar quando alguém estornasse uma venda em maio, e a pergunta é "quanto esta campanha trouxe", não "quanto vale hoje" |
| Relógio dentro de uma função que já recebe `agora` | é o parâmetro, nunca `now()` do banco. Misturar os dois fez a regra de um-por-dia comparar a data do parâmetro com uma coluna gravada pelo relógio do processo — e a segunda campanha do mesmo dia saía |
| `LATERAL` num `UPDATE` | não enxerga a tabela que está sendo alterada; o Postgres recusa a referência. O cálculo vira subconsulta que já traz o id do alvo — e continua sendo uma instrução só, porque um laço por alvo é o N+1 sobre o público inteiro |
| Semente de teste que limpa o banco | tem gancho com folga (`hookTimeout`), e não é tolerância a lentidão. O portão roda dez suítes contra o mesmo Postgres: o `TRUNCATE` espera pela trava e o gancho passa dos 10s do padrão. O estrago não é o gancho que estoura — é o que sobra dele, porque as instruções já enviadas caem **depois** do `TRUNCATE` seguinte e matam o teste de baixo com chave duplicada num id que ele nem escreveu. A falha aparecia ora num pacote ora noutro, sempre em testes diferentes: retrato de corrida, e a razão de o suspeito nunca ser o teste que ficou vermelho |

---

## Ao começar um bloco

1. Leia a seção correspondente em `docs/spec/` — a SPEC é o contrato.
2. **Pergunte o que já aponta para este bloco**:

   ```bash
   node scripts/verificar-lacunas.mjs 15
   ```

   O que sair dali entra no escopo do bloco. A guarda do `pnpm verify` recusa
   marcar o bloco como concluído enquanto uma lacuna apontar para ele, então
   descobrir isso no fechamento é retrabalho ou decisão tomada com pressa.

   Três saídas são legítimas — entregar junto, mover a lacuna para outro bloco
   com o motivo escrito, ou concluir que ela não é mais necessária e removê-la,
   o que fica visível no commit. Sumir em silêncio não é uma delas.
3. Confirme quais defeitos de `SPEC.md §2.2` o bloco resolve.
4. Escreva o teste da regra antes ou junto do código.
5. Ao terminar, percorra o Definition of Done item por item.
6. Commit descrevendo **a decisão**, não o arquivo alterado.

## Economia de tempo dentro do bloco

O bloco é entregue inteiro. O que dá para acelerar é o **jeito de trabalhar**,
e nada aqui abre mão de teste, de segurança ou de medição.

### A ordem do bloco, medida em blocos que demoraram demais

Os blocos 31, 32 e 33 passaram de uma hora cada. Metade foi escopo legítimo — o
33 sozinho carregava **quatro lacunas declaradas** de blocos anteriores. A outra
metade foi processo, e é o que esta seção corrige. Os números são deste
repositório, nesta máquina.

| Passo | Custo | Quantas vezes por bloco |
|---|---|---|
| `scripts/verify.sh --rapido` | 30–70 s | à vontade |
| `pnpm verify` | ~3,5 min | **uma**, no fechamento |
| `scripts/medicao.sh` | ~4 min | **uma**, no fechamento |
| `/security-review` | ~8 min | uma, e **cedo** |
| `npx vitest run scripts/crase-em-sql.test.mjs` | 3 s | sempre que tocar SQL |

**A ordem que funciona:**

1. Migração e domínio, com os testes. `--rapido` no laço.
2. API. `--rapido`.
3. **Dispare a `/security-review` aqui**, antes das telas. Ela leva oito minutos
   e acha coisa de verdade — no bloco 33 achou que a escada de login virava
   arma: errar uma senha de propósito a cada meia hora trancava o dono fora do
   próprio negócio para sempre. Achado no fim, o conserto custa mais uma volta
   inteira de portão; achado aqui, ele entra enquanto as telas são construídas.
4. Telas, enquanto a revisão roda.
5. `pnpm verify` inteiro, `scripts/medicao.sh`, prints, commit.

**Os desperdícios concretos, para não repetir:**

- **Rodar o portão inteiro no laço interno.** Cinco execuções de `pnpm verify`
  num bloco são doze minutos que o `--rapido` resolveria em três. Ele diz a cada
  execução que não fecha bloco; é para ser usado assim mesmo.
- **Rodar a medição de navegador a cada tela.** Ela é do fechamento, com todas
  as telas de uma vez.
- **Descobrir crase dentro de SQL pelo build.** O guarda custa três segundos e o
  build custa um minuto — e o erro sai como sintaxe em cima de uma linha de
  prosa, que é caro de ler. Rode o guarda logo depois de escrever a consulta.
- **Deixar a revisão de segurança para o último passo.** É o item mais caro do
  fechamento e o único que pode obrigar a refazer desenho.
- **Rodar qualquer outra coisa durante `scripts/medicao.sh`.** A parte de carga
  mede P95 de `/availability` com oito requisições simultâneas: ela disputa CPU
  com o que estiver rodando junto. Uma suíte de `vitest` por cima derrubou a
  vazão de 39,8 para 4,1 req/s e produziu P95 de 3367 ms, com sete requisições
  estourando o teto de 10s da transação do Prisma — falha que não existia. A
  repetição com a máquina livre deu 261 ms sobre a mesma carga.

  **Número de carga medido sob contenção é pior que número nenhum, porque tem
  cara de dado.** Se a medição acusar carga fora da meta, a primeira pergunta é
  o que mais estava rodando — e a resposta certa é repetir com a máquina livre,
  não anotar "provavelmente foi contenção" e seguir.

O portão está em ~90s (era ~208s). Como se chegou lá, e o que a medição
desmentiu, está no cabeçalho de `scripts/verify.sh` — vale ler antes de tentar
otimizar de novo, porque o palpite mais óbvio (trocar as migrações por
`CREATE DATABASE ... TEMPLATE`) estava errado: elas custam 1s.

**No laço interno, use o modo rápido.**

```bash
scripts/verify.sh --rapido    # só os pacotes afetados, e quem depende deles
```

Mudança em `apps/web` confere em ~32s no lugar de ~90s; em `packages/finance`,
~73s, porque ela legitimamente puxa o e2e da API. Quem decide é
`scripts/afetados.mjs`, que lê o grafo dos `package.json` — pacote novo aparece
sozinho, sem ninguém lembrar de cadastrá-lo.

Ele **não fecha bloco**, e diz isso a cada execução. O Definition of Done
continua exigindo `pnpm verify` inteiro. E mudança fora de um pacote
(`scripts/`, `tsconfig.base.json`, a raiz) confere tudo: um atalho que erra
para menos devolve verde sobre código que ninguém rodou, o que é pior do que
não ter atalho.

**Antes de otimizar o portão, quebre-o de propósito.** Um portão paralelo que
engole falha é pior que um lento, e um que inventa falha treina todo mundo a
ignorar vermelho. Quebre três testes em pacotes diferentes e confira que as
três — e só as três — aparecem na lista final. Foi assim que apareceu a corrida
do `ALTER ROLE` acusando `onboarding`, que ninguém tinha tocado.

- **Provar teste vermelho em lote.** Quebre cinco regras de uma vez e rode a
  suíte uma vez, conferindo que os cinco testes certos falharam. Cinco ciclos
  de quebrar-rodar-restaurar custam cinco execuções e provam o mesmo.
  Cuidado com um detalhe: confira que a quebra **de fato** aconteceu. Um `sed`
  que não casou deixa o teste passando e parecendo que ele não presta.
- **Durante o trabalho, rode só o pacote afetado.** O `pnpm verify` inteiro é
  do fechamento, não do meio.
- **`pnpm -r build` antes de qualquer e2e da API.** Ela importa `dist`, não
  `src`: um `dist` velho produz falha de um defeito que já foi corrigido, e o
  tempo vai embora investigando o que não existe. Dentro do `verify` isso já
  está garantido, porque o build vem antes.
- **A medição de responsividade roda uma vez, no fim**, com todas as telas.
- **Teste que depende de "agora" cabendo numa janela é teste instável.** Sob
  carga, os segundos entre uma consulta e o POST seguinte viram vários, e um
  horário encostado na antecedência mínima deixa de ser marcável no caminho. O
  e2e do balcão marcava no primeiro horário de **hoje** e reprovava uma vez em
  seis depois que as suítes passaram a rodar juntas. Marque amanhã.
- **Nada de `sleep` para esperar relógio.** Se o teste precisa do passo
  seguinte de uma janela de tempo, peça o passo seguinte — não durma até ele
  chegar. Foi assim que a medição perdia 31 segundos por execução.
