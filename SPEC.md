# SPEC v2.0 — Plataforma Inteligente de Gestão para Barbearias

**Status:** Draft para desenvolvimento
**Tipo:** SaaS B2B2C / Multi-tenant
**Plataformas:** Web responsivo + PWA Cliente + PWA Profissional
**Mercado inicial:** Brasil
**Nome provisório:** `[NOME DO PRODUTO]`
**Base:** SPEC v1.0 + análise técnica de campo (SalonSoft/Domari) + benchmark de mercado

---

## Como ler esta spec

| Parte | Arquivo | Conteúdo |
|---|---|---|
| **0** | este arquivo | Visão, posicionamento, princípios, evidências, roadmap, métricas, planos |
| **1** | [`docs/spec/01-dominio-perfis-acesso.md`](docs/spec/01-dominio-perfis-acesso.md) | Multi-tenancy, hierarquia, perfis, RBAC, onboarding, LGPD, auditoria |
| **2** | [`docs/spec/02-motor-de-agendamento.md`](docs/spec/02-motor-de-agendamento.md) | Availability engine, agenda, recursos, fila de espera, walk-in, no-show |
| **3** | [`docs/spec/03-atendimento-vendas-financeiro.md`](docs/spec/03-atendimento-vendas-financeiro.md) | Check-in, comanda, PDV, Pix, comissões, split, estoque, DRE, fiscal |
| **4** | [`docs/spec/04-crm-retencao-marketing-ia.md`](docs/spec/04-crm-retencao-marketing-ia.md) | CRM 360º, assinaturas, pacotes, fidelidade, campanhas, WhatsApp, IA |
| **5** | [`docs/spec/05-plataforma-dados-api-nfr.md`](docs/spec/05-plataforma-dados-api-nfr.md) | Site público, marketplace, modelo de dados, API, eventos, NFRs, migração |

Pesquisa de base:
- [`docs/01-analise-salonsoft.md`](docs/01-analise-salonsoft.md) — engenharia reversa do concorrente em produção
- [`docs/02-benchmark-apps-barbearia.md`](docs/02-benchmark-apps-barbearia.md) — matriz competitiva e preços

---

# 1. Visão do produto

Uma plataforma que integra num único ecossistema: aquisição de clientes, página
pública, agendamento online, agenda inteligente, fila de espera, walk-in,
profissionais, CRM, comandas, PDV, pagamentos, Pix, assinaturas, pacotes,
fidelidade, cashback, comissões, split, estoque, compras, financeiro, fiscal,
marketing, WhatsApp, avaliações, BI, IA, multiunidade e marketplace.

O objetivo **não** é replicar SalonSoft, AppBarber, Trinks, Booksy, Fresha ou Avec.
É absorver o melhor conceito de cada um e entregar a integração que nenhum deles
entrega.

> **Da descoberta do cliente ao lucro da barbearia em uma única plataforma.**

---

# 2. Evidências de campo

Esta spec não parte de suposição. Foi feita engenharia reversa de um concorrente
real em produção — **SalonSoft**, no estabelecimento **Domari Barber Club**
(slug legado `boxseisbarbearia`) — e benchmark documentado de 5 plataformas.
Detalhes completos em [`docs/01-analise-salonsoft.md`](docs/01-analise-salonsoft.md).

## 2.1 O que o líder incumbente faz bem (copiar)

| Prática observada | Por que importa |
|---|---|
| **Zero fricção de conta** — agendar pede só nome + celular, sem senha, sem app, sem e-mail e **sem código** | Cliente de barbearia não instala app nem cria senha. Isto é decisivo. |
| **Código só para ver e cancelar** | Criar não exige prova de posse do número; cancelar o agendamento de alguém, sim. A fronteira está no lugar certo. |
| **OTP por WhatsApp, não SMS** — no fluxo de ver/cancelar | Entrega melhor e custo menor no Brasil |
| **Recuperação só pelo telefone** | Resolve "troquei de celular / limpei o navegador" sem sessão persistente |
| **Filtro de habilidade** (`get_profs_hab`) | Só oferece quem sabe fazer o serviço — evita agendamento inválido na origem |
| **Carrinho multi-serviço** com soma de duração antes de buscar slots | Corte + barba na mesma ida é o caso mais comum |
| **Checagem de disponibilidade antes de gravar**, com erro específico de corrida | Evita overbooking silencioso |
| **`working_plan` como JSON por dia com `breaks[]`** | Modelagem simples e suficiente |

**Requisito derivado:** o fluxo do cliente final desta plataforma **não pode ser
mais pesado que o do SalonSoft**. Qualquer passo adicional (senha, e-mail,
download, cadastro) é regressão competitiva.

