# Backlog pós-revisão externa

Origem: revisão técnica externa do repositório, por leitura estática. **O revisor
não conseguiu executar a aplicação** e diz isso em letras — nenhuma nota daquele
texto é medição, e nenhuma deve ser citada como se fosse. Isso não enfraquece a
revisão: o melhor achado dela é de navegação, e o segundo é documental.

Este documento não é decisão tomada. É a fila proposta, com o que já existe
separado do que falta, e com a discordância escrita junto — backlog que engole a
discordância vira trabalho que ninguém sabe por que está fazendo.

Duas partes. A **I** é o programa de reorganização, que é o assunto e vem antes
de tudo. A **II** são as outras observações da revisão, que continuam valendo.

---
---

> **Revisão corretiva de 23/08/2026:** após auditoria independente da versão
> migrada, os critérios V8 e V10 abaixo foram reconciliados com a implementação
> real; R5 permanece dependente de build/medição e R12 de teste humano. Não há
> números retroativos inventados para a linha de base perdida.

# Parte I · Reorganização visual e de navegação

## A tese

> Não é preciso simplificar o que o produto faz. É preciso simplificar o que o
> usuário precisa enxergar de cada vez.

E o alvo é operacional, não estético — duas frases que dá para cronometrar:

- **Funcionário novo, sem treinamento, em menos de 30 segundos:** onde está a
  agenda, o cliente, o atendimento e o caixa.
- **Dono, em segundos:** "como está minha barbearia hoje?"

Isso é reorganização de produto, não redesenho de CSS. **Se só melhorarmos os
cartões, o acabamento sobe e a facilidade de uso não sai do lugar** — e esse é
exatamente o risco, porque mexer em CSS é a parte agradável e a parte que não
resolve.

Este programa vem antes de qualquer módulo novo, e é o maior retorno disponível
agora. **Não porque haja medição dizendo isso** — não há, e a revisão não rodou o
produto —, mas porque é o sinal qualitativo mais forte que ela produziu: as três
avaliações mais baixas — facilidade de uso, acabamento e simplicidade — apontam
todas para navegação, e nenhuma para funcionalidade faltando. Sinal forte não é
número; o número é o que o R12 vai buscar.

---

## A ordem de execução

A fila abaixo **não** é "Parte I inteira, depois Parte II". As duas se
intercalam, e a razão de cada posição está escrita.

| Ordem | Item | Por que aqui |
|---|---|---|
| **0** | **Cronometrar o estado de hoje** (R12, primeira passada) | **O "antes" só existe uma vez.** Se V1 entrar antes da medição, a linha de base some para sempre e o programa inteiro vira opinião defendida com opinião |
| 1 | **R7** · matriz de prontidão | Estabelece a verdade sobre o produto antes de qualquer trabalho: "bloco pronto" ≠ "dá para vender" |
| 2 | **V0** · vocabulário do menu | Renomear é barato e muda o que a pessoa lê antes de tudo. E define onde `Clientes` vai morar |
| 3 | **V1** · a porta dos clientes | O buraco estrutural |
| 4 | **V3** · migalha e abas | Saber onde se está |
| 5 | **V4** · operar × configurar | Reduz densidade sem tirar nada |
| 6 | **V5** · Hoje como centro operacional | Cria a casa de quem opera |
| 7 | **V10** · agenda em linha do tempo | Melhora a rotina principal, e buraco de agenda é o produto |
| 8 | **R5** · a primeira ilha de cliente | Destrava V11 e as quatro lacunas declaradas |
| 9 | **V11** · busca global e ação no contexto | Depende do R5 |
| 10 | **V2** · a ficha do cliente | Fecha o fluxo que o V1 abriu |
| 11 | **V6** · painel do dono | Gestão, depois de a operação estar resolvida |
| 12 | **V7 · V8 · V9** | Consolidam o sistema visual sobre telas que já estão no lugar certo |
| 13 | **R9** · armazenamento de objeto | Antes da primeira demonstração comercial séria |
| contínuo | **R10 · R11** | Refatorar a área que se está tocando, nunca como bloco separado |
| contínuo | **R12** | Recronometrar depois do 6 e depois do 9 |

**V10 e V11 subiram** em relação ao primeiro rascunho, e o motivo é o mesmo dos
dois: agenda visual e busca global atacam diretamente a sensação de *"fico
confuso e não sei onde estou"*. Busca global não é conveniência — num sistema
grande ela é **a válvula de escape da arquitetura de navegação**: quem pensa
"onde diabos fica comissão?" digita `Ctrl+K` e para de explorar menu.

---

## Antes de qualquer coisa: o que já está construído

A revisão propõe quinze mudanças. **Quatro já existem**, e uma delas é
justamente a que ela chama de possível identidade do produto. Reconstruí-las
seria o pior desperdício deste backlog, então ficam com a prova de onde estão.

