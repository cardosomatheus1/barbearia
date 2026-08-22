# Backlog pós-revisão externa

Origem: revisão técnica externa do repositório, feita por leitura estática.
**O revisor não conseguiu executar a aplicação** (o ambiente dele não baixou o
pnpm), e ele diz isso em letras. Então nada ali é comportamento observado: são
notas, arquitetura, contagem de linhas e leitura de documento. Isso não
enfraquece a revisão — o melhor achado dela é justamente documental —, mas
significa que **nenhuma nota daquele texto é medição**, e nenhuma deve ser
citada como se fosse.

Este documento não é decisão tomada. É a fila proposta, com o que já era lacuna
declarada separado do que é achado novo, e com o que eu discordo escrito junto —
porque backlog que engole a discordância vira trabalho que ninguém sabe por que
está fazendo.

---

## O que a revisão achou que nós **não** tínhamos escrito

Três coisas. As duas primeiras são as que valem o texto inteiro.

### R1 · O ROADMAP se contradiz sobre o arraste na agenda

`ROADMAP.md:151` marca o bloco 15 como **✅** com o título
*"Agenda: dia/semana/lista, **arrastar**, bloqueio pontual"*.
`ROADMAP.md:78` declara o arraste como lacuna aberta, sem bloco.

As duas linhas estão no mesmo arquivo. A tabela de lacunas está certa; o título
do bloco é que promete o que não foi entregue. E o defeito é maior que uma
linha: **"129 de 129" é contado sobre títulos de bloco**, e um título que
promete a mais infla o contador. Quem lê o contador — inclusive eu, ao fechar
bloco — lê um número que não significa o que parece.

Não é o único: qualquer título de bloco cuja lacuna correspondente esteja aberta
tem o mesmo problema. Ninguém varreu isso.

### R2 · Falta a matriz de prontidão por funcionalidade

Hoje só existe um eixo: bloco fechado ou não. Isso junta cinco coisas
diferentes num carimbo só. A revisão propõe cinco colunas, e ela está certa —
com estes valores de hoje:

| Funcionalidade | Motor | Tela | Integração real | E2E de verdade | Em produção |
|---|---|---|---|---|---|
| Agenda | ✅ | ✅ | — | ✅ | ✅ |
| Comanda / caixa / comissão | ✅ | ✅ | — | ✅ | ✅ |
| WhatsApp (Meta Cloud) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Stripe (cobrança) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Split de pagamento | ✅ | ✅ | ❌ `FakeSplitProvider` | ❌ | ❌ |
| Fiscal (NFS-e) | ✅ | ✅ | ❌ `FISCAL_MODO` só aceita `nenhum`/`fake` | ❌ | ❌ |
| Sinal cobrado online | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| Foto por upload | ❌ | ❌ (cola-se URL) | ❌ | ❌ | ❌ |

Os dois ❌ de integração eu confirmei no código: `adquirenteDoSplit()` devolve
`FakeSplitProvider` e `modoFiscal()` recusa qualquer valor que não seja
`nenhum` ou `fake`, com a mensagem *"não há emissor de verdade integrado"*.
Ambos já eram lacuna declarada — o que faltava era **a leitura de conjunto**,
que é o que impede vender o que não existe.

### R3 · Os monólitos internos

Medido no tip (bloco 129), sem `dist` e sem teste:

| Arquivo | Linhas |
|---|---|
| `apps/web/src/app/globals.css` | 9.228 |
| `apps/web/src/lib/admin-api.ts` | 4.096 |
| `apps/web/src/app/admin/acoes.ts` | 3.548 |
| `packages/finance/src/comanda.ts` | 2.091 |
| `apps/web/src/app/admin/cliente/[id]/page.tsx` | 1.760 |
| `packages/scheduling/src/booking.ts` | 1.714 |
| `packages/crm/src/whatsapp.ts` | 1.482 |

A arquitetura entre pacotes está boa e a revisão diz isso. O que apodreceu é
**dentro** de alguns arquivos. `globals.css` é o pior caso e o mais barato de
partir, porque não tem lógica: é o arquivo que mais cresce e o que ninguém olha
— e foi por isso que o teste de `min-width` precisou passar a ler ele, e não só
o design system.

---

## O que a revisão achou e nós **já** tínhamos escrito

Isto não é demérito dela — é confirmação de que a tabela de lacunas está fazendo
o trabalho. O que muda é a **posição na fila**, não a existência do item.

| Achado | Onde já está | O que a revisão acrescenta |
|---|---|---|
| Sem armazenamento de objeto; foto entra colando URL | lacuna, `ROADMAP.md:80` | que isso **bloqueia demonstração comercial**, não só a página. Nas capturas dele as imagens estavam quebradas |
| Sem componente de cliente no admin | lacuna, quatro vezes: `:78`, `:92`, `:95`, `:114` | que a nossa condição de entrada — *"quando houver uma segunda razão"* — já foi cumprida quatro vezes, e a regra é que está segurando |
| Split sem adquirente | lacuna | que não se vende split até existir conta |
| Fiscal sem emissor | lacuna | idem |
| Embedded Signup não provado contra a Meta | lacuna, `ROADMAP.md:84` | — |
| Ninguém clica nas telas | `CLAUDE.md` §1, escrito | que a saída não é mais e2e: é **barbearia de verdade operando** |

