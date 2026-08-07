# Direção visual — página pública

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

A paleta anterior (âmbar sobre quase-preto) era exatamente um dos três visuais
que a skill aponta como default de design gerado por IA. Tinha justificativa de
fachada — couro, latão —, mas paleta escura com um acento é o lugar mais
previsível possível.

A direção nova vem de um artefato concreto do ofício: **a cadeira de barbeiro
esmaltada em verde-menta**, com cromado, contra parede de azulejo.

| Papel | Valor | De onde vem |
|---|---|---|
| `ink` | `#141F1E` | ardósia esverdeada do azulejo — tem matiz, não é quase-preto |
| `inkRaised` | `#1D2B29` | a mesma parede, um degrau acima |
| `paper` | `#F1EEE8` | toalha, papel de barbear |
| `chrome` | `#A3B0AD` | cromado do apoio de braço |
| `enamel` | `#79D2B8` | o esmalte da cadeira — o acento |
| `brick` | `#FF8D7A` | tijolo à vista; erro e cancelamento |

Frio em vez de quente, e o acento é o mesmo verde que existe fisicamente numa
barbearia antiga. Contraste medido: nenhum par abaixo do mínimo, e a maioria com
folga de 6:1 ou mais.

---

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

O plano tinha uma galeria de fotos de cortes. Cortada: não há foto real, e caixa
vazia esperando conteúdo é pior que ausência. A capa única fica, e degrada para
um fundo sólido quando não existir.

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
