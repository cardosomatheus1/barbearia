# Benchmark — apps de barbearia e agendamento

Data: 2026-08-07

---

## 1. Os três modelos de negócio

Antes de comparar funcionalidade, é preciso separar o modelo — ele determina quem
é o dono do cliente.

| Modelo | Como funciona | Quem ganha | Exemplos |
|---|---|---|---|
| **Link direto / white-label** | A barbearia manda o próprio link. O cliente nunca vê concorrente. | A barbearia é dona da base | SalonSoft, Trinks, Belle, Simples Agenda |
| **Marketplace** | O cliente abre o app da plataforma e escolhe entre vários salões da região | A plataforma é dona da descoberta — e cobra por ela | Booksy, AppBarber, Fresha |
| **Vertical premium** | Sistema fechado para barbearia, com POS, folha e pagamento embutidos | Plataforma vira a infraestrutura financeira | Squire |

**Trade-off central:** marketplace traz cliente novo, mas te coloca ao lado do
concorrente e cria dependência. Fresha, por exemplo, cobra **20% de comissão sobre
agendamentos de clientes novos** vindos do marketplace. Link direto não traz
descoberta, mas o cliente é seu e o custo é fixo.

Para uma barbearia de bairro já estabelecida — caso da Domari — o modelo de link
direto é o certo. A descoberta já vem do Instagram e do boca a boca.

---

## 2. Matriz de funcionalidades

Legenda: ✅ tem · ⚠️ parcial/pago à parte · ❌ não tem

| Funcionalidade | SalonSoft | AppBarber | Trinks | Booksy | Squire |
|---|:--:|:--:|:--:|:--:|:--:|
| **Agendamento** |
| Agendamento online 24/7 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sem instalar app (link/PWA) | ✅ | ⚠️ | ✅ | ⚠️ | ✅ |
| Multi-serviço no mesmo horário | ✅ | ✅ | ✅ | ✅ | ✅ |
| Habilidade por profissional | ✅ | ✅ | ✅ | ✅ | ✅ |
| "Qualquer profissional disponível" | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Lista de espera** | ❌ | ✅ | ✅ | ✅ | ✅ |
| Fila de walk-in | ❌ | ⚠️ | ❌ | ⚠️ | ✅ |
| Encaixe manual | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| Reagendar pelo cliente | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Anti no-show** |
| Lembrete automático | ⚠️ (só admin) | ✅ | ✅ | ✅ | ✅ |
| **Sinal / pré-pagamento** | ❌ | ⚠️ | ✅ | ✅ | ✅ |
| Política de cancelamento | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Retenção** |
| Programa de fidelidade | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Clube de assinatura** | ❌ | ⚠️ | ✅ | ⚠️ | ✅ |
| Aniversariantes | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Pesquisa de satisfação | ❌ | ✅ | ✅ | ✅ | ✅ |
| Avaliações públicas | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Operação** |
| Comanda / caixa | ✅ | ✅ | ✅ | ✅ | ✅ |
| Comissões | ✅ | ✅ | ✅ | ✅ | ✅ |
| Estoque | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fiado / conta do cliente | ✅ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Vale / adiantamento | ✅ | ⚠️ | ⚠️ | ❌ | ✅ |
| Pacotes com sessões | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| POS / maquininha integrada | ❌ | ⚠️ | ⚠️ | ✅ | ✅ |
| **Marketing** |
| Descoberta por marketplace | ❌ | ✅ | ⚠️ | ✅ | ❌ |
| SEO / página indexável | ❌ | ⚠️ | ✅ | ✅ | ✅ |
| Fotos antes/depois | ✅ | ✅ | ✅ | ✅ | ✅ |
| Campanha de retorno | ❌ | ✅ | ✅ | ✅ | ✅ |
| Chatbot WhatsApp | ❌ | ⚠️ | ✅ | ❌ | ❌ |

**Leitura da matriz:** o SalonSoft é forte em **back-office** (fiado, vale,
pacotes, comissões — mais completo que Booksy nisso) e fraco em tudo que é
**relacionamento com o cliente final**: sem lista de espera, sem sinal, sem
fidelidade, sem avaliação, sem campanha de retorno. É um ERP de salão com um
agendador colado, não um produto de aquisição/retenção.

---

## 3. Preços praticados no Brasil (2026)

| Sistema | Faixa |
|---|---|
| Entrada de mercado (planos básicos) | R$ 30–50/mês |
| AppBarber | R$ 79,90/mês (1 prof.) · R$ 109,90/mês (2–5 prof.) |
| Trinks | orientado a operação maior (10+ profissionais) |
| Fresha | grátis + **20% sobre clientes novos do marketplace** |

Referência útil: uma barbearia de 2 barbeiros paga R$ 80–110/mês. Isso equivale a
**~1,5 corte por mês**. Qualquer funcionalidade que evite 2 no-shows por mês já se
paga sozinha — daí a centralidade de lembrete e sinal.

---

## 4. As funcionalidades que mais movem o ponteiro

Em ordem de retorno sobre esforço, com base no que o mercado reporta:

### 4.1 Lembrete automático — o maior ROI isolado
Barbearias que implementam agendamento online **com lembrete automático** relatam
**redução de 40% a 70% nas faltas**, sendo o lembrete de **24h antes** o fator
decisivo. Um segundo toque ~2h antes captura o esquecimento de última hora.