| Proposta da revisão | Situação | Onde está |
|---|---|---|
| "Sair de ~40 opções para 6–7 áreas mentais" | **a estrutura existe; o vocabulário, não** | `secoes.ts` tem sete módulos com sub-`grupo` e `nota` de uma linha em cada tela. Mas os nomes são *Visão geral · Atendimento · Financeiro · Marketing · Cadastros · Integrações · Administração* — que é como um arquiteto organiza funcionalidade, não como a recepção pensa. Eu tinha dado isto como feito; a estrutura está, o vocabulário está errado, e o vocabulário é a metade que o funcionário novo lê. Vira **V0** |
| "Cada perfil vê só o necessário" | **feito no bloco 126** | `modulosVisiveis(recursos, permissoes)` filtra por permissão **e** por recurso do plano. A recepcionista nunca viu quarenta destinos. O barbeiro tem telas próprias: `/admin/meu-dia` e `/admin/meus-numeros` |
| "Status consistente — não *Concluído* aqui e *Finalizado* ali" | **feito, com guarda** | `packages/core/src/vocabulario.ts`, `ROTULO_DO_ESTADO`. A tela não escreve texto de transição à mão, e há teste que reprova quem escrever |
| "Próxima melhor ação: três coisas precisam da sua atenção, com o botão ao lado" | **feito** | `insightsDoPainel` — no máximo três, ordenados pelo mais caro, cada um com o valor em reais e o destino que resolve |
| "Uma cor precisa significar alguma coisa" | **os tokens existem, a disciplina não** | `--color-success` · `--color-warning` · `--color-danger` estão no design system. O uso é que não é vocabulário fechado — vira V9 |
| "Transformar tabelas em interfaces" | **metade feita** | Não há um único `<table>` em `/dia`, `/agenda`, `/fila` ou `/painel`, e a fila já agrupa por estado em `<section>`. A agenda é que ainda é lista de compromissos, não linha do tempo — vira V10 |

O que sobra depois desse corte continua sendo muito. E o primeiro item é mais
grave do que qualquer coisa que a revisão escreveu, porque não estava na lista
dela.

---

## O achado que vale o texto inteiro: **não existe porta para o cliente**

A revisão propõe "Clientes" como uma das áreas do menu. Ao conferir, descobri
que **não existe tela de clientes neste produto.** Não é que esteja mal
posicionada: ela não existe.

A ficha (`/admin/cliente/[id]`, 1.760 linhas) só é alcançável **de lado**, a
partir de alguma lista que por acaso contenha aquela pessoa:

| De onde se chega hoje | Só alcança quem… |
|---|---|
| `/admin/retencao` | está em risco de sumir |
| `/admin/lgpd` | abriu pedido de titular |
| `/admin/meu-dia` | tem horário hoje com aquele barbeiro |
| `/admin/campanhas` | entrou no público de alguma campanha |

Consequência exata: **um cliente que não está em nenhuma dessas quatro situações
é inalcançável pela interface.** O cliente fiel — que vem todo mês, não falta,
não reclama, não precisa de campanha — é o mais difícil de encontrar no sistema.
A recepção que ouve *"quero ver o cadastro do João"* não tem caminho.

Isso é a §6 pergunta 1 — *onde a pessoa entra* — no tamanho de uma entidade
inteira, e passou 129 blocos porque **cada tela, sozinha, funciona**: retenção
lista quem está em risco e leva à ficha; a ficha abre e mostra tudo. Nenhum
teste fica vermelho por uma porta que ninguém abriu.

E fica a ironia registrada: o slide 13 da apresentação de venda chama a base de
clientes de *"o seu ativo"*. É o único ativo do produto sem porta de entrada.

---

## O programa

Doze itens. Estão numerados por assunto, **não** por ordem de execução — a ordem
está na tabela lá em cima, e ela intercala Parte I e Parte II. O que a numeração
guarda é a dependência conceitual: **V0 a V4 são vocabulário, porta, orientação e
separação.** Sem eles, V7 a V9 consertam a decoração de um lugar onde as pessoas
continuam se perdendo.

---

### V0 · O vocabulário do menu

**O defeito:** os sete módulos existem e estão nomeados pela arquitetura do
software, não pelo trabalho de quem abre. *Cadastros* é uma categoria de banco de
dados. *Integrações* é uma palavra de quem escreve API. *Marketing* é
departamento de empresa grande — numa barbearia de duas cadeiras quem manda o
WhatsApp é a mesma pessoa que varre o chão.

**O que entra** — a lista passa a ser dita na língua de quem trabalha:

```
Hoje · Agenda · Clientes · Atendimento · Financeiro · Crescimento · Gestão
─────────────
Configurações
```

O de-para, sem perder destino nenhum:

| Novo | De onde vem |
|---|---|
| **Hoje** | `/admin/dia`, promovido de dentro de *Atendimento* |
| **Agenda** | `/admin/agenda`, idem |
| **Clientes** | **novo** (V1) |
| **Atendimento** | fila · recados · recepção · avaliações · cobrar |
| **Financeiro** | caixa · fiado · contas · comissões · resultado |
| **Crescimento** | WhatsApp · campanhas · automações · avisos · retenção · fidelidade · clube |
| **Gestão** | serviços · preços · pacotes · profissionais · recursos · estoque · fotos · franquia · unidades · nota fiscal |
| **Configurações** *(abaixo do separador)* | usuários · segurança · chaves · webhooks · privacidade · auditoria · importar · plano · preferências |

