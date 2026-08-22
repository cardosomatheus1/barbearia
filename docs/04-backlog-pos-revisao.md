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

Este programa vem antes de qualquer módulo novo. É o maior retorno disponível
agora, e é a única coisa aqui que não é opinião: as três medições que a revisão
pontuou mais baixo — facilidade de uso, acabamento e simplicidade — apontam
todas para navegação, nenhuma para funcionalidade faltando.

---

## Antes de qualquer coisa: o que já está construído

A revisão propõe quinze mudanças. **Quatro já existem**, e uma delas é
justamente a que ela chama de possível identidade do produto. Reconstruí-las
seria o pior desperdício deste backlog, então ficam com a prova de onde estão.

| Proposta da revisão | Situação | Onde está |
|---|---|---|
| "Sair de ~40 opções para 6–7 áreas mentais" | **feito, e com sub-agrupamento** | `secoes.ts` tem sete módulos — Visão geral · Atendimento · Financeiro · Marketing · Cadastros · Integrações · Administração —, cada tela com `grupo` (*O dia*, *Voz do cliente*, *Balcão*, *Fechamento*, *Envios*, *Retorno*, *Catálogo*, *Estrutura*, *Marca*, *A conta*, *Preferências*, *Obrigações*) e uma `nota` de uma linha dizendo o que é |
| "Cada perfil vê só o necessário" | **feito no bloco 126** | `modulosVisiveis(recursos, permissoes)` filtra por permissão **e** por recurso do plano. A recepcionista nunca viu quarenta destinos. O barbeiro tem telas próprias: `/admin/meu-dia` e `/admin/meus-numeros` |
| "Status consistente — não *Concluído* aqui e *Finalizado* ali" | **feito, com guarda** | `packages/core/src/vocabulario.ts`, `ROTULO_DO_ESTADO`. A tela não escreve texto de transição à mão, e há teste que reprova quem escrever |
| "Próxima melhor ação: três coisas precisam da sua atenção, com o botão ao lado" | **feito** | `insightsDoPainel` — no máximo três, ordenados pelo mais caro, cada um com o valor em reais e o destino que resolve |
| "Uma cor precisa significar alguma coisa" | **os tokens existem, a disciplina não** | `--color-success` · `--color-warning` · `--color-danger` estão no design system. O uso é que não é vocabulário fechado — vira V8 |
| "Transformar tabelas em interfaces" | **metade feita** | Não há um único `<table>` em `/dia`, `/agenda`, `/fila` ou `/painel`, e a fila já agrupa por estado em `<section>`. A agenda é que ainda é lista de compromissos, não linha do tempo — vira V9 |

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

Onze itens. A ordem é por dependência, e ela importa: **V1 a V3 são porta,
orientação e separação.** Sem eles, V6 a V9 consertam a decoração de um lugar
onde as pessoas continuam se perdendo.

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
- Filtros que a operação usa de verdade: em risco · VIP · assinante · com fiado
  em aberto · sem retornar há N dias.
- E o que a lista mostra por padrão quando ninguém filtrou nada: **quem tem
  horário nos próximos dias**, não a base inteira em ordem alfabética. Lista de
  mil e duzentos nomes ordenada por A é uma lista sobre a qual não se age.

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

[ Agendar ]  [ WhatsApp ]  [ Nova comanda ]        ← ação no contexto (V10)

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

**Pronto quando:** as cinco seções aparecem nessa ordem, e a tela responde a
pergunta do alto sem rolagem no notebook do balcão.

---

### V7 · Quatro moldes de página, e nenhuma tela fora deles

**O defeito:** cada página inventa o próprio arranjo, então a pessoa reaprende o
sistema a cada clique. É também a origem das 9.228 linhas de `globals.css`: CSS
por tela, e não por molde.

