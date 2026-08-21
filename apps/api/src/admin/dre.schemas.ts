import { z } from 'zod';
import { diaISO } from '../common/data.js';

/**
 * A borda do DRE, do vale e do estorno (bloco 52).
 */


/**
 * O período do relatório tem teto nas **duas** pontas.
 *
 * Só o começo conferido deixaria "de 2020 até 2099" passar — uma varredura de
 * setenta e nove anos de venda por requisição. É o mesmo achado que a faixa de
 * dias da lista de espera teve no bloco 38.
 */
export const periodoDoDreSchema = z
  .object({
    de: diaISO.optional(),
    ate: diaISO.optional(),
    /**
     * A loja do relatório: um id, ou `todas` para o consolidado (bloco 129).
     *
     * Texto livre e não `uuid()` porque `todas` é um valor legítimo — quem
     * confere o id é `unidadeDoRelatorio`, sob RLS e contra as unidades que esta
     * conta enxerga. O teto de tamanho é o que impede a consulta de carregar
     * lixo até o banco.
     */
    unidade: z.string().trim().min(1).max(64).optional(),
  })
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
 * O mês corrente **da unidade**, do primeiro ao último diaISO.
 *
 * Fica na API e não na tela porque o diaISO de hoje é o da unidade, nunca o do
 * aparelho: às 22h de Salvador o UTC já virou, e no diaISO 30 o relatório abriria
 * no mês seguinte, vazio, para quem ainda está trabalhando. É o defeito D2.
 */
export function mesDaUnidade(hoje: string): { de: string; ate: string } {
  const [ano, mes] = hoje.split('-');
  if (!ano || !mes) return { de: hoje, ate: hoje };
  /**
   * Até **hoje**, nunca até o dia 31 (bloco 114).
   *
   * O padrão ia ao último dia do calendário, então no dia 20 a janela tinha 31
   * dias — onze deles ainda não aconteceram — e `periodoAnterior`, que
   * corretamente compara contra uma janela do mesmo tamanho, media 31 dias
   * cheios contra 20 dias de movimento mais 11 de vazio.
   *
   * O resultado é que toda queda que a tela mostrava era, na maior parte, a
   * diferença de duração: −38,9% em serviços onde a queda real era −6,3%. E o
   * Painel, ao lado, dizia −8% sobre o mesmo fato, porque ele já recortava o mês
   * anterior no mesmo dia do mês (§6, pergunta 6, entre duas telas do mesmo
   * módulo).
   *
   * A janela também alcançava receita de amanhã: uma mensalidade com `paid_at`
   * no dia 21 entrava no "resultado" consultado no dia 20.
   */
  return { de: `${ano}-${mes}-01`, ate: hoje };
}

/** Cem mil reais de vale é um zero a mais em qualquer barbearia. */
export const valeNovoSchema = z.object({
  professionalId: z.string().uuid(),
  valorCents: z.number().int().positive().max(10_000_000),
  /**
   * O diaISO **não** vem do formulário: o vale é sempre de hoje, e hoje é o diaISO da
   * unidade. Aceitá-lo do cliente deixaria o balcão datar um adiantamento para
   * dentro de um período já fechado — e é o defeito D2 com uma consequência
   * contábil.
   */
  de: diaISO,
  ate: diaISO,
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
  de: diaISO,
  ate: diaISO,
  professionalId: z.string().uuid().optional(),
});