**Duas decisões em aberto, e a minha recomendação:**

- **O painel do dono não tem lugar óbvio nessa lista de sete.** Recomendo que
  `Hoje` seja a casa de quem opera e o painel seja a **primeira tela dentro de
  Gestão** — e a casa de quem tem papel de dono. São dois produtos mentais
  diferentes (V5 e V6), e cada um merece a própria porta, não uma disputa.
- **O assistente sai do menu.** Ele não é um lugar: é um jeito de perguntar.
  Recomendo que ele passe a viver ao lado da busca global (V11), na barra do
  topo. Um destino de menu chamado "Assistente" obriga a pessoa a ir até ele;
  no topo, ele está onde ela já está.

**A porta de entrada depois do login também fica explícita por perfil** — o menu
não resolve orientação se `/admin` ainda mandar todo mundo para a mesma casa:

| Perfil | Destino inicial |
|---|---|
| **Barbeiro** | `/admin/meu-dia` |
| **Recepção** | `/admin/dia` (**Hoje**) |
| **Gerente operacional** | `/admin/dia` (**Hoje**) |
| **Dono** | `/admin/painel`, a primeira tela de **Gestão** |
| **Administrador da plataforma** | a área administrativa correspondente ao papel |

O redirecionamento é derivado de papel/permissão, nunca de uma lista paralela
escrita à mão. Se uma pessoa acumula papéis, prevalece o destino de maior escopo
de gestão que ela de fato pode abrir, com preferência configurável no futuro se
a operação mostrar necessidade.

**Pronto quando:** o de-para não perde nenhum dos 41 destinos atuais; a guarda de
navegação do bloco 126 continua verde; os nomes saem do mesmo `secoes.ts`, que
já é fonte única — renomear não pode virar a segunda lista —; e `/admin` leva
cada perfil ao destino inicial definido acima sem expor tela sem permissão.

---

### V1 · A porta dos clientes

**O defeito:** acima.

**O que entra:**

- `/admin/clientes` como destino de **primeira ordem** no menu, em módulo
  próprio — não dentro de *Cadastros*. Cliente não é cadastro: serviço é
  cadastro, cadeira é cadastro. Cliente é o ativo, e a posição no menu é o que
  diz isso sem precisar de treinamento.
- Busca por nome e por telefone. O telefone já é E.164 normalizado e já é a
  chave de deduplicação — a busca por número deveria ser exata e instantânea.
- Cada linha traz o **segmento derivado** ao lado do nome. Os segmentos já
  existem em `core`, calculados na leitura e nunca em coluna; hoje só aparecem
  dentro da ficha, uma pessoa de cada vez.
- Filtros como fichas no topo: **Todos · Recentes · Hoje · Em risco · VIP ·
  Assinantes · Fiado**.
- **O padrão é *Todos*, ordenado por atividade recente — nunca por ordem
  alfabética, e nunca recortado.** Esta é a correção de uma versão anterior deste
  documento, que propunha abrir mostrando só quem tem horário nos próximos dias.
  A intenção era certa (mil e duzentos nomes em ordem de A é lista sobre a qual
  não se age), o efeito seria péssimo: *"entrei em Clientes e não estou vendo
  meus clientes"* — a tela negaria a própria promessa do nome dela. Quem resolve
  a densidade é a **ordem**, não o recorte: a base continua inteira, e quem esteve
  aqui esta semana aparece primeiro.
- Cada linha diz o que a operação precisa saber antes de clicar:

```
João Silva          última visita ontem · próxima 29 ago
Pedro Souza         última visita há 4 dias
Carlos Lima         próxima visita hoje 16:30
```

**Pronto quando:** a recepção acha o João digitando "joão" num campo, sem saber
em qual lista ele está; e o percurso de navegador do bloco 126 cobre a porta nova
nos dois sentidos — quem pode, vê; quem não pode, recebe a recusa desenhada.

**Cuidado que já foi cobrado oito vezes aqui:** a lista devolve cadastro de
cliente, então declara `customers.view` — e segmento, fiado e nota de avaliação
**não** são `customers.view`. É a regra da rota que agrega. A nona quebra não
pode ser esta.

---

### V2 · A ficha do cliente, que devia ser a tela mais bonita do produto

**O defeito:** 1.760 linhas numa página só, com dezenas de seções empilhadas.
É a tela onde a recepção passa mais tempo por cliente, e é a mais cansativa de
ler.

**O que entra** — a ficha vira quatro abas com um cabeçalho que responde de
imediato quem é a pessoa:

```
JOÃO SILVA                                    Cliente desde 2024
★ VIP  ·  18 visitas  ·  R$ 2.840 no total

[ Agendar ]  [ WhatsApp ]  [ Nova comanda ]        ← ação no contexto (V11)

Visão geral │ Histórico │ Fidelidade │ Financeiro
────────────────────────────────────────────────

PRÓXIMO          22 ago · 17:30 · Corte com Lucas
PREFERÊNCIAS     degradê baixo · tesoura em cima · sem navalha
POR QUE VIP      gasta acima do decil 9 da base e volta a cada 21 dias
```

Duas decisões dentro disso:

