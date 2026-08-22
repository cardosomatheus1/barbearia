# Backlog pós-revisão externa

Origem: revisão técnica externa do repositório, por leitura estática. **O revisor
não conseguiu executar a aplicação** e diz isso em letras — nenhuma nota daquele
texto é medição, e nenhuma deve ser citada como se fosse. Isso não enfraquece a
revisão: o melhor achado dela é documental, e o segundo é de navegação.

Este documento não é decisão tomada. É a fila proposta, com o que já existe
separado do que falta, e com a discordância escrita junto — backlog que engole a
discordância vira trabalho que ninguém sabe por que está fazendo.

---

## A tese

> Não é preciso simplificar o que o produto faz. É preciso simplificar o que o
> usuário precisa enxergar de cada vez.

E o alvo é operacional, não estético:

- **Funcionário novo, sem treinamento, em menos de 30 segundos:** onde está a
  agenda, o cliente, o atendimento e o caixa.
- **Dono, em segundos:** "como está minha barbearia hoje?"

Isso é reorganização de produto, não redesenho de CSS. Se só melhorarmos os
cartões, o acabamento visual sobe e a facilidade de uso não sai do lugar.

**Este programa vem antes de qualquer módulo novo.** É o maior retorno
disponível agora, e a única coisa aqui que não é opinião: as três medições que a
revisão pontuou mais baixo — facilidade de uso, acabamento e simplicidade —
apontam todas para navegação, não para funcionalidade faltando.

---

## Antes de qualquer coisa: o que já existe

A revisão propõe quinze mudanças. **Três já estão construídas**, e uma delas é
justamente a que ela chama de possível identidade do produto. Reconstruí-las
seria o pior desperdício deste backlog, então ficam escritas com a prova.

| Proposta da revisão | Situação | Onde está |
|---|---|---|
| "Sair de ~40 opções para 6–7 áreas mentais" | **feito, e com sub-agrupamento** | `secoes.ts` já tem sete módulos — Visão geral · Atendimento · Financeiro · Marketing · Cadastros · Integrações · Administração — cada tela com `grupo` (*O dia*, *Voz do cliente*, *Balcão*, *Fechamento*, *Envios*, *Retorno*…) e uma `nota` de uma linha explicando o que é |
| "Cada perfil vê só o necessário" | **feito desde o bloco 126** | `modulosVisiveis(recursos, permissoes)` filtra por permissão **e** por recurso do plano. A recepcionista nunca viu quarenta destinos. O barbeiro tem telas próprias (`/admin/meu-dia`, `/admin/meus-numeros`) |
| "Status precisam ser consistentes — não pode ser *Concluído* aqui e *Finalizado* ali" | **feito, e com teste** | `packages/core/src/vocabulario.ts`, `ROTULO_DO_ESTADO`. A tela não escreve texto de transição à mão; há guarda que reprova quem escrever |
| "Próxima melhor ação: 3 coisas precisam da sua atenção, com o botão ao lado" | **feito** | `insightsDoPainel` — no máximo três, ordenados pelo mais caro, cada um com o valor em reais e o destino que resolve. É o slide 4 da apresentação |
| "Uma cor precisa significar alguma coisa" | **os tokens existem** | `--color-success` · `--color-warning` · `--color-danger`. Falta a **disciplina de uso**, que é item real abaixo (P6) |

O que sobra da revisão depois desse corte continua sendo muito — e o primeiro
item é mais grave do que qualquer coisa que ela escreveu.

---

## O achado que vale o texto inteiro: **não existe porta para o cliente**

A revisão propõe "Clientes" como uma das sete áreas do menu. Ao conferir,
descobri que **não existe tela de clientes neste produto.** Não é que esteja mal
posicionada no menu: ela não existe.

A ficha (`/admin/cliente/[id]`, 1.760 linhas) só é alcançável **de lado**, a
partir de uma lista que por acaso contenha aquela pessoa:

| De onde se chega hoje | Só alcança quem… |
|---|---|
| `/admin/retencao` | está em risco de sumir |
| `/admin/lgpd` | abriu pedido de titular |
| `/admin/meu-dia` | tem horário hoje com aquele barbeiro |
| `/admin/campanhas` | entrou no público de alguma campanha |

Consequência exata: **um cliente que não está em nenhuma dessas quatro
situações é inalcançável pela interface.** O cliente fiel, que vem todo mês, não
falta, não reclama e não está em campanha nenhuma — o melhor cliente da casa —
é justamente o mais difícil de encontrar. A recepção que ouve *"quero ver o
cadastro do João"* não tem caminho.

