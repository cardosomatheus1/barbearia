# Parte 4 — CRM, retenção, marketing e IA

← [SPEC.md](../../SPEC.md)

> **É aqui que o incumbente é fraco e o produto ganha.** O SalonSoft não tem
> fidelidade, clube de assinatura, avaliação, campanha de retorno nem churn score.
> Toda esta parte é território aberto.

---

## 4.1 CRM 360º

### Informações
nome · telefone · WhatsApp · e-mail · aniversário · foto · gênero (opcional) ·
unidade preferida · barbeiro preferido

### Histórico
visitas · serviços · produtos · pagamentos · avaliações · cancelamentos ·
no-shows · fotos

### Preferências — o diferencial de barbearia
Campo estruturado + texto livre. É o que nenhum concorrente faz bem e o que
realmente fideliza:

```
Máquina 1 nas laterais
Degradê médio
Tesoura em cima
Não usar navalha
Prefere atendimento silencioso
Alérgico a pós-barba com álcool
```

**Aparece na tela do barbeiro no check-in, sem ele precisar procurar.** Um
barbeiro novo atendendo cliente antigo e acertando o corte de primeira é a coisa
mais valiosa que este sistema pode entregar.

Campos estruturados sugeridos (viram filtro e template): `maquina_laterais`,
`tipo_degrade`, `topo`, `barba_estilo`, `produtos_evitar`, `conversa`.

---

## 4.2 Fotos do cliente

Com autorização LGPD explícita (Parte 1 §1.8).

O barbeiro registra **Antes** e **Depois**, vinculados ao atendimento. No
atendimento seguinte, consulta *"último corte"* com um toque.

**Requisitos:**
- Consentimento específico, com registro de data/IP/versão; revogável.
- Consentimento **separado** para uso em portfólio público — autorizar o registro
  interno não autoriza publicar.
- Acesso a fotos é permissão própria (`customers.view_photos`) e **auditado**.
- Armazenamento com URL assinada e expiração curta.

---

## 4.3 Timeline do cliente

```
10/07  Corte — João — R$ 60,00              ★ 5
25/06  Corte + barba — João — R$ 100,00     ★ 5
10/06  Comprou Pomada Modeladora — R$ 45,00
28/05  Cancelou (com 3 dias de antecedência)
14/05  Corte — Bruno — R$ 60,00             ★ 4
```

Uma linha do tempo única misturando atendimento, compra, avaliação, cancelamento,
assinatura e campanha recebida. É a tela que o barbeiro abre antes de atender.

---

## 4.4 Segmentação automática

Recalculada por evento, não por batch noturno.

| Segmento | Regra |
|---|---|
| **Novo** | primeiro atendimento |
| **Ativo** | retornou dentro do ciclo esperado |
| **Frequente** | alta recorrência (ciclo abaixo da mediana da base) |
| **VIP** | alto LTV (topo do decil de receita acumulada) |
| **Em risco** | não retorna há mais que sua média + desvio |
| **Perdido** | muito acima do tempo esperado (> 2× ciclo) |
| **Assinante** | assinatura ativa |

**Ponto-chave:** "Em risco" usa o **ciclo individual**, não um número fixo global.
Cliente que corta a cada 45 dias não está em risco no dia 30; cliente que corta a
cada 15 já está. Regra fixa de "60 dias sem voltar" — como fazem os concorrentes —
dispara campanha errada para metade da base.

---

## 4.5 Churn score

Probabilidade de abandono, com **explicação sempre**:

```
Carlos Souza — risco de churn: 78%

Por quê:
· normalmente retorna a cada 21 dias
· está há 45 dias sem retornar
· último atendimento recebeu nota 3
· não possui próximo agendamento
· barbeiro habitual (João) saiu da equipe

Ação sugerida:  [ Enviar campanha de retorno ]
```

Score sem explicação não gera ação — o dono não confia e ignora. A explicação é
requisito funcional, não enfeite.

**Sinais:** desvio do ciclo próprio · avaliação baixa recente · ausência de
agendamento futuro · saída do barbeiro preferido · cancelamento recente ·
assinatura vencida sem renovação · queda de ticket.

---

## 4.6 Assinaturas (clube)

> **A maior oportunidade estratégica.** Corte tem ciclo natural de 3–4 semanas — é
> o serviço mais assinável que existe. Transforma receita variável em receita
> mínima previsível. O incumbente **não tem**; Trinks e Squire têm e vendem forte.

