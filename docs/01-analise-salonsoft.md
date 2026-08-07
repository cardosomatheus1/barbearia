# Análise técnica — SalonSoft Agende Online

Alvo: `https://agendeonline.salonsoft.com.br/boxseisbarbearia`
Data da análise: 2026-08-07

> O link do Instagram aponta para o slug `boxseisbarbearia`, mas o estabelecimento
> hoje se chama **Domari Barber Club**. O slug antigo continua resolvendo — o link
> na bio nunca quebrou apesar do rebranding.

---

## 1. Arquitetura

| Camada | Tecnologia |
|---|---|
| Front-end | Angular (SPA, build Ivy/webpack, `es2015` + fallback `es5`) |
| Renderização | 100% client-side — o HTML servido é só um shell com `<app-root>` e um spinner |
| i18n | ngx-translate (`/assets/i18n/pt-br.json`, `pt.json`, `en`, `es`) |
| API | REST em `https://www.salonsoftware.com.br/api/` |
| Auth do cliente final | OTP por WhatsApp/SMS (sem senha, sem cadastro) |
| Auth do lojista | Firebase Auth (`salonsoftapp.firebaseio.com`) |
| Realtime | Firebase Realtime DB — ref `salonsoft/appointment/` |
| Push | Firebase Cloud Messaging |
| Mídia | CloudFront com URLs assinadas e expiração |
| Pagamentos (SaaS) | Iugu (`js.iugu.com/v2`) — cartão e boleto |
| Assinatura de contrato | ClickSign |

**Achado relevante:** o `main.js` do agendamento público é o **mesmo bundle do
sistema de gestão completo**. O app do lojista e o app do cliente são uma única
aplicação Angular; só a rota muda. Isso significa que toda a superfície de API do
produto (financeiro, comissões, estoque, comandas) está descrita no JS entregue a
qualquer visitante anônimo. Não é vazamento de dados — os endpoints exigem token —
mas é o mapa completo do produto exposto de graça.

### Consequência de SEO (importante)

Sendo SPA sem SSR, o HTML inicial contém apenas `<title>Agende online</title>`.
Nenhum buscador indexa nome da barbearia, serviços, preços ou endereço. Para um
negócio local isso é um custo alto: a página de agendamento não gera nenhum
tráfego orgânico, só funciona como destino de link pago/bio.

---

## 2. Fluxo completo (todas as telas)

Reconstruído a partir do `pt-br.json` e da máquina de estados do componente
(`this.page = 1..N`).