---

## Onde eu discordo, e por quê

**"Simplicidade 5,5 — 40 destinos no painel".** O diagnóstico está certo e a
causa nomeada está errada. Desde o bloco 126 o painel filtra por permissão **e**
por recurso do plano (`modulosVisiveis(recursos, permissoes)`): a recepcionista
não vê 41 destinos, vê os dela. O defeito real é outro e é mais estreito — **o
dono vê tudo no primeiro dia**, sem nenhuma revelação progressiva por adoção. A
correção não é esconder tela por papel (já é feito), é ordenar por maturidade da
casa. Se eu tratasse o achado como escrito, refaria uma coisa que funciona.

**"Design 7,5 — falta sensação de SaaS premium".** Opinião legítima, e é o único
item que eu poria por último. Ele não segura nenhuma venda, e a própria revisão
diz que o ativo do produto é a cadeia operacional — não o brilho.

**"A IA precisa ser posicionada com cuidado".** Concordo inteiramente, e não é
achado: é convenção escrita (*"integração de IA sem provedor contratado entra
como contrato com implementação local"*). `interpretadorLocal` é determinístico
de propósito. O trabalho aqui não é de código — é **não chamar de IA consultora
na apresentação de venda** o que hoje é um interpretador de catálogo fechado.
Isso é redação, e é grátis.

---

## A fila proposta

Ordenada pelo que destrava mais coisa por unidade de trabalho. Numeração a
partir de 130 é proposta, não decisão.

### Primeiro — o que custa pouco e conserta a leitura do produto

| # | Item | Por que aqui | Pronto quando |
|---|---|---|---|
| B130 | Varrer todo título de bloco ✅ cuja lacuna correspondente está aberta, e corrigir o título | R1. É uma tarde, e sem isso o contador mente para quem decide — inclusive para mim | `scripts/verificar-lacunas.mjs` passa a reprovar título que promete o que a tabela de lacunas nega |
| B131 | Matriz de prontidão por funcionalidade no `ROADMAP.md`, com as cinco colunas | R2. Substitui "129/129" por algo defensável | Toda linha da matriz tem origem verificável no código, e o `verify` reprova ❌ de integração descrito como pronto em qualquer lugar do repositório |
| B132 | Revisar o material de venda contra a matriz | Fiscal, split e sinal online não podem aparecer como entregues | Nenhuma frase comercial afirma o que a matriz marca ❌; "assistente de gestão", nunca "IA que entende o negócio" |

### Segundo — o que destrava mais de uma lacuna de uma vez

| # | Item | Por que aqui | Pronto quando |
|---|---|---|---|
| B133 | **O primeiro componente de cliente**, com medição de pacote | Destrava quatro lacunas de uma vez (`:78`, `:92`, `:95`, `:114`). A condição que escrevemos — "uma segunda razão" — já foi cumprida quatro vezes | Página pública continua 100% servidor e com o mesmo LCP medido; o admin ganha ilha de cliente onde há estado por linha; o pacote do visitante anônimo **não cresce** |
| B134 | Armazenamento de objeto: upload, recorte, compressão, servido do nosso domínio | Lacuna `:80`. É o que faz a página parecer produto na demonstração | Foto entra por arquivo; a página pública não depende de host de terceiro; a foto de cliente continua atrás do consentimento do bloco 74 |

### Terceiro — o que impede o próximo ano de ser pior que este

| # | Item | Por que aqui | Pronto quando |
|---|---|---|---|
| B135 | Partir `globals.css` (9.228 linhas) por superfície | R3, e é o mais barato: não tem lógica | Os testes de CSS existentes continuam verdes lendo os arquivos partidos; nenhuma regra duplicada sobrevive à partição |
| B136 | Partir `admin-api.ts` (4.096) e `acoes.ts` (3.548) por domínio | R3 | Nenhum arquivo de aplicação acima de ~1.200 linhas; guarda no `verify` que reprova o crescimento de volta |

### Quarto — o que só a operação real responde

| # | Item | Por que aqui | Pronto quando |
|---|---|---|---|
| B137 | Revelação progressiva do painel **por adoção**, não por papel | O defeito real por trás de "simplicidade 5,5" | Barbearia nova abre o painel e vê o caminho de um dia de trabalho; o resto aparece quando o dado que ele consome existe |
| B138 | Operação assistida em 3–5 barbearias de verdade | Nenhum teste daqui responde isso, e está escrito no `CLAUDE.md` que ninguém clica nas telas | Recepcionista num sábado às 11h, barbeiro fechando atendimento, dono conferindo dinheiro às 20h — com o que quebrou escrito |

### Sem posição na fila

Split e fiscal **não entram** enquanto não houver conta contratada. Não é
prioridade baixa: é dependência externa, e escrever código contra um emissor que
ninguém assinou é o defeito de `blocks` outra vez — parâmetro aceito que ninguém
preenche.

---

## O que este backlog deliberadamente não tem

Funcionalidade nova. A revisão termina dizendo que o perigo do projeto é
continuar construindo porque sempre há mais uma coisa interessante para
adicionar — e isso está certo. Nenhum dos nove itens acima acrescenta módulo:
sete consertam o que existe, dois trocam engenharia por informação sobre o
mundo real.
