# Análise do app na Meta — o que preencher

Roteiro do envio de `whatsapp_business_messaging` e `whatsapp_business_management`
para análise. Ele existe versionado junto do código porque **descreve o código**:
quando o fluxo mudar, esta página muda no mesmo commit.

Escrito na noite em que a primeira conexão de verdade foi feita, e o que ele
carrega de mais valioso são os dois erros que custaram tempo:

- O app estava em **desenvolvimento**. Nesse estado a Cloud API aceita a
  requisição, devolve um `wamid` e **bloqueia a entrega em silêncio**. Seis
  tentativas, seis `accepted`, nenhuma mensagem no celular.
- O app não estava **inscrito na WABA** (`subscribed_apps` vazio). Com isso a
  Meta nunca conta desfecho nenhum — nem entrega, nem falha, nem aprovação de
  texto. O produto passou a fazer isso sozinho no bloco 134.

---

## 0 · Antes de abrir o formulário

| | Onde |
|---|---|
| App publicado (**não** "Em desenvolvimento") | Painel do app → **Publicar** |
| Empresa verificada | WhatsApp Manager → Configurações |
| Forma de pagamento cadastrada | `business.facebook.com` → Cobranças |
| App inscrito na WABA | `GET /{waba-id}/subscribed_apps` não pode voltar `{"data":[]}` |
| Conta de teste criada, com número conectado e texto aprovado | painel do produto |

A conta de teste precisa continuar válida por **um ano** a partir do envio.

O papel de **Gerente** não tem `whatsapp.manage`, e não é possível criar uma
segunda conta de dono — a recusa é na borda e no domínio, de propósito. Então a
conta de análise é gerente **com a permissão concedida ao papel** em
Gestão → Equipe → Permissões. Isso vale para todos os gerentes daquela
barbearia: use a de demonstração, nunca a de um cliente.

---

## 1 · Configurações do app → Básico

| Campo | Valor |
|---|---|
| Nome de exibição | `Barber Dock` |
| Domínios do aplicativo | `barberdock.com.br` |
| URL da Política de Privacidade | `https://barberdock.com.br/privacidade` |
| URL dos Termos de Serviço | `https://barberdock.com.br/privacidade` |
| Exclusão de dados do usuário | `https://barberdock.com.br/privacidade` |
| Plataforma | **Site** → `https://barberdock.com.br` |

Os três endereços apontam para a mesma página porque hoje ela é a única peça
jurídica publicada, e ela cobre os três assuntos: quem é controlador, quem é
operador, por quanto tempo o dado fica e como pedir exclusão. Quando existir uma
página de termos separada, só a terceira linha muda.

**Nunca aponte esses campos para `facebook.com`.** Era o estado inicial do app, e
significa declarar que as suas condições de serviço moram no site da Meta.

---

## 2 · Uso permitido

**Descrição do negócio**, nas duas permissões:

```
Barber Dock is a management platform for barbershops in Brazil: appointments,
point of sale, customer records and customer communication.
```

### `whatsapp_business_messaging`

```
Barber Dock is a management platform for barbershops in Brazil. Each barbershop
connects its own verified WhatsApp Business number, and this permission is what
lets the platform send service messages from that number to that barbershop's
own customers.

HOW THE APP USES IT
The app sends template messages that Meta has already approved, triggered by
events inside the barbershop's own operation:
- appointment confirmation, and reminders 24 hours and 2 hours before;
- "it is your turn" when the barbershop calls the next person in the walk-in
  queue;
- a return invitation for customers who have not been back in a while.
The app also receives the delivery status of those messages and the customer's
reply when they tap a quick-reply button (confirm, reschedule, cancel, or stop
receiving promotions), and acts on it inside the appointment.

VALUE TO THE PERSON USING THE APP
No-shows are the single largest loss for a small barbershop: an empty chair
cannot be resold. Reminders sent to the channel Brazilian customers actually
read cut that loss, and the queue notification means a walk-in customer can wait
somewhere else instead of standing in the shop.

WHY IT IS NECESSARY
Without this permission the platform cannot deliver any of it. The barbershop
would go back to typing messages one by one from a personal phone, which does
not respect opt-out, does not respect quiet hours, and does not come from the
number the customer has saved.

SCOPE AND LIMITS
Recipients are only customers the barbershop itself registered. Nothing is sent
between 9pm and 8am in the barbershop's own timezone. Marketing templates carry
an opt-out button and the app stops sending to anyone who uses it. The app does
not send bulk or unsolicited messages, does not upload or retrieve media, and
never messages a number outside the barbershop's own customer base.
```

**Screencast:** login → Atendimento → Fila → cadastrar cliente → **Chamar** →
a mensagem chegando no celular.

### `whatsapp_business_management`