- **O rótulo vem com o porquê ao lado**, que já é convenção escrita aqui: "VIP"
  sozinho é classificação sem critério, e a recepção precisa poder responder
  *"por que ele é VIP?"* sem abrir documentação.
- **O histórico é linha do tempo, não tabela.** Data à esquerda, serviço e
  profissional no meio, valor à direita — é a forma que a pessoa lê de cima para
  baixo procurando "quando foi a última vez".

E há um ganho de graça: as quatro abas partem o arquivo de 1.760 linhas por
consequência, não por refatoração separada.

**Pronto quando:** nenhuma aba passa de ~600 linhas, e a visão geral responde
quem é a pessoa sem rolagem em 390px.

---

### V3 · Saber onde se está, em toda tela

**O defeito:** hoje o menu lateral acende o item, e é só. Não há migalha em
lugar nenhum do painel — `aria-label="Trilha"` existe em um só arquivo, dentro
da página de auditoria, e como navegação de abas, não como caminho. A revisão
descreve a sensação de dois menus laterais competindo, e o remédio não é
apagar um: é **separar os papéis dos dois eixos**.

**A estrutura constante de toda página do painel:**

```
Financeiro › Comissões               ← migalha: a área e a página
COMISSÕES                            ← título
o que a casa precisa pagar           ← a nota que JÁ EXISTE em secoes.ts
Visão geral │ Profissionais │ Regras │ Pagamentos    ← abas horizontais
──────────────────────────────────────────────────
conteúdo
```

```
┌──────────────┬────────────────────────────────────────┐
│ Hoje         │ Financeiro › Comissões                 │
│ Agenda       │                                        │
│ Clientes     │ COMISSÕES                              │
│ Atendimento  │ o que a casa precisa pagar             │
│ Financeiro ● │                                        │
│ Crescimento  │ Visão geral │ Profissionais │ Regras   │
│ Gestão       │ ────────────────────────────────────── │
│              │                                        │
│ ─────────    │ conteúdo                               │
│ Configurações│                                        │
└──────────────┴────────────────────────────────────────┘
```

A regra que separa os eixos, e que vale para sempre: **o menu lateral escolhe
onde estou no produto; as abas horizontais escolhem onde estou dentro da área.**
Nunca dois níveis verticais ao mesmo tempo.

O barato aqui é que migalha e descrição **não são texto novo**: módulo, nome e
`nota` já estão em `secoes.ts`. É derivar o que já existe — e é isso que impede
a migalha de discordar do menu no primeiro destino novo, que é exatamente como
`lgpd` e `plano` ficaram sem acender.

**Pronto quando:** toda tela registrada em `secoes.ts` desenha migalha derivada
do registro, com guarda que reprova migalha escrita à mão; e nenhuma página tem
dois níveis de navegação vertical simultâneos.

---

### V4 · Separar operar a barbearia de administrar a empresa

**O defeito:** hoje *Integrações* e *Administração* são módulos como qualquer
outro, na mesma lista e com o mesmo peso visual de *Atendimento*. Quem abre o
menu vê API, webhooks, LGPD e auditoria com a mesma prioridade da fila e do
caixa — e isso é o que faz o produto parecer ERP corporativo para quem tem duas
cadeiras.

**O que entra:** um corte visual, não um corte de permissão (esse já existe).

- **Em cima, o que se usa todo dia:** Hoje · Agenda · Clientes · Atendimento ·
  Financeiro · Crescimento · Gestão.
- **Embaixo, depois de um separador e em peso menor: Configurações** — usuários,
  segurança, chaves de API, webhooks, LGPD, auditoria, importação, plano,
  preferências. Coisas que se configuram uma vez e se revisitam por exceção.

Não some nada, não muda permissão nenhuma. Muda o que compete pelo olhar quando
alguém abre o menu pela primeira vez.

**Pronto quando:** as áreas do dia a dia cabem sem rolagem no menu em 768px, e
tudo que é configuração está abaixo do separador.

---

### V5 · "Hoje" como centro operacional

**O defeito:** `/admin/dia` e `/admin/painel` competem pelo mesmo papel, e o
assistente é um terceiro concorrente. Quem opera não abre gráfico: abre para
saber quem chegou, quem é o próximo e o que está atrasado.

**O que entra:** `/admin/dia` vira a casa de quem opera, e não um painel de
indicadores. A linha do tempo do dia com o próximo cliente em destaque, e ao
lado quatro leituras curtas:

```
Bom dia. Hoje você tem 27 atendimentos.

09:00  João Silva · Corte · Lucas             [Chegou] [Remarcar]
09:30  Pedro Alves · Barba + corte · Rafael   [Chegou] [Remarcar]
10:00  ── horário livre ──                    [Agendar]

┌ AGORA ────────────┐ ┌ HOJE ─────────────┐
│ 2 esperando       │ │ 27 marcados       │
│ 1 barbeiro atrasado│ │ 22 confirmados   │
│ próximo em 8 min  │ │ 3 aguardando      │
└───────────────────┘ └───────────────────┘
┌ CAIXA ────────────┐ ┌ ATENÇÃO ──────────┐
│ R$ 1.840 hoje     │ │ Carlos, 18 min de │
│ 12 comandas fechadas│ │ atraso           │
│ 3 abertas         │ │ 2 pagamentos      │
└───────────────────┘ └───────────────────┘
```