## 2.2 Defeitos concretos encontrados (evitar por design)

Cada item abaixo virou requisito explícito nas partes 2 e 5.

| # | Defeito observado | Impacto | Onde é resolvido |
|---|---|---|---|
| D1 | **Grade fixa de 15 min** independente da duração do serviço | Fragmenta a agenda; serviço de 20 min começa 09:15 e deixa buraco morto | Parte 2 §2.4 — slot dinâmico |
| D2 | **Fuso vem do cliente** (`getTimezoneOffset()`) | Relógio errado ou cliente viajando vê grade deslocada | Parte 2 §2.9 — timezone server-side |
| D3 | **Resposta de slots sem metadados** — array plano de strings | Impossível dizer *por que* um horário sumiu; inviabiliza lista de espera e UI honesta | Parte 2 §2.5 |
| D4 | **Durações de combo não fecham** — "Cabelo + Barba" = 30 min, mas 20+20=40; "Cabelo + Barba + Sobrancelha" = 30 min por R$ 94 | Agenda subestima o tempo real → atraso acumulado diário. **É o bug operacional mais caro observado.** | Parte 5 §5.7 — validador de catálogo |
| D5 | **11 de 17 serviços em "Outros Serviços"**, `Sobrancelhas` em "Estética Facial" | Cardápio incompreensível assim que o agrupamento for ligado | Parte 5 §5.7 |
| D6 | **SPA sem SSR** — HTML inicial só tem `<title>Agende online</title>` | Zero indexação: nome, serviços, preços e endereço invisíveis ao Google | Parte 5 §5.1 |
| D7 | **Obriga escolher profissional antes de ver horário** | Quem quer "o mais cedo possível" abre cada barbeiro na mão | Parte 2 §2.6 — "Qualquer profissional" |
| D8 | **Sem endereço, mapa, telefone ou horário de funcionamento na página** | Metade das visitas é "onde fica?" e "está aberto?", não agendamento | Parte 5 §5.1 |
| D9 | **Serviço sem descrição e sem foto** — só nome, preço, duração | Em barbearia a escolha é visual | Parte 5 §5.1 |
| D10 | **Bundle único admin+cliente** entregue a visitante anônimo | Todo o mapa de API do produto exposto; payload desnecessário no celular do cliente | Parte 5 §5.9 — separação de bundles |
| D11 | **"Reagendar" existe no i18n mas não no fluxo** — na prática é cancelar e refazer | Perde o slot durante a troca | Parte 2 §2.7 |
| D12 | **Agendas fantasma** — 2 dos 4 "profissionais" são contas de balcão com jornada 08:00–23:00 todos os dias | Poluem relatório de ocupação e comissão | Parte 1 §1.4 — tipo de agenda |

## 2.3 O gap de mercado que define o posicionamento

O SalonSoft é **forte em back-office** (fiado, vale, pacotes, comissões, estoque —
mais completo que o Booksy nisso) e **fraco em tudo que é relacionamento com o
cliente final**: sem lista de espera, sem sinal, sem fidelidade, sem avaliação,
sem campanha de retorno, sem clube de assinatura.

É um ERP de salão com um agendador colado. **É aí que está o espaço.**

## 2.4 Realidade comercial (âncora de preço)

| Sistema | Preço |
|---|---|
| Entrada de mercado | R$ 30–50/mês |
| AppBarber | R$ 79,90/mês (1 prof.) · R$ 109,90/mês (2–5 prof.) |
| Fresha | grátis + **20% sobre cliente novo do marketplace** |

Uma barbearia de 2 cadeiras paga R$ 80–110/mês — **~1,5 corte**. Qualquer
funcionalidade que evite **2 no-shows por mês já se paga**. Isso justifica
priorizar lembrete, sinal e fila de espera antes de qualquer BI ou IA.

## 2.5 As três alavancas com maior retorno comprovado

1. **Lembrete automático** — barbearias que implementam agendamento online com
   lembrete relatam **redução de 40% a 70% nas faltas**, com o lembrete de **24h
   antes** como fator decisivo. Maior ROI isolado e barato de construir.
2. **Lista de espera** — converte cancelamento (perda total) em atendimento, sem
   ninguém fazer nada. Sexta e sábado é onde mais se perde dinheiro hoje.
3. **Clube de assinatura** — corte tem ciclo natural de 3–4 semanas; é o serviço
   mais assinável que existe. Transforma receita variável em receita mínima
   previsível. É o movimento estratégico de maior valor e **o SalonSoft não tem**.