```
┌─ Entrada: /{slug} ─────────────────────────────────────────────┐
│  GET /agendamentoonline/get_inicial_online/{slug}              │
│  → logo, nome, serviços, categorias, profissionais, moeda      │
│  Erros: "Estabelecimento não encontrado :("                    │
│         "Agendamento online não configurado"                   │
└────────────────────────────────────────────────────────────────┘
        │
        ├──> [Agendar]                    ├──> [Ver/Cancelar agendamentos]
        v                                  v
┌─ P1. Seleção de serviço ─────────┐   ┌─ Login por celular ──────────┐
│ lista com nome / preço / duração │   │ "Por favor, escreva o número │
│ "a partir de" quando há variação │   │  do celular usado p/ agendar"│
│ agrupamento por categoria (flag  │   │ GET envia_codigo_login/{tel} │
│ agrupar_categorias — aqui = 0)   │   │ POST confirma_codigo_...     │
└──────────────────────────────────┘   └──────────────────────────────┘
        v                                       v
┌─ P2. Seleção de profissional ────┐   ┌─ Meus agendamentos ──────────┐
│ GET get_profs_hab/{slug}/{svc}   │   │ GET get_agendamentos_clientes│
│ só quem é habilitado p/ o serviço│   │ status: agendado, confirmado,│
│ "Selecione um profissional para  │   │   finalizado, cancelado      │
│  visualizar seu horário"         │   │ ações: Cancelar / Reagendar  │
└──────────────────────────────────┘   │ vazio: "Você ainda não       │
        v                               │  realizou nenhum agendamento"│
┌─ P3. Data + horário ─────────────┐   └──────────────────────────────┘
│ POST get_horarios_profissional/  │              v
│ body: {id_salon, id_profissional,│   ┌─ Confirmação de cancelamento ┐
│        data, servicos[], tz}     │   │ "Tem certeza...?"            │
│ → ["09:00","09:15",...]          │   │ "Pense bem, pois não será    │
│ vazio: "Nenhum horário disponível"│  │  possível restaurar."        │
└──────────────────────────────────┘   │ POST cancela_agendamento_... │
        v                               └──────────────────────────────┘
┌─ P4. Carrinho ───────────────────┐
│ "Adicionar outro serviço" → volta P1 (multi-serviço na mesma visita)│
│ soma duração e preço do carrinho                                   │
└────────────────────────────────────────────────────────────────────┘
        v
┌─ P5. Identificação ──────────────┐
│ Nome (mín. 3 letras, exige nome + sobrenome) │
│ Celular (WhatsApp) com máscara por país      │
│ GET verifica_celular/{tel}/{slug}            │
└──────────────────────────────────────────────┘
        v
┌─ P6. Validação OTP — NÃO ACONTECE ───────────────────────┐
│ As chaves de i18n existem ("Para finalizar o agendamento │
│ é necessário validar seu número..."), mas o fluxo não    │
│ passa por aqui. Ver a correção abaixo.                   │
└──────────────────────────────────────────────────────────┘
        v
┌─ P7. Sucesso ────────────────────────────────────────────┐
│ "Seu agendamento foi realizado com {prof} em {salon}"    │
│ "{date} às {time}h"                                      │
│ POST post_agendamento/                                   │
│ Ações: Novo agendamento · Ver os meus agendamentos       │
└──────────────────────────────────────────────────────────┘
```

### Correção: agendar não pede código

A primeira leitura desta análise concluiu, a partir das chaves de i18n, que o
agendamento exigia validação por código. **Está errado.** O componente desmente:

```js
let a = { id_salon, id_profissional, data, horario,
          nome: this.register_user.name,
          codigo: "",                       // sempre vazio
          phone: ... };
this.appointmentProvider.doOnlineAppointment(a).subscribe(t => {
  100 == t.code ? (localStorage.setItem("online_user", ...), this.done = !0)
                : alert("time-not-available")
})
```

O campo `codigo` vai fixo em branco e o sucesso já marca `done`. Não há ramo
para "código necessário". E `sendScheduleSms` aparece **uma vez** no bundle — é
a definição; ninguém chama.

O código só existe no outro fluxo, o de **ver/cancelar** (`envia_codigo_login`,
`confirma_codigo_cancelamento`). Faz sentido: cancelar exige provar que o
agendamento é seu; criar, não.

Lição de método: chave de i18n prova que uma tela foi escrita, não que ela é
alcançável.

**Concorrência:** ao confirmar, se o slot foi tomado no meio do caminho, o app
mostra `"Este horário já não está mais disponível. Tente em um outro horário."` —
há verificação otimista via `appointmentAvailable(...)` antes de gravar.

---

## 3. API mapeada

### Agendamento online (público, sem auth)

| Método | Rota | Função |
|---|---|---|
| GET | `/agendamentoonline/get_inicial_online/{slug}` | Payload inicial da loja |
| GET | `/agendamentoonline/get_profs_hab/{slug}/{id_servico}` | Profissionais habilitados |
| POST | `/agendamentoonline/get_horarios_profissional/` | Motor de slots |
| GET | `/agendamentoonline/verifica_celular/{slug}/{tel}` | Checa cliente existente |
| GET | `/agendamentoonline/envia_sms/{...}` | Dispara OTP |
| POST | `/agendamentoonline/post_agendamento/` | Cria agendamento |
| GET | `/agendamentoonline/envia_codigo_login/{tel}` | OTP de login |
| POST | `/agendamentoonline/confirma_codigo_cancelamento/{...}` | Valida OTP |
| GET | `/agendamentoonline/get_agendamentos_clientes/{...}` | Histórico do cliente |
| POST | `/agendamentoonline/cancela_agendamento_cliente/{...}` | Cancela |

