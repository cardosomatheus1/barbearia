import { z } from 'zod';

/**
 * A borda do clube (bloco 45).
 *
 * Os limites repetem os `CHECK` da migração 0048: o banco é a garantia, a borda
 * é a mensagem.
 */
export const planoSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  descricao: z.string().trim().max(300).nullable().optional(),
  precoCents: z.number().int().positive().max(1_000_000),
  // 5000 = 50%. Acima disso a casa paga para vender, e costuma ser um zero a mais.
  descontoEmProdutoBps: z.number().int().min(0).max(5000),
  ativo: z.boolean(),
  /** Dias de antecedência a mais que o visitante (bloco 46). Zero é a da casa. */
  janelaDeAgendamentoDias: z.number().int().min(0).max(180).optional(),
  /**
   * As faixas em que o plano **não** vale (bloco 46).
   *
   * O proibido e não o permitido: a barbearia abre setenta horas e bloqueia
   * quatro. Guardar o permitido faria toda mudança de horário de funcionamento
   * exigir reescrever o plano.
   */
  bloqueios: z
    .array(
      z.object({
        diaDaSemana: z.number().int().min(0).max(6).nullable(),
        inicio: z.number().int().min(0).max(1440),
        fim: z.number().int().min(0).max(1440),
      }).refine((b) => b.inicio < b.fim, 'a faixa termina antes de começar'),
    )
    .max(21)
    .optional(),
  beneficios: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        /** Nulo é ilimitado, e não um número grande — um `9999` é cota disfarçada. */
        quantidade: z.number().int().positive().max(100).nullable(),
        cooldownDias: z.number().int().min(0).max(90),
      }),
    )
    .max(10),
});

export const assinarSchema = z.object({
  customerId: z.string().uuid(),
  planId: z.string().uuid(),
});

export const cancelarSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

export const dependenteSchema = z.object({
  customerId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// A cobrança recorrente (bloco 47)
// ---------------------------------------------------------------------------

/**
 * A baixa manual de uma mensalidade.
 *
 * Enum fechado e não texto livre: o meio de pagamento é lido depois para saber
 * de onde o dinheiro veio, e "PIX", "pix " e "Pix" seriam três colunas no
 * relatório do mês.
 */
export const baixaDaFaturaSchema = z.object({
  metodo: z.enum(['dinheiro', 'pix', 'cartao', 'transferencia']),
});

/**
 * Cancelar uma fatura é perdoar uma dívida — e dívida perdoada tem motivo
 * escrito, como o desconto do bloco 30 e o ajuste de saldo do bloco 41.
 */
export const cancelarFaturaSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

/**
 * O cartão salvo da assinatura.
 *
 * Token, bandeira, quatro últimos e validade. **Não existe campo para número nem
 * para CVV** — a borda recusa antes do banco, e o banco não tem coluna para eles.
 */
export const cartaoDaAssinaturaSchema = z.object({
  token: z.string().trim().min(1).max(200),
  bandeira: z.string().trim().min(2).max(30),
  ultimosQuatro: z.string().regex(/^[0-9]{4}$/),
  mes: z.number().int().min(1).max(12),
  ano: z.number().int().min(2020).max(2100),
});

/**
 * O cancelamento self-service.
 *
 * O motivo é **opcional** aqui, ao contrário do cancelamento pelo balcão: exigir
 * que a pessoa justifique para poder sair é o atrito que a SPEC §4.6 manda tirar,
 * e o clube que o pratica vira reclamação no Procon.
 */
export const meuCancelamentoSchema = z.object({
  motivo: z.string().trim().max(300).optional(),
});

/**
 * O modelo de comissão sobre assinatura (bloco 48, SPEC §3.4).
 *
 * O teto vale só para o híbrido, e vem sempre: guardá-lo mesmo quando o modelo é
 * outro é o que permite alternar entre eles sem perder o número que o dono
 * escolheu — voltar do rateio para o híbrido não pode zerar o teto.
 */
export const modeloDaAssinaturaSchema = z.object({
  modo: z.enum(['por_uso', 'rateio', 'hibrido']),
  tetoBps: z.number().int().min(0).max(10000),
});

/** O recorte da simulação. Um mês fechado é o que responde a pergunta. */
export const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
