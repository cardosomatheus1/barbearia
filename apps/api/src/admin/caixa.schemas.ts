import { z } from 'zod';
import {
  BASES_DE_COMISSAO,
  FORMAS_DE_PAGAMENTO,
  MODOS_DE_COMISSAO,
  TIPOS_DE_ITEM,
  TRATAMENTOS_DA_TAXA,
  TRATAMENTOS_DO_DESCONTO,
} from '@barbearia/core';
import { diaISO } from '../common/data.js';

/**
 * A borda do dinheiro.
 *
 * Nada de valor vindo do cliente sem schema, e **centavos inteiros sempre**:
 * `z.number().int()` recusa `49.90` antes que ele vire ponto flutuante em
 * qualquer lugar do sistema. É a mesma decisão do banco, na borda.
 *
 * O teto de `MAX_CENTAVOS` existe para o erro de digitação: sem ele, um zero a
 * mais numa sangria vira uma gaveta impossível que só aparece no fechamento.
 * Cem mil reais numa operação de barbearia é claramente engano.
 */

const MAX_CENTAVOS = 10_000_000;

const centavos = z.number().int().min(0).max(MAX_CENTAVOS);
const centavosPositivos = z.number().int().positive().max(MAX_CENTAVOS);

export const uuidSchema = z.string().uuid();

export const abrirCaixaSchema = z.object({
  openingCents: centavos,
});

export const movimentoSchema = z.object({
  kind: z.enum(['withdrawal', 'supply']),
  amountCents: centavosPositivos,
  // Sangria sem motivo é dinheiro que sai sem explicação — a coluna existe
  // justamente para a conversa do dia seguinte.
  reason: z.string().trim().min(3).max(200),
});

export const fecharCaixaSchema = z.object({
  countedCents: centavos,
  notes: z.string().trim().max(500).optional(),
});

export const abrirComandaSchema = z.object({
  appointmentId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
});

export const itemSchema = z.object({
  tipo: z.enum(TIPOS_DE_ITEM),
  serviceId: uuidSchema.optional(),
  descricao: z.string().trim().min(1).max(120),
  quantidade: z.number().int().positive().max(99),
  precoUnitarioCents: centavos,
  professionalId: uuidSchema.optional(),
  /**
   * O pacote do catálogo que este item vende (bloco 42).
   *
   * Com ele, `precoUnitarioCents` é ignorado e o preço sai do catálogo: aceitar
   * o da tela faria um item de R$ 1 congelar cinco unidades de R$ 50.
   */
  packageId: uuidSchema.optional(),
  /**
   * O produto do catálogo que este item vende (bloco 44) — e a borda o
   * **descartava**.
   *
   * `adicionarItem` aceita `productId` desde aquele bloco: é ele que faz a
   * venda e a baixa de estoque serem o mesmo dado, e é dele que sai o preço,
   * lido do catálogo dentro da transação. Sem o campo aqui, o corpo chegava
   * limpo ao domínio e não existia caminho no produto para vender um produto:
   * a recepção digitava "Pomada · R$ 79,00" no campo livre, que é sempre
   * `service`. A pomada pagava comissão na regra de serviço, entrava no DRE
   * como receita de serviço e o estoque não se mexia.
   *
   * É o defeito de `blocks` — motor que aceita e ninguém preenche —, com oito
   * blocos de idade, sobre a distinção revenda × consumo interno que a SPEC
   * §3.7 chama de obrigatória.
   */
  productId: uuidSchema.optional(),
});

export const ajusteSchema = z.object({
  desconto: z
    .object({
      tipo: z.enum(['amount', 'percent']),
      valor: z.number().int().min(0),
      motivo: z.string().trim().max(200).optional(),
    })
    .nullable()
    .optional(),
  gorjetaCents: centavos.optional(),
  /**
   * De quem é a gorjeta (SPEC §3.6, bloco 124).
   *
   * `null` é a escolha explícita de **ratear entre quem atendeu**, que é o
   * padrão; ausente é "não mexa", como todo campo opcional desta borda.
   */
  gorjetaProfessionalId: uuidSchema.nullable().optional(),
});

