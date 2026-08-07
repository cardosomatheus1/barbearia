# Parte 1 — Domínio, perfis, acesso e conformidade

← [SPEC.md](../../SPEC.md)

---

## 1.1 Arquitetura de empresa

Multi-tenant **desde o primeiro dia**. Nunca "depois a gente separa" — retrofit de
`tenant_id` em produção é a dívida técnica mais cara que um SaaS pode assumir.

```
Plataforma
└── Empresa (tenant)
    └── Marca
        └── Unidade (location)
            ├── Profissionais
            ├── Recursos
            └── Operações
    └── Clientes  ← compartilhados entre unidades da mesma empresa
```

Exemplo:

**Box Seis Barbearia**
- Unidade Pituba
- Unidade Barra
- Unidade Lauro de Freitas

O mesmo cliente frequenta unidades diferentes da mesma empresa, com **histórico
unificado**. Fidelidade, assinatura e crédito são configuráveis como
`por empresa` ou `por unidade`.

### Isolamento
- `tenant_id` obrigatório em toda tabela de negócio.
- Isolamento aplicado na camada de repositório **e** por Row Level Security no
  PostgreSQL — defesa em profundidade. Um bug de `WHERE` não pode vazar tenant.
- Chave de idempotência e IDs públicos nunca sequenciais (usar UUID/ULID): ID
  sequencial em URL pública permite enumerar a base de clientes.

---

## 1.2 Perfis do sistema

### Super Admin
Administrador da plataforma SaaS. Visualiza tenants; cria e bloqueia contas;
altera planos; acompanha métricas globais, MRR, churn e pagamentos; gerencia
integrações, marketplace e categorias; controla feature flags; vê logs; executa
suporte assistido; **impersona usuário com registro de auditoria obrigatório**.

> Impersonação sem trilha auditável é incidente de LGPD esperando acontecer. O
> registro deve gravar quem impersonou, quando, por quanto tempo e o que acessou —
> e o tenant deve poder consultar esse log.

### Proprietário
Dono da barbearia. Acesso completo à empresa: faturamento, lucro, agenda,
clientes, profissionais, comissões, estoque, DRE, assinaturas, indicadores,
campanhas e todas as unidades autorizadas.

### Gerente
Administra determinada unidade, com permissões configuráveis: agenda, caixa,
clientes, estoque, equipe, relatórios. **Pode não ter acesso ao lucro total nem a
dados estratégicos da empresa.**

### Recepcionista
Cria e altera agendamento; faz check-in; cadastra cliente; abre comanda; inclui
produto; recebe pagamento; gerencia fila de espera e walk-ins.
**Não visualiza informação financeira estratégica por padrão.**

### Barbeiro
Interface própria. Visualiza agenda, próximos clientes, histórico autorizado,
preferências do cliente, serviços, check-in, início/fim de atendimento, comissão,
metas e avaliações. Conforme permissão: bloquear horários, remarcar, criar
encaixes, vender produtos, criar agendamentos.

### Cliente
Acesso simplificado. Procura barbearia; escolhe unidade, serviço, profissional e
horário; paga; cancela; remarca; entra em lista de espera; compra assinatura e
pacote; acompanha fidelidade; vê histórico; repete agendamento; avalia.

---

## 1.3 RBAC

Permissões granulares, não papéis fixos. Papéis são apenas **conjuntos nomeados**
de permissões, editáveis pelo proprietário.

```
appointments.view          appointments.create        appointments.cancel
appointments.reschedule    appointments.view_all_professionals
cashier.open               cashier.close              cashier.withdraw
finance.view               finance.view_profit        finance.export
commission.view_own        commission.view_all        commission.edit_rules
customers.view             customers.edit             customers.export
customers.view_photos      customers.view_notes
reports.finance            reports.operational
inventory.view             inventory.adjust
marketing.send             settings.manage            team.manage
```

**Regras não negociáveis:**
- `commission.view_own` ≠ `commission.view_all`. Barbeiro vendo a comissão do
  colega gera conflito interno e é o motivo nº 1 de reclamação em sistema de
  barbearia.
- `customers.export` é permissão separada e **sempre auditada** — é o vetor de
  roubo de base quando um profissional sai.
- `finance.view_profit` separado de `finance.view`: gerente vê faturamento sem ver
  margem.

---

## 1.4 Profissionais e tipos de agenda

> **Resolve D12.** No estabelecimento analisado, 2 dos 4 "profissionais" eram
> contas de balcão (`Recepcao`, `Danilson`) com jornada 08:00–23:00 todos os dias.
> Isso destrói qualquer relatório de ocupação e de comissão.

Toda agenda tem um `kind` explícito:

| `kind` | Aparece no site público | Entra em ocupação/comissão | Uso |
|---|:--:|:--:|---|
| `professional` | ✅ | ✅ | barbeiro real |
| `counter` | ❌ | ❌ | balcão/recepção, encaixe manual |
| `resource_only` | ❌ | ❌ | agenda de recurso (sala, cadeira) |
| `external` | ❌ | ✅ | atendimento externo/domicílio |

Métricas de ocupação, receita por cadeira e ranking **ignoram** tudo que não é
`professional` ou `external`.

### Perfil do profissional
nome · foto · bio · especialidades · serviços habilitados · preço próprio ·
duração própria · comissão · jornada · metas · documentos · status

### Preço e duração por profissional
Barbeiro sênior pode cobrar mais e levar menos tempo no mesmo serviço.
`professional_services` carrega `price_override` e `duration_override` nulos por
padrão (herdam do serviço).