**Pronto quando:** quem abre `/admin/dia` sabe quem é o próximo cliente sem
rolar, em 390px; e **nenhum gráfico aparece nessa tela.**

---

### V6 · O painel do dono conta uma história

**O defeito:** indicador enfileirado ao lado de indicador não responde "como
está minha barbearia hoje?". Responde quinze perguntas parciais e deixa a
síntese por conta de quem lê.

**O que entra:** `/admin/painel` passa a ter uma ordem narrativa —
**como estamos → onde está a folga → quem está fazendo → o que merece atenção →
o que dá para fazer a respeito**:

```
COMO ESTAMOS HOJE
R$ 5.870 faturados     +12% sobre a média das últimas 4 sextas

AGENDA
████████████████░░  84% ocupada · 32 atendimentos · 6 horários livres

EQUIPE
Lucas    91%   R$ 1.420
Rafael   86%   R$ 1.180
André    73%   R$   980

O QUE MERECE ATENÇÃO
6 clientes sem voltar há mais de 45 dias
Rafael está 22% abaixo da ocupação da equipe
Pomada X acaba em ~3 dias

O QUE DÁ PARA FAZER               ← insightsDoPainel, que JÁ EXISTE
14 horários livres amanhã          [Criar campanha]  até R$ 1.646,33
```

A última seção não se mexe: `insightsDoPainel` já entrega três, ordenados pelo
mais caro, com valor e destino. O que muda é tudo que vem antes dela.

**Cuidado:** a comparação de equipe é entre colegas, e a SPEC §4.21 manda o
indicador do barbeiro se comparar com o **próprio passado**. Aqui é a tela do
dono e a comparação é legítima — mas essa lista **não** pode vazar para a tela
do profissional, que é onde a briga começa.

**Pronto quando:** as cinco seções aparecem nessa ordem, mas sem comprimir a tela
para fazê-las caber artificialmente. **Sem rolagem devem aparecer pelo menos
“Como estamos”, a leitura de capacidade da agenda e o primeiro alerta ou ação**;
as demais seções podem continuar abaixo da dobra quando isso preservar espaço,
legibilidade e hierarquia visual no notebook do balcão.

---

### V7 · Quatro moldes de página, com exceções justificadas

**O defeito:** cada página inventa o próprio arranjo, então a pessoa reaprende o
sistema a cada clique. É também a origem das 9.228 linhas de `globals.css`: CSS
por tela, e não por molde.

| Molde | Para | Forma |
|---|---|---|
| **A · Operacional** | dia, agenda, fila, recepção, comanda | título · estado do momento · ação principal · linha do tempo · contexto lateral |
| **B · Cadastro** | clientes, profissionais, serviços, estoque, pacotes | título + *Novo* · busca e filtros · lista · detalhe |
| **C · Gestão** | resultado, comissões, retenção, desempenho, plano | título · período · número principal · indicadores secundários · gráfico · detalhamento |
| **D · Configuração** | equipe, unidades, integrações, fiscal, segurança | seções de formulário, uma decisão por bloco |

**E a regra não é "nenhuma tela fora deles".** A primeira versão dizia isso, e
estava errada: um design system diz *"este é o padrão"*, não *"é proibido existir
outra coisa"*. Vai aparecer mapa de ocupação, editor visual, onboarding, quadro
de colunas — coisas que legitimamente não cabem em A/B/C/D, e uma regra absoluta
faria a saída ser espremer a tela nova num molde errado, ou desligar a guarda.

A regra é: **toda tela usa um dos quatro moldes ou declara uma exceção com o
motivo escrito.** É o mesmo desenho das lacunas — a exceção existe, tem nome e
tem justificativa, e por isso alguém pode discordar dela depois.

**Pronto quando:** toda tela declara molde ou exceção justificada em `secoes.ts`,
e a guarda reprova apenas a tela que não declara **nada** — pela mesma razão que
rota sem `@Exige` é recusada e não liberada.

---

### V8 · Menos caixa, mais hierarquia

**O defeito:** quando tudo é cartão, nada se destaca. Hoje há cartão dentro de
cartão, borda sutil sobre fundo escuro, e informação de terceira ordem com o
mesmo peso visual da primeira.

**Três níveis, e só três:**

1. **O que importa agora** — grande. O próximo cliente, o número do dia, a ação.
2. **Contexto** — médio. Próximos, fila, caixa, alertas.
3. **Detalhe** — pequeno. Horário de criação, origem, id, observação, histórico.

**E a regra que substitui a caixa:** o agrupamento vem de espaço, alinhamento,
tamanho e peso **antes** de vir de borda e sombra. Quatro indicadores em quatro
cartões viram uma composição só:

```
antes                              depois
┌────┐┌────┐┌────┐┌────┐          HOJE
│ KPI││ KPI││ KPI││ KPI│          R$ 4.820  faturamento
└────┘└────┘└────┘└────┘          32 atendimentos · ticket R$ 150
                                   +14% sobre a sexta passada
```