Isso é a §6 pergunta 1 — *onde a pessoa entra* — no tamanho de uma entidade
inteira, e passou despercebido em 129 blocos porque **cada tela, sozinha,
funciona**: retenção lista quem está em risco e leva à ficha; a ficha abre e
mostra tudo. Nenhum teste fica vermelho por uma porta que ninguém abriu.

E há uma ironia registrada: o slide 13 da apresentação de venda chama a base de
clientes de *"o seu ativo"*. É o único ativo do produto sem porta de entrada.

---

## O programa de reorganização

Sete blocos. A ordem é por dependência: P1 e P2 são porta e orientação, e sem
eles o resto conserta a decoração de um lugar onde as pessoas se perdem.

### P1 · A porta dos clientes

**O defeito:** acima. Não há como chegar a um cliente que não esteja numa
lista de exceção.

**O que entra:**
- `/admin/clientes` como destino de primeira ordem no menu — módulo próprio,
  não dentro de Cadastros. Cliente não é cadastro: é o ativo.
- Busca por nome e por telefone (E.164 normalizado, que já é a chave de
  deduplicação), com o segmento derivado ao lado de cada linha — os segmentos
  já existem em `core`, calculados na leitura, e hoje só aparecem na ficha.
- Filtros que a operação usa de verdade: em risco, VIP, assinante, com fiado
  em aberto, sem retorno há N dias.
- A ficha ganha as abas que a revisão propõe: **Visão geral · Histórico ·
  Fidelidade · Financeiro** — e isso divide um arquivo de 1.760 linhas por
  consequência, não por refatoração separada.

**Pronto quando:** a recepção acha o João pelo nome em um campo, sem saber em
qual lista ele está; a ficha não passa de ~600 linhas por aba; e o teste de
navegação do bloco 126 cobre a porta nova nos dois sentidos.

**Cuidado:** a lista devolve cadastro de cliente, então declara `customers.view`
— e o segmento e o fiado **não** são `customers.view`. É a regra da rota que
agrega, quebrada oito vezes neste repositório. A nona não pode ser esta.

---

### P2 · Saber onde se está, em toda tela

**O defeito:** hoje o menu lateral acende o item, e é só. Não há migalha, e
`aria-label="Trilha"` existe em um lugar só — dentro da página de auditoria, e
como navegação de abas, não como caminho. A revisão descreve a sensação de dois
menus laterais competindo; o remédio é separar os papéis.

**O que entra**, como estrutura constante de toda página do painel:

```
Financeiro › Comissões          ← migalha: a área e a página
COMISSÕES                       ← título
o que a casa precisa pagar      ← a nota que já existe em secoes.ts
Visão geral │ Profissionais │ Regras │ Pagamentos   ← abas horizontais
─────────────────────────────────────────────────
conteúdo
```

Quatro níveis, e a regra que os separa: **o menu lateral escolhe onde estou no
produto; as abas horizontais escolhem onde estou dentro da área.** Nunca dois
menus verticais.

O barato aqui é que a migalha e a descrição **não são texto novo**: o módulo, o
nome e a `nota` já estão em `secoes.ts`. É derivar o que já existe, e é isso que
impede a migalha de discordar do menu no primeiro destino novo.

**Pronto quando:** toda tela registrada em `secoes.ts` desenha migalha derivada
do registro — com guarda que reprova quem escrever à mão —, e nenhuma página tem
dois níveis de navegação vertical ao mesmo tempo.

---

### P3 · "Hoje" como centro operacional, e o painel como leitura de gestão

**O defeito:** hoje `/admin/dia` e `/admin/painel` competem pelo mesmo papel, e
o assistente ainda é um terceiro. Quem opera não abre gráfico: abre para saber
quem chegou e quem é o próximo.

**O que entra** — separar os dois de vez:

**`/admin/dia` vira a home de quem opera.** Não um painel de indicadores: uma
central. A linha do tempo do dia com o próximo cliente em destaque, e ao lado
quatro leituras curtas — *Agora* (quantos esperando, quem está atrasado, próximo
em N min), *Hoje* (marcados, confirmados, aguardando, livres), *Caixa* (entrou,
comandas fechadas, abertas), *Atenção* (o que precisa de gesto agora).

**`/admin/painel` fica com a leitura do dono**, e conta uma história em vez de
enfileirar indicadores: como estamos hoje · ocupação da agenda · equipe ·
o que merece atenção · oportunidades. Os três insights de `insightsDoPainel` já
são a última seção — não se mexe neles, se mexe no que vem antes.

