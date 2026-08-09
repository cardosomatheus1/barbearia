# Roadmap de execução

Companheiro do [`SPEC.md`](SPEC.md). A SPEC diz **o que** o produto é; este
documento diz **em quantas partes** ele é construído e em que ordem.

**Status: 30 de 78 blocos.**

---

## O que é um bloco

Uma unidade de trabalho que termina **commitada, com teste verde e uma
capacidade nova real**. Não é uma sessão nem um dia — é um incremento que se
sustenta sozinho e pode ser revisado isoladamente.

**Nenhum bloco é dado como concluído sem cumprir o
[Definition of Done](CLAUDE.md#definition-of-done) do `CLAUDE.md`** — testes,
segurança, desempenho e arquitetura. `pnpm verify` é o portão.

---

## Aviso sobre este número

A primeira versão deste roadmap estimava 41 blocos. Estava errada: contava o que
estava escrito nas cinco partes da SPEC, e a SPEC descreve o **produto**, não a
**plataforma que o sustenta**.

Faltavam, por inteiro:

- o app do barbeiro (`app-pro`) — a SPEC pede três aplicações, o orçamento cobria duas;
- o Super Admin (Parte 1 §1.2) — seção escrita, zero blocos;
- a cobrança das barbearias — é o modelo de negócio, sem ele não há SaaS;
- infraestrutura — CI/CD, staging, deploy, observabilidade, backup testado;
- design system — três apps precisam de base comum;
- LGPD operacional — exportação, anonimização e retenção como código, não como texto.

O número corrigido é ~78. Ele é registrado aqui para não se perder, mas leia a
seção [Escopo recomendado](#escopo-recomendado) antes de tratá-lo como plano.

---

## Lacunas com dependência declarada

Quando um bloco fecha deixando algo de fora, o motivo entra aqui — com **o que
já existe**, **o que falta** e **em qual bloco entra**. Sem isso, "lacuna
conhecida" vira lugar onde trabalho adiado desaparece.

A regra que separa as duas colunas: mecanismo (schema, motor, API, tela do
cliente) fecha no bloco em que a necessidade aparece; **tela de administração
para cadastrar o dado** espera o bloco do admin. O contrário — mecanismo adiado
porque a tela ainda não existe — é o que produz motor que finge aceitar
`blocks` e nunca recebe nenhum.

| Lacuna | Pronto | Falta | Bloco |
|---|---|---|---|
| Arrastar o cartão na agenda para remarcar | mover está entregue e é o caminho principal: formulário com dia, hora e profissional, no cartão de cada compromisso, passando pelo mesmo motor e recusando choque | o arraste em si | sem bloco: **a WCAG 2.5.7 exige alternativa de um ponteiro para qualquer arraste**, então mover teria que existir de qualquer jeito — arrastar é acabamento sobre ele, não a funcionalidade. E seria o **primeiro componente de cliente do produto**, que hoje é 100% renderizado no servidor: essa decisão merece bloco próprio e medição de pacote, não entrar de carona. Entra quando houver uma segunda razão para mandar JavaScript ao navegador do admin |
| Painel como aplicação separada | rota `/admin` própria; o pacote da página pública continua em 102 kB depois de quatro telas novas de cadastro | extrair `apps/admin` quando o painel tiver dependência que a página pública não usa | sem bloco: o 13 era o candidato e passou sem criar essa dependência — o painel inteiro é renderizado no servidor e não manda JavaScript próprio. Extrair agora seria custo de build sem ganho medido. Entra quando o número subir |
| Enviar a foto em vez de colar o endereço | as colunas de foto são preenchidas por tela própria (`/admin/fotos`), validadas (`https` só) e exibidas na página pública | envio de arquivo, com recorte, redimensionamento e servido do nosso domínio | sem bloco definido: a dependência real é **armazenamento de objeto**, que o projeto ainda não tem — e o 13 passou sem criá-lo, porque infraestrutura de arquivo não é CRUD. Colar o endereço é v1 reversível — a barbearia já publicou as fotos em algum lugar, e esperar por infraestrutura deixaria a página como cardápio de texto por mais oito blocos. Foto **de cliente** é outra coisa, exige consentimento específico e fica no 74 |
| Taxa de cartão rateada com o profissional | a comissão calcula sobre líquido ou bruto, e o desconto tem tratamento configurável — as duas escolhas que a SPEC §3.4 exige que sejam explícitas | a terceira: a taxa do adquirente absorvida pela casa **ou** rateada. Hoje ela é sempre absorvida, por omissão | 36 (cartão e link de pagamento): a alíquota do adquirente não existe em lugar nenhum do produto. Oferecer "rateada" agora daria zero em toda comanda — campo que o motor aceita e ninguém preenche |
| Comissão sobre assinatura | comissão por profissional, serviço e categoria, nas três modalidades | os três modelos que a SPEC §3.4 descreve para assinante, e a simulação que compara os três | 48 (rentabilidade da assinatura): não há assinatura no produto até o bloco 45. Antes disso seria regra sem fato a que se aplicar |
| Ranking entre barbeiros (gamificação) | cada barbeiro vê os próprios números, a meta do mês com ritmo, o `rebooking rate` e a comissão do período — tudo comparado com o **próprio** passado | os rankings de faturamento, vendas, avaliações e retenção da SPEC §4.21, com o interruptor por barbearia e a escolha de quais são visíveis para a equipe | sem bloco: a própria SPEC manda vir **desligado por padrão** e explica por quê — ranking público produz disputa por cliente bom, empurra produto e faz recusar atendimento rápido. Entregar o motor de ranking antes de existir demanda real seria construir o que a SPEC pede para manter desligado. Entra quando uma barbearia pedir, junto do interruptor |
| Painel do dia que se atualiza sozinho | recarga manual e recarga a cada ação; a tela sempre reflete o banco no instante em que foi montada | atualização sem toque, para o balcão que fica aberto | sem bloco (movida do 20): o 20 entregou processo fora de requisição — que é trabalho de fundo, não canal do servidor para o navegador. Empurrar mudança para uma aba aberta exige SSE ou WebSocket, e portanto o **primeiro componente de cliente do produto**, hoje 100% renderizado no servidor. É a mesma decisão que segura o arraste na agenda, e as duas devem entrar juntas, com medição de pacote. A alternativa sem JavaScript é `meta refresh`, que é pesquisa em laço com o custo da página inteira e apaga o que a recepção estiver digitando — pior que recarregar quando ela quiser |
| Encerrar sessão nos outros aparelhos | revogação e "Sair" deste aparelho, para cliente e para gestor | listagem de sessões ativas | sem bloco: o cliente de barbearia usa um celular só. Entra se aparecer demanda real, não por simetria |
| Heatmap de ocupação | ocupação do dia em minutos vendidos sobre minutos de jornada, comparada com o mesmo dia da semana anterior | a grade horário × dia da SPEC §5.9 | 57 (campanhas): a própria SPEC diz que o heatmap **não é relatório, é ponto de partida de ação** — a célula fria vira campanha direcionada. Entregar a grade antes de existir campanha faria dela mais um quadro bonito de onde não sai nada, que é exatamente o que a SPEC recusa |
| Dashboard de crescimento (retenção, churn, LTV, receita por cadeira e por hora) | o painel do dia com as seis métricas da SPEC §5.9 que se respondem com o movimento de hoje, todas comparadas | as métricas que só existem sobre série longa | 62 (churn score com explicação): o cabeçalho do R4 é explícito — "depende de histórico acumulado, não antecipar". Retenção calculada sobre duas semanas de uso é número que engana quem decide contratação. "Assinaturas ativas", que aparece no mesmo quadro da SPEC, espera o bloco 45 pelo motivo mais simples: não existe assinatura no produto |
| Varredura diária do validador de catálogo | a conferência roda sob demanda, a cada carga do painel e da tela de diagnóstico, sempre sobre o cadastro do instante | a varredura em segundo plano que a SPEC §5.7 também pede | sem bloco: sob demanda é **mais fresco** que diário, então a varredura não melhora o que a tela mostra. O que ela acrescentaria é alertar quem não abriu o painel — e isso é canal de aviso **para o dono**, que o produto não tem (o bloco 20 entregou aviso para o cliente). Entra junto com o primeiro aviso dirigido ao gestor, não antes |
| Gráfico de série no painel | o anel de ocupação e a barra da meta, os dois sobre fração de um todo conhecido; e toda métrica com comparação contra o mesmo dia da semana anterior | a linha de faturamento por dia e o mapa de calor de horário, que o mock interno desenha | 62 (churn score com explicação): a API devolve **dois pontos** — hoje e o mesmo dia da semana passada. Desenhar uma linha com dois pontos é inventar tendência onde há uma comparação, e é o oposto do que o painel promete. Entra junto com a série histórica que o R4 exige |
| Importar agendamentos futuros e histórico | a base de clientes entra inteira, com deduplicação por telefone, preview, reversão e idempotência | as duas outras linhas do escopo mínimo da SPEC §5.8: a agenda futura e o histórico de atendimento | sem bloco definido: as duas dependem de **casar nome de profissional e de serviço** entre dois cadastros que não se conhecem, e de decidir o que fazer quando o horário importado bate com um existente — a constraint de exclusão recusa, e recusar em silêncio perderia o agendamento que a SPEC diz que não pode se perder. É outro importador, com outras telas de conferência. Enquanto isso vale a mitigação que a própria SPEC §5.8 prescreve: **operação paralela por uma ou duas semanas**, com a agenda velha em leitura — são umas trinta marcações a redigitar, não mil e duzentas |
| Importar fiado em aberto | o fiado existe no produto desde o bloco 18, com razão append-only, limite por cliente e trilha | trazer o saldo em aberto do sistema antigo | 51 (financeiro: contas a pagar/receber): saldo é dinheiro, e escrever em `customer_ledger` exige permissão do grupo de dinheiro e segundo fator. Pendurar isso na rota de importação faria `customers.edit` mover saldo — a permissão declarada deixaria de descrever a rota, que é o defeito que a `/security-review` cobrou no bloco 21. Saldo de pacote e assinatura, que a SPEC cita junto, esperam existir (blocos 42 e 45) |
| Resolver o conflito de telefone pela tela | o conflito é detectado, mostrado com o número da linha e os dois nomes, e a linha fica de fora em vez de escolher sozinha | escolher na tela qual nome fica, sem editar o arquivo | sem bloco: resolver linha a linha exige estado por linha no navegador, e portanto o **primeiro componente de cliente do produto** — a mesma decisão que segura o arraste na agenda e a atualização automática do balcão, e as três devem entrar juntas com medição de pacote. O caminho de hoje não é becos sem saída: corrigir no arquivo e reenviar cria uma importação nova, porque a idempotência é pelo conteúdo |
| Conversão da página e proporção de erro como alerta | duas das quatro regras da SPEC §5.12 entregues **com coletor**: queda de volume por barbearia e fila de trabalho travada, com teste puro da decisão e teste de integração da coleta | as outras duas: conversão da página pública e proporção de erro na gravação | sem bloco definido: as regras seriam triviais de escrever e **não têm origem de dado**. Conversão exige contar visita — que é rastreamento de visitante anônimo, com implicação de LGPD que merece decisão própria, não carona. Proporção de erro exige ler o log agregado de volta para dentro do produto, e não há agregador. Escrevê-las agora deixaria duas funções que ninguém chama, que é o defeito de `blocks` — aceito por oito blocos e sempre vazio |
| Canal por onde o alerta sai | as regras decidem, o coletor alimenta, `alertasDaBarbearia` devolve a lista pronta, e desde o bloco 28 existe `GestorProvider` — o primeiro canal do produto dirigido ao dono, com janela de silêncio pelo fuso da unidade | ligar o **alerta operacional** nesse canal: hoje só a cobrança o usa | 33 (segurança: hardening, auditoria de acesso): o que faltava era o canal, e ele chegou. O que sobra é decisão de produto — o que merece interromper o dono, e com que frequência —, e ela cabe junto da tela de preferências de notificação do gestor, que é do mesmo bloco |
| Deploy contínuo e ambiente de staging | a esteira roda o portão inteiro, a medição de navegador e a carga a cada push; as sondas de vivo e pronto existem; o ensaio de restauração confere dado, RLS, trigger e versão do schema | o CD: um ambiente para onde publicar, e a publicação automática | sem bloco definido: **não há infraestrutura contratada**. Escrever um passo de deploy apontando para lugar nenhum seria configuração que ninguém executa. O que dependia de código está pronto — a sonda de pronto é o que a publicação vai consultar |
| Tracing distribuído | log estruturado por requisição, com `x-request-id` aceito do proxy, devolvido na resposta e presente em toda linha — que é correlação ponta a ponta dentro do processo | spans com duração por camada, e propagação para fora | sem bloco definido: o produto é um monólito modular com um processo e um banco. Span entre camadas do mesmo processo responde o que o perfil de CPU responde melhor, e foi o perfil que achou o gargalo de fuso deste bloco. Entra quando houver um segundo serviço em jogo |
| Fatura em PDF e nota fiscal | a fatura tem período, plano, valor, vencimento e situação, e o dono a lê na tela | o documento para baixar e a nota fiscal do serviço | sem bloco definido: nota fiscal da **plataforma** é emissão sobre a própria empresa, não sobre a barbearia — outro regime, outro provedor, e nada a ver com o `FiscalProvider` que o bloco 40 traz para a comanda. Entra quando houver contabilidade de verdade por trás |
| Adquirente de verdade | a integração inteira existe: `PspProvider` com cobrança, consulta e estorno; webhook assinado com janela e comparação em tempo constante; conciliação por polling; e `psp_events` como trilha do que o provedor disse | contratar um adquirente e implementar a interface contra ele — hoje o único provedor é o `FakePspProvider`, e o worker só o liga com `PSP_MODO=fake` | sem bloco definido: **não há conta contratada**, e essa é uma decisão comercial, não de código. O que dependia de código está pronto, e é a mesma situação do deploy contínuo — ambiente e contrato são o que falta, não implementação |
| Entrega concorrente do mesmo webhook | a chave primária de `psp_events` trava a entrega repetida, e a máquina de estados da fatura carrega o caso sequencial (provado quebrando a chave de propósito: os testes de reentrega continuaram verdes sem ela) | um teste que exercite duas entregas **ao mesmo tempo** | sem bloco definido: o pool serializa as duas transações neste ambiente e o caso não se reproduz. Provar exigiria segurar uma transação por fora — o que testaria o arranjo do teste, não o produto. Fica escrito porque a garantia é real e não é provada |
| Split de pagamento e a comissão da plataforma | o adquirente entra pela mensalidade: a plataforma cobra a barbearia | a outra receita da SPEC §9.1 — percentual sobre a transação que a **barbearia** processa dos clientes dela | sem bloco definido: split exige que o pagamento do cliente final passe pelo nosso adquirente, e hoje ele é registrado na comanda depois de acontecer na maquininha da barbearia. É outro produto dentro do produto, com cadastro de recebedor, repasse e regime fiscal próprios |
| Papel novo criado pelo dono | os quatro papéis têm o conjunto de permissões editável pela tela, por barbearia, com trilha de antes e depois | criar um **quinto** papel — "caixa", "gerente de unidade" — em vez de só reconfigurar os quatro | sem bloco definido: `staff_role` é um enum do Postgres, e papel criado por barbearia teria que virar tabela com chave própria, migrando `staff_users.role`, `role_permissions.role` e a semente. É trabalho real e o ganho é pequeno enquanto os quatro cobrem o que a SPEC §1.3 descreve — quatro conjuntos editáveis já respondem "a recepção pode dar desconto?" |
| Teto de desconto por pessoa | o teto é por barbearia, em pontos-base, e vale para todo mundo que tem `finance.discount` | um teto diferente por papel — a recepção até 10%, o gerente até 30% | sem bloco definido: exigiria o teto migrar de `tenants` para `role_permissions`, que hoje é um par (papel, permissão) sem valor associado. Vale quando alguém pedir; hoje a separação que importa — quem pode e quem não pode — já existe |
| Papéis dentro da plataforma | uma conta de plataforma, com todas as capacidades | separar quem só consulta de quem bloqueia conta | 33 (segurança: hardening, auditoria de acesso): hoje há uma conta e ela é criada por quem tem acesso ao banco de produção. Inventar papéis antes de existir a segunda pessoa criaria permissão que nenhuma conta distingue — o mesmo erro que os blocos 18 e 21 declararam em vez de cometer |
| Série histórica e gráfico nas métricas da plataforma | MRR, churn, adoção, ocupação e falta apurados dia a dia por barbearia, com janela de 7, 30 ou 90 dias | a linha do tempo: MRR mês a mês, safra de entrada, curva de retenção | 62 (churn score com explicação): a série **existe** no banco desde este bloco — o que falta é histórico acumulado nela. Desenhar tendência sobre o primeiro mês de dados é inventar inclinação, e é a mesma decisão que já segura o gráfico no painel do dono |
| CAC e payback | GMV, MRR e churn saem de dado que o produto tem | as duas métricas da SPEC §8 que dependem de **custo de aquisição** | sem bloco definido: não existe origem de dado. Quanto se gastou para trazer uma barbearia mora em ferramenta de marketing, não aqui, e inventar um campo "custo" que ninguém preenche é o defeito de `blocks` outra vez |
| Assinaturas ativas e MRR de assinatura do tenant | o MRR **da plataforma** — o que as barbearias pagam a nós | o outro MRR da SPEC §8: o que os clientes pagam às barbearias | 45 (clube de assinatura): não há assinatura no produto até lá. É a mesma espera da comissão sobre assinatura |
| O dono encerrar sozinho o suporte na conta dele | a plataforma abre, lista e **encerra** o suporte por rota própria (`DELETE`), que derruba todas as sessões abertas na conta; o dono vê na trilha dele quem entrou, o que abriu e quando saiu | o botão **do lado do dono**, para ele expulsar o suporte sem pedir | 33 (segurança: hardening, auditoria de acesso): é a mesma tela de "sessões ativas" que falta para o gestor e para o Super Admin, e ela vale mais entregue de uma vez do que três vezes pela metade. Enquanto isso, o prazo de trinta minutos é o teto, e a trilha é imediata |
| Tabela de versão do schema | o ensaio de restauração confere que o banco restaurado tem as colunas da última migração | uma tabela que registre qual migração foi aplicada e quando | sem bloco definido: as migrações são aplicadas em ordem por script, e o marcador de coluna responde a pergunta que importa hoje ("este dump é velho?"). Uma tabela de versões vale a partir do primeiro deploy de verdade, junto do CD |

A leitura agrupada — o que é dívida, o que espera infraestrutura, o que é ordem
deliberada e o que é só tela — está em
[`SPEC.md` §7.1](SPEC.md#71-distância-entre-esta-spec-e-o-que-está-construído).
Esta tabela continua sendo a fonte do detalhe; a SPEC agrupa pelo motivo.

**Lacuna fechada sai da tabela.** O histórico de por que foi adiada fica no
commit que a fechou; manter linha morta aqui faria a lista virar ruído e
esconder o que ainda falta.

---

## R1 — MVP (23 blocos)

**Critério de aceite:** uma barbearia de duas cadeiras consegue largar o sistema
atual sem perder nenhuma capacidade que usava.

| # | Bloco | Estado |
|---|---|---|
| 1 | Motor de disponibilidade + schema Scheduling | ✅ |
| 2 | Repositórios: resolver `ProfessionalDay`, catálogo, habilidades | ✅ |
| 3 | API + middleware de tenant/RLS + `GET /availability` | ✅ |
| 4 | Domínio de reserva: criar, hold, idempotência, reagendamento atômico | ✅ |
| 5 | Auth do cliente (OTP WhatsApp) + endpoints de reserva | ✅ |
| 6 | Design system: tokens, componentes base, tema, acessibilidade | ✅ |
| 7 | Página pública SSR: layout, mapa, horário, JSON-LD, deep links | ✅ |
| 8 | Fluxo de agendamento no front: serviço → profissional → horário → dados → comprovante | ✅ |
| 9 | Meus agendamentos: entrar por código, listar, cancelar, remarcar | ✅ |
| 10 | Conta de gestor + onboarding em 6 etapas + configuração da unidade | ✅ |
| 11 | Balcão: painel do dia, check-in, no-show, busca e marcação pelo balcão | ✅ |
| 12 | RBAC mínimo: papéis, permissões e contas de equipe | ✅ |
| 13 | Admin: CRUD de catálogo, equipe, jornadas, recursos | ✅ |
| 14 | Balcão: fila de walk-in, encaixe com custo visível, posição pelo celular | ✅ |
| 15 | Agenda: dia/semana/lista, arrastar, bloqueio pontual | ✅ |
| 16 | `app-pro`: agenda do barbeiro, próximo cliente, preferências | ✅ |
| 17 | `app-pro`: check-in, iniciar/finalizar, comissão, metas | ✅ |
| 18 | Comanda + checkout + caixa + **fiado** | ✅ |
| 19 | Comissão básica + fechamento | ✅ |
| 20 | Notificações: confirmação, lembrete 24h/2h, retorno (fila + worker) | ✅ |
| 21 | Dashboard básico + validador de catálogo | ✅ |
| 22 | Importador de base + deduplicação por telefone | ✅ |
| 23 | CI/CD, staging, observabilidade, e2e, carga em `/availability` | ✅ |

---

## O balcão é a terceira superfície

Três pessoas usam este produto, e só duas tinham tela no plano original.

| Quem | Aparelho | Frequência | Densidade |
|---|---|---|---|
| Cliente | celular, em pé na rua | uma vez por mês | respira |
| Gestor | celular ou notebook | uma vez por semana | média |
| **Balcão** | **notebook ligado o dia inteiro** | **o tempo todo** | **densa** |

O balcão é quem digita o telefone de quem chegou sem marcar, marca presença,
descobre que o cliente das 14h não veio e decide se encaixa o que está esperando
em pé na frente dele. A SPEC descreve o papel (Parte 1 §1.2), a fila presencial
(Parte 2 §2.10 — "**é outro objeto e outra tela**") e o check-in (§2.11). O que
faltava era o roadmap tratar isso como **uma superfície**, e não como funções
espalhadas.

O erro concreto que estava no plano:

- **Check-in só existia dentro do `app-pro`**, o aplicativo do barbeiro. Mas o
  primeiro canal de check-in que a SPEC lista é "recepção" — quem marca presença
  na prática é quem está no balcão, não o barbeiro com a máquina na mão.
- **A fila de walk-in estava no bloco 37**, depois do MVP inteiro. Numa barbearia
  de bairro, quem entra sem marcar é uma fatia grande do faturamento; sem a fila,
  o sistema não cobre o dia real e a recepção volta para o caderno.
- **Não havia RBAC.** Hoje toda conta de gestor tem poder de dono. Criar a conta
  da recepcionista antes de existir permissão entregaria faturamento e base de
  clientes a quem só precisa marcar presença — e `customers.export` é o vetor
  clássico de roubo de base quando alguém sai.

Daí a ordem: o painel do dia (11) vem primeiro porque é o buraco mais agudo —
hoje o dono abre a página do cliente para adivinhar o que está marcado. O RBAC
(12) vem logo atrás e **antes de qualquer conta que não seja do dono**: enquanto
só existe dono não há permissão a separar, mas a primeira recepcionista criada
sem ele já é um incidente. O CRUD (13) espera porque mudar preço é dor semanal;
não enxergar a agenda é dor de todo minuto do expediente.

### O que muda no desenho

É a primeira tela cujo aparelho principal é um **notebook**, aberta o dia
inteiro, usada por alguém que não lê — olha de relance entre um cliente e outro.

Isso muda a **densidade**, não a regra. O balcão é a mesma tela nos dois
aparelhos: nasce no piso de 360px, ganha colunas e atalhos de teclado quando há
espaço. Nada de "versão de celular" reduzida — a recepção atende pelo telefone
sempre que o notebook está ocupado com outra coisa, e é justamente aí, com
cliente esperando em pé na frente dela, que a tela não pode faltar.

Vale para todo o produto e está no CLAUDE.md §5: alvo de toque de 44px em
qualquer largura, `min-width` sempre, e conferência medida em 360 · 390 · 768 ·
1280 por `scripts/medir-responsividade.js` — não no olho.

---

## Plataforma (10 blocos)

Transversal. Nada aqui aparece para o cliente final, e sem nada aqui o produto
não é vendável.

| # | Bloco | Estado |
|---|---|---|
| 24 | Super Admin: tenants, planos, bloqueio de conta | ✅ |
| 25 | Super Admin: métricas globais, MRR, churn | ✅ |
| 26 | Super Admin: feature flags, impersonação auditada | ✅ |
| 27 | Billing: planos, trial, assinatura da barbearia | ✅ |
| 28 | Billing: upgrade/downgrade, inadimplência, régua de retentativa | ✅ |
| 29 | Billing: integração com PSP, conciliação | ✅ |
| 30 | RBAC: telas de gestão de papéis e permissões editáveis pelo dono | ✅ |
| 31 | LGPD: consentimentos, exportação de dados | |
| 32 | LGPD: anonimização, retenção, pipeline de exclusão | |
| 33 | Segurança: hardening, rate limit global, auditoria de acesso | |

---

## R2 — dinheiro e ocupação (10 blocos)

| # | Bloco |
|---|---|
| 34 | `PaymentProvider`: abstração, fake, testes |
| 35 | Pix: QR Code, webhook, conciliação |
| 36 | Cartão e link de pagamento |
| 37 | Sinal seletivo + política de reembolso |
| 38 | Lista de espera: entradas, expiração, gatilho de cancelamento |
| 39 | Lista de espera: priority queue, janela exclusiva, notificação |
| 41 | Fidelidade: pontos, visitas ou cashback |
| 42 | Pacotes: venda, consumo, validade, receita diferida |
| 43 | Avaliações + fluxo de recuperação de nota baixa |
| 44 | Produtos, estoque, ficha de consumo, CMV |

---

## R3 — recorrência e escala (15 blocos)

| # | Bloco |
|---|---|
| 45 | Planos de assinatura: modelagem, regras, cooldown |
| 46 | Assinatura: restrição de horário, dependentes, prioridade na fila |
| 47 | Cobrança recorrente: régua, suspensão gradual, cancelamento self-service |
| 48 | Rentabilidade da assinatura (simulação dos três modelos de comissão) |
| 49 | Split: modelagem derivada da comissão |
| 50 | Split: KYC do profissional, liquidação, estorno |
| 51 | Financeiro: contas a pagar/receber, transferências, conciliação |
| 52 | Financeiro: vale, DRE gerencial |
| 53 | `FiscalProvider`: abstração e integração |
| 54 | Fiscal: NFS-e, cancelamento, Salão-Parceiro |
| 55 | WhatsApp oficial: templates, webhooks, botões |
| 56 | Marketing automation: motor de eventos, teto de mensagens, janela de silêncio |
| 57 | Campanhas: filtros, canais, receita atribuída |
| 58 | Multiunidade: seleção, consolidação, transferência de estoque |
| 59 | Multiunidade: cliente e fidelidade compartilhados |

---

## R4 — inteligência (10 blocos)

Depende de histórico acumulado. Não antecipar.

| # | Bloco |
|---|---|
| 60 | Reliability score + sinal condicional |
| 61 | Ciclo individual de retorno + segmentação automática |
| 62 | Churn score com explicação |
| 63 | Schema semântico de métricas (base do assistente) |
| 64 | Assistente do gestor: text-to-query |
| 65 | Agente de agendamento: intent, slots, confirmação |
| 66 | Agente: remarcação e recepção digital |
| 67 | Insights proativos |
| 68 | Smart pricing com aprovação humana |
| 69 | Previsão de consumo e sugestão de compra |

---

## R5 — rede (10 blocos)

Só faz sentido com centenas de barbearias na base.

| # | Bloco |
|---|---|
| 70 | Marketplace: busca geográfica e filtros |
| 71 | Marketplace: "próximo horário" em lote (exige `/availability` rápido) |
| 72 | Marketplace: atribuição de cliente novo e comissão |
| 73 | Perfil público do barbeiro |
| 74 | Portfólio e consentimento de uso público |
| 75 | Anúncios e destaque |
| 76 | Franquias: catálogo padrão, preços sugeridos |
| 77 | Franquias: indicadores consolidados, metas |
| 78 | API pública: chaves, escopos, rate limit |
| 79 | Webhooks assinados para terceiros |

---

## Correção de escopo: fiado subiu para o MVP

O roadmap punha fiado no bloco 52 e a SPEC §3.10 diz, com todas as letras:

> **Obrigatório no MVP** — sua ausência é motivo de não-migração.

Os dois não podiam estar certos, e quem decide é o critério de aceite do próprio
MVP: *uma barbearia de duas cadeiras substitui o incumbente sem perder nenhuma
capacidade que usava*. A engenharia reversa do concorrente encontrou
`get_controle_fiados` e `registra_pagamento_divida` — é recurso em uso, não
enfeite de catálogo. Barbearia de bairro fia, e sistema que não fia é sistema
que não entra.

Fiado passou para o **bloco 18**, junto com o caixa, porque é onde ele de fato
vive: pagar fiado é forma de pagamento no fechamento da comanda, e receber o
fiado é movimento de caixa. Separar em outro bloco criaria uma forma de
pagamento que a tela de pagamento não conhece.

**`vale` e DRE gerencial ficaram no 52.** A SPEC os descreve como presentes no
incumbente, mas não os marca como obrigatórios para migrar — vale é
adiantamento descontado da comissão, e comissão é o bloco 19.

---

## Escopo recomendado

78 blocos é produto de time, horizonte de mais de um ano. Duas decisões cortam
isso pela metade sem prejudicar o que é vendável:

### 1. Adiar R4 e R5 por dependência, não por preguiça
São 20 blocos que **não funcionam** no começo: score e IA precisam de histórico
que ainda não existe, marketplace precisa de densidade de barbearias que ainda
não existe. Construí-los cedo produz funcionalidade morta.

### 2. Comprar a Plataforma em vez de construir
Billing e Super Admin (blocos 24–29) são os menos diferenciados do produto
inteiro. Nenhuma barbearia escolhe o sistema pelo painel interno do fornecedor.
Uma solução de billing pronta cobre a maior parte, e sobra o essencial: feature
flags, impersonação auditada e LGPD.

### Resultado

```
R1 MVP              23 blocos   (20 + balcão e RBAC)
Plataforma enxuta    5 blocos   (de 10)
R2                  10 blocos   (a fila de walk-in subiu para o MVP)
─────────────────────────────
                    38 blocos  → produto que uma barbearia paga e usa
```

Os três blocos que entraram no MVP não são escopo novo: dois já estavam na SPEC
(recepcionista e fila presencial), fora de ordem. O terceiro divide o RBAC em
dois — **aplicar** permissão vem antes da primeira conta que não é do dono
(bloco 12); **gerenciar** papéis pela tela continua na Plataforma (bloco 30),
porque até lá os quatro papéis fixos da SPEC bastam.

O resto vira roadmap de verdade — replanejado com cliente real usando o sistema,
não estimado no vazio.

---

## Riscos que podem alterar a contagem

| Risco | Impacto |
|---|---|
| **Fiscal** (blocos 50–51) | ~5.500 municípios com regras próprias. Pode ser 2 ou 6 blocos, dependendo do provedor escolhido. Não estimável antes da decisão. |
| **WhatsApp oficial** | Depende de número verificado e aprovação de templates. Bloqueio de fornecedor, não de código. |
| **Split** | Exige KYC de cada profissional no PSP. O onboarding assíncrono é mais trabalhoso que a divisão em si. |
| **Importadores** | O bloco 19 cobre CSV e um sistema. Cada origem adicional (AppBarber, Trinks, Belle) é trabalho novo. |
| **Reordenação** | Quando o MVP estiver numa barbearia real, o que ela pedir vai reordenar R2 em diante — e deve mesmo. |