---

# 3. Princípio central de UX — complexidade progressiva

O sistema terá muitas funcionalidades e **não deve parecer complexo**.

Barbearia pequena usa apenas:
> **Agenda → Cliente → Comanda → Pagamento**

Operação avançada habilita:
> **Marketing → Assinaturas → Estoque → BI → IA → Multiunidade → Split → Fiscal → Marketplace**

**Regras de implementação:**
- Todo módulo é ligável/desligável por `feature_flag` no tenant.
- Módulo desligado some do menu — não fica cinza, não fica "faça upgrade" em cada
  tela. Upsell existe em um lugar só.
- O default de um tenant novo é o conjunto mínimo. Nada é ligado sem ação.
- Nenhuma tela do fluxo mínimo pode depender de módulo avançado.

---

# 4. Regra de ouro

Cada funcionalidade nova deve responder **sim** a pelo menos uma pergunta:

1. Ajuda a conseguir mais clientes?
2. Aumenta a frequência dos clientes?
3. Aumenta o ticket médio?
4. Reduz custos?
5. Reduz trabalho operacional?
6. Reduz no-show?
7. Melhora a experiência?
8. Melhora a tomada de decisão?

Se não contribui claramente para nenhuma, **não entra no core**.

---

# 5. Experiência-alvo (ciclo completo sem intervenção administrativa)

```
Carlos vê o Instagram da barbearia
  └─> clica em Agendar  ────────────────────── deep link cai direto no serviço
       └─> escolhe Corte + Barba
            └─> seleciona João (ou "qualquer profissional")
                 └─> escolhe sexta 18h
                      └─> paga R$ 20 de sinal via Pix ─── só porque o score dele pede
                           └─> confirmação no WhatsApp
                                └─> lembrete 24h antes ── botão Confirmar / Remarcar
                                     └─> Carlos confirma
                                          └─> chega e faz check-in por QR Code
                                               └─> João é avisado
                                                    └─> comanda já contém Corte + Barba
                                                         └─> João adiciona uma pomada
                                                              └─> finaliza e Carlos paga
                                                                   │
   ┌───────────────────────────────────────────────────────────────┘
   ├─> estoque da pomada reduz
   ├─> comissão de João é calculada
   ├─> caixa recebe lançamento
   ├─> fidelidade recebe pontos
   ├─> fiscal é emitido (se aplicável)
   └─> Carlos recebe pedido de avaliação
        └─> sistema aprende: Carlos retorna a cada ~24 dias
             └─> no dia 21 dispara:
                  "Está chegando a hora do próximo corte.
                   João tem horários quinta e sexta. Quer reservar?"
                   └─> um toque ──> novo agendamento
```

**Esse ciclo é o produto.** Toda decisão de arquitetura deve ser avaliada pela
pergunta: *isso quebra alguma seta do ciclo?*

---

# 6. Diferenciais competitivos

O posicionamento **não** pode ser "temos agenda online" — isso virou commodity
(todas as 5 plataformas analisadas têm). Os diferenciais reais:

### 6.1 Agenda realmente inteligente
Slot dinâmico (não grade fixa), recursos, buffers, encaixe, recorrência, fila
inteligente. Resolve D1, D3, D7.

### 6.2 CRM específico de barbearia
Não é CRM genérico: guarda **"máquina 1 nas laterais, degradê médio, tesoura em
cima, sem navalha, atendimento silencioso"** e a foto do último corte. Nenhum
concorrente analisado faz isso bem.

### 6.3 Recorrência
Assinaturas + pacotes + rebooking em 1 clique. O maior gap do incumbente.

### 6.4 Redução de no-show
**Score de confiabilidade + sinal seletivo + fila automática.** O diferencial é o
*seletivo*: cobrar sinal de todo mundo espanta cliente novo; cobrar só de quem já
faltou protege a agenda sem custo de aquisição.

### 6.5 Crescimento
Detectar horário vazio e cliente que deveria ter voltado — e agir sozinho.

### 6.6 IA operacional
Não um chatbot genérico. IA ligada aos dados reais, que **consulta e não inventa**.

### 6.7 Rentabilidade, não faturamento
Mostrar quanto cada serviço, profissional, cadeira, cliente e assinatura realmente
**gera de resultado** — com CMV, comissão e taxa de cartão descontados.

---

# 7. Roadmap

## MVP — Release 1

> Critério de aceite global: uma barbearia de 2 cadeiras consegue **substituir o
> SalonSoft** e não perder nenhuma capacidade que usava. Sem isso, não há migração.