**O que se proíbe é a causa, não o sintoma.** "Nenhum cartão dentro de cartão"
era a primeira redação, e ela mira no lugar errado: às vezes um recipiente dentro
de outro é semanticamente correto, e a regra literal faria contornar o teste sem
consertar a tela. O defeito real é **usar borda e fundo para criar a hierarquia
que deveria vir de espaço, tipografia e alinhamento** — e é isso que a revisão
tem que perguntar, em leitura, não em `grep`.

**Pronto quando:** cada tela consegue dizer qual dos três níveis cada elemento
ocupa; e o contraste medido dos três continua passando em AA nos dois temas —
hierarquia por tamanho e peso **antes** de cor é regra escrita aqui, e cor é o
que menos funciona para quem tem baixa visão.

**Situação pós-auditoria de 23/08/2026:** a guarda automatizada prova os três
níveis explicitamente em **Hoje, Painel e Ficha do cliente** e prova que as
demais seções declaram um molde V7. Isso **não fecha sozinho o critério acima**:
a aceitação global de V8 continua dependente de revisão visual das demais telas.
Adicionar `data-*` mecanicamente a todos os nós não conta como prova de
hierarquia.

---

### V9 · Cor com significado, e estado sempre visível

**O defeito:** os tokens semânticos existem e o uso não é disciplinado. Cor hoje
decora tanto quanto informa — e cor que decora ensina a pessoa a não olhar para
cor.

**O vocabulário fecha:** azul é ação e navegação · verde é concluído, recebido,
confirmado · amarelo é atenção · vermelho é problema · cinza é inativo. O resto
da interface é neutro. Quando aparece amarelo, a pessoa já sabe o que significa
antes de ler.

**E o estado de um atendimento vira sinal consistente** — confirmado ·
aguardando · chegou · em atendimento · finalizado · faltou —, desenhado igual em
todas as telas, com o rótulo saindo de `ROTULO_DO_ESTADO`, que já é fonte única.

**Pronto quando:** a cor nunca carrega o dado sozinha — o rótulo está sempre
escrito ao lado, que já é a regra do heatmap —, e há guarda que reprova cor
semântica usada fora do significado declarado.

---

### V10 · A agenda vira linha do tempo

**O defeito:** a fila já agrupa por estado em seções, o que está certo. A agenda
é que ainda é lista de compromissos: nada nela mostra **onde está o buraco**, e
buraco na agenda é o produto inteiro deste software.

**O que entra:** a agenda desenhada com o tempo proporcional ao tempo — uma hora
vazia ocupa espaço de uma hora vazia. É o que faz a folga da tarde ser visível
sem contar linha, e é o que torna o horário livre clicável no lugar onde ele
está.

**O comportamento muda por largura sem mudar o modelo mental:**

- **Desktop/notebook:** profissionais podem aparecer em colunas simultâneas, com
  o eixo vertical representando o tempo e os buracos ficando visíveis entre os
  compromissos.
- **Mobile (390px):** não se espremem cinco profissionais na mesma largura. A
  tela mostra **um profissional por vez** (ou um grupo pequeno quando couber),
  com troca por seletor e gesto/controle horizontal; o eixo temporal permanece
  proporcional e o horário livre continua clicável no lugar em que existe.
- A troca de profissional preserva data, posição temporal e filtros sempre que
  possível, para não fazer a recepção se localizar de novo a cada mudança.

**Pronto quando:** todo horário livre que vira ação na grade tem alvo de toque de
44px. Se o intervalo físico é menor que 44px na escala temporal, ele permanece
**informativo e não clicável**, em vez de ser artificialmente esticado sobre um
compromisso vizinho; o motor continua sendo a fonte final para dizer se o
serviço cabe. No desktop a comparação entre profissionais não destrói a
proporção do tempo; no mobile nenhum nome/coluna é comprimido para “caber”; e a
rolagem horizontal continua dentro do recipiente, nunca na página.

---

### V11 · Busca global e ação no contexto

**O defeito:** não existe busca global — conferido, não há nada. E várias ações
exigem sair de onde se está: para agendar para o João estando na ficha dele, a
recepção navega até a agenda e procura o João de novo.

**O que entra:**

- Busca no topo (`Ctrl/⌘ + K`) que acha **cliente, agendamento e função**.
  Digitar *"comissão"* leva a Financeiro › Comissões; digitar *"joão"* traz o
  cliente e o horário dele hoje. É o que faz um sistema grande deixar de parecer
  grande, e é o antídoto direto para quem não sabe onde uma tela mora.
- Ação onde o objeto está: vendo um cliente, **Agendar**; vendo uma comanda,
  **Receber**; vendo um horário vago, **Agendar cliente**; vendo um cliente
  atrasado, **Mandar WhatsApp**; vendo estoque baixo, **Registrar compra**.

**Pronto quando:** qualquer destino de `secoes.ts` é alcançável pela busca sem
tocar no menu, com o resultado **já recortado pela permissão de quem digita** —
oferecer o que a pessoa não pode abrir é dizer a ela que existe um número que ela
não vê, e isso é informação por si.

**E isto entra no design system como princípio, não como lista de botões:**

