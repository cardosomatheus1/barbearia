# Roadmap de execução

Companheiro do [`SPEC.md`](SPEC.md). A SPEC diz **o que** o produto é; este
documento diz **em quantas partes** ele é construído e em que ordem.

**Status: 5 de 76 blocos.**

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

O número corrigido é ~76. Ele é registrado aqui para não se perder, mas leia a
seção [Escopo recomendado](#escopo-recomendado) antes de tratá-lo como plano.

---

## R1 — MVP (20 blocos)

**Critério de aceite:** uma barbearia de duas cadeiras consegue largar o sistema
atual sem perder nenhuma capacidade que usava.

| # | Bloco | Estado |
|---|---|---|
| 1 | Motor de disponibilidade + schema Scheduling | ✅ |
| 2 | Repositórios: resolver `ProfessionalDay`, catálogo, habilidades | ✅ |
| 3 | API + middleware de tenant/RLS + `GET /availability` | ✅ |
| 4 | Domínio de reserva: criar, hold, idempotência, reagendamento atômico | ✅ |
| 5 | Auth do cliente (OTP WhatsApp) + endpoints de reserva | ✅ |
| 6 | Design system: tokens, componentes base, tema, acessibilidade | |
| 7 | Página pública SSR: layout, mapa, horário, JSON-LD, deep links | |
| 8 | Fluxo de agendamento no front (seleção → OTP → confirmação) | |
| 9 | Meus agendamentos: listar, cancelar, reagendar | |
| 10 | Onboarding em 6 etapas | |
| 11 | Admin: CRUD de catálogo, equipe, jornadas, recursos | |
| 12 | Admin: agenda dia/semana/lista, drag-and-drop, bloqueios, encaixe | |
| 13 | `app-pro`: agenda do barbeiro, próximo cliente, preferências | |
| 14 | `app-pro`: check-in, iniciar/finalizar, comissão, metas | |
| 15 | Comanda + checkout + caixa | |
| 16 | Comissão básica + fechamento | |
| 17 | Notificações: confirmação, lembrete 24h/2h, retorno (fila + worker) | |
| 18 | Dashboard básico + validador de catálogo | |
| 19 | Importador de base + deduplicação por telefone | |
| 20 | CI/CD, staging, observabilidade, e2e, carga em `/availability` | |

---

## Plataforma (10 blocos)

Transversal. Nada aqui aparece para o cliente final, e sem nada aqui o produto
não é vendável.

| # | Bloco |
|---|---|
| 21 | Super Admin: tenants, planos, bloqueio de conta |
| 22 | Super Admin: métricas globais, MRR, churn |
| 23 | Super Admin: feature flags, impersonação auditada |
| 24 | Billing: planos, trial, assinatura da barbearia |
| 25 | Billing: upgrade/downgrade, inadimplência, régua de retentativa |
| 26 | Billing: integração com PSP, conciliação |
| 27 | RBAC: telas de gestão de papéis e permissões |
| 28 | LGPD: consentimentos, exportação de dados |
| 29 | LGPD: anonimização, retenção, pipeline de exclusão |
| 30 | Segurança: hardening, rate limit global, auditoria de acesso |

---

## R2 — dinheiro e ocupação (11 blocos)

| # | Bloco |
|---|---|
| 31 | `PaymentProvider`: abstração, fake, testes |
| 32 | Pix: QR Code, webhook, conciliação |
| 33 | Cartão e link de pagamento |
| 34 | Sinal seletivo + política de reembolso |
| 35 | Lista de espera: entradas, expiração, gatilho de cancelamento |
| 36 | Lista de espera: priority queue, janela exclusiva, notificação |
| 37 | Fila presencial / walk-in + estimativa de espera |
| 38 | Fidelidade: pontos, visitas ou cashback |
| 39 | Pacotes: venda, consumo, validade, receita diferida |
| 40 | Avaliações + fluxo de recuperação de nota baixa |
| 41 | Produtos, estoque, ficha de consumo, CMV |

---

## R3 — recorrência e escala (15 blocos)

| # | Bloco |
|---|---|
| 42 | Planos de assinatura: modelagem, regras, cooldown |
| 43 | Assinatura: restrição de horário, dependentes, prioridade na fila |
| 44 | Cobrança recorrente: régua, suspensão gradual, cancelamento self-service |
| 45 | Rentabilidade da assinatura (simulação dos três modelos de comissão) |
| 46 | Split: modelagem derivada da comissão |
| 47 | Split: KYC do profissional, liquidação, estorno |
| 48 | Financeiro: contas a pagar/receber, transferências, conciliação |
| 49 | Financeiro: fiado, vale, DRE gerencial |
| 50 | `FiscalProvider`: abstração e integração |
| 51 | Fiscal: NFS-e, cancelamento, Salão-Parceiro |
| 52 | WhatsApp oficial: templates, webhooks, botões |
| 53 | Marketing automation: motor de eventos, teto de mensagens, janela de silêncio |
| 54 | Campanhas: filtros, canais, receita atribuída |
| 55 | Multiunidade: seleção, consolidação, transferência de estoque |
| 56 | Multiunidade: cliente e fidelidade compartilhados |

---

## R4 — inteligência (10 blocos)

Depende de histórico acumulado. Não antecipar.

| # | Bloco |
|---|---|
| 57 | Reliability score + sinal condicional |
| 58 | Ciclo individual de retorno + segmentação automática |
| 59 | Churn score com explicação |
| 60 | Schema semântico de métricas (base do assistente) |
| 61 | Assistente do gestor: text-to-query |
| 62 | Agente de agendamento: intent, slots, confirmação |
| 63 | Agente: remarcação e recepção digital |
| 64 | Insights proativos |
| 65 | Smart pricing com aprovação humana |
| 66 | Previsão de consumo e sugestão de compra |

---

## R5 — rede (10 blocos)

Só faz sentido com centenas de barbearias na base.

| # | Bloco |
|---|---|
| 67 | Marketplace: busca geográfica e filtros |
| 68 | Marketplace: "próximo horário" em lote (exige `/availability` rápido) |
| 69 | Marketplace: atribuição de cliente novo e comissão |
| 70 | Perfil público do barbeiro |
| 71 | Portfólio e consentimento de uso público |
| 72 | Anúncios e destaque |
| 73 | Franquias: catálogo padrão, preços sugeridos |
| 74 | Franquias: indicadores consolidados, metas |
| 75 | API pública: chaves, escopos, rate limit |
| 76 | Webhooks assinados para terceiros |

---

## Escopo recomendado

76 blocos é produto de time, horizonte de mais de um ano. Duas decisões cortam
isso pela metade sem prejudicar o que é vendável:

### 1. Adiar R4 e R5 por dependência, não por preguiça
São 20 blocos que **não funcionam** no começo: score e IA precisam de histórico
que ainda não existe, marketplace precisa de densidade de barbearias que ainda
não existe. Construí-los cedo produz funcionalidade morta.

### 2. Comprar a Plataforma em vez de construir
Billing e Super Admin (blocos 21–26) são os menos diferenciados do produto
inteiro. Nenhuma barbearia escolhe o sistema pelo painel interno do fornecedor.
Uma solução de billing pronta cobre a maior parte, e sobra o essencial: feature
flags, impersonação auditada e LGPD.

### Resultado

```
R1 MVP              20 blocos
Plataforma enxuta    5 blocos   (de 10)
R2                  11 blocos
─────────────────────────────
                    36 blocos  → produto que uma barbearia paga e usa
```

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