### Planos
```
Essencial · R$ 89/mês
  2 cortes

Premium · R$ 149/mês
  cortes ilimitados
  2 barbas
  10% em produtos

VIP · R$ 249/mês
  corte ilimitado
  barba ilimitada
  prioridade na agenda
  bebida cortesia
```

### Regras configuráveis
serviços incluídos · quantidade · uso ilimitado · **cooldown** · unidades ·
profissionais · dias disponíveis · horários disponíveis · dependentes ·
desconto em produtos

**Cooldown é o mecanismo que torna "ilimitado" viável:**
```
Corte ilimitado, com mínimo de 7 dias entre cortes.
```
Sem cooldown, "ilimitado" é prejuízo garantido no primeiro assinante entusiasmado.

**Restrição de horário** protege o pico: assinante do plano Essencial pode não ter
acesso a sábado 09:00–13:00, o horário mais disputado. Isso precisa aparecer no
motor de disponibilidade (Parte 2 §2.4, passo 4).

### Dependentes
Plano família — o assinante inclui filhos. Cada dependente é cliente próprio, com
agenda e histórico, consumindo da mesma cota.

### Prioridade na agenda
Benefício concreto e vendável: assinante entra com peso maior na priority queue da
fila de espera (Parte 2 §2.9) e pode ter janela de antecedência maior.

### Cobrança recorrente
```
ativa · pendente · inadimplente · suspensa · cancelada
```

- Retentativas automáticas em régua (D+1, D+3, D+7).
- **Suspensão de benefício é gradual e avisada** — cortar o acesso no primeiro
  erro de cartão gera cancelamento por raiva, não por preço.
- Aviso de cartão prestes a vencer, 15 dias antes.
- Cancelamento **self-service** obrigatório. Obrigar a ligar para cancelar gera
  chargeback e reclamação — e é ilegal na prática do CDC.

### Rentabilidade da assinatura
Tela obrigatória: quanto cada plano **realmente** rende depois de comissão e CMV,
e quais assinantes estão dando prejuízo.

```
Plano Premium · 84 assinantes
Receita          R$ 12.516,00
Uso médio        2,7 cortes + 1,1 barba
Custo (comissão + insumo)  R$ 8.940,00
Margem           R$ 3.576,00  (28,6%)
⚠ 7 assinantes com uso acima do ponto de equilíbrio
```

Sem essa tela, o dono descobre que o clube dá prejuízo seis meses depois.

---

## 4.7 Pacotes

Diferente de assinatura: compra única, sem recorrência.

```
5 cortes por R$ 250,00
Comprado: 5 · Usado: 3 · Restante: 2 · Validade: 31/12/2026
```

Requisitos: validade configurável · transferível ou não · reembolso proporcional ·
consumo automático no checkout · aviso quando restar 1.

**Contabilmente:** a venda do pacote é receita **diferida** — reconhecida conforme
o uso, não na venda. Sem isso, o DRE mostra um mês excelente seguido de meses
falsamente ruins.

---

## 4.8 Fidelidade

O administrador escolhe **um** modelo (nunca os três ao mesmo tempo — confunde o
cliente):

| Modelo | Regra |
|---|---|
| **Pontos** | R$ 1 = 1 ponto; resgate em serviço ou produto |
| **Visitas** | a cada 10 cortes, 1 grátis |
| **Cashback** | 5% do valor volta como crédito |

Requisitos: validade dos pontos · exibição do saldo no app e no PDV · resgate
parcial · bloqueio de acúmulo sobre item já resgatado (evita loop).

---

## 4.9 Indicação

```
barber.app/ref/CARLOS92

Novo cliente ganha:  R$ 10,00
Carlos ganha:        R$ 10,00 — após o primeiro atendimento do indicado
```

**Anti-fraude obrigatório:** bloquear autoindicação por telefone/dispositivo ·
crédito só após atendimento **concluído e pago** · teto de indicações por período ·
revisão manual acima do teto · não creditar se o indicado cancelar ou faltar.

---

## 4.10 Avaliações

Após o atendimento: 1–5 estrelas + categorias opcionais (atendimento · qualidade ·
pontualidade · ambiente) + comentário.

**Avaliação só existe vinculada a atendimento real concluído.** Isso é o que torna
a nota confiável e é vantagem estrutural sobre review aberta de marketplace.

### Recuperação de avaliação negativa
Nota ≤ 3 **não vai imediatamente para o perfil público**. Abre alerta interno:

> ⚠ Cliente insatisfeito — Carlos Souza, nota 2, atendimento de hoje 14:00

O gerente pode: entrar em contato · oferecer retrabalho · gerar crédito ·
registrar resolução.

