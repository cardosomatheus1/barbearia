# Direção visual — Barber Dock

Plano feito com a skill `frontend-design` antes de escrever CSS, como manda o
`CLAUDE.md` §5.

---

## Sujeito, público e a única tarefa da página

**Sujeito:** Domari Barber Club, Pituba, Salvador. Dois barbeiros, 17 serviços,
R$ 18 a R$ 95, terça a sábado 09:00–18:00, domingo até 13:00, segunda fechado.
Dados reais, extraídos da API do sistema atual.

**Público:** homem, 20–45, em Salvador, num Android de tela pequena, quase sempre
em pé, chegando pelo link da bio do Instagram.

**A única tarefa da página:** levar do toque no link até o horário escolhido com
o menor número de decisões. Endereço, mapa e horário de funcionamento servem ao
segundo visitante — o que veio perguntar "onde fica?" e "tá aberto?" —, e não
podem competir com a primeira tarefa.

---

## O risco assumido: o herói é a disponibilidade, não a foto

Toda página de barbearia abre igual: foto grande, nome por cima, botão
"AGENDE AGORA", e a agenda a três toques de distância.

Aqui a primeira coisa da página são **os próximos horários livres de hoje**,
renderizados no servidor, já tocáveis.

**Por que se justifica:** o visitante chegou do Instagram, onde já viu as fotos.
Ele não veio ver como é a barbearia; veio saber quando dá para ir. Abrir com a
resposta é a tese da página.

**O risco:** parece menos "premium" que uma foto em tela cheia. Aceito — a
página é ferramenta, não portfólio, e a foto continua presente logo abaixo.

---

## Cor

> **Atualizado quando a marca chegou.** As duas versões anteriores foram
> escolhas do projeto na falta de uma identidade: âmbar sobre quase-preto
> primeiro, depois o verde-menta da cadeira esmaltada. As duas caíram quando
> chegou o **Barber Dock** — logo, selo e dois mocks. Marca do cliente ganha de
> direção inventada, sempre.

A paleta é o selo: círculo azul-noite, campo de pergaminho, âncora, cordame e o
poste de barbeiro listrado.

| Papel | Valor | De onde vem |
|---|---|---|
| `surface` | `#071018` | o azul-noite do selo — tem matiz, não é preto |
| `surfaceRaised` | `#0C1822` | o mesmo casco, um degrau acima |
| `textPrimary` | `#F7F4EE` | a tinta branca do letreiro |
| `accent` | `#E1C39D` | o campo de pergaminho |
| `danger` | `#F0665A` | a listra do poste |

### O pergaminho é o acento, não o vermelho

No selo o vermelho é um detalhe pequeno e o creme é o campo inteiro: quem olha
de longe vê creme sobre azul. E há uma razão de produto mais dura — **vermelho já
significa "cancelar", "faltou" e "erro"** em trinta telas. Um "Agendar" vermelho
ao lado de um "Cancelar" vermelho é toque errado no balcão, com cliente na
frente.

O vermelho faz aqui o que faz no selo: aparece pouco. Tarja de seção, traço sob
a palavra do título, e o que remove dinheiro.

### O tema claro do admin é o mesmo pergaminho

Fundo `#F2ECE1` em vez de branco, e o acento inverte para o azul-noite do casco
— creme sobre branco não seria botão nenhum. É o que costura o admin à página
pública sem escurecer quem passa o dia na tela.

## Letra

Oswald condensada em caixa alta para o letreiro, DM Sans para o corpo. É o que o
selo faz — "BARBER DOCK" curvado em condensada pesada —, e sem isso a identidade
some, porque cor sozinha não diferencia.

As duas são servidas **do nosso domínio**, pelo `next/font`. O `@import` do
Google Fonts, que é como o mock chega, faria o navegador de cada cliente pedir a
fonte a um terceiro e entregar o IP dele junto: dado pessoal saindo da barbearia
a cada visita, por causa de uma fonte.

Oswald é do letreiro e das telas do cliente. O admin fica de fora de propósito:
ali a tela é densa e o título compete com quinze outras coisas, então ele segue
na sans com o tracking fechado. Densidade é diferente por app.

## Escala

A escala de espaçamento ganhou três degraus (`space-9`, `10`, `11`) e a
tipográfica outros três (`4xl`, `5xl`, `6xl`) quando a landing entrou. Não foi
capricho: a primeira versão dela usou a escala de produto e ficou apertada — o
que faz uma página parecer cara é ar, e ar não sai de uma escala desenhada para
caber comanda em 360px. Nenhuma tela de operação usa os seis.

## Tipografia

Sem fonte de rede. Duas razões: LCP abaixo de 2,5 s em 4G é regra, e fonte
carregada tarde desloca layout justo quando o cliente vai tocar num horário.

A personalidade vem de onde ela já existe neste assunto: **os números**. Horário,
preço, duração, número da máquina — o vocabulário da barbearia é numérico.

