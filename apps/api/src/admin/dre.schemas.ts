import { z } from 'zod';

/**
 * A borda do DRE, do vale e do estorno (bloco 52).
 */

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');

/**
 * O período do relatório tem teto nas **duas** pontas.
 *
 * Só o começo conferido deixaria "de 2020 até 2099" passar — uma varredura de
 * setenta e nove anos de venda por requisição. É o mesmo achado que a faixa de
 * dias da lista de espera teve no bloco 38.
 */
export const periodoDoDreSchema = z
  .object({ de: dia.optional(), ate: dia.optional() })
  .refine((p) => (p.de === undefined) === (p.ate === undefined), {
    message: 'Informe o período inteiro ou nenhum.',
  })
  .refine((p) => p.de === undefined || p.ate === undefined || p.ate >= p.de, {
    message: 'O fim vem antes do início.',
  })
  .refine(
    (p) =>
      p.de === undefined
      || p.ate === undefined
      || Date.parse(`${p.ate}T00:00:00Z`) - Date.parse(`${p.de}T00:00:00Z`) <= 400 * 86_400_000,
    { message: 'O período não passa de um ano.' },
  );

/**
 * O mês corrente **da unidade**, do primeiro ao último dia.
 *
 * Fica na API e não na tela porque o dia de hoje é o da unidade, nunca o do
 * aparelho: às 22h de Salvador o UTC já virou, e no dia 30 o relatório abriria
 * no mês seguinte, vazio, para quem ainda está trabalhando. É o defeito D2.
 */
export function mesDaUnidade(hoje: string): { de: string; ate: string } {
  const [ano, mes] = hoje.split('-');
  if (!ano || !mes) return { de: hoje, ate: hoje };
  const ultimo = new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate();
  return { de: `${ano}-${mes}-01`, ate: `${ano}-${mes}-${String(ultimo).padStart(2, '0')}` };
}

/** Cem mil reais de vale é um zero a mais em qualquer barbearia. */
export const valeNovoSchema = z.object({
  professionalId: z.string().uuid(),
  valorCents: z.number().int().positive().max(10_000_000),
  /**
   * O dia **não** vem do formulário: o vale é sempre de hoje, e hoje é o dia da
   * unidade. Aceitá-lo do cliente deixaria o balcão datar um adiantamento para
   * dentro de um período já fechado — e é o defeito D2 com uma consequência
   * contábil.
   */
  de: dia,
  ate: dia,
  motivo: z.string().trim().max(300).nullable().optional(),
  pelaGaveta: z.boolean(),
});

export const cancelamentoDeValeSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

export const estornoSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

export const transferenciaDePacoteSchema = z.object({
  paraCustomerId: z.string().uuid(),
  motivo: z.string().trim().min(3).max(300),
});

export const periodoDoValeSchema = z.object({
  de: dia,
  ate: dia,
  professionalId: z.string().uuid().optional(),
});