**Cliente**
- Página pública **com SSR** (resolve D6), endereço, mapa, horário, status
  aberto/fechado (D8), foto e descrição de serviço (D9)
- Deep link por serviço (`/{slug}/corte-barba`)
- Agendamento, OTP por WhatsApp, multi-serviço
- **"Qualquer profissional"** (D7)
- Meus agendamentos, cancelar, **reagendar de verdade** (D11)

**Empresa**
- Onboarding em 6 etapas, unidades, serviços com buffer, profissionais, jornada
  com exceções
- Agenda (dia/semana/lista) com drag-and-drop
- Clientes, check-in, comanda, checkout, caixa, comissão básica
- **Validador de catálogo** (D4, D5) rodando no onboarding e em background

**Automação**
- Confirmação, **lembrete 24h + 2h**, mensagem de retorno

**Gestão**
- Dashboard: faturamento, ocupação, clientes, serviços

**Plataforma**
- Multi-tenant, RBAC, auditoria, LGPD, **importador de base** (Parte 5 §5.8)

## Release 2 — Dinheiro e ocupação
Pix · pagamentos online · sinal/depósito · **lista de espera** · walk-in ·
fidelidade · pacotes · avaliações · produtos · estoque

## Release 3 — Recorrência e escala
Assinaturas · cobrança recorrente · split · financeiro completo · fiscal ·
marketing · WhatsApp avançado · múltiplas unidades

## Release 4 — Inteligência
IA · churn score · **no-show score** · campanhas inteligentes · previsão de
estoque · smart pricing · insights proativos · agente de WhatsApp

## Release 5 — Rede
Marketplace · descoberta geográfica · perfil público de barbeiro · anúncios ·
franquias · API pública

### Nota sobre a ordem
O sinal/depósito está no R2, não no MVP, **de propósito**: exige gateway,
conciliação e política de reembolso. Mas o **lembrete automático está no MVP**,
porque sozinho entrega 40–70% da redução de falta a uma fração do custo.

---

# 7.1 Distância entre esta spec e o que está construído

Esta seção existe porque uma spec que descreve o produto inteiro no presente
vira ficção assim que o código começa. O detalhe de cada item — o que já
funciona, o que falta e em que bloco entra — está na tabela
[Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada) do
`ROADMAP.md`, que é atualizada a cada bloco. Aqui fica só a leitura de alto
nível, agrupada pelo **motivo** de ainda não existir, porque é o motivo que
decide se algo é dívida ou sequência.

## A. Especificado, motor pronto, **sem caminho de escrita** — dívida

O único grupo que não é escolha de ordem. Aqui a spec descreve um comportamento,
o motor o implementa e é testado, e **nada no produto consegue produzir o dado
que o alimenta**. Campo que o motor aceita e ninguém preenche é mentira do
sistema, e o padrão já apareceu três vezes: `blocks`, `resource_pools` e
`schedule_exceptions`.

**Este grupo está vazio.** As três foram fechadas — recursos no bloco 13,
exceções de agenda no bloco 15 — e a última levou junto o `blocks`, que era o
mesmo `schedule_exceptions` com outro `kind`.

