# Parte 3 — Atendimento, vendas e financeiro

← [SPEC.md](../../SPEC.md)

> Esta é a área onde o incumbente é **forte**. SalonSoft tem fiado, vale, pacotes,
> comissões e estoque — mais completo que o Booksy nisso. Aqui o objetivo não é
> inovar, é **não perder**: nenhuma barbearia migra se perder uma capacidade
> operacional que já usava.

---

## 3.1 Comanda

Todo atendimento confirmado gera (ou pode gerar) uma comanda. A comanda **nasce
pré-preenchida com os serviços do agendamento** — o barbeiro só adiciona o extra.

```
Comanda #7842 · Carlos Souza · João · 08/08 14:00
─────────────────────────────────────────────────
Corte + Barba          (agendamento)     R$  74,00
Pomada Modeladora      (produto)         R$  45,00
Cerveja                (consumação)      R$   8,00
─────────────────────────────────────────────────
Subtotal                                 R$ 127,00
Desconto (cupom BEMVINDO)               −R$  10,00
Gorjeta (10% → João)                     R$  11,70
─────────────────────────────────────────────────
Total                                    R$ 128,70
```

Itens possíveis: serviço agendado · serviço adicional · produto · consumação ·
desconto · gorjeta

### Regras
- Comanda aberta **trava** o agendamento em `in_progress`.
- Item adicionado por barbeiro sem `orders.discount` não aceita desconto.
- Desconto acima do limite do papel exige aprovação do gerente **e é auditado**.
- Toda comanda registra quem executou cada item — a comissão é por item, não por
  comanda. Dois barbeiros no mesmo cliente é caso real (corte com um, barba com
  outro).

---

## 3.2 PDV

Tela otimizada para tablet e desktop.

```
┌─ Serviços ─┬─ Produtos ─┬─ Combos ─┬─ Assinaturas ─┬─ Pacotes ─┐
```

**Checkout**
```
Subtotal · Desconto · Crédito do cliente · Fidelidade · Gorjeta · Total
```

**Formas de pagamento:** Pix · dinheiro · débito · crédito · link · saldo ·
assinatura · combinado

### Pagamento dividido
```
R$ 50,00  Pix
R$ 70,00  Cartão de crédito
─────────────────
R$ 120,00 Total
```

Divisão também **entre pessoas** (pai paga o corte do filho junto com o dele).

### Requisitos de operação
- Tudo alcançável em ≤ 3 toques a partir da comanda aberta.
- Funciona com teclado (recepção usa desktop): `Ctrl+K` para busca global e
  command palette (§3.11).
- **Modo offline degradado:** queda de internet não pode travar o caixa. A venda é
  registrada localmente e sincroniza ao voltar. Barbearia em shopping perde
  conexão com frequência — sistema que trava vira sistema abandonado.

---

## 3.3 Pix

Gerar QR Code no checkout. Status: **aguardando → pago**.

Na confirmação, dispara em cadeia:
```
payment.completed
  ├─► fecha comanda
  ├─► registra no caixa
  ├─► gera comissão
  ├─► atualiza fidelidade / cashback
  ├─► baixa estoque
  ├─► emite fiscal (quando aplicável)
  ├─► debita uso de assinatura/pacote
  └─► agenda pedido de avaliação
```

**Requisitos:**
- Webhook do PSP é a fonte da verdade, com polling de reconciliação como rede de
  segurança (webhook perdido não pode deixar comanda aberta).
- Toda a cadeia acima é **idempotente por `payment_id`** — webhook duplicado não
  gera comissão dobrada nem baixa estoque duas vezes.
- Pix expirado libera a comanda e o `hold` do slot.

---

## 3.4 Comissões

Configuráveis por: profissional · serviço · produto · categoria · assinatura ·
unidade

```
Corte:    40%
Barba:    50%
Produto:  10%
```

Modalidades: valor fixo · percentual · **faixas progressivas**

```
até R$ 5.000       → 40%
R$ 5.001–8.000     → 45%
acima de R$ 8.000  → 50%
```

### Decisões que precisam estar explícitas

| Questão | Regra |
|---|---|
| Base de cálculo | sobre valor **líquido** (após desconto), configurável para bruto |
| Taxa de cartão | configurável: absorvida pela casa *ou* rateada — precisa ser escolha, não implícita |
| Gorjeta | **100% do profissional**, nunca entra na base de comissão |
| Desconto | por padrão reduz a base; configurável para "desconto é custo da casa" |
| Estorno | gera comissão negativa no período corrente, nunca reescreve o fechado |
| Assinatura | Ver §3.5 — o caso mais delicado |

### Comissão sobre assinatura
É o ponto que mais gera conflito na prática. Três modelos suportados:

1. **Por uso** — o profissional recebe comissão quando o assinante é atendido,
   sobre um valor de referência do serviço. Simples e justo, mas pode custar mais
   que a mensalidade se o assinante usar muito.
2. **Rateio da mensalidade** — a mensalidade é distribuída entre os profissionais
   que atenderam no mês, proporcional aos atendimentos. Protege a margem.
3. **Híbrido** — por uso, com teto na fração da mensalidade.

O sistema precisa mostrar ao dono, antes de ele escolher, a simulação dos três
sobre os dados reais dele.

### Fechamento
Comissão tem período de fechamento. Depois de fechado, é **imutável**; ajuste vira
lançamento novo. Sem isso, um estorno retroativo altera o pagamento já feito ao
barbeiro — e destrói a confiança no sistema.

---

## 3.5 Split de pagamento

Arquitetura preparada desde o início, mesmo que ativada só no Release 3.

```
Pagamento           R$ 100,00
├── Barbearia       R$  55,00
├── Profissional    R$  40,00
└── Plataforma      R$   5,00
```