**Pronto quando:** quem abre `/admin/dia` não precisa rolar para saber quem é o
próximo cliente; e nenhum gráfico aparece em `/admin/dia`.

---

### P4 · Quatro moldes de página, e nenhuma tela fora deles

**O defeito:** cada página inventa o próprio arranjo, então a pessoa reaprende o
sistema a cada clique. É também o que faz `globals.css` ter 9.228 linhas.

**Os quatro moldes:**

| Molde | Para | Forma |
|---|---|---|
| **A · Operacional** | dia, agenda, fila, recepção | título · estado do momento · ação principal · linha do tempo · contexto lateral |
| **B · Cadastro** | clientes, profissionais, serviços, estoque | título + *Novo* · busca e filtros · lista · detalhe |
| **C · Gestão** | resultado, comissões, retenção, desempenho | título · período · número principal · indicadores secundários · gráfico · detalhamento |
| **D · Configuração** | equipe, unidades, integrações, fiscal | seções de formulário, uma decisão por bloco |

**Pronto quando:** toda tela declara seu molde em `secoes.ts`, e há guarda que
reprova tela sem molde — pela mesma razão que a rota sem `@Exige` é recusada e
não liberada.

---

### P5 · Menos caixa, mais hierarquia

**O defeito:** quando tudo é cartão, nada se destaca. Hoje há cartão dentro de
cartão, borda sutil sobre fundo escuro, e informação de terceira ordem com o
mesmo peso da primeira.

**O que entra:** três níveis declarados no design system, e só três.

1. **O que importa agora** — grande: o próximo cliente, o número do dia, a ação.
2. **Contexto** — médio: próximos, fila, caixa, alertas.
3. **Detalhe** — pequeno: horário de criação, origem, id, observação.

E a regra que substitui a caixa: o agrupamento vem de **espaço, alinhamento,
tamanho e peso** antes de vir de borda e sombra. Quatro indicadores em quatro
cartões viram uma composição só.

**Pronto quando:** nenhuma tela tem cartão dentro de cartão; e o contraste medido
de cada nível continua passando em AA nos dois temas.

---

### P6 · Cor com significado, e estado sempre visível

**O defeito:** os tokens semânticos existem e o uso não é disciplinado. Cor hoje
decora tanto quanto informa — e cor que decora ensina a pessoa a não olhar para
cor.

**O que entra:** a cor passa a ser vocabulário fechado, escrito onde não depende
de ninguém lembrar. Azul é ação e navegação; verde é concluído, recebido,
confirmado; amarelo é atenção; vermelho é problema; cinza é inativo. O resto da
interface é neutro.

E o estado de um atendimento vira sinal visual consistente — confirmado,
aguardando, chegou, em atendimento, finalizado, faltou — desenhado igual em
todas as telas, com o rótulo saindo de `ROTULO_DO_ESTADO`, que já é fonte única.

**Pronto quando:** a cor nunca carrega o dado sozinha (o rótulo está sempre
escrito, como já é regra no heatmap), e há guarda que reprova cor semântica usada
fora do significado declarado.

---

### P7 · Busca global e ação no contexto

**O defeito:** não existe busca global — conferido, não há nada. E várias ações
exigem sair de onde se está: para agendar para o João estando na ficha dele, a
recepção navega.

**O que entra:**
- Busca no topo (`Ctrl/⌘ + K`) que acha **cliente, agendamento e função**.
  Digitar *"comissão"* leva a Financeiro › Comissões. É o que faz um sistema
  grande deixar de parecer grande — e é o antídoto direto para quem não sabe onde
  uma tela mora.
- Ação onde o objeto está: vendo um cliente, *Agendar*; vendo uma comanda,
  *Receber*; vendo um horário vago, *Agendar cliente*; vendo estoque baixo,
  *Registrar compra*.

**Pronto quando:** qualquer destino de `secoes.ts` é alcançável pela busca sem
tocar no menu, com o resultado já recortado pela permissão de quem digita —
oferecer o que a pessoa não pode abrir é dizer a ela que existe um número que
ela não vê, que é informação por si.

**Dependência:** a busca com estado por tecla é um **componente de cliente**, e
cai no mesmo bloqueio de P8 abaixo.

---

## O resto da fila

Continua valendo, com peso menor que o programa acima.