Grupo vazio não significa que não volte a acontecer: significa que hoje nenhum
campo que o motor lê está sem porta de entrada. Quando um novo aparecer, ele
entra aqui, e o [verificador de lacunas](#71-distância-entre-esta-spec-e-o-que-está-construído)
impede que o bloco responsável feche sem resolvê-lo.

Nota de correção histórica: `bloqueio pontual` e `folga/feriado` foram
registrados por um tempo como duas lacunas diferentes. São o mesmo
`schedule_exceptions`, separados só pelo `kind` — e a linha do bloqueio afirmava
ter "API", o que vendia demais: a API **respeitava** o bloqueio e recusava
agendamento em cima dele; criar um só era possível por SQL.

## B. Bloqueadas em infraestrutura que o projeto não tem — sequência, não dívida

Resolver qualquer uma destas significa construir a infraestrutura primeiro, o
que é outro bloco. Todas têm um contorno que funciona na barbearia de verdade
hoje.

| Lacuna | Depende de | Contorno atual |
|---|---|---|
| Convite do barbeiro | `app-pro` — sem a agenda dele o convite não leva a lugar nenhum | o profissional é criado pelo cadastro |
| Entregar a senha de primeiro acesso | canal transacional (provedor de WhatsApp + fila) | o dono entrega de viva-voz; a senha morre no primeiro uso |
| Marcar falta automaticamente | processo rodando fora de uma requisição | a recepção toca o botão; a tela mostra o relógio da tolerância |
| Painel que se atualiza sozinho | empurrão do servidor | recarga a cada ação; qualquer outra coisa seria pesquisa em laço |
| Enviar a foto em vez de colar o endereço | armazenamento de objeto | colar `https`; a barbearia já publicou as fotos em algum lugar |

## C. Ordem deliberada — construir antes seria construir sem consumidor

| Lacuna | Por que espera |
|---|---|
| ~~Fiado fora do MVP~~ | **Resolvido.** O roadmap o punha no bloco 52 e esta spec (§3.10) o marca como obrigatório para migrar. A contradição foi decidida a favor da spec: fiado subiu para o bloco 18, junto com o caixa, porque pagar fiado é forma de pagamento e receber fiado é movimento de caixa |
| Segundo fator para `finance.*` | nenhuma tela exige `finance.*` ainda. Há teste que reprova qualquer rota que passe a exigir antes de o MFA existir, então a regra não some por esquecimento |
| Faturamento do dia no balcão | é `finance.view`, e depende do item acima |

## D. Mecanismo pronto, falta a tela — legítimo adiar

A regra do projeto separa as duas coisas: mecanismo fecha no bloco em que a
necessidade aparece; **tela de administração para cadastrar o dado** espera o
bloco do admin correspondente. O que não é legítimo é o contrário — adiar o
mecanismo porque a tela ainda não existe, que é como se produz o grupo A.

| Lacuna | Mecanismo pronto | Bloco da tela |
|---|---|---|
| Editar as permissões de cada papel | `role_permissions` por barbearia, editável, valendo na requisição seguinte | 30 |
| Ler a trilha de auditoria | `audit_log` append-only, escrita na transação que muda o estado, leitura paginada por cursor | 21 |

---

# 8. Métricas

**North Star:** `Completed Appointments per Active Business`

Escolhida porque só sobe quando as três coisas dão certo ao mesmo tempo: a
barbearia adota, o cliente agenda e o cliente **comparece**.

**Complementares**

| Categoria | Métricas |
|---|---|
| Negócio (plataforma) | GMV · MRR · churn de tenant · CAC · payback |
| Adoção | % agendamentos online vs. recepção · unidades ativas · DAU de barbeiro |
| Saúde do tenant | taxa de ocupação · no-show · retorno em 45 dias · ticket médio |
| Recorrência | assinaturas ativas · MRR de assinatura do tenant · rebooking rate |
| Financeiro | pagamentos processados · % Pix · valor retido por sinal |

**Métrica de guardrail:** *tempo mediano do fluxo de agendamento do cliente*. Se
subir, alguma funcionalidade nova está cobrando pedágio no ciclo principal.

---

# 9. Planos comerciais

| Plano | Público | Inclui |
|---|---|---|
| **Starter** | barbeiro individual | agenda · clientes · agendamento online · caixa simples |
| **Pro** | barbearias | + equipe · comissões · estoque · WhatsApp · fidelidade · relatórios · assinatura |
| **Business** | rede | + multiunidade · financeiro avançado · split · BI · automações · IA |
| **Enterprise** | franquia | + franquias · API · SSO · SLA · BI centralizado |

Âncora: **Pro deve competir na faixa R$ 79–110/mês** (§2.4).

## 9.1 Receitas da plataforma

Não depender só de mensalidade:

| Fonte | Modelo |
|---|---|
| SaaS | mensalidade por plano/profissional |
| Payments | % sobre transação processada |
| Marketplace | comissão **só sobre cliente novo** trazido pela plataforma |
| WhatsApp | pacote de mensagens |
| IA | créditos/uso |
| Fiscal | add-on |
| Assinaturas | fee sobre cobrança recorrente |

**Regra:** comissão de marketplace jamais incide sobre cliente que a barbearia já
tinha. Cobrar sobre base própria é o que gera revolta contra Fresha e Booksy — e é
exatamente a brecha de posicionamento a explorar.

---

# 10. Posicionamento final

A plataforma não é "sistema de agendamento para barbearias" nem "ERP para
barbearias".

> **Uma plataforma operacional e de crescimento para barbearias, conectando
> aquisição, agenda, atendimento, pagamento, relacionamento e recorrência em um
> único sistema.**

O diferencial não é ter mais telas que o concorrente. É **conectar os dados entre
elas**:

```
agendamento → comanda → pagamento → comissão
                  ↓
                 CRM → recorrência → marketing → novo agendamento
                  ↓
            previsão de demanda → preço, escala e estoque
                  ↓
                 IA → próximo melhor movimento do gestor
```

Esse é o núcleo do produto.