export const fecharComandaSchema = z.object({
  pagamentos: z
    .array(
      z.object({
        forma: z.enum(FORMAS_DE_PAGAMENTO),
        valorCents: centavosPositivos,
      }),
    )
    .min(1)
    .max(5),
  /**
   * Quantos pontos, visitas ou centavos o cliente está resgatando (bloco 41).
   *
   * Separado do pagamento porque a **unidade** é outra: o pagamento diz quantos
   * centavos abateram da conta; isto diz quanto sai do saldo. Em `visitas` os
   * dois nem se parecem — dez visitas viram a conta inteira.
   *
   * O domínio reconfere o par sob a trava e recusa se não bater: o número da
   * tela nunca é a verdade sobre o saldo.
   */
  resgateQuantidade: z.number().int().positive().optional(),
  /**
   * Qual serviço o pacote está cobrindo, quando há pagamento por pacote
   * (bloco 42).
   *
   * Vem separado do pagamento pela mesma razão do resgate: a forma diz "quitou
   * pelo pacote", isto diz **qual** unidade some. O domínio confere que o
   * serviço está nesta comanda e que o valor bate com a unidade congelada.
   *
   * Não há par `pacotesVendidos`: quem foi vendido é derivado dos itens de
   * pacote da comanda, que são os que carregam o preço cobrado.
   */
  servicoDoPacote: uuidSchema.optional(),
});

export const receberFiadoSchema = z.object({
  customerId: uuidSchema,
  amountCents: centavosPositivos,
  // Fiado não paga fiado; o domínio também recusa, e aqui já nem chega.
  forma: z.enum(['cash', 'debit', 'credit', 'pix']),
});

export const diaSchema = z.object({
  // A data é só o dia; o fuso vem da unidade, nunca do aparelho (defeito D2).
  dia: diaISO.optional(),
});

export const codigoMfaSchema = z.object({
  // Aceita com ou sem hífen: o código de recuperação é lido de um papel.
  codigo: z.string().trim().min(6).max(20),
});

// -- Comissão -------------------------------------------------------------------

export const periodoSchema = z.object({
  de: diaISO.optional(),
  ate: diaISO.optional(),
});

export const fecharComissaoSchema = z.object({
  de: diaISO,
  ate: diaISO,
  notas: z.string().trim().max(500).optional(),
});

/**
 * Alíquota em pontos-base, sempre inteira.
 *
 * 40% é `4000`. Aceitar `0.4` aqui poria ponto flutuante na única porta que
 * ainda não tinha — e a diferença só apareceria no centavo do acerto do mês.
 */
export const regraDeComissaoSchema = z
  .object({
    professionalId: uuidSchema.optional(),
    serviceId: uuidSchema.optional(),
    categoryId: uuidSchema.optional(),
    modo: z.enum(MODOS_DE_COMISSAO),
    valor: z.number().int().min(0).max(10_000_000),
    faixas: z
      .array(
        z.object({
          ateCents: z.number().int().positive().nullable(),
          pontosBase: z.number().int().min(0).max(10_000),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine((r) => r.modo !== 'tiers' || (r.faixas?.length ?? 0) > 0, {
    message: 'Modo por faixas exige pelo menos uma faixa.',
    path: ['faixas'],
  });

export const configuracaoDeComissaoSchema = z.object({
  base: z.enum(BASES_DE_COMISSAO),
  tratamentoDoDesconto: z.enum(TRATAMENTOS_DO_DESCONTO),
  tratamentoDaTaxa: z.enum(TRATAMENTOS_DA_TAXA),
});

/**
 * A alíquota do adquirente por meio de pagamento (bloco 36).
 *
 * Teto de 30% na borda e no banco: acima disso é erro de digitação — 3,19
 * virando 319 —, e o estrago seria a comissão do mês inteiro de todo mundo.
 */
export const aliquotaDoAdquirenteSchema = z.object({
  /**
   * `fiado` fica de fora, e não é detalhe.
   *
   * Ele não é meio de pagamento — é dívida. Cobrar taxa de adquirente sobre um
   * fiado seria cobrar a maquininha de um dinheiro que não passou por ela, e o
   * barbeiro pagaria por uma transação que não existiu. A taxa do fiado nasce
   * quando o cliente volta e paga de verdade, no meio que ele escolher.
   *
   * `cash` continua na lista: há adquirente que cobra tarifa por saque, e a
   * barbearia que paga isso tem onde declarar.
   */
  forma: z.enum(FORMAS_DE_PAGAMENTO).refine((f) => f !== 'fiado', {
    message: 'Fiado não é meio de pagamento: a taxa nasce quando o cliente paga.',
  }),
  bps: z.number().int().min(0).max(3000),
});

/**
 * O meio da cobrança online (blocos 35 e 36).
 *
 * Lista fechada e **sem padrão**: um padrão silencioso faria o balcão emitir
 * Pix quando quis mandar link, e o erro só apareceria com o cliente esperando o
 * QR Code que não é o dele. `cartao` e `link` entram no bloco 36.
 */
export const cobrancaSchema = z.object({
  meio: z.enum(['pix', 'cartao', 'link']),
});