> O usuário não deve navegar para executar uma ação quando o objeto da ação já
> está diante dele.

Escrito assim, a tela nova nasce cobrada. Como lista de casos, ela ficaria
desatualizada no primeiro objeto que alguém acrescentar.

**Dependência:** busca com estado por tecla é um **componente de cliente**, e cai
no bloqueio do R5.

---
---

# Parte II · As outras observações

Continuam valendo, com peso menor que o programa acima.

## R1 · O ROADMAP se contradiz sobre o arraste na agenda

`ROADMAP.md:151` marca o bloco 15 como **✅** com o título *"Agenda:
dia/semana/lista, **arrastar**, bloqueio pontual"*. `ROADMAP.md:78` declara o
arraste como lacuna aberta, sem bloco.

As duas linhas estão no mesmo arquivo. A tabela de lacunas está certa; o título
do bloco é que promete o que não foi entregue. E o defeito é maior que uma
linha: **"129 de 129" é contado sobre títulos de bloco**, então um título que
promete a mais infla o contador que decide quando o produto está pronto —
inclusive para quem fecha bloco. Ninguém varreu se há outros.

## R2 · Falta a matriz de prontidão por funcionalidade

Bloco fechado é um carimbo só sobre cinco coisas diferentes. Com os valores de
hoje:

| Funcionalidade | Motor | Tela | Integração real | E2E de verdade | Em produção |
|---|---|---|---|---|---|
| Agenda | ✅ | ✅ | — | ✅ | ✅ |
| Comanda / caixa / comissão | ✅ | ✅ | — | ✅ | ✅ |
| WhatsApp (Meta Cloud) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Stripe (cobrança da plataforma) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Split de pagamento | ✅ | ✅ | ❌ `FakeSplitProvider` | ❌ | ❌ |
| Fiscal (NFS-e) | ✅ | ✅ | ❌ `FISCAL_MODO` só aceita `nenhum`/`fake` | ❌ | ❌ |
| Sinal cobrado online | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| Foto por envio de arquivo | ❌ | ❌ (cola-se URL) | ❌ | ❌ | ❌ |

Os dois ❌ de integração eu confirmei no código: `adquirenteDoSplit()` devolve
`FakeSplitProvider`, e `modoFiscal()` recusa qualquer valor além de `nenhum` e
`fake`, com a mensagem *"não há emissor de verdade integrado"*. Ambos já eram
lacuna declarada — o que faltava era a **leitura de conjunto**, que é o que
impede vender o que não existe.

## R3 · Os monólitos internos

Medido no bloco 129, sem `dist` e sem teste:

| Arquivo | Linhas |
|---|---|
| `apps/web/src/app/globals.css` | 9.228 |
| `apps/web/src/lib/admin-api.ts` | 4.096 |
| `apps/web/src/app/admin/acoes.ts` | 3.548 |
| `packages/finance/src/comanda.ts` | 2.091 |
| `apps/web/src/app/admin/cliente/[id]/page.tsx` | 1.760 |
| `packages/scheduling/src/booking.ts` | 1.714 |
| `packages/crm/src/whatsapp.ts` | 1.482 |
| `packages/finance/src/comissao.ts` | 1.388 |

A arquitetura entre pacotes está boa, e a revisão diz isso. O que apodreceu é
**dentro** de alguns arquivos. `globals.css` é o pior caso e o mais barato de
partir — não tem lógica —, e ele cai quase de graça depois do V7: com quatro
moldes, o CSS deixa de ser por tela.

## R4 · O que a revisão achou e nós já tínhamos escrito

Não é demérito dela: é confirmação de que a tabela de lacunas está funcionando.
O que muda é a **posição na fila**, não a existência do item.

| Achado | Onde já está | O que a revisão acrescenta |
|---|---|---|
| Sem armazenamento de objeto; foto entra colando URL | lacuna, `ROADMAP.md:80` | que isso **bloqueia demonstração comercial**, não só a página — nas capturas dele, as imagens estavam quebradas |
| Sem componente de cliente no admin | lacuna, quatro vezes: `:78`, `:92`, `:95`, `:114` | que a nossa condição de entrada — *"quando houver uma segunda razão"* — já foi cumprida quatro vezes, e agora cinco com a busca global do V11. **A regra é que está segurando** |
| Split sem adquirente | lacuna | que não se vende split até existir conta |
| Fiscal sem emissor | lacuna | idem |
| Embedded Signup não provado contra a Meta | lacuna, `ROADMAP.md:84` | — |
| Ninguém clica nas telas | `CLAUDE.md` §1, escrito | que a saída não é mais e2e: é **barbearia de verdade operando** |

## A fila da Parte II