```
Barber Dock is a management platform for barbershops in Brazil. Each barbershop
connects its own WhatsApp Business Account, and this permission is what lets the
platform manage the messaging assets inside that account on the barbershop's
behalf.

HOW THE APP USES IT
- Message templates: the barbershop writes the text of a message in our admin
  panel — an appointment reminder, a queue notification, a return invitation.
  The app submits it to Meta for approval, reads the resulting status, and shows
  it in the panel. When Meta rejects a template, the app shows Meta's own reason
  so the barbershop can correct the text and resubmit.
- Phone number: the app reads the connected number, its display name, its
  verification state and its quality rating, so the barbershop can see the state
  of its own channel.
- Webhook subscription: the app subscribes to the WhatsApp Business Account to
  receive template approval updates and message delivery status.

VALUE TO THE PERSON USING THE APP
A barbershop owner does not know what a template is, and should not have to
learn. Without this, they would have to open WhatsApp Manager, write the message
in Meta's own interface, wait, come back, and copy an identifier into our
platform. Here they write the text in the same screen where they decide which
message goes out, and the approval status appears next to it.

WHY IT IS NECESSARY
A message can only be sent from an approved template. Managing templates is not
an accessory to the messaging permission — it is the only way the barbershop can
create the messages it is allowed to send.

SCOPE AND LIMITS
The app only reads and writes inside the WhatsApp Business Account that the
barbershop itself authorized and connected. It does not access assets of any
business that has not granted access, and it does not create or manage QR codes,
ads, or catalogs.
```

**Screencast:** login → Crescimento → WhatsApp → **Mandar um texto para
aprovação** → preencher → enviar → o texto na lista com o estado.

### Sobre a sugestão automática da Meta

**Não use o botão "Use This".** O texto que a IA dela escreve promete o que o
produto não faz — *"upload and retrieve media from messages"* e *"create and
manage QR codes"* apareceram nas duas sugestões. O analista procura no vídeo o
que a descrição prometeu, e o que ele não achar vira reprovação.

Negar explicitamente o que a permissão **poderia** fazer e o app não faz é o
oposto disso, e reduz a superfície que ele vai procurar.

---

## 3 · Tratamento de dados

| Pergunta | Resposta |
|---|---|
| Operadores de dados? | **Sim** |
| Nome | `Contabo GmbH` — e o provedor do bucket, se `MEDIA_STORAGE=s3` |
| Categoria | Soluções e serviços de TI, incluindo armazenamento e processamento na nuvem |
| Países | Alemanha, mais a região do VPS se for outra |
| Controlador | a **razão social do CNPJ**, igual à empresa verificada |
| País do controlador | Brasil |
| Pedidos de segurança nacional em 12 meses | **Não** |
| Políticas aplicadas a pedidos de autoridades | as quatro primeiras |

As quatro políticas são adotáveis por uma empresa de uma pessoa, e a quarta o
produto já cumpre por construção: `audit_log` é append-only e registra todo
acesso a dado pessoal. Mas marque **querendo cumprir** — é declaração jurídica, e
o parágrafo correspondente precisa existir na política de privacidade.

Não liste Stripe nem emissor fiscal: nenhum dos dois recebe dado vindo da Meta.

---

## 4 · Instruções de teste para web

**Onde encontrar o app:** `https://barberdock.com.br/admin/entrar`

**Login do Facebook integrado:** **Sim** — o botão "Conectar WhatsApp" abre o
Facebook Login for Business com a configuração de Embedded Signup. Teste o botão
antes de enviar: o clique de ponta a ponta é lacuna declarada no `ROADMAP.md`, e
analista que clica num botão quebrado reprova.

**Instruções:**

```
Barber Dock is a management platform for barbershops in Brazil. Each barbershop
connects its own WhatsApp Business number and uses it to talk to its own
customers. Log in with the test credentials provided below.

FACEBOOK LOGIN FOR BUSINESS / EMBEDDED SIGNUP
1. After logging in, open "Crescimento" > "WhatsApp".
2. Click "Conectar WhatsApp". This starts Facebook Login for Business with our
   Embedded Signup configuration, so the barbershop can authorize its own
   WhatsApp Business Account without copying identifiers by hand.
3. We request whatsapp_business_management and whatsapp_business_messaging in
   that flow, and we store the returned access token encrypted, scoped to that
   single barbershop.

whatsapp_business_management — templates and phone number
4. On the same screen, the connected number and the approved message templates
   are listed; both are read from the WhatsApp Business Account through the API.
5. Open "Mandar um texto para aprovação", write a name and a message body, and
   submit. The app creates the template in that account and shows its status.
   When Meta rejects one, we display Meta's own reason.

whatsapp_business_messaging — sending a message
6. Open "Atendimento" > "Fila".
7. Under "Chegou agora", add a customer with a name and a phone number.
8. Click "Chamar". The app sends the approved "sua_vez" template to that
   customer, telling them it is their turn. The delivery status is then shown in
   the customer's record.

We do not send bulk or unsolicited messages, do not upload or retrieve media,
and only message customers registered by the barbershop itself.
```

**Credenciais de teste:** as da conta de análise, com a frase dizendo que a
barbearia tem número conectado, texto aprovado e clientes de exemplo.

**Códigos de loja e geo-blocking:** vazios.

---

## Depois de enviar

O passo 8 do roteiro — *"the delivery status is then shown in the customer's
record"* — só é verdade a partir do bloco 134. Antes disso a ficha não mostrava
nada, e a tela dizia "Mensagem enviada" sobre uma mensagem que a Meta tinha só
aceitado. Se este documento for reaproveitado num produto anterior a esse bloco,
tire a frase: descrever o que a tela não faz é o jeito mais rápido de reprovar.