Só isso já muda o resultado do mês. É também barato de implementar.

### 4.2 Lista de espera — receita que já existe e está sendo jogada fora
O cliente entra na lista do dia; quando alguém cancela, o sistema avisa
automaticamente quem está na fila e o slot é preenchido **sem ninguém fazer nada**.

Converte cancelamento (perda total) em atendimento. Em horário de pico —
sexta e sábado — é onde a barbearia perde mais dinheiro hoje.

### 4.3 Sinal / pré-pagamento — mata o no-show de vez
Para serviço de ticket alto ou cliente com histórico de falta, cobrar sinal no
agendamento **elimina** o risco. O padrão de mercado é sinal condicional: só exige
de quem já faltou antes, ou só em serviços acima de X reais. Cobrar de todo mundo
espanta cliente novo.

### 4.4 Clube de assinatura — receita previsível
Plano mensal com N cortes + aparos. O sistema cobra recorrente no cartão e controla
o que o membro já usou e o que resta. Com dezenas de membros pagando mensalidade
fixa, a barbearia sabe a **receita mínima** do mês e consegue planejar mesmo na
baixa temporada.

Corte tem ciclo natural de 3–4 semanas — é o serviço mais assinável que existe.
É o movimento estratégico de maior valor da lista, e o que o SalonSoft não oferece.

### 4.5 "Qualquer profissional disponível"
Barato de fazer, remove atrito real. Boa parte do público quer **o horário**, não a
pessoa. Hoje o site obriga a escolher barbeiro antes de ver a grade — quem quer "o
mais cedo possível" precisa abrir cada profissional e comparar na mão.

---

## 5. Padrões de UX que os líderes seguem

1. **Slot dinâmico, não grade fixa.** Slots ancorados no fim do agendamento
   anterior em vez de grade rígida de 15 min — reduz buraco morto na agenda.
2. **Preço e duração sempre visíveis** antes da escolha (o SalonSoft acerta aqui).
3. **Confirmação no WhatsApp com botão de cancelar.** O cliente não volta ao site;
   ele responde a mensagem. Reduz no-show *e* reduz cancelamento tardio.
4. **Deep link por serviço.** `/{slug}/corte-barba` cai direto no passo 2 — o
   Instagram vira link de conversão, não de navegação.
5. **Foto e portfólio do barbeiro.** Em barbearia a escolha é por pessoa; foto do
   trabalho converte mais que descrição.
6. **Endereço, mapa e horário na própria página.** Metade das visitas é gente
   procurando "onde fica" e "está aberto?", não agendando.
7. **PWA instalável.** Ícone na home sem passar por loja de app — captura o
   cliente recorrente sem o custo de distribuição de app nativo.

---

## Fontes

- [AppBarber — Funcionalidades](https://www.appbarber.com.br/funcionalidades/)
- [AppBarber](https://appbarber.com.br/)
- [Trinks — Sistema para Barbearia: Agenda Online e Clube de Assinatura](https://negocios.trinks.com/negocios/barbearias/)
- [Trinks — Clube de Assinaturas para barbearias](https://blog.trinks.com/como-funciona-um-clube-de-assinaturas-para-barbearias/)
- [Trinks — Barbearia por assinatura: o que é e como funciona](https://blog.trinks.com/barbearia-por-assinatura-o-que-e-e-como-funciona/)
- [Fresha — Best Barbershop Software 2026](https://www.fresha.com/for-business/barber/best-barbershop-software)
- [Booksy Biz vs Squire (GetApp)](https://www.getapp.com/customer-management-software/a/booksy/compare/squire-barber-appointment-app/)
- [Squire vs Booksy 2026](https://www.wabery.com/blog/booksy-vs-squire-2026)
- [GlossGenius — Best barber software in 2026](https://glossgenius.com/blog/barber-software)
- [Opero — AppBarber alternativa: 5 sistemas para barbearia](https://operosistemas.com.br/blog/comercial/appbarber-alternativa-sistemas-barbearia-2026)
- [Barbeiro.app — Melhor sistema para barbearia em 2026](https://www.barbeiro.app/blog/melhor-sistema-para-barbearia-2026)
- [Barbeiro.app — Agendamento online para barbearia](https://www.barbeiro.app/blog/agendamento-online-barbearia)
- [Belio — Software de agendamento para barbearia 2026](https://blog.belio.com.br/artigos/software-agendamento-barbearia-2026/)
- [Frizzar — 7 funcionalidades que facilitam o dia a dia](https://frizzar.com.br/blog/app-para-barbearia-funcionalidades-dia-a-dia/)
- [BarbUp — Quanto custa um sistema de agendamento em 2026](https://barbup.com.br/blog/quanto-custa-sistema-agendamento-barbearia)
- [Navalha App — Melhor app de agendamento para barbearia](https://navalha.app/blog/melhor-app-agendamento-barbearia)
- [Minha Agenda Virtual](https://minhaagendavirtual.com.br/cuidados_pessoais)
- [EasyWeek — Software para barbearia](https://easyweek.pt/solutions/barbershop)
- [Reservio — Software de agendamento para barbearia](https://www.reservio.com/barbershop-software)