### Configuração (lado lojista)

`post_config_prof`, `post_prof_agendamento_online`, `post_working_plan` — ou seja,
quais serviços cada profissional aceita online e a jornada de trabalho.

### Módulos do sistema de gestão completo

Extraídos do bundle — é o escopo real do produto SalonSoft:

- **clientes** (21 endpoints) — cadastro, fotos antes/depois, histórico, saldo,
  **controle de fiado** (`get_controle_fiados`, `registra_pagamento_divida`),
  pacotes abertos/finalizados, próximos agendamentos
- **profissionais** (17) — habilidades por serviço (`post_hab`/`delete_hab`),
  config avançada, controle de acesso, histórico
- **servicos** (14) — CRUD, categorias, paginação, variantes p/ comanda e pacote
- **produtos** (7) — estoque com entrada/saída, categorias, fotos
- **pacotes** (7) — venda de pacotes com controle de sessões
- **comandas** (5) — abertura/fechamento/reabertura de caixa
- **comissoes** (6) — cálculo e histórico de pagamento por profissional
- **controlefinanceiro** (6) — faturamento, resumo, categorias de despesa
- **contaspagar**, **vales** (adiantamento a funcionário)
- **assinaturas** — cobrança do SaaS via cartão/boleto, upgrade de plano

### Motor de slots — comportamento observado

Requisição enviada:

```json
{
  "id_salon": "boxseisbarbearia",
  "id_profissional": "332448",
  "data": "2026-08-11",
  "servicos": [{"id_servico": "65547", "duracao": "20"}],
  "timezone": 180
}
```

Resposta: array plano de strings `["09:00","09:15",...,"17:30"]`.

Observações:
- Grade fixa de **15 min**, independente da duração do serviço (serviço de 20 min
  começa às 09:15 — gera fragmentação de agenda).
- O último slot respeita a duração: jornada até 18:00, serviço de 20 min, último
  slot 17:30 (não 17:45). Há checagem de fim de expediente.
- O `working_plan` suporta `breaks[]` (intervalos), aqui não usados.
- O fuso vem do **cliente** (`getTimezoneOffset()`), não do servidor — um cliente
  viajando ou com relógio errado pode ver a grade deslocada.
- Resposta sem metadados: não diz por que um horário sumiu (ocupado × fora da
  jornada × bloqueio), o que impede qualquer UI de "lista de espera".

---

## 4. Dados reais do estabelecimento

**Domari Barber Club** — moeda BRL, `mostrar_preco: sim`, `agrupar_categorias: 0`,
plano `assinante`.

### Equipe

| Profissional | Agendamento online | Jornada |
|---|---|---|
| Ruan | ✅ | Ter–Sáb 09:00–18:00 · Dom 09:00–13:00 · **Seg folga** |
| Gleidson | ✅ | Ter–Sáb 09:00–18:00 · Dom 09:00–13:00 · **Seg folga** |
| Recepcao | ❌ | Todos os dias 08:00–23:00 |
| Danilson | ❌ | Todos os dias 08:00–23:00 |

`Recepcao` e `Danilson` com jornada 08:00–23:00 todos os dias são claramente
**agendas de apoio** (encaixe/balcão), não barbeiros com expediente real. Só 2
profissionais recebem agendamento online.

### Cardápio (17 serviços)

