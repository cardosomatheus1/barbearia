# Roadmap de execução

Companheiro do [`SPEC.md`](SPEC.md). A SPEC diz **o que** o produto é; este
documento diz **em quantas partes** ele é construído e em que ordem.

**Status: 12 de 78 blocos.**

---

## O que é um bloco

Uma unidade de trabalho que termina **commitada, com teste verde e uma
capacidade nova real**. Não é uma sessão nem um dia — é um incremento que se
sustenta sozinho e pode ser revisado isoladamente.

**Nenhum bloco é dado como concluído sem cumprir o
[Definition of Done](CLAUDE.md#definition-of-done) do `CLAUDE.md`** — testes,
segurança, desempenho e arquitetura. `pnpm verify` é o portão.

---

## Aviso sobre este número

A primeira versão deste roadmap estimava 41 blocos. Estava errada: contava o que
estava escrito nas cinco partes da SPEC, e a SPEC descreve o **produto**, não a
**plataforma que o sustenta**.

Faltavam, por inteiro:

- o app do barbeiro (`app-pro`) — a SPEC pede três aplicações, o orçamento cobria duas;
- o Super Admin (Parte 1 §1.2) — seção escrita, zero blocos;
- a cobrança das barbearias — é o modelo de negócio, sem ele não há SaaS;
- infraestrutura — CI/CD, staging, deploy, observabilidade, backup testado;
- design system — três apps precisam de base comum;
- LGPD operacional — exportação, anonimização e retenção como código, não como texto.

O número corrigido é ~78. Ele é registrado aqui para não se perder, mas leia a
seção [Escopo recomendado](#escopo-recomendado) antes de tratá-lo como plano.

---

## Lacunas com dependência declarada

Quando um bloco fecha deixando algo de fora, o motivo entra aqui — com **o que
já existe**, **o que falta** e **em qual bloco entra**. Sem isso, "lacuna
conhecida" vira lugar onde trabalho adiado desaparece.

A regra que separa as duas colunas: mecanismo (schema, motor, API, tela do
cliente) fecha no bloco em que a necessidade aparece; **tela de administração
para cadastrar o dado** espera o bloco do admin. O contrário — mecanismo adiado
porque a tela ainda não existe — é o que produz motor que finge aceitar
`blocks` e nunca recebe nenhum.

| Lacuna | Pronto | Falta | Bloco |
|---|---|---|---|
| Bloqueio pontual do dia (dentista às 14h) | tipo `block` no schema, motor, repositório e API: recorta a grade e recusa o agendamento | tela para a recepção criar — hoje só por SQL | 15 (agenda do admin) |
| Convite do barbeiro por WhatsApp | o profissional é criado no onboarding | o convite e o login próprio dele | 16 (`app-pro`) — sem a agenda do barbeiro não há para onde o convite levar |
| Painel como aplicação separada | rota `/admin` própria; o pacote da página pública não cresceu (102 kB antes e depois do painel) | extrair `apps/admin` quando o painel tiver dependência que a página pública não usa | 13 (CRUD do admin) |
| Jornada diferente por barbeiro | jornada por profissional no schema e no motor | o onboarding aplica a mesma para a equipe — o ajuste por pessoa é cadastro, não caminho de dez minutos | 13 (CRUD do admin) |
| Enviar a foto em vez de colar o endereço | as colunas de foto são preenchidas por tela própria (`/admin/fotos`), validadas (`https` só) e exibidas na página pública | envio de arquivo, com recorte, redimensionamento e servido do nosso domínio | 13 (CRUD do admin): a dependência real é **armazenamento de objeto**, que o projeto ainda não tem. Colar o endereço é v1 reversível — a barbearia já publicou as fotos em algum lugar, e esperar por infraestrutura deixaria a página como cardápio de texto por mais oito blocos. Foto **de cliente** é outra coisa, exige consentimento específico e fica no 74 |
| Entregar a senha de primeiro acesso por mensagem | a senha é gerada, mostrada uma vez e morre no primeiro uso — a conta nasce obrigada a trocá-la | entrega por WhatsApp em vez de o dono ler em voz alta; hoje ela passa por parâmetro de URL do painel | 20 (fila + worker): é onde nasce o canal transacional. Até lá a alternativa real na barbearia é entregar de viva-voz para quem está do lado |
| Segundo fator para quem mexe em dinheiro | as permissões `finance.*` existem no catálogo e em nenhum papel além do dono | o MFA que o `CLAUDE.md` exige para elas | 18 (comanda e caixa): é a primeira tela que precisa de `finance.*`. Há teste que reprova qualquer rota que exija uma dessas antes do MFA existir, então a regra não some por esquecimento |
| Editar as permissões de cada papel pela tela | `role_permissions` é por barbearia e editável — tirar `appointments.cancel` da recepção é um `DELETE` e vale na requisição seguinte | a tela que faz isso sem SQL | 30 (RBAC: telas de gestão): o mecanismo está pronto de propósito para o bloco 30 precisar só de tela, não de migração |
| Ler a trilha de auditoria pela tela | tabela `audit_log` append-only no banco, escrita na mesma transação da mudança, com antes e depois, e leitura paginada por cursor | a tela que mostra | 21 (dashboard): a trilha já registra; falta onde olhar sem `psql` |
| Falta automática ao fim da tolerância | `no_show_after_minutes` na unidade, o relógio calculado no domínio e mostrado no painel antes de o prazo acabar | quem vira o status é uma pessoa — nada faz isso sozinho | 20 (fila + worker): é a primeira vez que existe processo rodando fora de uma requisição. Até lá a tela diz "tolerância acaba em", nunca "automática" |
| Painel do dia que se atualiza sozinho | recarga manual e recarga a cada ação; a tela sempre reflete o banco no instante em que foi montada | atualização sem toque, para o balcão que fica aberto | 20 (fila + worker) para o empurrão do servidor; antes disso qualquer solução seria pesquisa em laço, que é o que o produto cobra dos outros |
| Encerrar sessão nos outros aparelhos | revogação e "Sair" deste aparelho, para cliente e para gestor | listagem de sessões ativas | sem bloco: o cliente de barbearia usa um celular só. Entra se aparecer demanda real, não por simetria |

**Lacuna fechada sai da tabela.** O histórico de por que foi adiada fica no
commit que a fechou; manter linha morta aqui faria a lista virar ruído e
esconder o que ainda falta.

---

## R1 — MVP (23 blocos)

**Critério de aceite:** uma barbearia de duas cadeiras consegue largar o sistema
atual sem perder nenhuma capacidade que usava.

| # | Bloco | Estado |
|---|---|---|
| 1 | Motor de disponibilidade + schema Scheduling | ✅ |
| 2 | Repositórios: resolver `ProfessionalDay`, catálogo, habilidades | ✅ |
| 3 | API + middleware de tenant/RLS + `GET /availability` | ✅ |
| 4 | Domínio de reserva: criar, hold, idempotência, reagendamento atômico | ✅ |
| 5 | Auth do cliente (OTP WhatsApp) + endpoints de reserva | ✅ |
| 6 | Design system: tokens, componentes base, tema, acessibilidade | ✅ |
| 7 | Página pública SSR: layout, mapa, horário, JSON-LD, deep links | ✅ |
| 8 | Fluxo de agendamento no front: serviço → profissional → horário → dados → comprovante | ✅ |
| 9 | Meus agendamentos: entrar por código, listar, cancelar, remarcar | ✅ |
| 10 | Conta de gestor + onboarding em 6 etapas + configuração da unidade | ✅ |
| 11 | Balcão: painel do dia, check-in, no-show, busca e marcação pelo balcão | ✅ |
| 12 | RBAC mínimo: papéis, permissões e contas de equipe | ✅ |
| 13 | Admin: CRUD de catálogo, equipe, jornadas, recursos | |
| 14 | Balcão: fila de walk-in, encaixe com custo visível, posição pelo celular | |
| 15 | Agenda: dia/semana/lista, arrastar, bloqueio pontual | |
| 16 | `app-pro`: agenda do barbeiro, próximo cliente, preferências | |
| 17 | `app-pro`: check-in, iniciar/finalizar, comissão, metas | |
| 18 | Comanda + checkout + caixa | |
| 19 | Comissão básica + fechamento | |
| 20 | Notificações: confirmação, lembrete 24h/2h, retorno (fila + worker) | |
| 21 | Dashboard básico + validador de catálogo | |
| 22 | Importador de base + deduplicação por telefone | |
| 23 | CI/CD, staging, observabilidade, e2e, carga em `/availability` | |

---

## O balcão é a terceira superfície

Três pessoas usam este produto, e só duas tinham tela no plano original.

| Quem | Aparelho | Frequência | Densidade |
|---|---|---|---|
| Cliente | celular, em pé na rua | uma vez por mês | respira |
| Gestor | celular ou notebook | uma vez por semana | média |
| **Balcão** | **notebook ligado o dia inteiro** | **o tempo todo** | **densa** |

O balcão é quem digita o telefone de quem chegou sem marcar, marca presença,
descobre que o cliente das 14h não veio e decide se encaixa o que está esperando
em pé na frente dele. A SPEC descreve o papel (Parte 1 §1.2), a fila presencial
(Parte 2 §2.10 — "**é outro objeto e outra tela**") e o check-in (§2.11). O que
faltava era o roadmap tratar isso como **uma superfície**, e não como funções
espalhadas.

O erro concreto que estava no plano:

- **Check-in só existia dentro do `app-pro`**, o aplicativo do barbeiro. Mas o
  primeiro canal de check-in que a SPEC lista é "recepção" — quem marca presença
  na prática é quem está no balcão, não o barbeiro com a máquina na mão.
- **A fila de walk-in estava no bloco 37**, depois do MVP inteiro. Numa barbearia
  de bairro, quem entra sem marcar é uma fatia grande do faturamento; sem a fila,
  o sistema não cobre o dia real e a recepção volta para o caderno.
- **Não havia RBAC.** Hoje toda conta de gestor tem poder de dono. Criar a conta
  da recepcionista antes de existir permissão entregaria faturamento e base de
  clientes a quem só precisa marcar presença — e `customers.export` é o vetor
  clássico de roubo de base quando alguém sai.

Daí a ordem: o painel do dia (11) vem primeiro porque é o buraco mais agudo —
hoje o dono abre a página do cliente para adivinhar o que está marcado. O RBAC
(12) vem logo atrás e **antes de qualquer conta que não seja do dono**: enquanto
só existe dono não há permissão a separar, mas a primeira recepcionista criada
sem ele já é um incidente. O CRUD (13) espera porque mudar preço é dor semanal;
não enxergar a agenda é dor de todo minuto do expediente.

### O que muda no desenho

É a primeira tela cujo aparelho principal é um **notebook**, aberta o dia
inteiro, usada por alguém que não lê — olha de relance entre um cliente e outro.

Isso muda a **densidade**, não a regra. O balcão é a mesma tela nos dois
aparelhos: nasce no piso de 360px, ganha colunas e atalhos de teclado quando há
espaço. Nada de "versão de celular" reduzida — a recepção atende pelo telefone
sempre que o notebook está ocupado com outra coisa, e é justamente aí, com
cliente esperando em pé na frente dela, que a tela não pode faltar.

Vale para todo o produto e está no CLAUDE.md §5: alvo de toque de 44px em
qualquer largura, `min-width` sempre, e conferência medida em 360 · 390 · 768 ·
1280 por `scripts/medir-responsividade.js` — não no olho.

---

## Plataforma (10 blocos)

Transversal. Nada aqui aparece para o cliente final, e sem nada aqui o produto
não é vendável.

| # | Bloco |
|---|---|
| 24 | Super Admin: tenants, planos, bloqueio de conta |
| 25 | Super Admin: métricas globais, MRR, churn |
| 26 | Super Admin: feature flags, impersonação auditada |
| 27 | Billing: planos, trial, assinatura da barbearia |
| 28 | Billing: upgrade/downgrade, inadimplência, régua de retentativa |
| 29 | Billing: integração com PSP, conciliação |
| 30 | RBAC: telas de gestão de papéis e permissões editáveis pelo dono |
| 31 | LGPD: consentimentos, exportação de dados |
| 32 | LGPD: anonimização, retenção, pipeline de exclusão |
| 33 | Segurança: hardening, rate limit global, auditoria de acesso |

---

## R2 — dinheiro e ocupação (10 blocos)

| # | Bloco |
|---|---|
| 34 | `PaymentProvider`: abstração, fake, testes |
| 35 | Pix: QR Code, webhook, conciliação |
| 36 | Cartão e link de pagamento |
| 37 | Sinal seletivo + política de reembolso |
| 38 | Lista de espera: entradas, expiração, gatilho de cancelamento |
| 39 | Lista de espera: priority queue, janela exclusiva, notificação |
| 41 | Fidelidade: pontos, visitas ou cashback |
| 42 | Pacotes: venda, consumo, validade, receita diferida |
| 43 | Avaliações + fluxo de recuperação de nota baixa |
| 44 | Produtos, estoque, ficha de consumo, CMV |

---

## R3 — recorrência e escala (15 blocos)

| # | Bloco |
|---|---|
| 45 | Planos de assinatura: modelagem, regras, cooldown |
| 46 | Assinatura: restrição de horário, dependentes, prioridade na fila |
| 47 | Cobrança recorrente: régua, suspensão gradual, cancelamento self-service |
| 48 | Rentabilidade da assinatura (simulação dos três modelos de comissão) |
| 49 | Split: modelagem derivada da comissão |
| 50 | Split: KYC do profissional, liquidação, estorno |
| 51 | Financeiro: contas a pagar/receber, transferências, conciliação |
| 52 | Financeiro: fiado, vale, DRE gerencial |
| 53 | `FiscalProvider`: abstração e integração |
| 54 | Fiscal: NFS-e, cancelamento, Salão-Parceiro |
| 55 | WhatsApp oficial: templates, webhooks, botões |
| 56 | Marketing automation: motor de eventos, teto de mensagens, janela de silêncio |
| 57 | Campanhas: filtros, canais, receita atribuída |
| 58 | Multiunidade: seleção, consolidação, transferência de estoque |
| 59 | Multiunidade: cliente e fidelidade compartilhados |

---

## R4 — inteligência (10 blocos)

Depende de histórico acumulado. Não antecipar.

| # | Bloco |
|---|---|
| 60 | Reliability score + sinal condicional |
| 61 | Ciclo individual de retorno + segmentação automática |
| 62 | Churn score com explicação |
| 63 | Schema semântico de métricas (base do assistente) |
| 64 | Assistente do gestor: text-to-query |
| 65 | Agente de agendamento: intent, slots, confirmação |
| 66 | Agente: remarcação e recepção digital |
| 67 | Insights proativos |
| 68 | Smart pricing com aprovação humana |
| 69 | Previsão de consumo e sugestão de compra |

---

## R5 — rede (10 blocos)

Só faz sentido com centenas de barbearias na base.

| # | Bloco |
|---|---|
| 70 | Marketplace: busca geográfica e filtros |
| 71 | Marketplace: "próximo horário" em lote (exige `/availability` rápido) |
| 72 | Marketplace: atribuição de cliente novo e comissão |
| 73 | Perfil público do barbeiro |
| 74 | Portfólio e consentimento de uso público |
| 75 | Anúncios e destaque |
| 76 | Franquias: catálogo padrão, preços sugeridos |
| 77 | Franquias: indicadores consolidados, metas |
| 78 | API pública: chaves, escopos, rate limit |
| 79 | Webhooks assinados para terceiros |

---

## Escopo recomendado

78 blocos é produto de time, horizonte de mais de um ano. Duas decisões cortam
isso pela metade sem prejudicar o que é vendável:

### 1. Adiar R4 e R5 por dependência, não por preguiça
São 20 blocos que **não funcionam** no começo: score e IA precisam de histórico
que ainda não existe, marketplace precisa de densidade de barbearias que ainda
não existe. Construí-los cedo produz funcionalidade morta.

### 2. Comprar a Plataforma em vez de construir
Billing e Super Admin (blocos 24–29) são os menos diferenciados do produto
inteiro. Nenhuma barbearia escolhe o sistema pelo painel interno do fornecedor.
Uma solução de billing pronta cobre a maior parte, e sobra o essencial: feature
flags, impersonação auditada e LGPD.

### Resultado

```
R1 MVP              23 blocos   (20 + balcão e RBAC)
Plataforma enxuta    5 blocos   (de 10)
R2                  10 blocos   (a fila de walk-in subiu para o MVP)
─────────────────────────────
                    38 blocos  → produto que uma barbearia paga e usa
```

Os três blocos que entraram no MVP não são escopo novo: dois já estavam na SPEC
(recepcionista e fila presencial), fora de ordem. O terceiro divide o RBAC em
dois — **aplicar** permissão vem antes da primeira conta que não é do dono
(bloco 12); **gerenciar** papéis pela tela continua na Plataforma (bloco 30),
porque até lá os quatro papéis fixos da SPEC bastam.

O resto vira roadmap de verdade — replanejado com cliente real usando o sistema,
não estimado no vazio.

---

## Riscos que podem alterar a contagem

| Risco | Impacto |
|---|---|
| **Fiscal** (blocos 50–51) | ~5.500 municípios com regras próprias. Pode ser 2 ou 6 blocos, dependendo do provedor escolhido. Não estimável antes da decisão. |
| **WhatsApp oficial** | Depende de número verificado e aprovação de templates. Bloqueio de fornecedor, não de código. |
| **Split** | Exige KYC de cada profissional no PSP. O onboarding assíncrono é mais trabalhoso que a divisão em si. |
| **Importadores** | O bloco 19 cobre CSV e um sistema. Cada origem adicional (AppBarber, Trinks, Belle) é trabalho novo. |
| **Reordenação** | Quando o MVP estiver numa barbearia real, o que ela pedir vai reordenar R2 em diante — e deve mesmo. |