Tratamento:
- Numerais tabulares em tudo que é dado, para a coluna não dançar.
- Contraste de escala grande entre o número e seu rótulo (`09:20` grande,
  `com Ruan` pequeno).
- Tracking apertado nos horários; folgado nos rótulos em caixa alta.

O número é o elemento tipográfico, não um acessório do texto.

---

## Estrutura

Divisor com rótulo em vez de linha decorativa: `── CORTE ──────`. O rótulo é a
categoria real do cardápio, então a régua carrega informação.

**Sem marcadores numerados (01/02/03).** O cardápio não é sequência; numerar
seria decorar fingindo estrutura.

A duração fica numa coluna própria à esquerda do preço, porque é ela que decide
o que cabe no dia de quem está escolhendo.

```
┌────────────────────────────────────────┐
│ DOMARI BARBER CLUB          ● Aberto   │
│ Pituba, Salvador · fecha 18:00         │
├────────────────────────────────────────┤
│ HOJE                                   │
│ ┌─────┐┌─────┐┌─────┐┌─────┐          │
│ │09:20││09:40││10:00││10:20│  →       │
│ └─────┘└─────┘└─────┘└─────┘          │
│ com Ruan e Gleidson                    │
├────────────────────────────────────────┤
│ ── CORTE ───────────────────────────   │
│ Cabelo (Tesoura)      25 min   49,00   │
│ Cabelo + Barba        40 min   74,00   │
├────────────────────────────────────────┤
│ QUEM ATENDE   ·   ONDE   ·   HORÁRIOS  │
└────────────────────────────────────────┘
│         [ Agendar horário ]            │ ← fixo, com área segura
```

---

## Movimento

Quase nenhum, de propósito. Movimento ambiente é o que mais faz uma página
parecer gerada.

Só duas coisas se mexem, e ambas informam:
1. Resposta ao toque no chip de horário.
2. Sombra de rolagem na faixa de horários, indicando que há mais à direita.

`prefers-reduced-motion` desliga as duas.

---

## O acessório que foi removido

O plano tinha uma galeria de fotos de cortes. Cortada: caixa vazia esperando
conteúdo é pior que ausência. A capa única fica, e degrada para um fundo sólido
quando não existir.

---

## Revisão do bloco 11: o que o documento prometia e a tela não entregava

Escrito depois de olhar a página pronta, lado a lado com este texto.

**"A foto continua presente logo abaixo" era falso.** A página passou dez blocos
sem uma única imagem. A justificativa original — "não há foto real" — descrevia
o estado do banco, não uma decisão de desenho: as colunas `cover_url`,
`photo_url` e `logo_url` existiam desde o bloco 1 e o perfil público já as
devolvia. Faltava a **origem do dado**, que é o mesmo defeito que `blocks` teve
por oito blocos, com o agravante de estar à vista de qualquer visitante.

Corrigido no bloco 11: `/admin/fotos` dá à barbearia por onde preencher, e a
página exibe capa, rosto do barbeiro e foto do serviço. Enquanto não há
armazenamento próprio o endereço é colado, com validação de `https`.

**A régua de horários se sabotava.** Ela sai ordenada por horário, então os
primeiros catorze de um dia com 126 vagas eram `12:30 12:35 12:40 12:45` — a
mesma hora repetida, seguida de "e mais 122 horários". A tese da página é
"escolha quando", e a régua mostrava uma fila. Agora são seis horários
espalhados pelo dia, com as pontas presas: o primeiro livre e o último do
expediente.

**O nome do barbeiro saiu do cartão.** Ele repetia seis vezes o mesmo nome,
porque a grade vem colapsada por horário e o primeiro da fila ganha todos. Pior
que ruído: sugeria que só aquela pessoa estava livre. O cartão carrega o
horário, que é o que se escolhe; quem atende é o passo seguinte, e a seção
"Quem atende" agora mostra a equipe com rosto.

**Não havia layout de notebook.** Uma coluna só, esticada até 1280: a linha ia
de "Pezinho" na margem esquerda a "R$ 15,00" na direita, com mil pixels de nada
no meio. O wireframe deste documento era só de celular, e "ganha densidade
quando há espaço" (CLAUDE.md §5) nunca foi construído. A partir de 768 o
cardápio fica à esquerda e equipe, endereço e horários viram coluna de
referência à direita — que também conserta a hierarquia: as cinco seções tinham
exatamente o mesmo peso, e a política de cancelamento gritava tanto quanto o
preço do corte.

---

## Crítica antes de construir

| Escolha | É default? |
|---|---|
| Herói = disponibilidade | Não. Todo concorrente abre com foto + CTA. |
| Verde-esmalte sobre ardósia | Não é creme + terracota, nem quase-preto + ácido, nem broadsheet. |
| Números como tipografia | Vem do assunto; protege o LCP. |
| Divisor rotulado | Carrega a categoria real, não decora. |

**Onde ainda há default:** não há fonte de display. É uma concessão consciente
ao desempenho, compensada no tratamento dos numerais. Se o LCP sobrar folga
depois de medido, uma display condensada de sinalização entra numa revisão.