**Limite ético — obrigatório:** isso é uma janela de recuperação de serviço, **não
um filtro de censura**. Portanto:
- A janela é limitada (ex.: 48h). Depois disso a avaliação é publicada de qualquer
  forma.
- O cliente **nunca** é impedido de publicar em Google, Instagram ou qualquer
  plataforma externa.
- A nota interna e a média real **sempre** contam para o gestor e para os
  indicadores, mesmo quando não publicadas.
- O produto não pode oferecer "apagar avaliação ruim". Suprimir review é o que
  destrói a credibilidade de plataforma de avaliação — e é risco jurídico.

---

## 4.11 Marketing automation

Motor baseado em eventos, não em listas estáticas.

**Eventos-gatilho:** primeiro atendimento · aniversário · X dias sem retorno ·
assinatura vencendo · pacote acabando · cancelamento · avaliação positiva ·
avaliação negativa · horário ocioso · cliente VIP · produto comprado · serviço
realizado · vaga na fila de espera · churn score cruzou limiar

**Estrutura:** `gatilho → condição → atraso → canal → conteúdo → objetivo`

Toda automação declara o **objetivo mensurável** (ex.: gerar agendamento em 7
dias). Sem isso não há como desligar o que não funciona.

### Regras de proteção
- **Teto de mensagens por cliente por período** (default: 4/mês, todos os canais
  somados). Automação sem teto vira spam e queima o número de WhatsApp da
  barbearia.
- Respeito ao opt-out de marketing (transacional ≠ promocional).
- Janela de silêncio: nada entre 21h e 8h.
- Deduplicação: cliente não recebe duas campanhas no mesmo dia.

---

## 4.12 WhatsApp

API oficial, com templates aprovados.

### Confirmação de agendamento
> Olá, Carlos. Seu corte está confirmado para amanhã às 15h com João.

`[ Confirmar ]` `[ Remarcar ]` `[ Cancelar ]`

### Pós-atendimento
> Como foi seu atendimento?
> ⭐ 1–5

### Retorno
> Já faz 28 dias desde seu último corte. Quer reservar novamente com João?

`[ Agendar novamente ]`

### Requisitos
- Botão de cancelar dentro da mensagem **reduz no-show e reduz cancelamento
  tardio ao mesmo tempo** — o cliente não precisa voltar ao site, então avisa com
  antecedência em vez de simplesmente não aparecer.
- Cancelamento por WhatsApp dispara a fila de espera automaticamente.
- Número verificado da barbearia, não da plataforma.
- Custo por template é repassado/limitado por plano (SPEC §9.1).
- Fallback para SMS/push quando o WhatsApp falha.

---

## 4.13 Campanhas

**Filtros:** clientes inativos · aniversariantes · VIP · serviço · profissional ·
unidade · faixa de gasto · frequência · assinatura · segmento · churn score

**Canais:** WhatsApp · push · e-mail · SMS (opcional)

Toda campanha reporta: enviados · entregues · lidos · cliques · **agendamentos
gerados** · **receita atribuída**. A última coluna é a única que importa.

---

## 4.14 IA — princípios

Antes de qualquer funcionalidade de IA, três regras inegociáveis:

1. **A IA consulta dados estruturados e não inventa.** Toda resposta numérica vem
   de query, não de geração. Se o dado não existe, a resposta é "não tenho esse
   dado", nunca uma estimativa apresentada como fato.
2. **A IA sugere, o humano aprova** — em tudo que altera dinheiro, preço, agenda ou
   comunicação com cliente.
3. **Toda ação de IA é auditada** com o prompt, os dados consultados e a decisão.

---

## 4.15 IA — assistente do gestor

Chat integrado ao dashboard:

> Quanto faturei este mês?
> Qual barbeiro tem maior ticket médio?
> Quais horários estão mais vazios?
> Quantos clientes estão em risco de churn?
> Quanto perdi com no-show?
> Qual serviço dá maior margem?
> Minha assinatura é rentável?

Implementação: **text-to-query sobre um schema semântico restrito**, não SQL livre.
Um conjunto fechado de métricas e dimensões validadas, com escopo de tenant
aplicado na camada de dados — jamais confiando no prompt para isolar tenant.

Toda resposta traz o número, o período, a fonte e um link para a tela onde ele
pode ser conferido.

---

## 4.16 IA — agente de agendamento

Cliente escreve no site ou no WhatsApp:

> Quero cortar amanhã depois das 18h com o João.

