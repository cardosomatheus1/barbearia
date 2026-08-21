# Regras do projeto

Vinculante para todo bloco do [`ROADMAP.md`](ROADMAP.md). Nenhum bloco é dado
como concluído sem cumprir as quatro regras abaixo e o
[Definition of Done](#definition-of-done).

Estas regras não são estilo. Cada uma existe por um defeito concreto encontrado
no sistema analisado em campo (`docs/01-analise-salonsoft.md`) ou por um erro
cometido e corrigido neste repositório.

---

## 0. Autoridade de decisão

@AGENT_AUTHORITY.md

O que aquele documento governa é **quando parar e perguntar** — e a resposta é
quase sempre "não pare". A escolha não especificada se decide pelos quatro
critérios de lá e a execução continua. As regras 1 a 6 **deste** arquivo
continuam valendo integralmente: elas dizem *o que* o código precisa cumprir,
não *quem* decide.

Quatro pontos em que este repositório é mais específico que o texto geral, e
onde o específico vence:

- **"Toda query de domínio filtra por tenant explicitamente"** não vale aqui, e
  o motivo está na regra 2: quem filtra é a política de RLS, e o repositório
  **não** repete `tenant_id` no `WHERE` de propósito. Repetir o filtro mascara
  política ausente — a consulta fica certa, o teste passa, e a próxima que
  alguém escrever sem o `WHERE` vaza sem nada ter ficado vermelho antes. O teste
  que consulta **sem filtro** esperando zero linhas é o que prova a política, e
  ele existe desde o bloco 1.
- **Não existe `DECISIONS.md`, de propósito.** Já há três lugares para registrar
  decisão, e nenhuma lista mora em dois lugares neste código — é a regra que
  `secoes.ts`, os rótulos de campanha e o estado que ocupa uma venda já
  cobraram. Onde vai cada coisa:

  | O que é | Onde mora |
  |---|---|
  | Decisão que vale daqui para a frente | tabela de convenções deste arquivo, com o contrafactual |
  | Decisão que deixa algo por fazer | [Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada), com o bloco de destino |
  | Decisão local de um bloco | a mensagem de commit, que descreve **a decisão**, não o arquivo |

  O prefixo `REVISAR:` do texto geral — a escolha que nem o precedente decidiu —
  entra como linha na tabela de lacunas, que é o único dos três lugares que tem
  destino e que o `pnpm verify` cobra.
- **"Não declare conclusão sem o CI verde"**: não há CI aqui, e `pnpm verify`
  mais `scripts/medicao.sh` fazem o julgamento por código de saída. Mas o portão
  é **necessário e não suficiente**, e isso não é ressalva de estilo: o bloco 35
  passou o portão inteiro — 123 testes, verify verde, medição verde, revisão de
  segurança feita — e entregou uma tela em que nenhuma aba acendia e um
  indicador que nunca saía de `—`. Portão verde prova que o que existe passa;
  não prova que existe o que precisa existir. Quem responde por isso é a regra 6
  e os prints, e o critério de conclusão é o
  [Definition of Done](#definition-of-done) inteiro.
- **"Uma SPEC por branch, PR aberto"**: o trabalho sai em bloco do
  [`ROADMAP.md`](ROADMAP.md), um commit por bloco na branch designada da sessão.
  Pull request é aberto quando pedido, não por padrão.

O documento diz de si mesmo que é "contexto, não trava". A réplica das paradas
obrigatórias em `.claude/settings.json` e o hook de `PreToolUse` que ele cita
**não** estão instalados: mexer na configuração de permissão da ferramenta é a
única coisa aqui que não se faz sem o dono saber.

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
| Fluxo com tela | e2e da API cobrindo o caminho inteiro. **Ninguém clica nas telas hoje** — a medição as abre e mede, não as usa. É lacuna declarada, com dependência escrita no ROADMAP |

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
- **O `vitest` não faz typecheck.** Ele roda por esbuild, que apaga os tipos sem
  conferi-los: um teste que monta o objeto com o nome de campo errado passa
  verde, e às vezes **pelo motivo errado** — no bloco 60 um histórico montado com
  `quando` no lugar de `comecariaEm` chegava vazio à janela, e a asserção sobre a
  presunção de boa-fé estava na verdade provando que a janela descarta lixo. O
  `pnpm verify` roda typecheck e a suíte; verde na suíte não quer dizer que os
  tipos batem.
- **SQL cru não é conferido por ninguém até rodar.** `$queryRaw` não sabe se a
  coluna existe: o Prisma é introspectado, mas a string não passa por ele. Toda
  consulta nova precisa de um teste que a **execute** — e é por isso que
  `packages/db` e as suítes de integração existem. Coluna inventada numa consulta
  só aparece em produção.
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

### Ler o código não é verificar o comportamento

A `/security-review` lê. Ela acha muito — sete achados reais nos blocos 58 e 59 —
e há uma classe que ela não pega: a que só aparece quando alguém **executa** o
ataque. O produto tem duas barbearias em toda suíte de integração de propósito,
e é isso que as torna úteis. Toda rota nova que recebe um id de outra entidade
ganha o teste que manda **o id da vizinha** e espera recusa — não porque a RLS
possa falhar, mas porque a checagem de integridade referencial do Postgres a
ignora, e a chave estrangeira aceita o id alheio sem reclamar.

**Entrada malformada que devolve 500 é defeito de borda, sempre.** O certo é 400
com motivo. Já aconteceu aqui: `(71) 3333-4444` batia na `CHECK` de E.164 e a
tela do onboarding dizia "Erro interno" sobre um telefone que a pessoa digitou
do jeito que se digita telefone no Brasil.

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
| Unidade da sessão | em `staff_sessions.location_id`, nunca num cabeçalho que a tela mandasse. É o desenho de `mfa_verified_at`: a recepção escolhe a loja ao chegar e trabalha nela o dia inteiro, e um cabeçalho faria cada uma das vinte telas do painel precisar lembrar de repassá-lo — a que esquecesse cairia de volta em "a primeira", que é o defeito que o bloco 58 fecha. Nula é "ainda não escolheu" e cai na primeira aberta, e é por isso que a barbearia de uma loja só não nota que o bloco existiu |
| Vínculo entre pessoa e unidade | **ausência significa todas**, ao contrário do resto deste schema, que nega por omissão. Negar aqui trancaria a equipe inteira para fora no dia da migração, porque nenhuma barbearia existente tem linha em `staff_locations`. O risco está contido em outro lugar: o que a pessoa **pode fazer** continua saindo de `role_permissions` — isto decide só *onde* |
| Escopo de unidade numa rota que grava | conferido **no domínio**, nunca na borda nem no seletor. A lista que a tela oferece decide o que ela **mostra**; o `POST` recebe o id do corpo, e o id da unidade mais antiga sai na página pública. Sem a conferência, o gerente de uma filial esvaziava o estoque da matriz por um corpo escrito à mão. Achado da `/security-review` do bloco 58 |
| Recusa de unidade que não é sua | mesma mensagem de unidade inexistente. "Existe, mas não é sua" confirma o id para quem o adivinhou — é o precedente do OTP, que responde igual para telefone existente e inexistente |
| Conceder unidade | ninguém concede o que não tem, e o que o ator tem sai do **banco**: um `team.manage` escopado à filial chamava a rota sobre a própria conta com lista vazia — que significa "todas" — e passava a operar a rede inteira. E o dono não se edita, como em `changeStaffRole` e `setStaffActive`: escopá-lo a uma loja faria vinte rotas do painel devolverem 404 para ele |
| Transferência de estoque | um fato com duas pontas (`stock_transfers`) mais os dois movimentos que o saldo soma, na mesma transação — é a decisão da transferência entre contas do bloco 51. O saldo conferido é o **da loja de origem**, nunca o da rede: com o global, a matriz transferiria dez unidades que estão na filial. Custo unitário congelado, senão transferir mudaria a margem das duas sem ninguém ter comprado nada |
| Coluna que existe e ninguém preenche | é o mesmo defeito de `blocks`, e reaparece por caminho parcial. `stock_movements.location_id` era gravado por venda, consumo e estorno **e não pela entrada** — que é por onde o produto chega —, então o saldo por loja somava zero em toda parte. Quando um caminho preenche e o outro não, o campo mente pior do que se estivesse vazio: ele tem número |
| Chave estrangeira para `locations` que amplia acesso | `RESTRICT`. `staff_locations` nasceu `CASCADE`, e como **ausência significa todas**, apagar uma unidade promoveria em silêncio todo operador escopado a ela a operador da rede inteira. Cascata que amplia acesso é o contrário do que uma cascata parece fazer |
| Mensalidade do clube no DRE | recortada por `club_subscriptions.location_id`, **congelado na adesão**. A assinatura é do cliente com a barbearia e não com uma loja — mas existe uma resposta que não é inventada: onde a pessoa assinou. Nula é assinatura anterior ao bloco 58 e conta para **todas** as leituras: o dinheiro é da barbearia, e sumir de todas seria pior que aparecer em cada uma |
| Saldo configurável por empresa ou por unidade | o escopo é **congelado em cada lançamento**, como o modo, e o saldo de uma loja é a soma de **dois bolsos**: o compartilhado e o dela. Filtrar o saldo pela loja quebraria no dia da troca — a barbearia que passa para `unidade` em maio faria os pontos de abril sumirem, porque eles não têm loja: foram ganhos quando loja não importava |
| Saída de um saldo com dois bolsos | tira do **compartilhado primeiro**, e pode virar duas linhas. Saindo do bolso da loja, um saldo compartilhado de 300 seria gasto na matriz — deixando aquele bolso em −300 — e continuaria inteiro para gastar na filial. Vale para resgate, ajuste manual, estorno e vencimento: os quatro escrevem no bolso de onde o valor saiu, e os quatro estavam errados na primeira versão |
| Linha negativa escrita no bolso errado | é **descartada em silêncio**. O FIFO só desconta uma saída contra as entradas que a precedem no mesmo bolso: sem lote lá, a linha não acha o que consumir, não dá erro e não deixa saldo negativo. Foi assim que estornar a venda devolvia o dinheiro e deixava os pontos, e que tirar 300 à mão e devolver 300 dava o dobro |
| Pagamento de dívida numa rede | abate **onde a dívida está**, da mais antiga para a mais nova — nunca onde ele foi feito. Carimbado com a loja do balcão, ele deixava o bolso daquela loja positivo e o limite lá passava a valer duas vezes; repetindo pegar-e-pagar, o crédito não tinha teto. O dinheiro continua entrando na gaveta de onde saiu; a dívida que ele quita é a de quem a tem |
| Crédito positivo sem unidade | conta no bolso de **cada** loja, e por isso a unidade é obrigatória em quem cria crédito. É a direção contrária da dívida sem unidade, que conta em todas e aperta o limite: um reembolso de R$ 250 sem loja virava R$ 250 na matriz **e** R$ 250 na filial |
| Plano do clube por unidade | o escopo é do **plano**, não da barbearia: o clube da filial pode ser da loja e o Premium pode valer na rede, e um interruptor único obrigaria a escolher pelo pior dos dois. Assinatura anterior à coluna de unidade é coberta em toda parte — ela foi vendida quando loja não fazia parte da promessa |
| Escopo do fiado | é da **barbearia**, ao contrário do clube: aqui não há dois produtos a distinguir. E o limite não é repartido entre as lojas — "pode levar R$ 300 sem pagar" é uma frase sobre a pessoa, e dividi-la faria abrir a segunda loja cortar pela metade o crédito de todo mundo |
| `as never` num teste ou num controller | é o compilador desligado exatamente onde ele serve. Um campo novo e obrigatório chegou ao banco como nulo em dezenove testes por causa de um — e a coluna tinha `DEFAULT`, que um `NULL` explícito atropela. `Partial<T>` no teste e `z.infer` no controller fazem o campo novo aparecer em vez de sumir |
| Semente de teste que produz o cenário | é de **outra gente** que não o sujeito do teste. A semente que enchia a hora de pico usava o cliente do próprio caso: os dezesseis comparecimentos dela levavam três faltas em vinte, score 85, e a recusa que o teste existia para provar nunca disparava. Semente produz **contexto**; o sujeito é separado |
| Relógio dentro de uma leitura que decide dinheiro | por parâmetro, nunca `new Date()` no corpo. `horaCheia` lia o relógio do processo e a janela de oito semanas andava sozinha: o quarto termo do sinal ficou não-determinístico do bloco 57 ao 60, e o sintoma era um teste que passava hoje e falharia depois de amanhã |
| Código de saída atrás de um `pipe` | é o do último comando, não o do primeiro. `pnpm typecheck 2>&1 \| tail` devolve zero com erro de tipo na tela, e foi assim que um commit entrou com typecheck vermelho. Portão desligado em silêncio é pior que portão lento |
| `ON CONFLICT DO NOTHING` × `DO UPDATE` | é decisão de produto, não detalhe. `DO NOTHING` semeia padrão e **respeita quem já decidiu**; `DO UPDATE` corrige para todos e **sobrescreve escolha**. Escolher pelo que é mais fácil de escrever é como uma decisão do dono some sem ninguém saber |
| Número de relatório que ignora parte do dado | diz isso **na tela**. Uma conta sem categoria fora do DRE, um CMV indisponível, uma janela sem movimento — o número sai completo, com cara de completo, e o dono decide em cima dele. Aviso silencioso é pior que erro visível: o erro visível alguém investiga |
| Nome de indicador | é o que o número **é**, não o que soa melhor. "Margem de caixa" não é "margem líquida", e chamar errado leva a decisão errada com o número certo |
| Trocar a senha | revoga **todas** as sessões abertas da conta, na mesma transação. Sem isso, quem roubou a sessão continua dentro depois da troca — e trocar a senha é justamente o que a pessoa faz quando desconfia |
| `.gitignore` de diretório inteiro | ignora o que está dentro, e exceção lá dentro **não vale** — o git não entra no diretório para avaliá-la. Ignore o conteúdo (`.claude/*`) e libere o que precisa (`!.claude/skills/`), senão uma reorganização apaga arquivo novo sem aviso |
| Regra que recusa um cliente | nasce **desligada**; regra que beneficia nasce ligada. Recusar é a coisa mais cara que este produto faz — ligada por padrão, a barbearia descobre pelo cliente que ligou reclamando, e ninguém decidiu isso. Beneficiar ligado no pior caso dá prioridade a quem nunca faltou sem ter pedido |
| Interruptor que recusa | vem com a **lista de quem ele recusou**, com o valor congelado no momento. Sem ela é uma regra cujo efeito só aparece pela reclamação: o dono não sabe se barrou dois clientes ou duzentos. E recalculado na leitura, a lista mudaria conforme as pessoas voltassem a comparecer — a pergunta é "quem eu recusei", não "quem eu recusaria hoje" |
| Guarda nova num caminho de escrita | vale em **todos** os caminhos que chegam ao mesmo lugar. `createAppointment` e `rescheduleAppointment` não compartilham corpo: a recusa por score entrou na primeira e a segunda virou a porta dos fundos — marcar a hora vazia, remarcar para a cheia, ficar com ela, em dois cliques pelo caminho normal da tela |
| Número interno numa rota de leitura | não sai só porque a linha o guarda. O score é congelado na recusa para a linha explicar a si mesma, e devolvê-lo na rota o entregava a quem tem `appointments.view` — enquanto ler o score é `finance.deposit`. Nenhuma tela o mostrava: estava sendo enviado para ninguém |
| Código de erro que vai para a URL | não nomeia o mecanismo. `?erro=score_no_pico` fica no histórico do navegador, no autocompletar e em qualquer referrer — o número não vaza, mas a existência do julgamento sim, no único lugar em que o código teve o cuidado de não pô-lo |
| Override manual de um número derivado | vale em **toda** consequência dele, não na primeira que foi escrita. O gerente zerava a reputação de quem sumiu com a chave e a pessoa continuava furando a fila de espera, porque aquele caminho lia o histórico calculado — duas fontes de verdade para o mesmo número |
| Semente de teste que limpa o banco | tem gancho com folga (`hookTimeout`), e não é tolerância a lentidão. O portão roda dez suítes contra o mesmo Postgres: o `TRUNCATE` espera pela trava e o gancho passa dos 10s do padrão. O estrago não é o gancho que estoura — é o que sobra dele, porque as instruções já enviadas caem **depois** do `TRUNCATE` seguinte e matam o teste de baixo com chave duplicada num id que ele nem escreveu. A falha aparecia ora num pacote ora noutro, sempre em testes diferentes: retrato de corrida, e a razão de o suspeito nunca ser o teste que ficou vermelho |
| Segmento do cliente | **derivado, nunca coluna** — mesma decisão do DRE, do saldo de estoque e do de fidelidade. A SPEC §4.4 pede "recalculada por evento, não por batch noturno", e derivar na leitura é mais forte que isso: não existe instante em que o rótulo esteja velho. Uma coluna `segmento` estaria errada em todo minuto entre a visita e a varredura passar, e é justamente aí que alguém abre a ficha |
| "Em risco" | sai do **ciclo individual**, nunca de um número fixo. Quem corta a cada 45 dias não está atrasado no dia 30 e quem corta a cada 15 já está — o filtro de "60 dias sem voltar" erra nas duas pontas, e há teste que roda os dois sobre a mesma base para mostrar o erro. O filtro de dias fixos continua existindo: é uma pergunta legítima, e deixou de ser a única |
| Medida central de um ritmo | mediana e desvio absoluto mediano, nunca média e desvio padrão. Quem corta a cada 20 dias, some por oito meses e volta tem média de 60 e mediana de 20 — e a mediana é quem ele é. A folga tem piso de um dia: com desvio zero, quem corta toda sexta viraria "em risco" no sábado de manhã |
| Estatística da base num cálculo | sai **de quem tem o dado**, nunca de todo mundo. Zero não é valor baixo — é ausência: contar quem veio uma vez como ciclo zero puxa a mediana para o chão e ninguém mais volta "mais rápido que a maioria"; contar quem nunca comprou como gasto zero desce o corte do decil e faz VIP incluir gente comum. E abaixo de um mínimo a estatística é `null`, não um número: com cinco clientes, "a maioria da base" é uma frase sobre duas pessoas |
| Visita, para efeito de ritmo | só `completed`. Falta e cancelamento dariam ciclo curto a quem marca e não aparece, e a pessoa que mais falta seria a que o produto classificaria como mais frequente |
| Ordem de rótulos que se sobrepõem | a da **consequência**, não a da tabela da SPEC. Um assinante que sumiu é as duas coisas, e a resposta certa é ir atrás — principalmente assinante, porque ali há uma mensalidade prestes a ser cancelada. Chamar de VIP quem não volta há três ciclos esconde exatamente o que precisa ser visto |
| Público de campanha que depende da base inteira | decidido em `packages/core` **dentro da transação** que grava o público. A mediana de uma base não cabe numa cláusula `WHERE` sobre uma linha, e calcular fora da transação abre a janela em que alguém é cadastrado entre o cálculo e a gravação |
| Parâmetro que um caso da consulta não usa | aparece no texto assim mesmo (`$5::uuid[] IS NOT NULL`). O `bind` vai com o mesmo número de valores sempre, e o Postgres recusa mais valores do que o texto declara — o caso que "não precisa" do parâmetro é o que quebra |
| Rótulo que a tela exibe | mora em `packages/core`, escrito **uma vez**. O mapa dos públicos de campanha estava em `crm` e à mão dentro da tela: o bloco que acrescentou três públicos teria deixado a tela oferecendo quatro com a API aceitando sete, e nada ficaria vermelho, porque a tela sozinha continuava coerente. É a segunda lista paralela depois de `secoes.ts`, e virou teste pelo mesmo motivo |
| Ordem de exibição de um conjunto | sai da constante do domínio, nunca de `Object.entries` de um mapa. A ordem das chaves de um objeto é a de escrita, que ninguém garante e que um `merge` reordena |
| Rótulo que classifica uma pessoa na tela | vem com o **porquê** ao lado. "Em risco" sozinho é uma acusação sem critério, e a recepção precisa poder responder "por que ele está em risco?" sem abrir a documentação |
| Contagem que a tela mostra | vem com os nomes quando cabe agir sobre eles. "Vinte e três em risco" sem nomes obriga a abrir a base e procurar um por um — e a lista é curta de propósito, porque quem precisa falar com todos usa a campanha, que é o botão ao lado |
| Duas telas que classificam a mesma pessoa | usam o mesmo cálculo, mesmo quando uma delas poderia usar um atalho mais barato. Calcular na ficha só os segmentos que cabem no histórico individual seria mais rápido e faria a ficha discordar da contagem do dono sobre a mesma pessoa (§6, pergunta 6) |
| Score que a tela mostra | vem com a **explicação na mesma conta**, nunca escrita depois. Cada sinal contribui com pontos e com a frase que diz o que ele contribuiu, e o número é a soma dos motivos — uma explicação derivada do score pronto é texto plausível ao lado de um número, e no primeiro caso em que os dois discordarem o dono descobre que não pode confiar em nenhum dos dois (SPEC §4.5) |
| Soma de pesos | não é probabilidade, e o produto não a chama assim. Sem modelo treinado e sem rótulo de "abandonou" gravado, "78% de chance" é dar cara de estatística a um palpite. "Risco de 0 a 100" é o que se pode defender |
| Explicação de um score na tela | **aberta**, nunca atrás de um acordeão. Escondida, ela vira opcional — e a SPEC chama a explicação de requisito funcional, não de enfeite |
| Termo que empurra o score para baixo | desconta e **não zera**. Assinante que sumiu é justamente quem cancela a mensalidade no fim do mês: zerando, ele sai da lista; sem descontar, ele aparece ao lado de quem não tem vínculo nenhum, e a campanha é gasta na pessoa errada |
| "Não dá para dizer" | é diferente de "risco zero", e a lista mostra a diferença tirando quem não tem base. Numa lista ordenada por risco, o zero desce para o fim com cara de boa notícia, e o dono lê a lista inteira concluindo que a base está saudável |
| Hábito de um cliente | é o que **mais se repete**, nunca o mais recente. Três cortes com João e um com Ruan têm João como barbeiro de sempre — é a diferença entre um sinal e uma coincidência, e ela decide se a saída de alguém da equipe entra na explicação |
| Estado pendente de data passada | não é compromisso futuro. Uma marcação de três semanas atrás que ninguém fechou continua `pending` para sempre; contá-la faz o produto dizer "tem próximo horário" sobre quem não vai voltar, e o sinal some justamente de quem mais precisa dele |
| Número que um pacote precisa e não pode calcular | entra por parâmetro **obrigatório**, nunca opcional com padrão. Opcional, ele vira zero por omissão na primeira rota nova e o indicador fica em `—` para sempre sem nada ficar vermelho. É o defeito de `blocks` e o do quarto termo do sinal, os dois já cometidos aqui |
| Comparar "quem já vinha" | contra o período **imediatamente anterior**, do mesmo tamanho — nunca contra qualquer visita anterior. Sem o recorte, quem veio uma vez há três anos derruba a retenção por gente que a barbearia já tinha perdido antes de a janela começar |
| Dia sem movimento numa série | entra com zero, nunca some. Uma linha que pula o domingo desenha a semana com seis pontos igualmente espaçados, e o gráfico passa a mentir sobre o ritmo do movimento |
| Denominador de uma taxa de ocupação ou de rendimento | sai da jornada cadastrada, com pausa descontada — nunca "horas × cadeiras × dias". O número fixo erra em toda barbearia que fecha na segunda, e todas fecham |
| MRR de um mês passado | é o que foi **pago** com competência nele, nunca o preço vigente vezes quem está ativo hoje. O segundo reescreve o passado a cada troca de plano. E ajuste proporcional não entra: ele produz um pico que some no mês seguinte sem ninguém ter cancelado nada |
| Retenção da plataforma | por **safra de entrada**, não global. Uma retenção global sobe sozinha num mês de muitas assinaturas novas, porque ninguém cancela no primeiro mês — a safra é o que separa "estamos retendo melhor" de "entrou muita gente nova" |
| Célula de um triângulo de safra que ainda não aconteceu | fica vazia, e é diferente de zero. "Ainda não chegou o mês +5" não é "todas saíram", e pintar as duas igual é o gráfico mentindo sobre o futuro |
| Gráfico neste produto | SVG ou CSS servidos pelo servidor, nunca biblioteca — não há componente de cliente aqui, e o que a tela precisa é `path`, `text` e um retângulo. Uma série só não leva legenda: o título já diz o que a linha é, e a caixa ocuparia a altura que o celular não tem |
| Rampa de cor que codifica magnitude | **um tom só**, do fraco ao forte, nunca arco-íris — no arco-íris é preciso consultar a legenda para saber se verde é mais que laranja. E como os degraus baixos ficam abaixo de 3:1 contra o fundo, **toda célula mostra o número**: a cor nunca carrega sozinha o dado |
| Rótulo direto num gráfico | só no ponto que se procura. Um número em cada ponto vira ruído e some no próprio excesso; o pico é o que a pessoa abriu a tela para ver |
| Permissão que derivaria segundo fator numa tela de consulta | é decisão escrita, não omissão. O prefixo `finance.` cobra TOTP a cada 30 min, e numa tela que a gerência abre de manhã e volta o dia todo isso são trinta confirmações por dia. Quando a rota não move centavo, o caminho é não declarar — e escrever **por quê**, junto do que sustenta a decisão |
| Constante nova num pacote com barril de exportação | confere se o nome já existe. `PESO_DO_ATRASO` era "chegar depois da hora" na confiabilidade e virou "estar vencido para voltar" no churn: duas coisas diferentes com o mesmo nome é como uma passa a ser lida como a outra, e só o `tsc` reclamou — o `vitest` roda por esbuild e não viu
| Rota que responde muitas perguntas diferentes | a permissão viaja com **o que foi perguntado**, nunca com a rota. Um assistente é uma rota só devolvendo dezenas de coisas: declarada com a permissão de *conversar*, ela vira o caminho mais curto para tudo que o painel guarda. O `@Exige` dela é o piso — "esta pessoa é da casa" —, e quem decide é o catálogo, uma métrica de cada vez |
| Piso de permissão numa rota de consulta genérica | o **mais baixo** que existe, de propósito. Um piso alto barra por conta própria, e aí ninguém nota se a conferência que importa parar de acontecer — o teste passa pelo motivo errado, e a proteção real deixa de ser exercitada |
| Entrada que um modelo vai montar | é validada por um **conjunto fechado**, e o modelo nunca é a fronteira. O que não está no catálogo não existe; a recusa acontece antes de qualquer ida ao banco, e a chave nunca é concatenada em SQL |
| Média de um total agrupado | é a soma sobre a contagem, nunca a média das fatias. Duas comandas de R$ 30 e uma de R$ 120 dão ticket de R$ 60, e a média das médias dá R$ 75 — ela pesa igual quem fez duas e quem fez uma. Vale para ocupação também, e o teste **precisa pedir a dimensão**: sem ela o agrupamento tem uma linha só e os dois cálculos coincidem |
| Mensagem de recusa por permissão | é diferente da de entrada inválida. "Não entendi a pergunta" manda a pessoa reformular para sempre um número que ela nunca poderá ver — 403 com "você não tem acesso a este número", 400 para o resto |
| Catálogo devolvido a uma tela | já recortado pelo que aquela pessoa pode. Mandar a lista inteira e esconder na view é a permissão recalculada na tela, e diz à recepção que existe um número que ela não pode ver — o que é informação por si |
| `Record<string, T>` num mapa de erro | é `Record<Uniao, T>`. Com a chave larga o acesso devolve `undefined`, e o mapa parcial vira uma caixa de erro em branco no balcão; com a união, o compilador cobra a frase no dia em que a falha nova existir |
| Resposta de recepção automática | sai **exclusivamente** do que a barbearia cadastrou, e o que não tem cadastro devolve nulo. Uma única frase de conhecimento geral — "sim, pode levar criança" — é o produto inventando uma política que alguém vai ter que honrar no balcão, e ela não sai de nenhum campo que o dono possa corrigir |
| Pergunta que ninguém soube responder | é **dado**, não caso degradado. Ela vira linha com contador (`reception_gaps`), e a lista é o produto: "dezoito pessoas perguntaram se você abre no domingo" é tarefa; "não sei" é um problema que some no log. Sem `customer_id` de propósito — a pergunta mais valiosa é a de quem ainda não é cliente, e guardar quem perguntou transformaria leitura operacional em dado pessoal |
| Agrupamento de texto livre digitado por gente | por chave normalizada — sem acento, sem caixa, sem pontuação, sem palavra vazia e com as palavras ordenadas. Sem isso a lista tem cinquenta linhas de uma coisa só, que é exatamente a tela que ninguém olha. E chave vazia **não** é registrada: ela juntaria toda pergunta ininteligível numa linha sobre a qual não dá para agir |
| Registro que existe para o dono, num caminho que serve o cliente | engole a própria falha. Quem está do outro lado perguntou o preço do corte; deixar a exceção subir trocaria uma lacuna anotada por uma conversa quebrada. É o precedente da recusa de score do bloco 60 |
| Marcar como resolvido o que outra pessoa continua sofrendo | reabre. Perguntar de novo zera `resolvida_em`, senão resolver errado esconde a pergunta para sempre — e o cliente seguinte continua sem resposta, invisível |
| Lista de trabalho na tela | diz **onde se resolve**, e pela mesma função que o motor usa para decidir a resposta. Uma lista que só mostra o problema obriga o dono a adivinhar em qual das trinta telas do painel está o campo, e é a lista que ninguém abre duas vezes. Duas leituras da mesma frase por caminhos diferentes acabariam mandando para o cadastro errado |
| Cancelamento na conversa | responde com **oferta de remarcação** (SPEC §4.17). Quem só cancela deixa a cadeira vazia; quem remarca continua sendo atendido, e o horário liberado ainda vai para a fila de espera pela rota que já existe. O caminho óbvio — confirmar o cancelamento — é o que joga a receita fora |
| Conversa que mexe em agendamento existente | sob sessão, e a proposta continua sem gravar. Remarcar exige saber **qual** horário, e um id numa rota pública é o caminho para mexer no alheio; gravar por um segundo caminho perderia a janela mínima, o teto de remarcações, o sinal que atravessa inteiro e o disparo da fila de espera |
| "O próximo agendamento" | é o **mínimo** por início, nunca o primeiro da consulta. `listCustomerAppointments` ordena do mais distante para o mais próximo: pegar `[0]` ofereceria remarcar o horário do mês que vem para quem disse "não consigo ir hoje" — e a redução por mínimo não depende da ordem de nenhuma consulta |
| Grade oferecida para remarcar | ignora o próprio horário (`ignoreAppointmentId`) e lê os serviços **do agendamento**, nunca da frase. Sem o primeiro, o motor conta a própria reserva como ocupação e esconde a faixa em que a pessoa já cabe; sem o segundo, dá para remarcar para um serviço mais caro pelo preço do antigo |
| Rota de painel que ganha um assunto novo | ganha a permissão daquele assunto junto. O insight de estoque passou a nomear o produto, o prazo e a quantidade — o que a tela de estoque serve sob `inventory.view` — sem declará-la, e virou o caminho mais curto para o estoque do que a própria tela. É a **sétima** vez que a regra da rota que agrega é quebrada aqui, e a terceira varredura derivada criada para que não haja oitava |
| Cópia do que é "público" | usa o **mesmo predicado** da tela pública, não uma aproximação. A vitrine copiava o menor preço de todo serviço ativo, e a página só mostra o que é vendável online com cadeira que o faça: o card anunciava numa busca anônima o "corte funcionário" de R$ 10 que a barbearia tinha mantido fora da própria página. Duas noções de "o que é público" é como uma delas fica para trás |
| Função que escreve em tabela sem RLS | escopa pelo tenant do contexto, mesmo que o único chamador de hoje já o faça. O contrato não pode depender do que os chamadores acertam: o `DELETE` da vitrine era por id puro, e o primeiro botão de "sair da vitrine" por unidade o transformaria em delistar a concorrente. É o defeito do 58 e do 68, achado desta vez **antes** de virar rota |
| Varredura prometida num comentário | tem chamador e tem teste, ou é comentário. A da vitrine foi escrita, exportada e não era chamada por ninguém — preço e nota do card só se atualizariam quando alguém publicasse de novo, e o cabeçalho da migração dizia o contrário |
| Leitura que atravessa barbearias | é a exceção, e o que a torna segura é o **conteúdo**, não a política. A busca do marketplace roda antes de existir tenant no contexto — descobrir a barbearia é o que ela faz —, então lê uma tabela sem RLS que só guarda o que a página pública já mostra. Cliente, agenda e dinheiro continuam atrás da RLS, e a cópia é escrita `withTenant`, de dentro da barbearia |
| Cópia derivada de dado com RLS | carrega o carimbo de quando foi feita e uma varredura que a refaz. Preço e nota mudam por caminhos que não conhecem a vitrine; chamar a atualização de dentro de cada um espalharia a vitrine por cinco pacotes, e o primeiro caminho novo esqueceria dela. Evento nos dois pontos óbvios, varredura como rede, e `refreshed_at` para a defasagem ser verificável em vez de suposta |
| Filtro de nota e filtro de preço | são assimétricos de propósito. Sem nota **não passa** no filtro de nota: quem pediu "4 estrelas para cima" quer garantia, e o desconhecido ali responde outra pergunta. Sem preço **passa** no filtro de preço: o teto não é exigência, e excluir puniria quem ainda não cadastrou o catálogo — justamente quem mais precisa aparecer |
| Caixa de coordenadas de uma busca por raio | usa o cosseno da latitude na longitude. Um grau de longitude vale 111 km no equador e 80 em Porto Alegre: usar o valor do equador em toda parte faz a caixa do sul ser estreita demais e **perder** quem está dentro do raio — resultado ausente que ninguém investiga, porque a lista parece completa |
| `Write` sobre caminho que já existe | é sobrescrita, não criação, e a ferramenta diz "updated" em vez de "created" — a única diferença. Aconteceu aqui: `packages/core/src/vitrine.ts` era o destaque de horários da página pública e virou a busca do marketplace, com o `tsc` acusando um `any` a três arquivos de distância. Nome novo antes de escrever; se o arquivo existia, o `git status` mostra `M` onde deveria estar `??` |
| Previsão de consumo | sai do movimento **medido**, e a taxa divide pela janela inteira — nunca só pelas semanas em que houve saída. A segunda conta responde "quanto sai quando sai"; a pergunta é "quanto sai por dia", e um produto que vende em rajada dura o dobro do que ela diria |
| O que conta como consumo | o que **saiu e não volta**: venda, consumo interno e perda. `ajuste` fica de fora — ele é correção de contagem, a linha que aparece quando alguém recontou e achou menos. Somá-lo faz erro de inventário virar demanda, e a sugestão manda comprar o que nunca foi usado |
| Prazo de um produto acabar | arredondado para **baixo**, e "não dá para dizer" é `null`, nunca infinito. Errar para menos no prazo é errar para mais na antecedência; e numa lista ordenada por urgência o infinito desce para o fim com cara de boa notícia |
| Ritmo com uma semana só de movimento | não é ritmo. Um pedido grande de uma cliente vira "consumo semanal" e a sugestão manda comprar doze potes de uma pomada que sai um por mês — é o critério de `VISITAS_PARA_TER_CICLO` aplicado a estoque |
| Insight sobre o que não tem preço de venda | não existe. Para o consumo interno o produto não sabe quanto de receita a falta bloqueia, e um teto inventado ao lado de dois defensáveis faz a ordenação inteira deixar de valer — ele aparece na tela de estoque, com prazo e sugestão, que é a resposta operacional |
| Semente de teste que mexe em `created_at` | ancora no **`agora` do teste**, não no relógio real, e isola a linha nova por uma janela em volta do relógio. Recuar semanas a partir do relógio deixa tudo fora da janela consultada — o teste mede zero achando que mede consumo —, e "a mais recente" pega uma já carimbada, porque as carimbadas estão no futuro |
| Rota que apaga por id | confere a **unidade** no domínio, e a recusa tem a mesma mensagem de inexistente. A RLS separa barbearias e não separa lojas dentro de uma: sem o filtro, o gerente da filial apaga a regra da matriz mandando o id alheio. Id ser UUID não conserta — `staff_locations` vazio significa "todas", então todo gerente enxerga os ids de todas as lojas até alguém escopá-lo, e escopar depois não tira dele o que ele já anotou. Achado da `/security-review` do bloco 68, e é o mesmo do 58 |
| Número de JS num `int4range` | vai com `::int` explícito. O Prisma manda `bigint`, e `int4range(bigint, bigint)` não existe — o erro sai como função inexistente sobre uma linha que parece certa, e só aparece quando a consulta roda |
| Preço decidido por algoritmo | não existe, e a ausência é o bloco. A IA **recomenda** e a pessoa **aprova**: a recomendação é derivada da ocupação medida e some quando deixa de ser verdade, e o botão dela abre o mesmo cadastro que o formulário. Há invariante que reprova coluna de "preço sugerido" no schema — uma tabela de sugestões aprovadas sozinhas seria a autorização automática que a SPEC §4.20 proíbe |
| Faixa de preço por horário | não se sobrepõe, e quem garante é a constraint de exclusão. Duas regras valendo às 14h de terça exigiriam precedência entre regras de preço, e regra de desempate sobre preço é como o cliente vê um valor na tela e outro na hora de pagar. Semiaberta `[início, fim)`, como todo intervalo daqui: encostar não é sobrepor |
| Teto de variação de preço | é da **marca** (`tenants`), vale sobre toda regra e **apara** em vez de recusar. Dentro da regra, cada linha decidiria o próprio limite, que é o mesmo que não ter limite; recusando, a barbearia cadastra −40%, salva sem erro e não entende por que nada mudou. A tela mostra o aplicado ao lado do cadastrado |
| Assinante e preço de pico | nunca paga acréscimo, e **continua ganhando desconto**. Aparar o desconto também seria ler a SPEC §4.20 ao contrário: ela protege quem assina, não a receita da casa. Quem paga mensalidade por previsibilidade não descobre num sábado que o corte subiu |
| Ajuste de preço que fica só no total | mente na comanda. Ela nasce de `appointment_services`, então um desconto que pare em `appointments.price_cents` aparece na tela do cliente e some na hora de pagar — e a comissão de cada serviço vai junto no erro. A repartição soma **ao centavo**, com a sobra no último, como o split do bloco 50 |
| Preço mostrado ao cliente | é o do **mesmo motor** que grava, e fica congelado na reserva. Aplicar o ajuste depois, em cada chamador, seria a segunda noção de preço que a SPEC §3.5 proíbe; e a grade pública é anônima de propósito — quem sabe o cliente é `resolveSlot`, e é o preço dele que fica |
| Número que ordena uma lista curta | é **teto**, não previsão, e a mesma definição para todo item. Multiplicar por uma taxa de conversão seria inventar um número de marketing com cara de estatística; o teto — "receita deixada na mesa" — é comparável entre tipos, que é tudo que a ordenação precisa. E a tela escreve "até R$ X": teto anunciado como previsão vira promessa |
| Teto que cruza dois lados | é o **menor** deles. Cem clientes no ponto de voltar não valem nada com três vagas, e trinta vagas não valem nada sem a quem oferecer — multiplicar ou pegar o maior produz um número grande que ordena a lista errado, que é o único jeito de um limite de três atrapalhar |
| Limite de itens numa lista de ação | é regra de produto, não de layout, e a tela diz o número. Três insights cabem numa decisão de manhã; vinte ensinam que aquela área não pede nada. O corte tem que cortar **os certos** — por ordem de chegada, ele esconde o problema mais caro atrás do mais antigo |
| Empate numa lista ordenada | desempata por um campo estável, nunca pela ordem da consulta. Sem isso o painel troca de conteúdo entre dois carregamentos sem nada ter mudado, e quem opera deixa de confiar nele |
| Contagem que a tela promete e um botão vai buscar | sai do **mesmo** filtro que o botão abre. Contar "noventa e seis no ponto de voltar" de um jeito e mandar a campanha para outro conjunto é a §6 pergunta 6 — duas telas discordando sobre o mesmo fato —, e o tipo do filtro é o que faz o compilador cobrar |
| Cartão novo que diz o que um cartão velho já dizia | substitui o velho. Dois avisos afirmando "sua agenda tem espaço", em ordens diferentes, na mesma tela, deixam quem opera sem saber qual responder primeiro — e o que sai é o mais fraco: sobre hoje, sem público, sem valor e com um botão que só abre uma tela |
| Varredura que deriva permissão de tipo | precisa enxergar a função **síncrona** também. A primeira versão só olhava `export async function ... Promise<...>`, e com isso não via nada de `packages/core`, onde a função é pura e devolve o tipo direto — a rota de insights passava sem ser vista. Guarda que não alcança a camada onde a regra mora é guarda que não vale |
| Ocupação por pessoa | tem no denominador a **jornada cadastrada**, com pausa descontada, e devolve zero quando não há jornada. Sem descontar a pausa, quem atende o dia inteiro aparece com 87% e nunca cruza o corte; sem o zero, a cadeira recém-contratada mostra "∞%" justamente no dia em que o dono abre o painel |
| "Recusou um pedido de horário" | é a lista de espera, não um contador novo. `waitlist_entries` já é *quem foi embora sem conseguir marcar*; um contador de tentativas seria segunda fonte de verdade, e uma que ninguém preencheria nos caminhos que já existem. Só conta quem pediu **aquela** cadeira: pedido sem preferência somado a toda a equipe infla o número que ordena o painel |
| Texto livre guardado sem `customer_id` | tem prazo escrito no schema, como `imports.payload`. Nada impede alguém de digitar "meu nome é Ana, telefone tal" dentro de uma pergunta anônima — e sem o vínculo, esse texto não é alcançável por `anonimizar_cliente` nem sai na exportação do titular. Vence a **redação**; a chave normalizada e o contador ficam, porque são o produto e não identificam ninguém |
| Prazo de uma cópia de dado pessoal | é o horizonte em que ela ainda serve, nunca o do cadastro. Cinco anos é sobre uma ficha que existe para servir a pessoa; noventa dias é sobre uma frase que ninguém repete há um trimestre e que já não descreve o público de hoje. Guardar além disso é risco sem contrapartida |
| Achado de revisão que não é vulnerabilidade | ou vira entrega, ou vira lacuna com bloco escrito. A `/security-review` do bloco 66 não achou falha e apontou que o texto anônimo ficaria para sempre fora de toda varredura: não era exploitável, e continuar assim seria a postura de dado ter sido **herdada** em vez de decidida |
| Teste que compara duas consultas diferentes | não prova a regra que as separa. O de remarcação passava **com e sem** `ignoreAppointmentId` porque comparava com a grade colapsada da equipe: qualquer diferença satisfazia o `some`. O que prende a regra é o **instante reservado** aparecer para o dono dele e não aparecer para o público |
| Tradutor de linguagem natural | produz um **palpite**, nunca um acesso. Ele pode errar, ser enganado por um texto malicioso ou um dia virar um modelo: a saída é uma chave de conjunto fechado que ainda passa por validação e por permissão. Modelo não é fronteira de segurança |
| Integração de IA sem provedor contratado | entra como **contrato** com implementação local, igual a `PaymentProvider` e `WhatsAppProvider`. Escrever a chamada ao modelo antes de existir a conta seria o `blocks` de novo — parâmetro aceito que ninguém preenche |
| "Não entendi" | é resposta legítima, e melhor que um palpite. Um número que parece certo para a pergunta errada é o pior desfecho de um assistente, porque o dono decide em cima dele |
| Pista de palavra-chave | a mais específica vem antes da mais genérica. "Quanto perdi com falta" contém "falta" e é sobre dinheiro — na ordem errada, a resposta é a contagem em vez do prejuízo |
| Texto que o balcão digita | é comparado sem acento e sem caixa. No celular, com uma mão, ninguém digita acento — responder só a quem digita é o produto funcionando no teste e não no balcão |
| Isenção numa varredura de permissão | é **conquistada**, nunca declarada. A do assistente é "o handler chama `validarPergunta`" — quem compuser métricas sem passar por ela continua reprovado. Uma isenção por nome de arquivo seria a lista que ninguém revisa |
| Guarda que varre código-fonte | tira comentário antes de casar. A guarda de pureza do `core` reprovava a **frase que explica a regra**, porque ela cita ``new Date()`` — e guarda que proíbe documentar o próprio motivo é guarda que alguém apaga |
| `typecheck` e `build` num pacote | não são a mesma conferência. Uma colisão de nome no barril e um genérico estreito demais passaram pelo `tsc -p tsconfig.json` e só apareceram no `tsconfig.build.json` — o `pnpm verify` roda os dois, e é por isso que ele fecha bloco e o `--rapido` não |
| Agente que agenda | **nunca** calcula disponibilidade: ele chama o motor, o mesmo da página pública, com a mesma antecedência mínima e a mesma constraint. Uma segunda noção de "horário livre" é a agenda vendida duas vezes |
| Agente que fala com o cliente | não grava nada. O que sai é **proposta**; gravar continua sendo o `POST` que tem `Idempotency-Key`, sinal e score — não existe atalho para dentro da agenda |
| Nome que o agente reconhece | sai do catálogo **desta** barbearia, casado contra a lista. O que não está nela vira nulo, e nulo faz perguntar em vez de chutar |
| Substantivo no catálogo, verbo na boca | "Corte" não casa com "quero cortar" por `includes`. A raiz de quatro letras resolve, e sem ela o agente perguntava "o que você quer fazer?" para a frase mais comum que existe numa barbearia |
| Nome longo que contém o curto | vence, e por isso são duas passadas: inteiro primeiro, raiz depois. "Corte e barba" caindo em "Corte" faz o cliente sair com metade do que pediu, pagando metade e ocupando metade do tempo |
| Hora dita sem "depois" nem "antes" | é a hora **pedida**, não um piso. Tratada como piso, quem só pode às 19h vê três opções das quais duas não servem — pior que uma pergunta |
| "Amanhã" numa conversa | é amanhã **na barbearia**. Somar 24 horas ao instante e cortar o ISO dá depois de amanhã para quem está a oeste às 22h |
| Pedir para falar com gente | é intenção, não falha. Tratar como "não entendi" é o agente insistindo com quem já desistiu dele |
| Quantos horários o agente oferece | três. Uma lista de vinte numa conversa não é escolha, é planilha — quem quer ver tudo tem a página |
| Escrita que exige saber **qual** registro | não entra na rota pública do agente: ela exige sessão, e a rota que já faz isso tem as garantias que uma segunda porta não teria |
| Motor rodado em lote | é o **mesmo** motor, uma transação por barbearia. A RLS é fixada por transação, então atravessar barbearias numa consulta só é justamente o que a política impede — o que dá para limitar é a largura, para o lote não esgotar o pool de quem está agendando neste instante |
| Preço e horário no mesmo card | falam do **mesmo serviço**, e por isso a vitrine guarda o id do serviço que deu o piso. Anunciar "a partir de R$ 55" ao lado do horário de outro serviço é o card prometendo o que a página não vende — e o predicado do piso tem cinco condições, então recalculá-lo do outro lado seria a terceira cópia de "o que é público" |
| Grade em lote para escolher um horário só | `collapse: true`, sempre. Sem ele a grade sai uma vez por profissional e o "primeiro horário" vira o do primeiro barbeiro da lista: com três cadeiras, o card mostra 17:40 tendo 15:00 livre ao lado |
| Tipo de retorno que estreita um objeto | estreita **o objeto**, não só a declaração. Um `{ ...casa }` tipado como público continua carregando `tenantId` em tempo de execução, e aí o compilador passa a garantir "isto é público" sobre o que não é — a única barreira vira a lista de campos escrita à mão na rota, e a primeira paginação que alguém escrever manda o id da barbearia para a internet sem nada ficar vermelho |
| Teto que a busca aplica antes de calcular | é dito na tela **com o critério do corte**. "Olhamos as 40 mais próximas" é falso quando a ordem pedida foi menor preço: quem corta é a ordem vigente, e uma frase que nomeia o critério errado é pior que nenhuma |
| Card de resultado sem o dado principal | mostra a ausência em letras, nunca um espaço em branco. Card mudo lê como defeito de carregamento, e a barbearia lotada continua sendo resultado legítimo de uma busca por barbearia |
| Promessa comercial que é **negativa** | mora no schema, não num relatório. "A plataforma nunca cobra por cliente que já era seu" é o produto inteiro do marketplace, e o que a impõe é o índice único `(tenant_id, customer_id)` mais as duas pontas da janela — um relatório se perde no primeiro caminho novo |
| Origem que decide dinheiro | é **assinada pelo servidor** e conferida na borda que grava. Um cookie com a palavra "marketplace" dentro é contornado por um `curl` que manda o rótulo no corpo; e um endereço que carimba qualquer navegador vira anúncio de terceiro fazendo a barbearia dever comissão por um cliente que ela mesma trouxe. Emite quem tem o segredo, confere quem grava, e a porta olha `Sec-Fetch-Site` e `Referer` |
| Renúncia a uma cobrança | exige motivo escrito com piso na borda, no domínio e por `CHECK`, mais trilha — e é **estado**, nunca `DELETE`. Sem o motivo, um laço de cliques sobre a lista é evasão de cem por cento da receita e nada a distingue de discordância legítima |
| Tabela que registra contrato entre dois lados | tem política de leitura **com e sem tenant**, como `invoices`. Com a política estrita, o outro lado do contrato enxerga zero linhas e não consegue nem auditar o que foi contestado — isso não é isolamento, é cegueira |
| Estado `rescheduled` numa contagem de histórico | não conta como visita anterior. Remarcar é mover o mesmo compromisso: contando, o balcão apagava a comissão remarcando o horário um minuto antes de concluí-lo, com uma permissão que a recepção já tem e sem deixar rastro |
| `UPDATE` que fecha um lote somado antes | marca **por id**, nunca pela mesma janela de datas. Entre a soma e a marcação nascem linhas novas — o balcão conclui no dia 2 o atendimento do dia 31 —, e pela janela elas ficam carimbadas contra uma fatura que nunca as incluiu: dinheiro que ninguém cobra e que os dois lados veem como pago |
| Total que a tela promete e a cobrança usa | sai do domínio, sem o teto da leitura. Somar a página truncada dá um total menor que a fatura assim que a lista passa do limite |
| `psql -tAc` com `RETURNING` | devolve a linha **e** a etiqueta do comando ("INSERT 0 1"). Sem pegar a primeira linha, o id sai com o rótulo colado e a instrução seguinte recusa o uuid |
| Semente que cria agendamento no relógio | colide com o que outra semeadura já criou para a mesma cadeira, e a constraint anti-overbooking recusa a linha inteira. Hora fixa e fora do expediente |
| Publicar uma **pessoa** | nasce desligado, e é a exceção consciente à regra do bloco 60. Nome, foto, nota e contagem de atendimentos numa página indexada é exposição de gente, não benefício que a barbearia concede — ligado por padrão, o barbeiro descobriria o próprio perfil pelo Google |
| Endereço público de pessoa | permanente, gravado só enquanto é nulo, e único **por barbearia**. Global, dois "joao" em cidades diferentes virariam corrida por nome; trocável, o link salvo pelo cliente morre |
| Página pública de quem trabalha na casa | some quando a pessoa sai **e** quando a unidade fecha. Fechar filial não desliga quem trabalhava nela, e o pior link deste produto é o perfil indexado com "Agendar com X" funcionando para quem não está mais lá |
| Precisão de um número em duas telas | é a mesma nas duas. A nota deste produto tem uma casa desde o bloco 43; a página do barbeiro mostrando duas diria 4,92 onde a da casa diz 4,9, sobre a mesma pessoa (§6, pergunta 6) |
| Teste que prova uma guarda por ausência de dado | não prova nada. O caso "perfil desligado não aparece" passava com a guarda removida, porque a linha nem tinha endereço público para ser achada — a semente precisa satisfazer **tudo menos** a regra sob teste |
| Interruptor e campos no mesmo formulário | são dois envios, não um. Com o estado num campo escondido fixo na negação, salvar uma especialidade nova exigia tirar a página do ar e publicar de novo — o botão que submete é quem manda o valor |
| `ALTER TABLE` com várias cláusulas | é `ADD CONSTRAINT`, nunca `CONSTRAINT` solto. A forma de dentro do `CREATE TABLE` não vale no `ALTER`, e o erro sai como sintaxe apontando para a linha seguinte |
| Duas autorizações para o mesmo dado | são duas guardas, e as duas no banco. Guardar a foto na ficha e publicá-la numa página indexada são decisões diferentes do titular, e uma cláusula de aplicação é perdível numa reescrita — o gatilho não |
| Revogação que a lei manda apagar | apaga, e o gatilho é quem apaga. Deixar isso para a aplicação faz a revogação depender de o caminho que a grava lembrar de limpar, e um caminho novo que esquecesse deixaria a foto de quem disse não no ar, sem nada ficar vermelho |
| Tabela que guarda a pessoa, e não um fato dela | aceita `DELETE`, ao contrário de quase tudo aqui. O `REVOKE DELETE` protege registro de dinheiro; a foto do rosto de alguém não é registro de nada — é a pessoa, e é o mesmo critério de `customer_sessions` |
| `anonimizar_cliente` e uma tabela nova | ou a função a alcança, ou ela entra na varredura de catálogo com o motivo. A função é **lista escrita**, e o bloco 74 quase repetiu o defeito de 1 para 1: a foto de quem exerceu o direito à exclusão continuaria numa página indexada, porque a anonimização não insere revogação e o gatilho que apaga nunca dispararia |
| Consulta nova numa exportação existente | traz a permissão do que ela devolve junto. A foto entrou no arquivo do titular e a rota continuou com quatro permissões: o papel a quem a barbearia deu `customers.export` e negou `customers.view_photos` passava a colher a foto de rosto da base inteira, um cliente por vez, sem a auditoria que a SPEC exige. Oitava quebra da regra da rota que agrega |
| `@Exige` em várias linhas | não. A varredura que cobra permissão em toda rota lê o texto do controller, e o decorador quebrado em linhas com comentários no meio deixa de casar — a rota vira "sem `@Exige`" no teste e passaria a "sem `@Exige`" na vida se o teste não existisse. O motivo vai **acima**, o decorador numa linha |
| Semente de teste que carimba data pelo relógio do processo | usa o fuso da **unidade**. `Date.now() + 24h` cortado no ISO discorda do domínio entre a meia-noite de Londres e a de Salvador: o e2e do agente passava vinte e uma horas por dia |
| Ponto e vírgula dentro de comentário de SQL | não, quando a semente parte a instrução por ele. É irmão da crase: o comentário vira metade de uma instrução e o erro sai como sintaxe em cima de uma linha de prosa |
| Corpo de webhook que sai para terceiro | carrega **fato e id**, nunca dado pessoal. É uma requisição que sai da nossa rede para um endereço digitado num campo, sem TLS mútuo e sem ninguém do outro lado respondendo por LGPD — telefone de cliente por ali é exportar base por um canal configurado em trinta segundos e esquecido. O webhook avisa; a API pública responde, com chave, escopo e trilha |
| Endereço de destino que o cliente escolhe | é conferido pelo **IP resolvido**, não pelo nome, e em duas camadas: o nome no cadastro (para a frase explicar) e cada IP antes de conectar (que é a guarda de verdade, porque o domínio é dele e pode ser reapontado). `https://169.254.169.254/` passa por toda validação de formato e busca credencial de nuvem |
| `fetch` que vai a um endereço de terceiro | `redirect: 'manual'`. Sem isso, um `302` para `http://169.254.169.254/` faz toda a conferência de destino valer nada — o segundo salto não passa por guarda nenhuma. O `3xx` vira resposta não-2xx e a escada trata como falha |
| Segredo que **nós** assinamos | cifrado e recuperável (AES-256-GCM, chave de ambiente própria), ao contrário da chave de API, que guarda só o HMAC. A diferença é a direção: lá quem apresenta o segredo é o outro lado; aqui quem assina somos nós |
| Escada de entrega para terceiro | para na recusa definitiva. Contra um `400`, os seis degraus são seis chamadas que já sabem a resposta — e `408` e `429` são exceção, porque dizem literalmente "tente de novo". É a regra da recusa do adquirente do bloco 46 |
| Reprogramar uma tarefa **e** ter varredura | escolha uma. A nota fiscal se reprograma porque a tabela dela tem RLS e a varredura sem tenant enxergaria zero linhas; o webhook não, porque `next_attempt_at` já é a resposta para "quando tentar de novo" — as duas seriam a segunda noção do mesmo instante, e a entrega cuja tarefa se perdesse ficaria pendente para sempre |
| Motivo gravado ao lado de um código de resposta | só quando **acrescenta** algo. "HTTP 404 · resposta 404" é a mesma frase duas vezes, e quem lê passa a pular a coluna que existe para explicar o que o número não diz |
| Consulta que junta duas tabelas dentro de `semTenant` | vale a política **de cada uma**. `webhook_deliveries` permite a leitura sem tenant e `webhook_endpoints` não: o `JOIN` devolvia zero linhas, e a entrega respondia "sumiu" sobre uma pendência que estava lá. A saída é função `SECURITY DEFINER` do tamanho exato — abrir a política entregaria o segredo cifrado da base |
| Campo obrigatório no `Contexto` do worker | é o que faz o teste que esquecer ficar vermelho. As duas ligações novas do bloco 79 reprovaram treze fixtures no `typecheck` — que é exatamente o que "obrigatória de propósito" promete, e o que o `vitest` sozinho não veria |
| Escopo de chave de API | é uma **permissão do mesmo catálogo** do painel, nunca um vocabulário paralelo. `read:appointments` mais uma tabela de-para seria a sexta lista paralela daqui, e as cinco anteriores todas divergiram. Assim a permissão do bloco 90 nasce disponível para a API sem ninguém lembrar dela |
| Dinheiro numa chave de API | não, nunca. O segundo fator é derivado do prefixo e provado por **sessão**, com TOTP: máquina não digita TOTP, e a saída óbvia — isentar a chave da exigência — faria a API pública virar a porta sem segundo fator para o que o balcão só move com ele. Recusa na borda, no domínio e por `CHECK`, e há teste que percorre `PERMISSOES_DE_DINHEIRO` e cobra as três |
| Segredo de credencial no banco | prefixo em claro (é por ele que a autenticação acha a linha) e **HMAC** do segredo, com chave de ambiente própria. HMAC e não `scrypt`: senha é entropia baixa digitada por gente e precisa ser cara de derivar; chave de API é 256 bits sorteados e conferidos a cada requisição, e um `scrypt` por chamada é o teto de vazão da integração |
| Teto de uma API por chave | contador no banco, e portanto entre processos — o `ThrottlerModule` conta por IP dentro de um processo, o que aperta o integrador atrás de um NAT e dobra o do que usa dois IPs. E a cota é gasta **depois** de o segredo conferir: contar chamada inválida deixaria qualquer um esgotar a cota alheia mandando o prefixo com segredo errado |
| Porta nova que descobre o tenant por conta própria | confere o **bloqueio da conta**, como o `StaffGuard` faz a cada requisição. A chave de API não passava por `TenantService.resolve` nem pelo guarda do painel: a barbearia bloqueada seguia vendendo agenda pela integração, e revogar a chave exigia o painel que o bloqueio trancou. Achado da `/security-review` do bloco 78, e é o que o comentário do `TenantService` previa |
| `UPDATE` dentro de transação `semTenant` numa tabela com política por tenant | alcança **zero linhas, em silêncio**. `last_used_at` ficou nula para sempre e a tela dizia "nunca usada" sobre a chave em uso naquele instante — a única pista de uso do produto afirmando o contrário da verdade, na tela em que se decide qual chave revogar depois de um vazamento. A saída é função `SECURITY DEFINER` do tamanho exato do que se precisa, com a contagem conferida; abrir a política sem tenant liberaria `scopes` e `revoked_at` junto, porque RLS não recorta coluna |
| Guarda do Nest que injeta `Reflector` | usa `@Inject(Reflector)` explícito. Só a anotação de tipo faz o `design:paramtypes` chegar vazio, e a guarda sobe com o campo indefinido — toda rota daquela superfície respondendo 500 |
| Lista num parâmetro de consulta | reaproveita o parser que já existe, nunca reescreve. Duas noções de "como se manda uma lista" divergem no primeiro ajuste, e a API pública passa a aceitar o que a página recusa |
| `CHECK` com subconsulta | não existe no Postgres. A conferência vira operador de arranjo mais expressão regular sobre os elementos juntados — e o erro, quando se tenta, sai na aplicação da migração |
| Leitura que atravessa a RLS de outro tenant | é `SECURITY DEFINER`, com **todas** as guardas escritas dentro e o `search_path` fixado: a franquia sai do contexto e nunca de um parâmetro (um id vindo da requisição seria o relatório da rede concorrente), sem tenant não devolve linha, e a identidade é redigida ali — não na rota. O que atravessa é **a soma**; cliente, comanda e equipe continuam atrás da política de sempre |
| O que a franqueadora vê da franqueada | receita, e só. Royalty é percentual sobre venda e a Lei 13.966/2019 manda declarar isso na COF — receber o número é o contrato funcionando. Cliente, telefone, ficha e anotação não são do contrato, e é o schema que garante a diferença |
| Comparar empresas concorrentes na mesma marca | sem nome. A franqueadora recebe a rede nomeada; a franqueada recebe os próprios números e a mediana. É o princípio da SPEC §4.21 — o indicador se compara com o próprio passado, não com o colega — e aqui pesa mais, porque faturamento de vizinha é informação comercial de terceiro |
| Prova de papel derivada de uma lista | é frágil quando a lista pode ter um elemento. "Se veio linha redigida, quem pergunta é o lado fraco" falhava numa rede de **uma** franqueada: a única linha era a dela, nomeada. A prova certa era estrutural — a franqueadora **não está** na lista, porque a consulta devolve só franqueadas |
| `linhas[0]` de consulta sem ordem | aposta que a RLS devolve uma linha só, e a política de amanhã não sabe disso. Abrir a leitura para a franqueadora enxergar a rede fez a tela dela dizer "franqueada" e esconder o botão de publicar. Papel sai da função que a política usa, nunca de uma linha sorteada |
| Tirar `FORCE` para evitar recursão de política | confira antes: função `SECURITY DEFINER` cujo dono é superusuário **não** passa por row security, com ou sem `FORCE`, e a recursão não acontece. Sem a conferência, a proteção passa a depender de como o banco foi provisionado em vez de da tabela — e isso não aparece em teste nenhum |
| Meta combinada entre duas empresas | é alvo de vendas, e o contrato de franquia combina isso; preço é que não. Por mês, congelada, sem renovação automática — a do mês passado sugere e nunca decide, como a meta do profissional do bloco 22 |
| "Sem meta" numa tabela de progresso | é escrito, nunca zero por cento. A tela não acusa de fracasso quem não foi cobrado de nada, e a rede inteira sem meta devolve `null` em vez de "0 de 5 bateram" |
| Franquia × unidade | tabelas separadas, e é o precedente de `subscriptions` × `club_subscriptions`. `locations` é multiunidade: uma barbearia, várias lojas, mesmo caixa e mesma equipe. Franquia são **vários tenants**, cada um com CNPJ, dinheiro e clientes próprios — o mercado chama as duas de "rede", e confundi-las no schema seria confundi-las em toda consulta daqui para a frente |
| Preço que uma empresa publica para outra | é de **referência**, e o schema não tem caminho para ele virar o cobrado. A franqueada é outra empresa, e impor preço de revenda a distribuidor independente é infração à ordem econômica (Lei 12.529/2011 art. 36 §3º IX). A adoção copia uma vez; republicar não reescreve nada, e o tipo de retorno de `republicar` **não tem** o campo de preço, então o compilador recusa quem tentar |
| A distância entre um padrão e o praticado | é informação, não julgamento: "18,2% abaixo do padrão", nunca "abaixo do que deveria", e sem vermelho nem seta. Um relatório que chamasse a diferença de desvio estaria ensinando o cliente a cometer a infração pela ferramenta que ele comprou |
| RLS de uma tabela que não tem `tenant_id` | pela **participação**, com função `SECURITY DEFINER` e o filtro escrito dentro. Uma política que consultasse direto a tabela de vínculo cairia na política daquela tabela — recursão que o Postgres recusa em tempo de execução. E a política de vínculo é comparação direta com o contexto, sem subconsulta, senão o ciclo volta |
| `GRANT` numa tabela nova | não defende nada: a 0002 instala `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE`, e conceder **não revoga**. `GRANT SELECT ON franchise_tenants` deixou a tabela que decide quem é franqueadora de qual rede com DML completo e sem RLS. O que protege é a política ou o `REVOKE` — nunca o `GRANT`. Achado da `/security-review` do bloco 76 |
| `SELECT ... FOR UPDATE` numa tabela que só se lê | devolve zero linhas em silêncio: no Postgres a trava passa **também** pela política de escrita. A franqueada podia ler o item do padrão e não travá-lo, e a adoção morria com "não encontrado" sobre um item que estava lá. Trava é do caminho que grava — e ali o que se grava é outra tabela |
| Permissão que só existe num tipo de conta | é concedida no instante em que a conta vira daquele tipo, nunca semeada na base. `franchise.manage` entra quando a plataforma marca a barbearia como franqueadora; na migração, seria uma permissão que ninguém decidiu dar a mil e duzentas barbearias |
| Destaque pago numa busca | é **rótulo**, nunca ordenação: o card patrocinado sai marcado e em cima, e a lista orgânica continua ordenada pelo que a pessoa pediu. E ele só rende se a casa passou nos filtros — quem comprou destaque e não tem vaga hoje não aparece numa busca por "disponível hoje", senão o primeiro card é o que menos serve a quem está lendo |
| Escassez que é o produto | imposta por constraint de exclusão, nunca por contador na aplicação. Com cinquenta destaques em Salvador, destaque deixa de valer alguma coisa — para quem compra e para quem busca —, e um contador tem corrida entre duas vendas simultâneas |
| Casar um anúncio com um resultado | pela **unidade**, nunca pelo slug. `marketplace_listings.slug` vem de `tenant_slugs`: numa rede todas as lojas carregam o mesmo, e casar por ele fazia o anúncio comprado para Salvador rotular "Patrocinado" na loja de outra cidade |
| Tabela sem RLS pelo argumento "isto é público" | só quando **todas** as colunas são. `marketplace_ads` nasceu assim, e era verdade de cidade, lugar e período — e falso de preço, fatura, motivo do cancelamento e autor. `marketplace_listings` não tem coluna dessas; esta tinha quatro, e o repositório aqui **não** repete o filtro de tenant de propósito |
| Política de escrita que a plataforma precisa exercer | tem o ramo sem tenant escrito nela. A leitura de `marketplace_attributions` foi aberta no bloco 72 e a escrita ficou estrita: a rota de reversão existiria e não alcançaria linha nenhuma — sem erro, zero linhas afetadas |
| Data inválida numa conta de dinheiro | barrada por `Number.isFinite`, nunca só por `<= 0`. `NaN <= 0` é **falso**: a guarda deixava passar e o `NaN` chegava a `amount_cents` |
| Piso de uma coluna de grade ou de item flex | é `min-content`, e o `min-content` de um `<select>` é a **opção mais comprida** que ele guarda. Sem `min-width: 0`, o dado decide a largura da tela: um nome de barbearia comprido fazia a coluna nascer com 391px dentro de 360. Mora no design system, não em mais um conserto local — havia seis escritos à mão em `globals.css`, um por formulário que já tinha sofrido |
| `documentElement.scrollWidth` como prova de que a página não rola de lado | não basta: ele vem clamped quando o transbordo mora dentro de um `position: sticky`. A barra do painel da plataforma estourou 156px em 390px por vários blocos, com "ok" nas quatro larguras nas seis telas, e dois destinos da navegação fora do alcance de quem usa o celular. `body.scrollWidth` enxerga, e a medição confere os dois |
| Barra de navegação que quebra em linhas | quebra **por dentro** também. A externa tinha `flex-wrap` e a de dentro não: os seis destinos formavam uma linha só que não cabia, e o comentário prometia "sem nada sumir" enquanto sumiam justamente a trilha de auditoria e a tela de segurança |
| Seletor cortado numa tela larga | responde outra pergunta. "Disponível hoje" saindo como "Disponível h" faz a pessoa escolher sem saber o que escolheu — menos colunas e piso legível, nunca seis lado a lado espremidos |
| Acúmulo de fidelidade sobre crédito pré-pago | não. Pacote e assinatura são receita **já reconhecida e já premiada** na venda deles: o pacote de R$ 250 entra uma vez no caixa e era premiado duas — na compra e em cada um dos cinco usos —, dando 10% onde a casa configurou 5%. Em `visitas` é o contrário e a distinção importa: quem usa uma unidade **veio e sentou**, então a visita conta; só a conta inteira paga com o próprio saldo é que não empurra o contador |
| Teto do prêmio de `visitas` | é **um serviço**, nunca o total da comanda. "A cada dez cortes, um grátis" é um corte, e a decisão foi tomada quando a comanda só tinha serviço: com um pacote de R$ 250 na mesma conta, o prêmio pagava a compra inteira e o cliente saía com cinco cortes que ninguém pagou — ainda reembolsáveis proporcionalmente, virando crédito no razão do fiado |
| Texto livre que atravessa para o outro lado de um contrato | vira lista fechada, e a frase fica com quem responde pelo dado. O motivo da contestação de comissão é escrito **sobre um cliente** — "o João Paulo é primo do dono, já corta aqui há três anos" — e ia íntegro para o painel de quem é **operadora**, não controladora. A categoria responde a mesma pergunta ("esta renúncia se explica?") e não nomeia ninguém |
| `SECURITY DEFINER` num gatilho que escreve em tabela protegida | resolve o **privilégio** e não a **política**. Contra `REVOKE UPDATE` ele é obrigatório; contra `FORCE ROW LEVEL SECURITY` ele não passa, porque `FORCE` sujeita até o dono. As duas barreiras são diferentes e precisam das duas respostas: `DEFINER` para uma, e o tenant do chamador para a outra |
| `CHECK` que exige texto para sempre | impede a limpeza que a lei manda fazer. O motivo escrito da contestação era obrigatório por `CHECK` em toda linha cancelada, e isso tornava a anonimização impossível — o gatilho batia na constraint. Quem carrega a exigência passa a ser o campo que **não** sai; a frase continua obrigatória na borda e no domínio, que é onde a pessoa está escrevendo. Quando **não há** campo que possa carregá-la — o motivo de um ajuste de saldo é texto livre por desenho —, o lugar recebe um **marcador fixo**, nunca nulo. Foi a segunda vez, e a segunda custou mais: com o ajuste manual no extrato, `anonimizar_cliente` respondia **500** e o direito à exclusão ficava impossível de exercer. Cada metade tinha suíte verde — a de LGPD anonimizava quem não tinha ajuste, a de fidelidade não anonimizava ninguém —, e quem achou foi o percurso de navegador clicando "Apagar os dados" numa ficha de verdade |
| Papel que só o banco concede | tem o comando que o concede, ou é papel inalcançável. Conta de plataforma nasce `viewer`, nenhuma rota promove, e `criar-super-admin.mjs` era a única porta: a plataforma inteira ficava sem ninguém capaz de bloquear uma inadimplente, trocar um plano ou encerrar um suporte, com a única saída sendo um `UPDATE` à mão que nada documentava. É o estado sem saída da §6 um nível acima, e o padrão continua `viewer` — o que muda é a promoção ser **dita** |
| Semente que prepara um estado | confere a resposta. O bloqueio da medição vinha sendo recusado havia blocos — primeiro 400 por id malformado, depois 403 por papel — e o cartão "bloqueada" que a função diz fotografar nunca existiu. Semente que dispara e segue prepara o estado que ela **acha** que preparou, e a tela é medida no estado errado sem nada ficar vermelho |
| Dois campos com o mesmo `name` na mesma tela | são dois destinos para o mesmo preenchimento, e a tela não desempata. A ficha do cliente tem `motivo` no apagar e no ajuste de confiança; o cartão da plataforma tem `motivo` no bloqueio e no acesso de suporte, dentro de dois `details` de mesma classe com dois `summary` de mesma aparência. Quem escreve o percurso erra por isso; quem opera com pressa também |
| Uma derivação que a guarda faz | vale para **todas** as derivações dela, não só a que se lembrou. A `PermissaoGuard` deriva três coisas do mesmo `@Exige` — permissão, limite do suporte e segundo fator —, e a rota que baixa o piso de propósito desligava as três. Quem baixa o piso passa a cobrar as três com a permissão **de fato exercida**, pelas mesmas funções que a guarda usa |
| Conceder papel | é conceder o conjunto inteiro dele de uma vez, e passa pela mesma guarda de conceder permissão. "Ninguém concede o que não tem" estava em `definirPermissoesDoPapel` e não em `changeStaffRole` — com `team.manage` delegado à recepção, ela levava 403 ao pedir `finance.view` e 200 ao se promover a `manager`, que a tem. Vale também para criar conta e para reemitir senha, onde o alcance do **alvo** é que decide |
| Tabela sem RLS com leitura pública | copia as **duas** metades do precedente: leitura aberta e escrita restrita. De `tenant_slugs` só a primeira foi copiada para `whatsapp_numbers` e `staff_directory`, e a segunda barbearia a reivindicar um `phone_number_id` levava o roteamento do webhook da Meta — e com ele o telefone e o texto dos clientes da primeira |
| Consulta a tabela com RLS fora de `withTenant` | devolve **zero linhas, em silêncio**. `nameOf` lia `tenants` assim desde o bloco 5, e todo código de acesso saía como "Seu código para Barbearia" — nada falhava, nada logava, e o sintoma só aparecia no celular de quem tentava entrar. Quando o dado é público e o contexto ainda não existe, o recorte é função `SECURITY DEFINER` de **uma coluna**, porque RLS não recorta coluna |
| Preço livre numa linha de comanda | é capacidade do balcão, não furo: o formulário é texto livre e a cortesia é a mesma linha. `max_discount_bps` limita o **gesto de desconto** — abrir mão de receita sobre um total que já existe —, e nunca foi limite sobre o que a casa cobra. O que faltava era a trilha de **remover** a linha que veio do agendamento: sem ela, "quem tirou o corte de R$ 49 da comanda do Carlos?" não tinha resposta |
| Texto que alguém digitou dentro de `audit()` | nunca, quando a entidade é uma pessoa. `audit_log` é append-only, a anonimização não o alcança e a exportação do titular o deixa de fora — é o pior destino possível para dado pessoal. Guarda-se o **tamanho**, como o CPF guarda `{ tinha: true }`. Há varredura derivada, e o corte dela é a entidade: reprovar o motivo da sangria seria reprovar o certo, que é o que faz alguém desligar a guarda |
| Coluna nova em `customers` | ou entra na exportação do titular, ou entra na lista de exceções com o motivo escrito. `birth_date` e `tax_id` ficaram de fora por blocos: a guarda de completude comparava **tabelas**, e o arquivo afirmava pelo silêncio que a barbearia não guardava o CPF. A varredura nova lê a consulta **do fonte**, não uma lista ao lado |
| `GRANT` com menos verbos | não revoga nada — a 0002 instala `ALTER DEFAULT PRIVILEGES` com os quatro. Catorze tabelas se descreviam como append-only por causa dele, e `cash_movements` — sobre a qual "conta paga pela gaveta não volta atrás" se apoia — tinha `UPDATE` e `DELETE` desde o bloco 18. Ninguém os usava: a garantia era disciplina, não banco |
| Varredura de cascata | é uma pergunta ao catálogo, nunca uma lista de tabelas. As seis por-tabela que existiam falhavam pelo **recorte** — uma filtrava `attname = 'location_id'` e não via `customer_id` —, e a global achou dez, quatro nunca listadas. E revogar um privilégio **revela** cascata nova: `cash_movements.session_id` estava escondida atrás do próprio `DELETE` que a tabela ainda tinha |
| Isentar a escrita "sem tenant" num gatilho de congelamento | confira quem escreve de verdade primeiro. Presumir "com tenant é a barbearia" é falso em `tenant_platform` (o espelho e o contador de cadeiras escrevem por gatilho) e em `marketplace_attributions` (a emissão da fatura roda `withTenant` de propósito). O corte que funciona é **por coluna** |
| `SECURITY DEFINER` contra `FORCE ROW LEVEL SECURITY` | não basta: `FORCE` sujeita até o dono da tabela. Foi o que quebrou o onboarding quando a política de `tenant_platform` fechou o `UPDATE` — o gatilho que conta cadeiras é definer e mesmo assim foi barrado |
| Resgate de saldo | não queima mais do que a conta consome. `valorDoResgate` apara no teto e quem grava debitava a quantidade **pedida**: cinco mil pontos numa comanda de R$ 10 pagavam R$ 10 e apagavam R$ 50, sem volta a não ser ajuste manual com outra permissão. O que segurava era `resgateSugerido`, que mora na **tela** — qualquer cliente HTTP passava direto |
| Semente de demonstração | atrás de profile e com trava de ambiente. Ela cria uma conta de **dono** com senha publicada no repositório, e rodava em todo `docker compose up` com as portas em todas as interfaces: subir o compose num VPS para mostrar o produto entregava base de clientes, caixa e exportação LGPD a quem alcançasse a porta. A frase "não servem em lugar nenhum além desta máquina" era suposição sobre onde o comando foi digitado, não verificação |
| Contestar uma avaliação | é **suspender da vitrine**, nunca apagar: a nota e o texto continuam imutáveis e a média do gestor continua contando. Se a contestação mexesse na média interna, o dono cegaria o próprio termômetro com o botão que o produto lhe deu — e é a distância entre as duas médias que diz "o Bruno está com 4,8 na rua e 3,9 de verdade". A suspensão vive **só** no predicado do que é público |
| Motivo de uma moderação | lista fechada, nunca texto livre. Texto livre vira "não gostei", e "não gostei" é apagar com outro nome; os cinco valores descrevem coisas que ou aconteceram ou não aconteceram, e é isso que torna a suspensão auditável em vez de discricionária |
| Estado que tira algo do ar | tem saída, e a saída é do mesmo peso da entrada. Sem retirada, contestar por engano deixaria a nota fora da vitrine para sempre — apagar com mais passos, que é o que o bloco existe para não ser. A permissão é a mesma porque a direção é a segura: quem retira devolve a avaliação ao público. Reescrever a contestação viva continua recusado; recontestar são dois gestos e duas linhas na trilha |
| Texto que o balcão escreve sobre um cliente | sai na anonimização, e quem o tira é **gatilho**, não uma linha a mais em `anonimizar_cliente`. A função é lista escrita e a varredura de catálogo do bloco 34 só olha colunas de `customers` — nenhuma das duas redes pega uma coluna de `reviews`. Vira marcador e não nulo, porque o `CHECK` exige a decisão completa e o motivo de lista fechada precisa continuar explicando por que a nota está fora do ar |
| Gatilho que precisa rodar antes de outro | é ordem de **nome**, e o Postgres dispara por ela. `reviews_anonimiza_contestacao` escreve o marcador; `reviews_contestacao_imutavel` compara depois — trocada a ordem, o segundo recusaria a anonimização que o primeiro acabou de fazer |
| Campo novo num tipo que decide visibilidade | obrigatório, nunca opcional. `contestadaEm?` chegaria `undefined` na primeira consulta que esquecesse dele, e `undefined` é falso: a avaliação suspensa voltaria ao ar com o compilador calado. O erro que a omissão produz é o pior possível e é silencioso — é o defeito de `blocks` com a polaridade invertida |
| Cópia derivada que guarda nota de avaliação | é atualizada no evento que muda a nota, não só pela varredura. Contestar sem chamar a vitrine deixa o card do marketplace contando por um dia a avaliação que o dono já suspendeu: a suspensão funcionando na tela que ele abre e falhando na que o cliente abre |
| Teste que mede uma média depois de tirar uma nota | confere se sobrou o mínimo de exibição. Com três avaliações, contestar uma derruba a pública abaixo do piso e o número some — o teste passa medindo o piso do bloco 43, e não a média recalculada que ele foi escrito para provar |
| Crase dentro de template literal de CSS | mesma armadilha do SQL, e o sintoma é outro: o erro sai como sintaxe de TypeScript em cima de uma linha de prosa. Quem pega é o `build`, não o `vitest` |
| Recurso que a plataforma ainda não estreou | nasce desligado em `feature_flags` e **fora** de `plan_features`, e liga pelo toggle do Super Admin, uma conta de cada vez. É diferente de conteúdo de plano, que é o que faz o Pro custar mais que o Starter — e diferente do gatilho que a barbearia liga, que aparece marcado e nunca escondido. Quando quem decide é a plataforma, o desligado **não existe** do outro lado: some do menu, o endereço responde 404, e é a mesma razão de a guarda não responder 403 |
| Esconder o link do menu | não fecha a tela. O endereço continua digitável e fica salvo no navegador de quem já entrou — sem a guarda na página, a pessoa chega a uma tela que pede à API algo que ela responde 404, e o que ela lê é erro em vez de "isto não existe aqui". As duas metades, e a segunda derivada do registro de navegação: o destino que alguém marcar no bloco seguinte nasce cobrado |
| Lista fechada numa borda de validação | sai do catálogo, nunca escrita de novo no `z.enum`. Escrita, ela ficou para trás no primeiro recurso novo: o toggle do Super Admin respondia **400** para um recurso que o catálogo, o banco e a guarda já conheciam. A borda é o pior lugar para uma lista paralela, porque o sintoma é a rota recusando o que o produto aceita |
| Teste contra rede injetada | prova o que **sai**, nunca o que falta sair. Campo obrigatório ausente não aparece em asserção nenhuma sobre o corpo, e a rede de mentira responde 200 para qualquer coisa — o `success_url` do checkout faltava desde que o arquivo foi escrito, com a suíte verde, e o meio "link" nunca funcionou. Uma rodada contra a conta de verdade em modo de teste devolveu três 400 em cima de código que passava inteiro |
| Estado do adquirente que serve a duas situações | precisa de discriminador vindo da própria resposta. `requires_payment_method` é o intent recém-criado **e** o cartão recusado; sem olhar `last_payment_error`, toda cobrança de cartão nasce recusada e a conciliação a encerra antes de o cliente abrir o link. Quem escreve a resposta falsa do teste é quem já acha que sabe o que ela contém |
| Campo nulo num corpo `form-urlencoded` | vira string vazia, e a Stripe responde **400** — que não é 402. "Esta barbearia não tem cartão salvo" chegando à régua como indisponibilidade gasta D+1, D+3 e D+7 em chamadas que já sabem a resposta. A recusa é local e definitiva, antes da ida |
| Permissão que um terceiro concede | guardada com **os nomes que ele usa**, nunca um booleano derivado. A Meta acrescenta escopo sem avisar, e um `pode_gerenciar` responde uma pergunta só — a seguinte exigiria migração e reconexão de todas as barbearias já ligadas. E a ausência é **`null`, não `false`**: o cadastro pelo formulário nunca fala com o terceiro, e tratar isso como "não pode" faz a tela acusar de falta de acesso quem está mandando mensagem sem reclamar. É a distinção que o score do bloco 61 já precisou fazer — numa tela, "não sei" e "zero" se parecem e levam a decisões opostas |
| Migração depois da baseline do livro-caixa | é **reaplicável**, e as anteriores não precisam ser. Banco preexistente é adotado marcando tudo até a baseline (`migrate.sh`) e rodando de verdade o que vem depois — então a primeira migração nova reencontra o que ela mesma criou num banco que já a tinha. Sem `IF NOT EXISTS` e sem a guarda de `pg_constraint`, o `preparar` do compose morre, `api`, `worker` e `web` não sobem por `service_completed_successfully`, e o Caddy fica fora do ar: o sintoma é a 443 recusando conexão depois de um comando que era só para atualizar. Mover a baseline para a frente é a saída errada e pior — a produção veria a migração marcada como aplicada **sem** ter a coluna |
| `ON CONFLICT` e violação de `CHECK` | ele trata índice único, e **não** `CHECK`: ela é avaliada na linha que o `INSERT` propõe, antes de o conflito ser detectado. Deixar uma coluna fora da lista para "resolver no `DO UPDATE`" faz a linha proposta chegar incompleta e morrer ali — o `DO UPDATE` nunca é alcançado. `status_reason` fora da lista derrubava salvar o cadastro de um número suspenso, e a pista está no `DETAIL` do Postgres: `created_at` igual a `updated_at` é a linha do insert, não a atualizada |
| Salvar um cadastro | não rebaixa o que já foi provado. A versão que escrevia `aguardando_verificacao` sempre que houvesse token fazia **rotação de credencial** — operação normal de segurança — devolver um canal ativo para "falta confirmar", com `verified_at` preenchido na mesma linha: dois campos discordando sobre o mesmo fato, e a tela mandando repetir um passo já feito. A escada respeita o que existe, e `suspenso` só sai por quem falou com o terceiro |
| Semente da medição e o estado que o bloco criou | a semente precisa produzir o estado novo, senão o print é da tela **antes** da mudança e a medição diz "ok" sobre o que não foi olhado. O cadastro do WhatsApp era semeado sem escopo, e o aviso do bloco 88 não aparecia em largura nenhuma. É a regra da semente que confere a resposta, aplicada ao que a medição fotografa |
| Prévia do que vai sair | casada com a escolha que a manda, nunca a lista inteira. O seletor dizia "Convite de retorno — sem texto aprovado" e a caixa abaixo mostrava "Lembrete de 24 horas", sob a frase *"é este o texto que o cliente vai ler"* — no singular. É a §6 pergunta 6 acontecendo entre dois campos vizinhos da mesma tela, e nada ficava vermelho: cada metade, sozinha, listava a coisa certa. A guarda ancora na constante do domínio (`TIPOS_DE_CAMPANHA`) e não em `name="tipo"`, que acusava a tela de estoque — cujo "tipo" é entrada, venda ou perda |
| Seletor de uma opção só | não é escolha, é uma frase com cara de decisão: quem abre procura a segunda opção que não existe. O campo vira `hidden` e o rótulo vira afirmação, **derivado do tamanho da lista** — no dia em que houver a segunda, ela volta a ser rádio sozinha |
| Significado que muda por opção, sem componente de cliente | mora **dentro da opção**, aberta. Num `<select>` ele some quando o seletor fecha, e a saída que a tela tinha tomado era repetir: a `<option>` dizia "Sumiu há um tempo — depois de quantos dias sem vir" e uma lista de seis definições logo abaixo dizia o mesmo de novo, ocupando o maior bloco da página. Duas cópias do mesmo mapa, e nenhuma visível na hora de preencher |
| Classe de CSS nova numa tela | confere se o nome já existe. `.escolha` está definida três vezes neste arquivo — o cardápio de serviços, a marcação pelo balcão e o realce do escolhido —, com `display: flex` e `justify-content: space-between` valendo. Herdá-la num cartão de rádio jogaria a explicação para a outra ponta da tela, e a briga entre as regras é o defeito que o comentário do bloco do cardápio já documenta. É a mesma armadilha de `PESO_DO_ATRASO`, no CSS |
| Estado que a tela cria | tem como sair **na tela**, e a pergunta é se o botão existe, não se o domínio aceita. A ação de salvar automação recebe `id` desde o bloco 56 e a linha nunca ofereceu desligar: a única forma de calar uma mensagem que estava saindo errado era pelo banco. §6 pergunta 3, com o mecanismo pronto há trinta e seis blocos |
| Título de uma lista | descreve o que está embaixo dele. "O que está ligado" sobre uma lista que sempre trouxe as desligadas junto é a §6 pergunta 6 entre um cabeçalho e a própria lista — e piora no bloco que acrescenta o botão de desligar, porque a linha desligada passa a ficar onde está |
| Rota de escrita que devolve o mesmo objeto de uma rota de leitura | declara as mesmas permissões dela. `GET /orders/:id` exigia `customers.view` com o motivo escrito — a comanda carrega nome, saldo de fiado e teto de crédito —, e as **cinco** rotas de escrita que devolvem o mesmo `Comanda` declaravam só `cashier.open`: os três campos que a porta da frente recusava saíam inteiros pela porta de trás, um cliente por vez. Nona quebra da regra da rota que agrega |
| Rota que devolve pessoa e não pode exigir `customers.view` | recebe `podeVerCliente` e **redige**, nunca recusa. `@Exige` é conjuntivo: somar a permissão à agenda trancaria quem só atende para fora do próprio dia. O mecanismo existia desde o bloco 38 com um chamador só, e três leitores — painel do dia, agenda e fila — entregavam nome, telefone e id da base inteira sob `appointments.view`. Medido: 577 dos 631 clientes por nome, enquanto `GET /customers` respondia 403 |
| Permissão no catálogo que nenhuma rota exige | é pior que ausente: a caixa está na tela, o dono desmarca, e nada muda — um controle de segurança que ele acredita ter configurado. `appointments.cancel` era o **exemplo do cabeçalho** daquela tela e cancelar passava por `appointments.attend`. Ou ganha conferência, ou aparece marcada como sem tela, e a guarda cobra os dois sentidos: a que ganhar rota sai da lista |
| Permissão decidida por ação dentro de uma rota | é `pode(...)` no corpo, nunca um segundo nome no `@Exige` — ele é conjuntivo e trancaria quem faz as outras ações. É o desenho de `metrica.controller.ts`, que decide uma métrica de cada vez, e o que permitiu cobrar `appointments.cancel` sem tirar de ninguém o direito de marcar presença |
| Rota que só precisa da contagem | chama a função que devolve contagem, não a que devolve a lista. O assistente respondia "quantos em risco?" chamando `churnDaBase` e contando em cima — trazendo nome e telefone de cada um para dentro de uma rota que declara o piso mais baixo do painel. É a decisão do bloco 63 aplicada a gente em vez de dinheiro |
| Varredura derivada que lê `packages/` | lê **todos**, não `core` + `finance`. Três derivações de permissão liam dois pacotes, e `crm`, `scheduling` e `catalog` são exatamente onde moravam a receita de campanha, a agenda e a jornada. E o corpo da interface sai por **contagem de chaves**: `[^}]*` para no primeiro objeto aninhado, e foi assim que `DayBoard` ficou invisível para as três |
| Leitura por id numa tabela com `location_id` | filtra pela loja quando a função **recebe** a loja. A RLS separa barbearias e não separa lojas dentro de uma, e oito defeitos de uma varredura só eram a mesma linha: `WHERE id = $1` dentro de uma função que já tinha `locationId` na assinatura. O pior fechava a comanda da matriz com o dinheiro caindo na gaveta da filial, e pelo webhook do Pix isso acontecia **sem ninguém clicar**. A distinção que separa o legítimo do defeituoso é essa: quem *deriva* a loja da própria linha (`cancelAppointment`) não pode filtrar por ela; quem a *recebe* escolheu não usar |
| Parâmetro de loja numa função de escrita | obrigatório, nunca opcional. Opcional, ele nasce ausente no primeiro caminho novo — `stock_movements.location_id` era gravada pela venda, pelo consumo e pelo estorno, e não pela entrada, que é por onde o produto chega, então o saldo por loja somava zero em toda parte. Quando um caminho preenche e o outro não, o campo mente pior do que se estivesse vazio: ele tem número |
| `DELETE` que limpa o que "sobrou" de um formulário | pergunta pelo conjunto que a tabela alcança, não pelo que a tela mandou. `service_resource_requirements` é da barbearia e `resource_pools` é da loja: salvar a tela de Recursos de uma loja nova, com a lista vazia, apagava a exigência de lavatório da matriz junto — a grade de lá parava de reservar o recurso e passava a vender dois banhos no mesmo horário, sem trilha e sem nada ficar vermelho. E roda **por último**, senão a subconsulta não enxerga o que a mesma transação acabou de gravar |
| `SET NOT NULL` numa tabela que já existe | não numa migração só, e a guarda de migração aditiva reprova. A versão anterior da aplicação volta a escrever nulo e passa a falhar: "sobe a imagem anterior" deixa de ser rollback. É operação de duas fases em dois deploys, e entre elas quem segura é o **tipo** — o parâmetro obrigatório que faz o compilador cobrar o caminho que esquecer |
| Loja de um relatório que decide preço | a mesma do DRE ao lado. A tela de margem devolvia byte a byte o mesmo corpo nas duas lojas — a da matriz — enquanto o DRE, que filtra por unidade nas dez consultas, mostrava outro número: o gerente da filial lia a margem da matriz e decidia o preço da dele. É a §6 pergunta 6 entre duas telas vizinhas do mesmo painel |
| Fuso de uma tarefa de fundo que data dinheiro | sai da loja **do fato**, nunca de `primaryLocation`. `orders.business_day` decide o mês do acerto do barbeiro, e o webhook do adquirente resolvia o fuso pela loja mais antiga: numa rede Salvador + Rio Branco, a venda da filial confirmada às 22h30 era datada pelo dia da matriz. A cobrança já carrega `location_id`, então a resposta está a um `JOIN` de distância |
| Tela que não diz em qual loja você está | é o que transforma erro de escopo em erro de operação. A tela de Unidades prometia em letras "trocar aqui troca em todas as telas" e nenhuma das outras mencionava a loja — a recepcionista que atende nas duas abria o Caixa sem saber qual gaveta ia abrir. A linha some na barbearia de uma loja só: ali ela repetiria o nome da casa |
| Janela que uma reserva ocupa | é `[início, LEAST(fim, GREATEST(início, concluído_em)))` — **encolher, nunca esticar**. O corte das 18:15 às 19:35 concluído às 18:36 segurava a cadeira por mais uma hora: o painel dizia "livre agora" e "Sentou" respondia "este profissional tem cliente marcado", com o conserto sugerido sendo impossível (remarcar recusa `completed`). Esticar seria pior que não mexer: **concluir** um atendimento que passou da hora passaria a ser recusado pelo horário do cliente seguinte, e o balcão não fecharia a venda. E a expressão mora numa **função** `IMMUTABLE`, não em dois lugares: a constraint de exclusão e o motor de disponibilidade têm que dizer a mesma coisa, senão a grade oferece o que a gravação recusa |
| Gorjeta | é **repasse**, nunca receita nem custo: fora das duas somas do DRE, fora da base de comissão e fora do faturamento da casa. Tem dono — nulo é **rateada entre quem atendeu**, por peso da receita dos itens, que é a mesma regra da taxa do adquirente; um id é o cliente tendo dito a quem. Ela era gravada, subtraída em toda tela e nunca atribuída: R$ 2.628,33 em 447 comandas entrando na conta da casa sem registro de quem é, e o único lugar em que aparecia positiva era o total do dia no caixa, sem nome |
| Rateio de gorjeta | não reaproveita o do desconto. Aquele apara o valor no total dos itens, e tem que aparar — desconto maior que a conta zeraria a base. Gorjeta não tem esse teto: R$ 10 numa conta de R$ 3 é caso legítimo, e com o `Math.min` ela sairia repassando R$ 3. A distribuição de resto é a mesma; o teto é que não |
| Item de comanda escolhido por nome || Item de comanda escolhido por nome | nasce sem id, e o id é o que faz tudo funcionar. O campo era texto livre com `datalist` de **nomes**: digitar exatamente "Corte masculino" gravava `service_id` nulo, e a partir dali a ficha técnica não baixava insumo, o pacote não cobria, o plano do clube não cobria e a margem por serviço perdia a linha — tudo sem erro. O catálogo vai num `<select>` e o id viaja junto; "Outro" continua existindo, e aí a linha nasce sem id **de propósito**, que é diferente de nascer sem id por acidente |
| Coluna que o motor lê e a borda descarta | é o motor que aceita e ninguém preenche, uma camada acima. `adicionarItem` aceita `productId` desde o bloco 44 — é ele que faz a venda e a baixa de estoque serem o mesmo dado — e o `z.enum` da borda não tinha o campo: **não existia caminho no produto para vender um produto**. A recepção digitava "Pomada · R$ 79,00" no campo livre, que é sempre `service`, e a pomada pagava comissão na regra de serviço, entrava no DRE como receita de serviço e o estoque não se mexia. Oito blocos assim, sobre a distinção revenda × consumo que a SPEC §3.7 chama de obrigatória |
| Consulta de relatório que soma movimento de estoque | olha o **estado da venda**. O CMV somava `kind IN ('venda','consumo')` por dia e sem mais nada: a devolução do estorno entra como `entrada`, carimbada no dia do estorno, então o custo ficava no mês da venda para sempre com a receita já removida. O rodapé da tela dizia *"venda estornada sai de todas as linhas"* — saía de sete |
| Erro de domínio que a borda não traduz | vira 500, e 500 no balcão é "Erro interno" sobre uma recusa legítima. `FidelidadeError` ficou fora do `toHttp` do caixa: as seis recusas de resgate têm frase escrita para quem opera e nenhuma chegava. E o caminho não exige má-fé — `resgateQuantidade` é calculado na renderização, então duas abas da mesma comanda bastam |
| Varredura de dado pessoal por nome de coluna | procura **todas** as colunas que carregam pessoa, não só `customer_id`. `fiscal_invoices` guarda nome e CPF congelados na emissão e não tem aquela coluna: ficou fora do arquivo do titular, e `anonimizar_cliente` só a alcança porque alguém escreveu a linha à mão. O silêncio é o defeito — o arquivo afirmava, por omissão, que a barbearia não tinha mandado o CPF à prefeitura |
| Elemento cujo estado a medição nunca alcança | precisa de guarda que leia o fonte. O único `<summary>` sem classe do produto — 24px de alvo — vivia atrás de `podeMexer && signup`, e a semente da medição não configura o Embedded Signup. É a regra da semente vista pelo outro lado: ali o print sai do estado errado, aqui o elemento não sai |
| Preço que a tela mostra antes de gravar || Preço que a tela mostra antes de gravar | sai do **motor**, nas duas portas. A grade do balcão vem do mesmo `getAvailabilityRange` da página pública, com a faixa por horário já aplicada — e o tipo do cliente admin **apagava o campo**: a tela somava o catálogo e mostrava R$ 45,00 sobre um horário que `resolveSlot` congela por R$ 49,50, porque o motor não pergunta quem está marcando. É o defeito que o bloco 105 consertou na tela do cliente, de pé na tela de quem atende o telefone. Na terça de manhã o erro inverte: cobra-se cheio de quem tinha desconto |
| Faturamento **por profissional** | é item a item, pelo profissional do item — a mesma conta de `desempenho.ts`, que é a tela que o barbeiro abre. Atribuir a comanda inteira ao profissional do agendamento põe na conta dele a pomada que a recepção vendeu junto e o desconto que a casa deu: R$ 673,00 de diferença sobre o mesmo barbeiro no mesmo mês, com o dono lendo um número e ele outro. O total **sem** dimensão continua saindo de `orders` — ali a pergunta é quanto a casa faturou, e a pomada é dela |
| Numerador e denominador de uma barra de meta | são da mesma coisa. `metaDaCasa` soma metas individuais, e o numerador era o faturamento da casa: a barra dizia 67% enquanto os três barbeiros somados viam 61% — seis pontos que ninguém reconcilia, porque a diferença é venda de produto |
| Número de relatório que caiu porque alguém não pagou | não ganha seta verde. O DRE é de caixa e soma a conta **paga** — a regra está certa —, e um mês com seis contas vencidas e nenhuma paga mostrava *"Despesas operacionais −R$ 0,00 ↓ -100,0%"* em verde, com "margem de 57,0%" no rodapé. A ressalva ocupa o lugar da seta: uma variação que ela explica não é desempenho |
| Duas contagens quando já há duas médias | andam juntas. A tela separava "Sua média" de "No seu perfil" e explicava que *"a distância entre os dois é a informação"* — e mostrava **uma** contagem: 682 no painel contra 680 na página do cliente. Quem contestou uma nota não sabia quantas ficaram no ar |
| Duas populações com a mesma palavra | uma delas troca de palavra. `em_risco` (passou do próprio ciclo) e o score de churn listavam 34 e 51 pessoas, as duas telas dizendo "em risco" — e a ficha do cliente chamava de "Frequente" quem a Retenção chamava de "Risco médio". O bloco 108 consertou o **botão** e deixou os dois rótulos: o rótulo do fato virou "Passou do ritmo", e "Em risco" ficou com quem soma os sete sinais |
| Troco numa tela que lista pagamentos | é linha da lista. Sem ele a comanda dizia "Total R$ 65,00" e "Dinheiro R$ 100,00", como se tivessem entrado R$ 35,00 a mais — e é justamente a tela que se abre quando a gaveta não bate. O caixa já lia o troco; esta não |
| Frase de estado vazio que não diz o período | mente ao lado do cartão que diz. "Operação sem alerta crítico agora" convivia com "Hoje: 33% Faltas" na mesma tela: o alerta é avaliado sobre o período selecionado e o "tudo certo" não dizia qual. O bloco 114 pôs o período no título de quem dispara e esqueceu de quem não dispara |
| Semente que cria comanda sem item | não existe no produto: a comanda que nasce de um atendimento vem pré-preenchida com os serviços marcados. Duas suítes mediam a única conta possível sobre `orders` — a errada — e passariam a passar por acidente com qualquer definição |
| Estado que o enum tem e nenhum caminho escreve || Estado que o enum tem e nenhum caminho escreve | é estado que não existe, e a linha que precisaria dele fica presa. `order_status` tem `cancelled` desde a migração 0018 e **nada no produto o escrevia**: a comanda aberta por engano só saía de `open` sendo paga, e comanda vazia não fecha — o fechamento exige pelo menos uma forma de pagamento. O botão que a cria fica a um clique dentro de um `details`, e depois de criada ela não aparecia em tela nenhuma: quem fechasse a aba perdia a única porta |
| Índice parcial sem a consulta que ele serve | é a listagem que ninguém escreveu. `orders_abertas_idx`, parcial em `status = 'open'`, existia desde o bloco 18 esperando por uma tela de comandas abertas que nunca veio — e a ausência dela é o que tornava a comanda avulsa invisível. Índice órfão é a pergunta que alguém já sabia que ia ser feita |
| Rota inteira sem cliente na tela | é a mesma coisa que a rota não existir, e pior: ela tem guarda, domínio, trilha e teste, então tudo parece pronto. `POST /mfa/disable` está assim desde o bloco 19 — quem ligou o segundo fator e trocou de celular não desligava nem recadastrava (`already_enabled`), e numa barbearia que exige TOTP no dinheiro aquela conta parava de operar. A tela ainda escrevia *"desligar o segundo fator de uma conta pede o código"*, sobre um botão que não estava desenhado |
| Lista de trabalho com teto | esconde o que ainda pede ação. O painel de avaliações montava as trinta últimas, e "Retirar a contestação" só existe dentro do cartão: passadas trinta avaliações novas, contestar por engano tirava a nota do perfil público **para sempre** — o "apagar com mais passos" que a contestação existe para não ser. Quem pede ação entra sem teto, como a fila de recuperação; o teto é para o que só se lê |
| Tarefa que se reprograma e desiste | precisa de varredura para o depois. `fiscal.emitir` acompanha **uma** nota e nasce com cinco tentativas: esgotadas, a tarefa vira `failed` e nada mais olha aquela linha — a comanda fica com "Na fila, sai em alguns minutos" para sempre, sem botão, e a venda não aceita nota nova. `notasEmCurso` existia desde o bloco 53 com o comentário certo e **sem nenhum chamador**. Vale para todo estado em voo: `cancelando` era pior, porque nem uma varredura futura o alcançaria |
| Gesto que desfaz uma dívida | desfaz também o que a dívida causou, na mesma transação. Perdoar a mensalidade deixava a assinatura `suspensa` sem saída: ela só é reativada quando uma fatura é **paga**, e cancelar era o caminho para não haver mais fatura para pagar. A ficha do cliente seguia dizendo *"dar baixa na mensalidade em Clube devolve o benefício"* sobre uma lista onde aquele assinante não estava |
| Lista que a tela desenha com nome e telefone | tem controle, ou é a lista que o balcão não consegue operar. A espera aparecia com nome, telefone e convite vivo e **sem um único `<form>`**: quem ligava dizendo "já resolvi" continuava recebendo convite, e cada convite segura o horário fora da grade pública por dez minutos. A saída existia só do lado do cliente, sob a sessão dele |
| Estado em voo que só a tarefa tira | é linha presa quando a tarefa morre. `enviando` numa campanha só vira `enviada` no fim do despacho, e o botão "Enviar" só é desenhado para `rascunho` — corretamente, é ele que segura o segundo toque. A saída é derivada do relógio (uma hora sem nada se mexer), nunca de coluna, e nunca oferecida durante um envio que anda: duas voltas simultâneas leem o mesmo alvo, e mensagem repetida no celular do cliente não se desfaz |
| Semente cujas linhas têm o mesmo `created_at` | não ordena nada, e um `LIMIT` sobre elas escolhe por sorte. O teste da avaliação contestada passava **com e sem** o conserto porque as trinta e seis avaliações nasceram no mesmo instante. Semente que produz o cenário produz também a **ordem** dele |
| Frase que o domínio escreveu para a tela | chega à tela. Cada uma traduzia o código da recusa num `Record<string, string>` próprio com `?? 'Tente de novo.'` no fim: os controllers mapeiam 239 códigos e as telas cobriam 142 — **97 recusas** viravam a frase genérica. A recepcionista digitava 30% numa casa com teto de 20% e lia "Não deu para salvar", sobre uma mensagem que trazia o teto em reais de propósito. A frase vai por **cookie** e não pela URL, que fica no histórico; e o mapa da tela continua sendo a rede, nunca o primeiro |
| Porta de entrada e a frase da API | só o código. `AvisoDeRecusa` mostra o que a API escreveu, e é o certo em toda tela de dentro; num login isso vira oráculo — "e-mail já cadastrado" conta a quem está adivinhando exatamente o que a regra de não revelar existência de cadastro existe para não contar |
| Tipo com o mesmo nome nos dois lados | é uma declaração só, reexportada. `admin-api.ts` redeclarava vinte uniões do `core` — `FormaDePagamento` com oito valores contra dez, sob um comentário dizendo "espelha o core", e `EstadoDaNota` sem `cancelando`. O sintoma é sempre tardio: um valor cru na tela, ou um `Record<Uniao, …>` que o `tsc` confirma completo porque **o tipo mente** dizendo que o estado não existe |
| Constante de domínio sem nenhum consumidor | é a lista que a borda e a tela reescreveram. `METODOS_DA_BAIXA`, `MODOS_DA_ASSINATURA`, `DIRECOES_DA_CONTA` e `ESCOPOS` estavam exportadas e não eram usadas por ninguém, com os mesmos valores num `z.enum` e em `<option>` escritos à mão. Constante sem chamador não é reserva para depois — é a divergência de amanhã já escrita |
| Rótulo de um conjunto fechado | `Record<Uniao, string>` no domínio, nunca `Record<string, string>` com `??` na tela. Foi o `??` que deixou a comanda paga mostrar `fidelidade`, `pacote` e `assinatura` crus e minúsculos ao lado de "Dinheiro" — remendados à mão um de cada vez, três vezes. E quando a mesma direção tem ângulos diferentes ("A pagar" na lista, "Pagar" no botão, "Despesa" na categoria), são **três mapas nomeados**, não três telas inventando o seu |
| Lista sem `CHECK` e sem constante | é a que o banco aceita de qualquer jeito. `products.unit` tinha os três valores num **comentário** da migração, um `z.enum` na borda e três `<option>` na tela: importação de base, correção manual e script antigo entravam por fora, e a ficha técnica rateia insumo em cima disso |
| Permissão somada a um `@Exige` que já funcionava | é uma tela a menos para alguém. `@Exige` é conjuntivo: `customers.view` nas seis rotas da comanda tirava o **PDV inteiro** de um papel de balcão a que o dono a negasse, `finance.view` na listagem de campanha deixava um papel "Marketing" criando e enviando o que não conseguia ver, e `customers.view` na listagem fiscal tirava do "Contador" a única pergunta daquela tela. Quando a permissão protege **alguns campos** de um objeto, o caminho é redigir; quando ela protege **o assunto** da rota — a lista de quem deve, o tomador de uma nota específica —, é recusar |
| Guarda que exige redação | cobra o interruptor **usado no corpo**, nunca só declarado na assinatura. Declarar `podeVerCliente` e ignorá-lo custava uma linha e desligava a varredura inteira; e a isenção precisa alcançar a redação feita **na borda**, senão a saída vira uma lista de arquivos isentos — que é a lista que ninguém revisa. A conferência é estrutural: a chamada acusada aparece **dentro** dos argumentos de uma função de redação de verdade |
| Guarda que só varre uma pasta de controllers | vale só ali. A varredura de permissão lia `apps/api/src/admin` e estava desligada em `booking/`, `plataforma/`, `publica/` e `auth/` — as quatro superfícies em que uma rota nova tem mais chance de nascer sem `@Exige`, porque ali a maioria legitimamente não o tem. Quem separa uma coisa da outra é o `@UseGuards` da própria classe, e ele já era lido |
| `{` do corpo de uma função, numa varredura de fonte | não é o primeiro depois do `)`. `): Promise<{ readonly futuros: ... }> {` tem dois, e o primeiro é o do **tipo de retorno**: pegá-lo fazia o "corpo" ser a declaração do retorno, e a função que redigia era acusada de não redigir. O do corpo é o que fecha a linha |
| Guarda escrita à mão sobre **uma** ação de um conjunto | deixa as vizinhas passando. `cancel` ganhou `appointments.cancel` e `no_show` — que a `ACOES_PESADAS` já nomeia como igualmente pesada, com os mesmos estados de origem, a mesma cadeira liberada e ainda a punição na confiabilidade que o cancelamento da casa não tem — continuou sob `appointments.attend`. O mapa total no tipo é quem cobra a decisão da ação nova; um `if` sobre um nome é a porta dos fundos do bloco 60 |
| Guarda que lê o fonte de uma tela | vê o que está **escrito**, nunca o que é desenhado. A de `id` repetido pega a segunda cópia do campo escrita à mão; um componente escrito uma vez e renderizado dez vezes aparece uma vez para ela, e nenhum `id` repetido no navegador a faz ficar vermelha. Isso foi verificado quebrando de propósito, e o limite vai escrito **dentro** da guarda — guarda em que se confia mais do que ela alcança é pior que guarda nenhuma |
| Destino de menu que a conta não abre | **some do menu**, e o endereço continua explicando. Esconder e mentir seria trocar um defeito por outro: quem tem o link salvo precisa ler de quem é a permissão. É o oposto do recurso desligado, que **não existe** do outro lado — ali quem decidiu foi a plataforma, e o dono não tem o que fazer com um link que responde 404 |
| Coluna à mão que o repositório proibiria | passa quando a **guarda é empírica e nos dois sentidos**. A objeção contra a permissão por destino em `secoes.ts` era boa — errar uma linha esconde uma tela de quem deveria vê-la —, e quem responde por ela não é a coluna: é o percurso que entra com cada papel padrão, abre tudo que o menu ofereceu e reprova se recusar, e abre tudo que ele escondeu e reprova se abrir. Uma permissão a mais fica vermelha de um lado, a menos do outro |
| Ler o `@Exige` para saber o que a tela precisa | é mais fraco do que parece. A tela chama várias rotas: a união esconde demais, a primeira esconde de menos, e **nenhuma das duas enxerga a tela que engole o 403** e desenha o formulário inteiro para recusar só no botão — era o caso de WhatsApp, Campanhas e Automações, e só o percurso pegou |
| 403 respondido com "recarregue a página" | é a recusa vestida de falha passageira, e o pior lugar para essa confusão é uma instrução que nunca vai funcionar: a pessoa recarrega até desistir do produto. Seis telas faziam isso — Plano, Chaves de API, Webhooks, Fotos, Franquia e a lista de comandas abertas |
| Marca que uma guarda de navegador lê | é atributo no DOM derivado do código (`data-recusa`), nunca uma lista de frases. Vinte telas escrevem a própria recusa com a frase que só elas sabem escrever, e uma lista de frases deixaria a vigésima primeira variação passar verde |
| Esperar por um elemento que já está na tela | resolve na hora, sobre o valor **antigo**. A senha de primeiro acesso vive dois minutos: ao criar a segunda conta o bloco da primeira ainda estava lá, e o percurso entrava na conta nova com a senha da anterior — "E-mail ou senha incorretos" sobre uma conta criada oito segundos antes. A espera é pelo bloco **daquela** conta, pelo nome |
| Lista fechada que duas camadas precisam | mora em `core`, mesmo quando quem **grava** é outro pacote. `PAYMENT_METHODS` nasceu em `onboarding`, e quando a recepção automática precisou dela — `core` não depende de ninguém — a saída fácil seria escrevê-la de novo. Seria a sexta lista paralela: os mesmos quatro valores e os mesmos quatro rótulos já estavam à mão na tela do onboarding |
| Coluna gravada pelo onboarding e nunca mais | é a coluna que existe e ninguém edita. `locations.payment_methods` era escrita no passo 5 e depois disso inalcançável: quem trocou de maquininha em março não tinha por onde dizer, e o assunto mais perguntado da recepção automática respondia "não sei" com a resposta a um `SELECT` de distância |
| Limpeza que pega carona no próximo uso | só alcança quem volta. O `payload` do preview de importação era apagado no início da **próxima** análise, e o caso mais provável é o oposto: a barbearia sobe o CSV, olha a conferência, desiste e some — deixando nome, telefone e aniversário da base legada inteira sem prazo nenhum. Carona **e** varredura, como a nota fiscal |
| Semente que cria linha com `created_at` do banco | o teste ancora no `created_at` **da linha**, nunca num instante fixo do teste. `AGORA` é uma data fixa no passado e `created_at` sai do `DEFAULT`: somar oito dias àquela dá um instante anterior ao da linha, a varredura não pega nada, e o teste mede zero achando que mede a expiração — inclusive o de tenant vizinho, que passaria pelo motivo errado |
| Link que existe para o número ser conferido | leva o **período** junto. O assistente responde sobre sete janelas — 1, 2, 7, 15, 30, 90 e 365 dias — e o painel tinha três, nenhuma delas trinta dias corridos: "faturei R$ 33.297" levava a uma tela que dizia R$ 22.947, e o dono clicava para confiar e saía desconfiando dos dois. A janela sai de `de` e `ate`, que é o que a resposta imprime — derivar do que foi dito é o que garante que o link e a frase falem do mesmo período |
| Tela que sabe ler um parâmetro novo | é uma lista ao lado do destino, nunca uma regra dentro do componente. `TELAS_COM_JANELA` mora no catálogo de métricas, colada em `tela`: quem ensinar outra tela a ler `dias` acrescenta uma linha lá, e não descobre a regra dentro de um JSX |
| Estado vazio que não diz o porquê | é o indicador sempre `—` com outra roupa. A simulação do clube dizia "a comparação aparece quando um assinante for atendido" ao lado da tabela que listava dezesseis assinantes atendidos — e a causa real era não haver regra de comissão. A distância entre o **fato** (`club_uses`) e o **lançamento** (que exige profissional no item e regra que case) é a informação, e são três frases diferentes, não uma |
| Rota inteira sem cliente na tela | é a mesma coisa que a rota não existir, e pior: tem guarda, domínio, trilha e teste, então tudo parece pronto. Cancelar, reativar e trocar o cartão de uma barbearia existiam desde o bloco 27 e nenhuma tinha cliente em `plataforma-api.ts` — enquanto `/admin/plano` mandava o dono "falar com o suporte", e o suporte tinha `curl` ou `UPDATE` num banco de produção |
| Campo que a API devolve com nome de gente | pode ser de outra entidade. `assinatura.publico` é `plans.audience` — o público-alvo do **plano** —, e os quatro cartões da tela nova saíram com o mesmo título, "Barbearias". O nome da barbearia se resolve da lista, pelo `tenant_id`, como a trilha e a cobrança já faziam. Nada no portão pega isso: o campo existe e tem valor. O print pegou |
| União nova no barril de `core` | confere se o nome já existe **e** se o conceito é o mesmo. `EstadoDaAssinatura` já era o do clube, com cinco valores em português; o da plataforma tem quatro em inglês, porque espelha o vocabulário do adquirente. É a distinção de `subscriptions` × `club_subscriptions` um nível acima, e sem o sufixo um passaria a ser lido como o outro |

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

- **Deixar o piloto de pé durante `pnpm verify`.** Cada pacote cria e destrói o
  próprio banco descartável no **mesmo** Postgres, e o portão roda as suítes em
  paralelo. Com a API e o web do piloto segurando conexões, seis pacotes
  falharam de uma vez com `Database "barbearia_<pacote>_test" does not exist` —
  que lê como catástrofe de código e é contenção de ambiente. A repetição com
  `fuser -k 3010/tcp && fuser -k 3011/tcp` antes deu verde no mesmo commit.

  É a mesma lição da carga, com outro sintoma: **falha de infraestrutura que
  parece defeito** custa a mesma hora que número inventado. Antes de investigar
  um erro de banco que aparece em muitos pacotes ao mesmo tempo, derrube o que
  estiver falando com o Postgres e rode de novo.

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