Isso alimenta o "a partir de R$ X" no site público.

---

## 1.5 Onboarding da barbearia

Extremamente simples. **Meta: da criação da conta ao link publicado em menos de 10
minutos.** Cada etapa é salva individualmente — abandonar no passo 4 não perde os
passos 1–3.

### Etapa 1 — Conta
nome · WhatsApp · e-mail · senha

### Etapa 2 — Empresa
nome da barbearia · CNPJ/CPF (opcional inicialmente) · endereço · localização ·
Instagram · logo · foto de capa

### Etapa 3 — Serviços
Templates sugeridos, pré-preenchidos e editáveis: corte · barba · corte + barba ·
pezinho · sobrancelha · pigmentação · lavagem · hidratação

Cada serviço: nome · descrição · preço · duração · **buffer de limpeza** ·
categoria · profissionais habilitados

> O template já vem com duração e buffer coerentes. **Resolve D4 na origem** — o
> problema do concorrente nasceu de cadastro manual sem validação.

### Etapa 4 — Profissionais
nome · foto · especialidades · comissão · horário de trabalho

Convite por WhatsApp: o barbeiro recebe link, define senha e já vê a própria
agenda. Sem esse passo, o dono cadastra tudo sozinho e a equipe nunca adota.

### Etapa 5 — Pagamentos
Pix · cartão · dinheiro · pagamento online

### Etapa 6 — Publicar
Gera automaticamente:
```
seudominio.com/nome-da-barbearia
nome-da-barbearia.plataforma.com
```

**Slug é imutável e permanente.** Ao renomear a barbearia, o slug antigo continua
resolvendo via `tenant_slugs` (histórico). O link na bio do Instagram nunca pode
quebrar.

> Evidência direta: o estabelecimento analisado trocou de nome (Box Seis →
> Domari Barber Club) e o slug `boxseisbarbearia` continua funcionando. O
> concorrente acertou nisso — **replicar**.

### Checklist pós-onboarding
Card persistente no dashboard até completar: adicionar foto de capa · descrever 3
serviços · convidar equipe · configurar lembrete · fazer o primeiro agendamento
de teste.

---

## 1.6 Autenticação

| Perfil | Método |
|---|---|
| Cliente | telefone + OTP no WhatsApp (fallback SMS) — **sem senha, sem e-mail** |
| Profissional | e-mail ou telefone + senha |
| Gestor | e-mail + senha + MFA opcional (obrigatório para `finance.*`) |
| Enterprise | SSO (futuro) |

**OTP por WhatsApp é o padrão, SMS é fallback** — melhor entrega e menor custo no
Brasil (prática validada no concorrente).

### Proteções obrigatórias no OTP
- Rate limit por telefone **e** por IP (o endpoint de OTP é a porta de entrada
  para custo de mensagem e para enumeração de base).
- Código de 6 dígitos, TTL de 5 min, máximo 5 tentativas, invalidação no acerto.
- Cooldown progressivo no reenvio (30s → 60s → 120s).
- `verifica_celular` **não pode revelar** se o telefone já existe na base — resposta
  idêntica nos dois casos.

---

## 1.7 Auditoria

Registrar toda alteração sensível:

```
07/08/2026 14:42 · Usuário: Maria (Recepcionista, Unidade Pituba)
Ação: cancelou pagamento · Comanda #7842 · Valor: R$ 120,00
IP: 189.x.x.x · Antes: {status: "paid"} · Depois: {status: "cancelled"}
```

**Eventos auditados obrigatoriamente:** cancelamento de pagamento · desconto acima
do limite · alteração de comissão · exclusão de agendamento · fechamento e
reabertura de caixa · sangria · exportação de clientes · alteração de permissão ·
impersonação · acesso a foto de cliente · alteração de preço.

Logs são **append-only**. Usuário comum não apaga. Retenção mínima de 5 anos para
eventos financeiros.

---

## 1.8 LGPD

Implementar: consentimentos · finalidade · exportação de dados · anonimização ·
exclusão · política de retenção · registro de consentimento · controle de marketing.

**Regras:**

1. **Consentimento de marketing é separado** do necessário para executar o
   serviço. Agendar não autoriza receber campanha. São dois aceites distintos,
   com data, IP e versão do texto registrados.
2. **Foto de cliente exige consentimento explícito e específico** (§Parte 4 — fotos
   antes/depois). O barbeiro não fotografa sem o aceite registrado. O cliente pode
   revogar, e a revogação apaga as fotos.
3. **Direito à exclusão vs. obrigação fiscal:** ao pedir exclusão, dados pessoais
   são anonimizados (`cliente_anonimizado_a1b2`), mas o registro financeiro
   permanece pelo prazo legal, sem vínculo com pessoa identificável.
4. **Exportação** em formato legível pelo titular (JSON + PDF), entregue em até 15
   dias.
5. **Encarregado (DPO)** configurável por tenant — a barbearia é controladora, a
   plataforma é operadora. O contrato precisa deixar isso explícito.
6. **Retenção:** cliente sem interação há 5 anos entra em fila de anonimização
   automática, com aviso prévio ao tenant.

### Multi-tenant e base de clientes
A base de clientes pertence ao **tenant**, não à plataforma. Na saída, o tenant
exporta sua base completa. Isso deve ser contratual e implementado — é o principal
motivo de desconfiança na troca de sistema e, portanto, o principal argumento de
venda contra o incumbente.