| Molde | Para | Forma |
|---|---|---|
| **A · Operacional** | dia, agenda, fila, recepção, comanda | título · estado do momento · ação principal · linha do tempo · contexto lateral |
| **B · Cadastro** | clientes, profissionais, serviços, estoque, pacotes | título + *Novo* · busca e filtros · lista · detalhe |
| **C · Gestão** | resultado, comissões, retenção, desempenho, plano | título · período · número principal · indicadores secundários · gráfico · detalhamento |
| **D · Configuração** | equipe, unidades, integrações, fiscal, segurança | seções de formulário, uma decisão por bloco |

**Pronto quando:** toda tela declara seu molde em `secoes.ts` e há guarda que
reprova tela sem molde — pela mesma razão que rota sem `@Exige` é recusada e não
liberada.

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

**Pronto quando:** nenhuma tela tem cartão dentro de cartão; e o contraste medido
de cada um dos três níveis continua passando em AA nos dois temas — hierarquia
por tamanho e peso **antes** de cor é regra escrita aqui, e cor é o que menos
funciona para quem tem baixa visão.

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

**Pronto quando:** o horário livre é alvo de toque de 44px na própria grade, em
qualquer largura; e a rolagem horizontal continua dentro do recipiente, nunca na
página.

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

**Dependência:** busca com estado por tecla é um **componente de cliente**, e cai
no bloqueio do R4 na Parte II.

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
| R5 | **O primeiro componente de cliente**, com medição de pacote | Página pública continua 100% servidor com o mesmo LCP medido; ilha de cliente só onde há estado por linha; o pacote do visitante anônimo **não cresce**. Destrava cinco coisas: as quatro lacunas declaradas mais o V11 |
| R6 | Varrer todo título de bloco ✅ cuja lacuna correspondente está aberta | `verificar-lacunas.mjs` reprova título que promete o que a tabela de lacunas nega |
| R7 | Matriz de prontidão no `ROADMAP.md`, substituindo "129/129" | Toda linha tem origem verificável no código, e o `verify` reprova ❌ de integração descrito como pronto em qualquer lugar do repositório |
| R8 | Revisar o material de venda contra a matriz | Nenhuma frase comercial afirma o que a matriz marca ❌; o assistente é *"assistente de gestão"*, nunca *"IA que entende o negócio"* — ele é interpretador de catálogo fechado, e isso é convenção escrita, não limitação envergonhada |
| R9 | Armazenamento de objeto: envio, recorte, compressão, servido do nosso domínio | Foto entra por arquivo; a página pública não depende de host de terceiro; foto de cliente continua atrás do consentimento do bloco 74 |
| R10 | Partir `globals.css` por superfície | Testes de CSS continuam verdes lendo os arquivos partidos; nenhuma regra duplicada sobrevive à partição |
| R11 | Partir `admin-api.ts` e `acoes.ts` por domínio | Nenhum arquivo de aplicação acima de ~1.200 linhas, com guarda que reprova o crescimento de volta |
| R12 | Operação assistida em 3–5 barbearias de verdade | Recepcionista num sábado às 11h, barbeiro fechando atendimento, dono conferindo dinheiro às 20h — com o que quebrou escrito. **É o único juiz de V1–V11** |

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

**"Design 9,0–9,5 como alvo."** É consequência de V1–V11, não trabalho separado.
Entrando como redesenho isolado, sobe o acabamento e a simplicidade fica onde
está — que é exatamente o risco que a própria revisão nomeia na primeira linha.

**Sobre as notas.** Nenhuma é medida: o revisor não rodou o produto. O que dá
para medir é outra coisa, e é o que o R12 propõe — **quantos segundos uma pessoa
nova leva para achar a agenda, o cliente, o atendimento e o caixa.** Esse número
existe, dá para cronometrar, e é melhor que qualquer nota de 0 a 10.

---

## O que este backlog deliberadamente não tem

Funcionalidade nova. Nenhum dos vinte e três itens acrescenta módulo: onze
consertam navegação e forma do que já existe, oito consertam a leitura do próprio
repositório e as integrações que serão vendidas, três partem monólitos, e um
troca engenharia por informação sobre o mundo real.