```
Intent:        BOOK_APPOINTMENT
Service:       Corte
Professional:  João
Date:          tomorrow
After:         18:00
```

Consulta `/availability` (Parte 2) e responde:
> 18:20 · 19:00 · 20:10

> 19h.

Agenda.

**Requisitos:**
- O agente **nunca** calcula disponibilidade sozinho — sempre chama o motor. Uma
  única fonte de verdade.
- Confirmação explícita antes de gravar, com serviço, profissional, data, hora e
  valor.
- Escalada para humano quando a confiança é baixa ou em pedido do cliente.
- Nunca inventa serviço, preço, horário ou promoção.

---

## 4.17 IA — remarcação e recepção digital

**Remarcação**
> — Não consigo ir hoje.
> — Sem problemas. Quer remarcar com João? [horários]

Além de remarcar, dispara a fila de espera para o slot liberado — o cancelamento
vira receita para outro cliente na mesma conversa.

**Recepção digital**
> Quanto custa corte?
> Vocês abrem domingo?
> João trabalha sexta?
> Posso levar meu filho?

Respostas vêm **exclusivamente** dos dados configurados pela barbearia. Pergunta
sem resposta configurada → encaminha a um humano e **registra a lacuna**, para o
dono preencher. Essa lista de lacunas é, sozinha, um produto útil.

---

## 4.18 IA — campanhas

> Quero encher minha terça à tarde.

```
Nas últimas 8 semanas, terça entre 13h e 16h teve 42% de ocupação.
Existem 168 clientes ativos sem agendamento futuro.

Sugestão: campanha para quem cortou nos últimos 45 dias,
oferecendo 10% de desconto nesse horário.

Alcance estimado: 168 · Conversão esperada: 8–14 agendamentos
Receita estimada: R$ 520–910 · Custo em desconto: R$ 58–101
```

`[ Criar campanha ]` — o gestor aprova, edita ou descarta. Nunca dispara sozinho.

---

## 4.19 IA — insights proativos

O sistema identifica situações sem ser perguntado:

> Há 23 horários vagos amanhã entre 13h e 17h. Existem 96 clientes cujo ciclo médio
> de retorno vence hoje. Uma campanha para esse público pode ajudar a preencher.
> `[ Criar campanha ]`

> A pomada X deve acabar em ~9 dias pelo consumo das últimas 8 semanas.
> `[ Comprar 12 unidades ]`

> João está com 97% de ocupação há 6 semanas e recusou 14 pedidos de horário.
> Considere abrir a agenda de sexta até 21h.

**Limite:** no máximo 3 insights ativos por vez, ordenados por impacto financeiro
estimado. Painel com 20 alertas é painel ignorado.

---

## 4.20 Smart pricing / revenue management

O administrador cria regras:
```
Terça 13:00–16:00   → −10%
Sábado 09:00–13:00  → +10%
```

A IA **recomenda**, o administrador **aprova**:
> Sexta 17–20h está com 97% de ocupação há 8 semanas. Um reajuste de R$ 5 nesse
> período geraria ~R$ 1.240/mês, considerando demanda constante.

**Regras obrigatórias:**
- **Nunca alterar preço automaticamente** sem autorização configurada
  explicitamente.
- Preço mostrado ao cliente é **travado no momento da reserva**. Mudança de regra
  não altera agendamento já feito.
- Variação máxima configurável (default ±15%) — evita que o algoritmo produza
  preço que destrói a percepção da marca.
- Assinante **nunca** paga surge pricing; é benefício do clube.
- Desconto de horário ocioso não pode canibalizar o pico: se o cliente já
  agendaria no sábado, dar 10% na terça é perda. A regra deve mirar quem **não
  tem** agendamento futuro.

---

## 4.21 Performance, metas e gamificação

### Indicadores do barbeiro
faturamento · ticket médio · ocupação · clientes atendidos · retenção ·
**rebooking rate** · avaliação · produtos vendidos · assinaturas vendidas

`rebooking rate` — % de clientes que saem com o próximo horário marcado — é a
métrica mais preditiva de retenção em barbearia e quase ninguém mede.

### Metas
```
João · Meta de faturamento: R$ 15.000,00
Atual: R$ 12.400,00 — 82,6%
```

### Gamificação interna
Rankings de faturamento, vendas, avaliações e retenção.

**Desligável, e desligada por padrão.** Ranking público entre barbeiros produz
comportamento indesejado: disputa por cliente bom, empurrar produto e recusar
atendimento rápido. Quando ligada, o proprietário escolhe quais rankings são
visíveis para a equipe e quais só para ele.