| # | Item | Por quê | Pronto quando |
|---|---|---|---|
| P8 | **O primeiro componente de cliente**, com medição de pacote | Destrava cinco coisas de uma vez: as quatro lacunas já declaradas (`ROADMAP.md:78`, `:92`, `:95`, `:114`) mais a busca global do P7. A condição que nós mesmos escrevemos — *"quando houver uma segunda razão"* — já foi cumprida cinco vezes | Página pública continua 100% servidor, com o mesmo LCP medido; ilha de cliente só onde há estado por linha; o pacote do visitante anônimo **não cresce** |
| P9 | Varrer todo título de bloco ✅ cuja lacuna correspondente está aberta | `ROADMAP.md:151` marca o bloco 15 como concluído com o título *"Agenda: …, **arrastar**, …"*, e o `:78` declara o arraste como lacuna. Como "129 de 129" é somado sobre títulos, um título que promete demais infla o contador que decide quando o produto está pronto | `verificar-lacunas.mjs` reprova título que promete o que a tabela de lacunas nega |
| P10 | Matriz de prontidão por funcionalidade | Bloco fechado é um carimbo só sobre cinco coisas: motor, tela, integração real, e2e, produção. Split devolve `FakeSplitProvider` e `modoFiscal()` recusa tudo além de `nenhum`/`fake` — as duas com motor e tela completos | Toda linha tem origem verificável no código, e o `verify` reprova ❌ de integração descrito como pronto em qualquer lugar do repositório |
| P11 | Revisar o material de venda contra a matriz | Fiscal, split e sinal online não podem aparecer como entregues; e o assistente é interpretador de catálogo fechado, não IA generativa — *"assistente de gestão"*, nunca *"IA que entende o negócio"* | Nenhuma frase comercial afirma o que a matriz marca ❌ |
| P12 | Armazenamento de objeto: envio, recorte, compressão, servido do nosso domínio | Lacuna `ROADMAP.md:80`. Hoje a foto entra colando URL (`photo_url text`), e nas capturas do revisor as imagens estavam quebradas | Foto entra por arquivo; a página pública não depende de host de terceiro; a foto de cliente continua atrás do consentimento do bloco 74 |
| P13 | Partir `globals.css` (9.228 linhas) por superfície | Cai quase de graça depois do P4: com quatro moldes, o CSS deixa de ser por tela | Os testes de CSS continuam verdes lendo os arquivos partidos; nenhuma regra duplicada sobrevive à partição |
| P14 | Partir `admin-api.ts` (4.096) e `acoes.ts` (3.548) | Arquitetura entre pacotes está boa; apodreceu dentro de alguns arquivos | Nenhum arquivo de aplicação acima de ~1.200 linhas, com guarda que reprova o crescimento de volta |
| P15 | Operação assistida em 3–5 barbearias de verdade | Nenhum teste daqui responde isso, e está escrito no `CLAUDE.md` que ninguém clica nas telas. É o único juiz de P1–P7 | Recepcionista num sábado às 11h, barbeiro fechando atendimento, dono conferindo dinheiro às 20h — com o que quebrou escrito |

**Sem posição na fila:** split e fiscal não entram enquanto não houver conta
contratada. Não é prioridade baixa — é dependência externa, e escrever código
contra um emissor que ninguém assinou é o defeito de `blocks` outra vez.

---

## Onde eu discordo, e por quê

**"Sair de ~40 opções para 6–7 áreas mentais."** O diagnóstico de densidade está
certo; a causa apontada, não. O menu já agrupa em sete módulos com sub-grupos,
nota explicativa e filtro por permissão e por plano. O que falta é bem mais
estreito e bem mais grave: **a porta dos clientes não existe** (P1), e
configuração não está separada visualmente do operacional. Tratar o achado como
veio faria refazer a única parte que funciona.

**"Barbeiro talvez precise apenas de Hoje, Agenda e Clientes."** Já é assim
desde o bloco 126 — `/admin/meu-dia` e `/admin/meus-numeros`, e o resto some por
permissão. O que falta ao barbeiro é o mesmo que falta a todo mundo: a porta dos
clientes.

**"Design 9,0–9,5 como alvo."** É consequência de P1–P6, não trabalho separado.
Se entrar como redesenho isolado, sobe o acabamento e a simplicidade fica onde
está — que é exatamente o risco que a própria revisão nomeia.

**Sobre as notas.** Nenhuma delas é medida: o revisor não rodou o produto.
O que dá para medir aqui é outra coisa, e é o que P15 propõe — quantos segundos
uma pessoa nova leva para achar a agenda, o cliente, o atendimento e o caixa.
Esse número existe, e é melhor que qualquer nota de 0 a 10.

---

## O que este backlog deliberadamente não tem

Funcionalidade nova. Nenhum dos quinze itens acrescenta módulo: onze consertam
navegação e forma do que já existe, três consertam a leitura do próprio
repositório, e um troca engenharia por informação sobre o mundo real.