| Serviço | Preço | Duração |
|---|---|---|
| Família | R$ 18,00 | 20 min |
| Pezinho | R$ 20,00 | 10 min |
| Sobrancelhas | R$ 20,00 | 15 min |
| Pigmentação Barba | R$ 25,00 | 30 min |
| Hidratação Capilar | R$ 30,00 | 25 min |
| Barba | R$ 35,00 | 20 min |
| Cabelo (Máquina zero ou pente único) | R$ 35,00 | 15 min |
| Pigmentação Cabelos | R$ 45,00 | 30 min |
| Barba + Pezinho | R$ 49,00 | 20 min |
| Cabelo (Tesoura e/ou Máquinas) | R$ 49,00 | 20 min |
| Cabelo (Tesoura) | R$ 49,00 | 25 min |
| Barboterapia | R$ 55,00 | 15 min |
| Cabelo + Sobrancelha | R$ 69,00 | 30 min |
| Cabelo Free Style | R$ 70,00 | 20 min |
| Cabelo + Barba | R$ 74,00 | 30 min |
| Cabelo + Barba + Sobrancelha | R$ 94,00 | 30 min |
| Cabelo + Barboterapia | R$ 95,00 | 30 min |

### Problemas de dados encontrados

1. **Durações dos combos não fecham.** `Cabelo + Barba` = 30 min, mas Cabelo (20) +
   Barba (20) = 40 min. `Cabelo + Barba + Sobrancelha` = 30 min para R$ 94 —
   impossível. A agenda está sistematicamente **subestimando o tempo real**, o que
   produz atraso acumulado ao longo do dia. É o bug operacional mais caro aqui.
2. **Categorias erradas.** `Barba + Pezinho` e `Sobrancelhas` estão em "Estética
   Facial"; 11 dos 17 serviços caíram em "Outros Serviços". Hoje isso não aparece
   porque `agrupar_categorias = 0`; se o lojista ligar o agrupamento, o cardápio
   fica incompreensível.
3. **Nenhum serviço tem descrição ou foto** — só nome, preço e duração.

---

## 5. O que o site **não** faz

Lacunas confirmadas por ausência de chave no i18n e de endpoint na API:

- ❌ Sem lista/fila de espera
- ❌ Sem sinal/pré-pagamento — nada previne no-show
- ❌ Sem cadastro de cartão ou pagamento online pelo cliente
- ❌ Sem programa de fidelidade ou clube de assinatura voltado ao cliente final
- ❌ Sem avaliações/reviews
- ❌ Sem endereço, mapa, telefone ou horário de funcionamento na página
- ❌ Sem descrição/foto de serviço e sem portfólio do barbeiro
- ❌ Sem "reagendar" de verdade — o status existe no i18n, mas o fluxo prático é
  cancelar e refazer
- ❌ Sem seleção "qualquer profissional disponível" (obriga a escolher pessoa
  antes de ver horário — atrito real: quem só quer "o mais cedo possível" precisa
  abrir cada barbeiro)
- ❌ Sem SSR/SEO, sem PWA instalável, sem deep link para serviço específico
- ❌ Sem indicação de intervalo/almoço na grade
- ❌ Sem confirmação por WhatsApp após o agendamento (o WhatsApp só é usado para
  o OTP)

---

## 6. Pontos fortes (o que copiar)

1. **Zero fricção de conta.** Sem senha, sem download, sem e-mail. Nome + celular
   + OTP no WhatsApp. Para barbearia isso é decisivo — o cliente não instala app.
2. **OTP por WhatsApp, não SMS.** Entrega melhor e custo menor no Brasil.
3. **Recuperação por telefone.** "Ver/Cancelar agendamentos" sem login persistente
   resolve o caso "troquei de celular / limpei o navegador".
4. **Habilidade por profissional.** `get_profs_hab` só oferece quem sabe fazer o
   serviço — evita agendamento inválido na origem.
5. **Carrinho multi-serviço** com soma de duração antes de buscar slots.
6. **Checagem de disponibilidade antes de gravar**, com mensagem específica de
   corrida.
7. **`working_plan` como JSON por dia** com suporte a `breaks[]` — modelagem
   simples e suficiente.

---

## Fontes

- [SalonSoft](https://www.salonsoft.com.br/)
- [SalonSoft — app](https://www.appsalonsoft.com.br/)
- [Salon Soft na Google Play](https://play.google.com/store/apps/details?id=br.com.salonsoft)