| # | Item | Pronto quando |
|---|---|---|
| R5 | **O primeiro componente de cliente**, com medição de pacote | Página pública continua 100% servidor; ilha de cliente só onde há estado por linha; **o build real precisa provar** que o chunk/CSS da ilha ficou exclusivo do admin e que o bundle/LCP público não regrediu. A guarda estática sozinha não fecha este item. Destrava cinco coisas: as quatro lacunas declaradas mais o V11 |
| R6 | Varrer todo título de bloco ✅ cuja lacuna correspondente está aberta | `verificar-lacunas.mjs` reprova título que promete o que a tabela de lacunas nega |
| R7 | Matriz de prontidão no `ROADMAP.md`, substituindo "129/129" | Toda linha tem origem verificável no código, e o `verify` reprova ❌ de integração descrito como pronto em qualquer lugar do repositório |
| R8 | Revisar o material de venda contra a matriz | Nenhuma frase comercial afirma o que a matriz marca ❌; o assistente é *"assistente de gestão"*, nunca *"IA que entende o negócio"* — ele é interpretador de catálogo fechado, e isso é convenção escrita, não limitação envergonhada |
| R9 | Armazenamento de objeto: envio, recorte, compressão, servido do nosso domínio | Foto entra por arquivo; a página pública não depende de host de terceiro; foto de cliente continua atrás do consentimento do bloco 74 |
| R10 | Partir `globals.css` por superfície | Testes de CSS continuam verdes lendo os arquivos partidos; nenhuma regra duplicada sobrevive à partição |
| R11 | Partir `admin-api.ts` e `acoes.ts` **por domínio** — `admin-api/clientes.ts`, `/financeiro.ts`, `/agenda.ts` | Cada módulo tem **uma responsabilidade dizível numa frase**. Contagem de linha fica como **alarme, nunca como definição**: 1.250 linhas coesas são melhores que 450 incoerentes, e um teto numérico faz alguém partir um arquivo no lugar errado para passar no portão |
| R12 | **Cronometragem contínua** com gente que nunca usou, mais operação assistida em 3–5 barbearias | Ver o protocolo abaixo. **Não é o item final: é o item zero, repetido.** Ele é o único juiz de V0–V11, e um juiz que só chega no fim não julga nada |

### O protocolo do R12

Cinco tarefas, cronometradas com alguém que nunca abriu o sistema, sem ajuda e
sem explicação prévia:

1. Encontre o cadastro do João Silva.
2. Agende o João para amanhã.
3. Veja quanto o João está devendo.
4. Veja quem é o próximo cliente a ser atendido.
5. Veja quanto a casa faturou hoje.

Medido **três vezes**: agora (linha de base), depois do V5, e depois do V11.
O resultado é uma tabela que nenhuma nota de 0 a 10 substitui:

```
Encontrar um cliente        antes 47s → depois 6s
Criar um agendamento        antes 38s → depois 12s
Saber o próximo atendimento antes 24s → depois 3s
```

**A primeira passada é a única que não dá para refazer.** Depois que o V1
existir, ninguém consegue mais medir quanto tempo se levava para achar um cliente
sem porta — e aí o programa inteiro passa a ser defendido com opinião, que é
exatamente o que este documento diz não aceitar sobre as notas da revisão.

E a operação assistida — recepcionista num sábado às 11h, barbeiro fechando
atendimento, dono conferindo dinheiro às 20h — roda **em paralelo** ao programa,
não depois dele. Esperar V0–V11 terminarem para colocar em barbearia é descobrir
no fim o que se descobriria na segunda semana.

---

**Sem posição na fila:** split e fiscal não entram enquanto não houver conta
contratada. Não é prioridade baixa — é dependência externa, e escrever código
contra um emissor que ninguém assinou é o defeito de `blocks` outra vez:
parâmetro aceito que ninguém preenche.

---
---

## Onde eu discordo, e por quê

**"Sair de ~40 opções para 6–7 áreas mentais."** O diagnóstico de densidade está
certo; a causa apontada, não. O menu já agrupa em sete módulos com sub-grupos,
nota explicativa e filtro por permissão e por plano. O que falta é mais estreito
e mais grave: **a porta dos clientes não existe** (V1), e configuração não está
separada visualmente do operacional (V4). Tratar o achado como veio faria
refazer a única parte que funciona.

**"Barbeiro talvez precise apenas de Hoje, Agenda e Clientes."** Já é assim desde
o bloco 126 — `/admin/meu-dia`, `/admin/meus-numeros`, e o resto some por
permissão. O que falta ao barbeiro é o mesmo que falta a todo mundo: V1.

**"Design 9,0–9,5 como alvo."** É consequência de V0–V11, não trabalho separado.
Entrando como redesenho isolado, sobe o acabamento e a simplicidade fica onde
está — que é exatamente o risco que a própria revisão nomeia na primeira linha.

**Sobre as notas.** Nenhuma é medida: o revisor não rodou o produto. O que dá
para medir é outra coisa, e é o que o R12 propõe — **quantos segundos uma pessoa
nova leva para achar a agenda, o cliente, o atendimento e o caixa.** Esse número
existe, dá para cronometrar, e é melhor que qualquer nota de 0 a 10.

---

## O que este backlog deliberadamente não tem

Funcionalidade nova. São **vinte itens** — doze na Parte I (V0–V11) e oito na
Parte II (R5–R12) —, e nenhum acrescenta módulo: doze consertam navegação e forma
do que já existe, quatro consertam a leitura do repositório e as integrações que
serão vendidas, dois partem monólitos, um resolve o armazenamento de foto, e um
troca engenharia por informação sobre o mundo real.