**Requisitos:**
- `payment_splits` como tabela própria, com status por parte.
- Split é **derivado da comissão**, nunca configurado em paralelo — duas fontes de
  verdade para o mesmo número é bug garantido.
- Profissional precisa de cadastro no PSP (KYC). O onboarding disso é assíncrono:
  enquanto pendente, o pagamento cai integralmente na barbearia e a comissão é
  paga fora, sem bloquear a venda.
- Estorno com split já liquidado exige política explícita de recuperação.

---

## 3.6 Gorjetas

No checkout: **Adicionar gorjeta?** → 5% · 10% · 15% · personalizado

- Vinculada ao profissional que executou.
- Nunca entra na base de comissão nem no faturamento da casa (é repasse).
- Aparece separada no DRE e no extrato do barbeiro.
- Configurável: desligada, sugerida ou pedida no PDV/no link de pagamento.

---

## 3.7 Estoque

**Cadastro:** SKU · código de barras · nome · categoria · fornecedor · custo ·
preço · estoque · estoque mínimo · validade

### Revenda vs. consumo interno
Distinção obrigatória — é o que permite calcular margem real:

| Tipo | Exemplo | Baixa |
|---|---|---|
| `resale` | pomada vendida ao cliente | na venda |
| `internal` | shampoo usado no serviço | por ficha técnica |

### Ficha técnica de consumo
```
Barba Premium consome:
  óleo pré-barba    5 ml
  pós-barba         2 ml
  lâmina            1 un
```

Permite custo real por atendimento — e alimenta a previsão de compra por IA
(Parte 4).

### Movimentações
entrada · saída · venda · consumo · perda · ajuste · transferência entre unidades

Toda movimentação é imutável e auditada. Estoque é **saldo derivado** do
movimento, nunca campo editado direto.

Alertas: estoque mínimo · validade próxima · produto parado

---

## 3.8 CMV e margem por serviço

O diferencial de rentabilidade (SPEC §6.7). Nenhum concorrente analisado mostra
isso bem.

```
Corte                        R$ 60,00
─────────────────────────────────────
Comissão (40%)              −R$ 24,00
Consumíveis (ficha técnica) −R$  3,00
Taxa de pagamento           −R$  2,00
─────────────────────────────────────
Custo variável              −R$ 29,00
Margem de contribuição       R$ 31,00  (51,7%)
```

Mesma decomposição aplicada a: **profissional · cadeira · cliente · assinatura ·
horário do dia**.

Insight típico que só aparece assim: *"Barboterapia parece o serviço mais caro
(R$ 55), mas depois de comissão e insumo rende menos que o Corte simples."*

---

## 3.9 Compras

```
estoque mínimo atingido
  → sugestão de compra
    → pedido
      → fornecedor
        → recebimento (parcial permitido)
          → entrada no estoque
```

Recebimento parcial e divergência de nota precisam existir — sem isso o estoque
descola da realidade na primeira semana.

---

## 3.10 Financeiro

**Módulos:** caixa · contas a pagar · contas a receber · transferências ·
conciliação · categorias financeiras · centros de custo · DRE gerencial

### Caixa
abertura · valor inicial · movimentações · sangria · suprimento · fechamento ·
divergência

Requisitos:
- Caixa aberto por operador identificado; fechamento cego opcional (o operador
  conta sem ver o esperado) — reduz ajuste conveniente.
- Divergência registrada, nunca silenciada.
- Reabertura permitida por papel autorizado, **sempre auditada**.

### Fiado / conta do cliente
O incumbente tem (`get_controle_fiados`, `registra_pagamento_divida`) e é usado de
verdade em barbearia de bairro. **Obrigatório no MVP** — sua ausência é motivo de
não-migração.

Cliente tem saldo (crédito ou débito), com histórico e limite configurável.

### Vale / adiantamento
Adiantamento ao profissional, descontado da comissão do período. Também presente
no incumbente e usado de verdade.

### DRE gerencial
```
  Receita de serviços
+ Receita de produtos
+ Receita de assinaturas
──────────────────────────
− Comissões
− CMV
− Taxas de pagamento
− Despesas operacionais
──────────────────────────
= Resultado
```

Filtrável por unidade e período, com comparativo contra o período anterior.

---

## 3.11 Fiscal

Preparado para NFS-e, NF-e/NFC-e quando aplicável, regras municipais e regime
Salão-Parceiro.

**Decisão de arquitetura:** não implementar lógica municipal no core. Criar a
abstração `FiscalProvider` e delegar a um emissor terceirizado.

```
interface FiscalProvider {
  issueServiceInvoice(order, taxpayer) -> Invoice
  cancelInvoice(invoice_id, reason)    -> void
  getStatus(invoice_id)                -> InvoiceStatus
}
```

Motivo: são ~5.500 municípios com regras próprias. Absorver isso no core garante
que o time passe a manter integração fiscal em vez de produto.

### Salão-Parceiro (Lei 13.352/2016)
Relevante e específico do setor: o profissional pode ser parceiro, não empregado,
e a nota separa a parcela do salão da parcela do profissional. O modelo de dados
precisa suportar essa separação desde o início — é exatamente o mesmo dado do
split (§3.5), o que torna a arquitetura consistente.

---

## 3.12 Busca global e command palette

`Ctrl + K` — pesquisa cliente · telefone · agendamento · produto · profissional ·
comanda

E executa comandos:
```
> Novo agendamento
> Abrir caixa
> Buscar Carlos
> Nova venda
> Fechar comanda #7842
```

Recepção em horário de pico é operação de teclado. Isso não é enfeite: é a
diferença entre atender a fila e travar nela.
