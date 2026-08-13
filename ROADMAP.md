# Roadmap de execução

Companheiro do [`SPEC.md`](SPEC.md). A SPEC diz **o que** o produto é; este
documento diz **em quantas partes** ele é construído e em que ordem.

**Status: 72 de 80 blocos.**

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

## Correção de fluxo (entre o 36 e o 37)

Não é bloco: é conserto do que o portão inteiro deixou passar, e a razão de o
`CLAUDE.md` ter ganhado a [§6](CLAUDE.md#6-regra-de-negócio-e-coerência-do-fluxo).
Dez defeitos, todos com teste verde antes e todos invisíveis a qualquer teste
de tela — porque cada tela, sozinha, era coerente:

| O que estava errado | O conserto |
|---|---|
| Duas barras escritas à mão (`BalcaoNav`, `CadastroNav`) discordavam do registro: a primeira misturava dois módulos, **não** tinha Comanda, e não existia em Dia, Agenda e Fila — as três telas que ela oferecia | as duas foram **apagadas**. O contexto do casco já lista as telas do módulo aberto, derivadas de `MODULOS`, em qualquer largura. As barras eram o mesmo link duas vezes no DOM |
| `lgpd` e `plano` nunca acendiam no trilho — e o teste passava, porque ele também tinha lista escrita à mão | as regras entraram, e a guarda passou a derivar de `MODULOS` |
| A mesma transição tinha três nomes: **Iniciar · Começar · Sentou**, em três telas do mesmo produto | vocabulário único em `packages/core/src/vocabulario.ts`, com teste que reprova tela definindo o próprio dicionário |
| A fila nunca fechava ninguém: nada escrevia `done`, e por isso a **espera média era sempre `—`** | encerrar o atendimento fecha a entrada, na mesma transação |
| Ninguém via quem estava na cadeira nem há quanto tempo — `appointments.started_at` existia desde a migração 0014, com o comentário "base da duração real", e era descartado antes de chegar à tela | faixa "Nas cadeiras agora" no topo do dia, com o tempo decorrido. **O número não anda**: é o instantâneo da carga, e a tela diz isso |
| Abrir a comanda do mesmo atendimento duas vezes esbarrava em `orders_uma_aberta_por_agendamento` e virava **500**: a tela dizia "tente de novo" e tentar de novo dava o mesmo erro para sempre. A comanda existia e não havia caminho até ela | `abrirComanda` devolve a que já está aberta. O índice dizia desde o bloco 18 que é uma só; faltava a outra metade da regra. A corrida também: a violação de unicidade vira leitura numa transação nova |
| Encerrado o corte, o cartão do dia ficava **sem saída** — receber exigia ir a Dinheiro → Cobrar e procurar a mesma pessoa numa segunda lista, montada pela **mesma** consulta e pelos **mesmos** dois estados | "Cobrar" no cartão, escondido de quem não tem `cashier.open`. E a definição de "cobrável" saiu das duas telas para `ESTADOS_COBRAVEIS`, em `core`: escrita nas duas, bastava mexer numa para elas discordarem sem nada ficar vermelho |
| A agenda mostrava estado de operação ("Na cadeira", "Atendido") e não oferecia nada além de "Mover" | link "Ver no dia" no cartão. Link, e não os botões de atendimento: a máquina de estados fica em uma tela só — duplicá-la é como as transições ganharam três nomes |
| A página pública desenha um botão de ligar desde o bloco 4, e o número era **sempre nulo**: `locations.phone_e164` existia, a API aceitava `phone`/`whatsapp` e nenhuma tela os preenchia. Achado ao escrever `scripts/rodar-local.sh` — o semeador foi o primeiro cliente a mandar o campo | os dois campos entraram na etapa 2 do onboarding. E o valor passa a ser normalizado **na borda**: `(71) 3333-4444` batia na `CHECK` de E.164 e virava **500 "Erro interno"** — entrada externa inválida é 400 com motivo. Fixo é aceito aqui e recusado no cadastro do cliente, porque o do cliente recebe o código de acesso |
| A tela de comissão dizia **"Comissão"** para os dois lados do mesmo dinheiro. O dono abre para saber quanto **paga**, o barbeiro para saber quanto **recebe**, e quem tem as duas contas não tinha como saber qual estava na tela | "Comissão da equipe" e "Minha comissão", com o subtítulo dizendo o que o número é. Os dados sempre estiveram certos — a API já recorta pelo `commission.view_all` |

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
| A taxa que o adquirente cobrou **de fato** | a alíquota é cadastrada por meio de pagamento, congelada em cada venda (`orders.fee_cents`) e descontada da base quando o rateio está ligado — a terceira escolha da SPEC §3.4, entregue no bloco 36 | usar o valor **real** do extrato no lugar do calculado. Quem sabe o número exato é o adquirente, que o informa na transação de saldo | sem bloco definido: depende de conta contratada, como a própria integração. **Não há coluna esperando por ele** — criá-la agora seria campo que ninguém preenche, e a revisão deste bloco cobrou exatamente isso. O calculado erra por centavos e na direção conhecida (a alíquota é a contratada), o que basta para a comissão; o valor real importa para conciliação bancária, que é outro assunto e não existe no produto |
| Cartão de garantia (cobrado só na falta) | o sinal antecipado inteiro: Pix, cartão e link pelo adquirente, com reembolso por política | a modalidade "cartão de garantia" da SPEC §2.12, em que o cartão fica registrado e só é cobrado se a pessoa faltar | sem bloco definido: exige tokenizar cartão e **capturar depois**, que é outro contrato com o adquirente — e a convenção deste código é que só existe token do provedor, marca e os quatro últimos, com invariante que reprova quem criar coluna para PAN. A modalidade entra quando houver conta contratada e captura postergada, junto da lacuna do contrato com a Stripe |
| Cobrar o sinal pelo produto, e devolvê-lo sozinho | a decisão inteira: quem paga sinal, quanto, por quê, e se o dinheiro volta num cancelamento — com a política por unidade, o serviço que sempre exige, o ajuste do gerente e o registro do recebido pelo balcão, auditado | a **cobrança pelo adquirente**: QR Code na tela de agendamento, webhook confirmando e devolução automática. Hoje o sinal é o Pix que o cliente manda para o número da barbearia e alguém confere — que é como a esmagadora maioria das barbearias do país cobra, mas deixa a recepção digitando "recebi" | sem bloco definido, junto da lacuna do contrato com a Stripe: é o mecanismo dos blocos 35 e 36 aplicado ao **agendamento** em vez da comanda, e a diferença não é pequena — a cobrança nasce dias antes de existir comanda, sem caixa aberto, e a devolução é estorno de uma cobrança que pode ter sido paga num ciclo de faturamento anterior. O registro manual não é becos sem saída: ele preenche `deposit_paid_cents` e é o que a política de reembolso lê |
| Contestar uma avaliação injusta | as três camadas que impedem apagar (sem permissão no catálogo, sem `DELETE` para a aplicação, gatilho que recusa reescrever nota e comentário), a publicação derivada do relógio e a média do gestor contando tudo — publicado ou não | a **contestação**: motivo de lista fechada (spam, ofensa, profissional errado, nunca foi cliente, duplicada), o estado de suspensa que tira da vitrine sem tocar em nota nem texto, e a trilha de quem contestou o quê. Sem ela o dono não tem resposta nenhuma para a nota abusiva, e a única saída que ele enxerga é pedir para apagar | 80 (contestar uma avaliação), escopo novo declarado depois do 51 e escrito em [Adição de escopo](#adição-de-escopo-contestar-uma-avaliação-bloco-80). Não entra no 51 porque não é dinheiro: é moderação, e desenhá-la junto do financeiro seria decidir com pressa o único mecanismo do produto que decide o que o público vê |
| Falar com a Cloud API de verdade | o canal inteiro: cadastro do número por unidade com token cifrado em chave própria, templates com os cinco estados da Meta, envio por template aprovado, webhook assinado com HMAC do corpo cru, os quatro botões virando ação, entrega e leitura conciliadas, e a conversa entrando na exportação e na anonimização do titular | a **implementação do `WhatsAppProvider` contra a Meta**. Hoje o provedor é o de mentira, que responde `pendente` ao submeter template — o estado real de um recém-enviado — e devolve id de mensagem próprio | sem bloco definido: a dependência é **conta contratada e empresa verificada na Meta**, que não é código. É a mesma forma do emissor fiscal e do adquirente, e a razão de o contrato existir: quando a conta sair, entra uma classe que fala HTTP e nada mais muda — há teste que prova a cadeia inteira contra o fake |
| Campanha por e-mail, push e SMS | a campanha inteira: público congelado na criação, quatro filtros (incluindo a célula fria do heatmap), as mesmas proteções da automação, as seis colunas da SPEC §4.13 e a **receita atribuída** congelada na janela | os **outros três canais**. Hoje tudo sai pelo caminho de mensagem do produto, que é o WhatsApp do bloco 55 | sem bloco definido: e-mail exige domínio verificado e reputação de remetente; push exige aplicativo instalado, que este produto não tem (é PWA); SMS tem custo por mensagem e chega sem formatação. A SPEC §4.13 lista os quatro e marca SMS como opcional — o que ela não diz é que os três valem menos que o primeiro numa base brasileira, e é por isso que o WhatsApp veio antes |
| Nota de produto (NF-e / NFC-e) | a NFS-e inteira: contrato do emissor, emissão que não bloqueia a venda, cancelamento com estado em voo, Salão-Parceiro, CPF do tomador e a nota chegando ao cliente. A base da nota é **só serviço**, por decisão escrita, e a tela diz por quê quando a comanda só tem produto | o **segundo documento**. Produto é NF-e ou NFC-e: outro modelo fiscal, outra numeração, outro credenciamento estadual — e a SPEC §3.11 diz "quando aplicável", não "junto". Somá-lo à NFS-e recolheria ISS sobre mercadoria, que é imposto errado sobre base errada | sem bloco definido: a dependência é a mesma da NFS-e — **conta contratada com o emissor** —, e é ela que decide se o mesmo contrato cobre os dois documentos ou se são duas integrações. Enquanto a barbearia média vende pomada como acessório do corte, a nota que o cliente pede é a do serviço; a de produto vira obrigatória quando a revenda deixa de ser acessório, e aí é o volume dela que paga a integração |
| Indicação com link e anti-fraude | nada — a SPEC §4.9 descreve `barber.app/ref/CARLOS92`, crédito para os dois lados e cinco regras anti-fraude | o mecanismo inteiro: link por cliente, vínculo do indicado, crédito só depois de atendimento concluído e pago, teto por período e bloqueio de autoindicação por telefone e por aparelho | sem bloco definido. Ele **depende** da fidelidade, que agora existe: o crédito da indicação é um lançamento em `loyalty_entries`, com o mesmo extrato e a mesma validade. Entra quando houver demanda — e o anti-fraude é o bloco inteiro, não um detalhe: sem ele a indicação é a porta mais barata para fabricar crédito |
| Passar um recado para outra pessoa da equipe | assumir para si e devolver à fila, os dois gestos que a tela do balcão oferece | "manda esse para o Ruan, é da cadeira dele". O domínio já aceita qualquer id da equipe em `assumirRecado`; o que não existe é a rota e o seletor — e a rota de assumir foi deliberadamente fechada para não aceitar responsável do corpo | sem bloco definido: é conveniência, não lacuna de regra. Entra quando uma barbearia com equipe grande pedir. Hoje, quem quer passar adiante devolve à fila e a outra pessoa assume |
| Tokenizar o cartão do assinante | a régua de cobrança inteira: fatura por ciclo com valor congelado, escada D+1/D+3/D+7, suspensão gradual avisada aos quinze dias, cancelamento self-service e a coluna `payment_token` com a rota que a preenche — mais o contrato `CobrancaDoClubeProvider`, que separa recusa definitiva de indisponibilidade | a **origem do token**: a tela em que o assinante digita o cartão e o adquirente devolve a referência. Sem ela nenhuma assinatura tem cartão salvo, e a régua pula a cobrança sem gastar degrau — o que quita a mensalidade é o balcão registrando o Pix que viu no extrato, que é como a esmagadora maioria das barbearias do país cobra hoje | sem bloco: a dependência não é de código, e três blocos seguidos a empurraram para frente sem que nada a destravasse. Faltam **duas coisas de fora**: uma conta de adquirente por barbearia — a mesma dependência comercial do split — e o primeiro componente de cliente do produto, com PCI a reboque, num app que hoje não tem nenhum. Nenhum bloco do roadmap entrega qualquer uma das duas, e apontar para o próximo a cada fechamento é adiamento com data falsa. Ela entra quando houver contrato assinado, e o mecanismo já está inteiro esperando: a régua de cobrança roda hoje sobre o provedor de mentira, que recusa por padrão justamente para que escada, inadimplência e suspensão sejam percorridas pelo caminho real |
| Ranking entre barbeiros (gamificação) | cada barbeiro vê os próprios números, a meta do mês com ritmo, o `rebooking rate` e a comissão do período — tudo comparado com o **próprio** passado | os rankings de faturamento, vendas, avaliações e retenção da SPEC §4.21, com o interruptor por barbearia e a escolha de quais são visíveis para a equipe | sem bloco: a própria SPEC manda vir **desligado por padrão** e explica por quê — ranking público produz disputa por cliente bom, empurra produto e faz recusar atendimento rápido. Entregar o motor de ranking antes de existir demanda real seria construir o que a SPEC pede para manter desligado. Entra quando uma barbearia pedir, junto do interruptor |
| Teste que usa a tela como o usuário usa | e2e da API cobrindo o caminho inteiro (`apps/api/test/caminho-inteiro.e2e.test.ts` e mais quinze arquivos), a medição de responsividade abrindo **toda** tela em quatro larguras num navegador de verdade, e a leitura de fluxo do §6 feita à mão a cada bloco | o teste que **clica**: navegar, preencher, submeter e conferir o efeito no banco. A medição abre as telas e mede o layout; ela não usa o produto. Um unitário passa com a funcionalidade quebrada, e três defeitos deste repositório — o botão que levava a lugar nenhum, o estado sem saída na interface, o indicador sempre `—` — só apareceram na leitura manual | sem bloco definido: a dependência é **infraestrutura de teste**, não produto. O Playwright já está montado para medir, então o custo não é o navegador — é a suíte de fixtures (sessão de gestor, sessão de cliente, banco semeado por caso) e o tempo dela dentro do portão, que hoje fecha em ~90s. Entra quando o custo do §6 manual passar do custo da suíte, e o sinal disso é um defeito de fluxo escapar da leitura |
| Tela do balcão que se atualiza sozinha | recarga manual e recarga a cada ação; a tela sempre reflete o banco no instante em que foi montada — vale para o painel do dia e, desde o bloco 35, para a comanda com Pix em curso | atualização sem toque: hoje, quem cobra por Pix recarrega a comanda para ver que o cliente pagou | sem bloco (movida do 20): o 20 entregou processo fora de requisição — que é trabalho de fundo, não canal do servidor para o navegador. Empurrar mudança para uma aba aberta exige SSE ou WebSocket, e portanto o **primeiro componente de cliente do produto**, hoje 100% renderizado no servidor. É a mesma decisão que segura o arraste na agenda, e as duas devem entrar juntas, com medição de pacote. A alternativa sem JavaScript é `meta refresh`, que é pesquisa em laço com o custo da página inteira e apaga o que a recepção estiver digitando — pior que recarregar quando ela quiser |
| Varredura diária do validador de catálogo | a conferência roda sob demanda, a cada carga do painel e da tela de diagnóstico, sempre sobre o cadastro do instante | a varredura em segundo plano que a SPEC §5.7 também pede | sem bloco: sob demanda é **mais fresco** que diário, então a varredura não melhora o que a tela mostra. O que ela acrescentaria é alertar quem não abriu o painel — e isso é canal de aviso **para o dono**, que o produto não tem (o bloco 20 entregou aviso para o cliente). Entra junto com o primeiro aviso dirigido ao gestor, não antes |
| Importar agendamentos futuros e histórico | a base de clientes entra inteira, com deduplicação por telefone, preview, reversão e idempotência | as duas outras linhas do escopo mínimo da SPEC §5.8: a agenda futura e o histórico de atendimento | sem bloco definido: as duas dependem de **casar nome de profissional e de serviço** entre dois cadastros que não se conhecem, e de decidir o que fazer quando o horário importado bate com um existente — a constraint de exclusão recusa, e recusar em silêncio perderia o agendamento que a SPEC diz que não pode se perder. É outro importador, com outras telas de conferência. Enquanto isso vale a mitigação que a própria SPEC §5.8 prescreve: **operação paralela por uma ou duas semanas**, com a agenda velha em leitura — são umas trinta marcações a redigitar, não mil e duzentas |
| Resolver o conflito de telefone pela tela | o conflito é detectado, mostrado com o número da linha e os dois nomes, e a linha fica de fora em vez de escolher sozinha | escolher na tela qual nome fica, sem editar o arquivo | sem bloco: resolver linha a linha exige estado por linha no navegador, e portanto o **primeiro componente de cliente do produto** — a mesma decisão que segura o arraste na agenda e a atualização automática do balcão, e as três devem entrar juntas com medição de pacote. O caminho de hoje não é becos sem saída: corrigir no arquivo e reenviar cria uma importação nova, porque a idempotência é pelo conteúdo |
| Conversão da página e proporção de erro como alerta | duas das quatro regras da SPEC §5.12 entregues **com coletor**: queda de volume por barbearia e fila de trabalho travada, com teste puro da decisão e teste de integração da coleta | as outras duas: conversão da página pública e proporção de erro na gravação | sem bloco definido: as regras seriam triviais de escrever e **não têm origem de dado**. Conversão exige contar visita — que é rastreamento de visitante anônimo, com implicação de LGPD que merece decisão própria, não carona. Proporção de erro exige ler o log agregado de volta para dentro do produto, e não há agregador. Escrevê-las agora deixaria duas funções que ninguém chama, que é o defeito de `blocks` — aceito por oito blocos e sempre vazio |
| Deploy contínuo e ambiente de staging | a esteira roda o portão inteiro, a medição de navegador e a carga a cada push; as sondas de vivo e pronto existem; o ensaio de restauração confere dado, RLS, trigger e versão do schema | o CD: um ambiente para onde publicar, e a publicação automática | sem bloco definido: **não há infraestrutura contratada**. Escrever um passo de deploy apontando para lugar nenhum seria configuração que ninguém executa. O que dependia de código está pronto — a sonda de pronto é o que a publicação vai consultar |
| Tracing distribuído | log estruturado por requisição, com `x-request-id` aceito do proxy, devolvido na resposta e presente em toda linha — que é correlação ponta a ponta dentro do processo | spans com duração por camada, e propagação para fora | sem bloco definido: o produto é um monólito modular com um processo e um banco. Span entre camadas do mesmo processo responde o que o perfil de CPU responde melhor, e foi o perfil que achou o gargalo de fuso deste bloco. Entra quando houver um segundo serviço em jogo |
| Fatura em PDF e nota fiscal | a fatura tem período, plano, valor, vencimento e situação, e o dono a lê na tela | o documento para baixar e a nota fiscal do serviço | sem bloco definido: nota fiscal da **plataforma** é emissão sobre a própria empresa, não sobre a barbearia — outro regime, outro provedor, e nada a ver com o `FiscalProvider` dos blocos 53 e 54, que emite sobre o serviço da barbearia. Entra quando houver contabilidade de verdade por trás |
| Contrato com a Stripe exercido de verdade | o código das duas pontas existe e é o mesmo cliente: `StripePspProvider` (a plataforma cobrando a barbearia) e `StripePaymentProvider` (a barbearia cobrando o cliente), com versão fixada, idempotência no cabeçalho, erro tipado e `PSP_MODO=stripe` ligando os dois processos de uma vez | uma chamada que a **Stripe** tenha de fato respondido. Os testes provam o que sai na requisição e como a resposta é lida, contra uma rede injetada — não que a conta aceita estas chamadas, que o Pix está habilitado nela, nem qual expiração ela permite para o QR Code | sem bloco definido: falta a **conta contratada**, que é decisão comercial e não código. Nenhum bloco pode entregá-la, e escrever um teste contra a rede real transformaria o portão numa dependência de terceiro no ar. O que dependia de código está pronto; o que resta é apontar `STRIPE_SECRET_KEY` para uma conta e rodar o caminho uma vez em `test mode` |
| Entrega concorrente do mesmo webhook | a chave primária de `psp_events` trava a entrega repetida, e a máquina de estados da fatura carrega o caso sequencial (provado quebrando a chave de propósito: os testes de reentrega continuaram verdes sem ela) | um teste que exercite duas entregas **ao mesmo tempo** | sem bloco definido: o pool serializa as duas transações neste ambiente e o caso não se reproduz. Provar exigiria segurar uma transação por fora — o que testaria o arranjo do teste, não o produto. Fica escrito porque a garantia é real e não é provada |
| Contrato de split exercido pelo adquirente | o mecanismo inteiro, dos dois blocos: `payment_splits` derivado da comissão, o cadastro do recebedor (KYC) com o dado bancário atravessando sem ser gravado, a régua de liquidação com estado próprio para a chamada em voo, chave de idempotência estável por fatia, e a política de estorno — cancelar o que não saiu, cobrar do profissional o que saiu. Tudo exercido pelo `FakeSplitProvider`, que deixa o cadastro pendente e recusa o repasse | uma chamada que um adquirente **de verdade** tenha respondido. Como na lacuna da Stripe, os testes provam o que sai na requisição e como a resposta é lida contra uma rede injetada — não que exista conta habilitada para split, nem qual é o fluxo de KYC dela | sem bloco definido, junto da lacuna do contrato com a Stripe: falta a **conta contratada com split habilitado**, que é decisão comercial e não código. Nenhum bloco pode entregá-la. O que dependia de código está pronto, e o produto funciona sem ela: a parte do barbeiro fica retida, o dinheiro cai na casa e a comissão sai no fechamento — que é como toda barbearia do país paga o barbeiro hoje |
| Papel novo criado pelo dono | os quatro papéis têm o conjunto de permissões editável pela tela, por barbearia, com trilha de antes e depois | criar um **quinto** papel — "caixa", "gerente de unidade" — em vez de só reconfigurar os quatro | sem bloco definido: `staff_role` é um enum do Postgres, e papel criado por barbearia teria que virar tabela com chave própria, migrando `staff_users.role`, `role_permissions.role` e a semente. É trabalho real e o ganho é pequeno enquanto os quatro cobrem o que a SPEC §1.3 descreve — quatro conjuntos editáveis já respondem "a recepção pode dar desconto?" |
| Teto de desconto por pessoa | o teto é por barbearia, em pontos-base, e vale para todo mundo que tem `finance.discount` | um teto diferente por papel — a recepção até 10%, o gerente até 30% | sem bloco definido: exigiria o teto migrar de `tenants` para `role_permissions`, que hoje é um par (papel, permissão) sem valor associado. Vale quando alguém pedir; hoje a separação que importa — quem pode e quem não pode — já existe |
| `Idempotency-Key` obrigatório na troca de plano | o POST aceita a chave e a honra; o reenvio sequencial esbarra em `same_plan`, e a chave é escopada por operador | torná-la obrigatória, para fechar também o envio **concorrente** — dois cliques ao mesmo tempo emitiriam dois acertos de rateio | sem bloco definido: seria a primeira rota do produto a exigir a chave, e as de dinheiro do balcão (comanda, caixa) a aceitam opcional. Mudar uma só cria duas convenções; mudar todas é decisão de contrato de API, com cliente a atualizar. Fica escrito porque a `/security-review` do bloco 28 apontou e a resposta foi consciente, não esquecimento |
| Segundo fator na troca de plano pelo dono | a rota é `settings.manage`, e o segundo fator é derivado da permissão declarada — então ela emite cobrança sem exigir o autenticador | decidir se a emissão de cobrança pelo próprio dono merece `finance.*` | sem bloco definido: exigir finanças obrigaria o dono que ainda não cadastrou autenticador a não conseguir **ler** o próprio plano, que é a tela onde ele descobre que a conta vai vencer. O risco é o próprio dono gastando o próprio dinheiro, com fatura e trilha. A troca vira decisão no dia em que houver mais de uma conta com `settings.manage` numa barbearia |
| CAC e payback | GMV, MRR e churn saem de dado que o produto tem | as duas métricas da SPEC §8 que dependem de **custo de aquisição** | sem bloco definido: não existe origem de dado. Quanto se gastou para trazer uma barbearia mora em ferramenta de marketing, não aqui, e inventar um campo "custo" que ninguém preenche é o defeito de `blocks` outra vez |
| Foto do cliente só sai com o consentimento na mão | o aceite existe e é coletado: `photos` e `photos_public` são finalidades distintas no histórico append-only, com texto e versão próprios, registráveis na ficha pelo balcão e conferíveis por consulta | a **guarda** que impede subir a foto de quem não autorizou, a que separa "guardar na ficha" de "publicar nas redes", e o apagamento das fotos quando o aceite é revogado (SPEC §1.8 regra 2) | 74 (foto de cliente e antes/depois): não existe foto de cliente no produto — não há coluna, tela nem armazenamento. Escrever a guarda agora seria função que ninguém chama, e é o defeito de `blocks` outra vez. O aceite entra antes de propósito: consentimento é o que precede a coleta, então coletá-lo primeiro é a ordem certa, e é o oposto de campo vazio. A anonimização do bloco 32 já limpa tudo o que existe hoje; quando houver foto, ela entra na mesma função |
| Exportação do titular em PDF | o arquivo sai em JSON, completo, com nove consultas nomeadas e teste que reprova quando uma tabela com dado de cliente fica de fora | o PDF que a SPEC §1.8 regra 4 cita ao lado do JSON | sem bloco definido: exigiria a primeira dependência de geração de documento do produto, e a mesma decisão volta nos blocos 53 e 54 (nota fiscal) e na fatura em PDF da plataforma. As três devem escolher o mesmo caminho de uma vez, não três vezes. O JSON já é legível e é o formato que a ANPD aceita para portabilidade; o PDF é conforto de leitura, não o direito |
| Teto de requisição compartilhado entre processos | teto por IP em duas janelas, e — desde o bloco 33 — escada de espera **por conta** no login, esta guardada no banco e portanto compartilhada por todos os processos | o teto por IP num armazenamento comum: hoje ele é a memória do processo, então dois servidores dobram o limite efetivo | sem bloco definido: exigiria Redis, que é a primeira dependência de infraestrutura fora do Postgres, e a decisão de tê-lo vale junto com o CD e o ambiente que ainda não existem. O que protegia senha era a escada por conta, e essa **já** é compartilhada; o teto por IP protege custo de endpoint, e dobrá-lo com dois processos não abre nada |
| Formas de pagamento na recepção digital | o assunto é reconhecido e a pergunta vira lacuna contada, com a tela dizendo em letras que ainda não há onde cadastrar | o **cadastro**: uma lista de meios aceitos na tela de Configurações, para a recepção responder "aceitamos Pix, débito e crédito" em vez de escalar | sem bloco definido: é uma coluna e um campo de formulário, e entra no primeiro bloco que abrir a tela de Configurações. Deixá-lo marcado é decisão — escondê-lo faria a SPEC §4.17 parecer entregue, e inventar a resposta é exatamente o que "respostas vêm **exclusivamente** dos dados configurados" proíbe. A pergunta não some enquanto isso: ela é contada, e a contagem é o que justifica o campo |
| "Perto de mim" com a coordenada do aparelho | a busca inteira: vitrine sem RLS, raio, caixa de coordenada indexada, filtros de nota, preço, comodidade e clube, e a cidade escolhida com o centro derivado das próprias barbearias listadas | ler a **geolocalização do navegador**, que é o que a SPEC §5.2 chama de "perto de mim" | sem bloco definido: exige o **primeiro componente de cliente do produto**, hoje 100% renderizado no servidor — a mesma dependência do arraste na agenda, da atualização automática do balcão e da resolução de conflito de telefone, e as quatro devem entrar juntas com medição de pacote. Escolher a cidade não é consolo: ela resolve o caso de quem busca do computador, e o centro sai do cadastro em vez de uma tabela de municípios que alguém teria que manter |
| Filtros por **serviço** e por **profissional** na busca | os outros sete filtros da SPEC §5.2, e o motor rodando em lote — desde o bloco 71 cada card traz a próxima vaga, e "disponível hoje" e "disponível agora" filtram por ela | escolher o serviço na busca. Hoje o horário do card é o do **serviço de entrada** da casa, o mesmo do "a partir de", para preço e horário falarem da mesma coisa: a casa cujo serviço mais barato está lotado some do filtro mesmo com a tarde livre para o resto do cardápio, e a tela diz isso em letras | 73 (perfil público do barbeiro), que é onde a dimensão "profissional" entra no marketplace e onde os dois filtros compartilham o mesmo desenho de seleção |
| Revisão da contestação de comissão pela plataforma | a barbearia contesta com motivo escrito, a linha vira `cancelada`, a trilha registra autor e motivo, e a política de leitura deixa a plataforma **ver** todas as contestações sem tenant no contexto | a tela do Super Admin que lista as contestações e a rota que reverte uma indevida. Hoje a renúncia é definitiva do lado da barbearia: o índice único faz aquele cliente nunca mais gerar comissão | 75 (anúncios e destaque), que é o próximo bloco a mexer no painel da plataforma sobre o marketplace. Até lá o freio é o motivo escrito com piso na borda, no domínio e por `CHECK`, mais a trilha — o que torna a renúncia auditável, não impedida |
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
| 31 | LGPD: consentimentos, exportação de dados | ✅ |
| 32 | LGPD: anonimização, retenção, pipeline de exclusão | ✅ |
| 33 | Segurança: hardening, rate limit global, auditoria de acesso | ✅ |

---

## R2 — dinheiro e ocupação (11 blocos)

| # | Bloco |
|---|---|
| 34 | `PaymentProvider`: abstração, fake e o cliente Stripe compartilhado | ✅ |
| 35 | Pix pela Stripe: QR Code, webhook, conciliação | ✅ |
| 36 | Cartão e link de pagamento pela Stripe | ✅ |
| 37 | Sinal seletivo + política de reembolso | ✅ |
| 38 | Lista de espera: entradas, expiração, gatilho de cancelamento | ✅ |
| 39 | Lista de espera: priority queue, janela exclusiva, notificação | ✅ |
| 40 | Sugestões e reclamações do cliente | ✅ |
| 41 | Fidelidade: pontos, visitas ou cashback | ✅ |
| 42 | Pacotes: venda, consumo, validade, receita diferida | ✅ |
| 43 | Avaliações + fluxo de recuperação de nota baixa | ✅ |
| 44 | Produtos, estoque, ficha de consumo, CMV | ✅ |

### O bloco 40 e o 43 são irmãos, e não a mesma coisa

A SPEC §4.10 descreve **avaliação**: 1 a 5 estrelas, vinculada a um atendimento
concluído de verdade, com janela de recuperação quando a nota é baixa. Ela é
confiável justamente por ser vinculada — é o que a separa de review aberta de
marketplace, e é o bloco 43.

Falta o outro lado, e ele não estava em lugar nenhum da SPEC nem do roadmap: o
cliente que quer **dizer alguma coisa sem ter uma nota para dar**. "A cadeira
do fundo está bamba", "vocês deviam abrir no domingo", "fui atendido bem, mas
esperei quarenta minutos". Nada disso cabe numa estrela, e nada disso exige um
atendimento concluído — quem desistiu da fila e foi embora é justamente quem
mais tem o que contar.

Por isso é bloco próprio e não um campo no 43:

- **A entrada é diferente.** Avaliação nasce de um atendimento; sugestão nasce
  de uma vontade. Amarrá-la a `appointment_id` perderia quem nunca chegou a ser
  atendido.
- **O destino é diferente.** Nota baixa vira alerta de recuperação com prazo de
  48h. Sugestão vira fila de triagem sem prazo, que alguém lê quando dá.
- **A publicação é diferente.** Avaliação vai para o perfil público. Sugestão e
  reclamação **não vão** — são conversa entre o cliente e a casa, e publicá-las
  seria transformar um canal de melhoria em vitrine de problema.

O que o bloco entrega: o canal do lado do cliente (na página pública e no
próprio link de agendamento, sem exigir conta), a fila de triagem no admin com
estado e responsável, resposta ao cliente pelo canal que ele já usa, e o
vínculo opcional com atendimento quando existir um. O limite ético do §4.10 vale
igual — o produto não oferece apagar reclamação.

---

## R3 — recorrência e escala (15 blocos)

| # | Bloco |
|---|---|
| 45 | Planos de assinatura: modelagem, regras, cooldown | ✅ |
| 46 | Assinatura: restrição de horário, dependentes, prioridade na fila | ✅ |
| 47 | Cobrança recorrente: régua, suspensão gradual, cancelamento self-service | ✅ |
| 48 | Rentabilidade da assinatura (simulação dos três modelos de comissão) | ✅ |
| 49 | Split: modelagem derivada da comissão | ✅ |
| 50 | Split: KYC do profissional, liquidação, estorno | ✅ |
| 51 | Financeiro: contas a pagar/receber, transferências, conciliação | ✅ |
| 52 | Financeiro: vale, DRE gerencial | ✅ |
| 53 | `FiscalProvider`: abstração e integração | ✅ |
| 54 | Fiscal: NFS-e, cancelamento, Salão-Parceiro | ✅ |
| 55 | WhatsApp oficial: templates, webhooks, botões | ✅ |
| 56 | Marketing automation: motor de eventos, teto de mensagens, janela de silêncio | ✅ |
| 57 | Campanhas: filtros, canais, receita atribuída | ✅ |
| 58 | Multiunidade: seleção, consolidação, transferência de estoque | ✅ |
| 59 | Multiunidade: cliente e fidelidade compartilhados | ✅ |

---

## R4 — inteligência (10 blocos)

Depende de histórico acumulado. Não antecipar.

| # | Bloco |
|---|---|
| 60 | Reliability score + sinal condicional | ✅ |
| 61 | Ciclo individual de retorno + segmentação automática | ✅ |
| 62 | Churn score com explicação | ✅ |
| 63 | Schema semântico de métricas (base do assistente) | ✅ |
| 64 | Assistente do gestor: text-to-query | ✅ |
| 65 | Agente de agendamento: intent, slots, confirmação | ✅ |
| 66 | Agente: remarcação e recepção digital | ✅ |
| 67 | Insights proativos | ✅ |
| 68 | Smart pricing com aprovação humana | ✅ |
| 69 | Previsão de consumo e sugestão de compra | ✅ |

---

## R5 — rede (10 blocos)

Só faz sentido com centenas de barbearias na base.

| # | Bloco |
|---|---|
| 70 | Marketplace: busca geográfica e filtros | ✅ |
| 71 | Marketplace: "próximo horário" em lote (exige `/availability` rápido) | ✅ |
| 72 | Marketplace: atribuição de cliente novo e comissão | ✅ |
| 73 | Perfil público do barbeiro |
| 74 | Portfólio e consentimento de uso público |
| 75 | Anúncios e destaque |
| 76 | Franquias: catálogo padrão, preços sugeridos |
| 77 | Franquias: indicadores consolidados, metas |
| 78 | API pública: chaves, escopos, rate limit |
| 79 | Webhooks assinados para terceiros |

---

## Adição de escopo: contestar uma avaliação (bloco 80)

O bloco 43 fechou com a nota baixa publicando **de qualquer forma** passadas as
48 horas, e as três camadas que impedem apagar avaliação continuam de pé. Isso
está certo para a nota ruim e verdadeira, e deixa sem resposta a nota ruim e
**injusta** — spam, ofensa, nota atribuída ao profissional errado, gente que
nunca foi cliente. Contra essa, hoje o dono não tem nada, e é uma reclamação
justa.

O caminho **não** é apagar. Apagar o que não se gostou transforma a nota em
folheto — e não só do lado de fora: a média que o gestor vê no painel conta tudo
hoje, publicado ou não, e é a distância entre ela e a média pública que diz
"o Bruno está com 4,8 na rua e 3,9 de verdade". Com o botão de apagar, os dois
números viram o mesmo e o dono cega o próprio termômetro. Somem-se a isso o CDC
art. 37 e o fato de a plataforma ser operadora.

A contestação é o meio-termo que Booksy e Fresha já operam:

| | Apagar | Contestar |
|---|---|---|
| Motivo | nenhum | lista fechada, registrado e auditado |
| Efeito | some para sempre | **suspensa** da vitrine enquanto está em análise |
| Nota e texto | apagáveis | continuam imutáveis — sai da vitrine, não do histórico |
| Média do painel | muda | **não muda**: o gestor continua vendo a verdade |

| # | Bloco |
|---|---|
| 80 | Contestar uma avaliação: motivo de lista fechada, suspensão da vitrine, trilha |

O número do roadmap sobe de 79 para 80. Não é bloco descoberto: é escopo novo,
pedido depois do 51, e está aqui porque adição silenciosa é o que faz um plano
deixar de servir para planejar.

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

79 blocos é produto de time, horizonte de mais de um ano. Duas decisões cortam
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
