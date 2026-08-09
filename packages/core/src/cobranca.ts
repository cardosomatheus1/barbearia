/**
 * A régua de cobrança e o rateio da troca de plano (bloco 28, SPEC §9).
 *
 * Lógica pura: o relógio entra por parâmetro e todo dinheiro é centavo inteiro.
 * É o mesmo motivo da comissão — quem decide quanto se cobra tem que poder ser
 * conferido sem banco, sem rede e sem depender do dia em que a suíte roda.
 *
 * ## O que este arquivo recusa a fazer
 *
 * **A régua não bloqueia no dia do vencimento.** Bloqueio é o produto saindo do
 * ar para uma barbearia que está atendendo gente — a agenda para, o cliente que
 * ia marcar não marca, e o telefone que toca é o do dono. Cortar no dia
 * seguinte ao boleto atrasado é o comportamento que faz um cliente odiar o
 * fornecedor de software, e é justamente o que o produto vende contra.
 *
 * Entre o vencimento e o bloqueio existe uma janela com nome, prazo e aviso
 * escrito. É por isso que `past_due` não é bloqueio (ver a migração 0029): o
 * estado de cobrança e o estado de acesso são coisas diferentes, e quem os
 * confunde entrega o corte automático.
 */

/**
 * Quantos dias antes do vencimento o dono é avisado.
 *
 * Três, e não um: o aviso serve para dar tempo de resolver — trocar o cartão,
 * falar com o contador, pedir a segunda via. Aviso de véspera é comunicado de
 * bloqueio com outro nome.
 */
export const ANTECEDENCIA_DO_AVISO_DIAS = 3;

/**
 * A escada da retentativa, em dias depois do vencimento.
 *
 * Cresce porque a causa muda com o tempo: no primeiro dia é quase sempre saldo
 * ou limite, o que se resolve sozinho em horas; na segunda semana já é cartão
 * cancelado, o que exige alguém agir. Repetir de hora em hora contra um cartão
 * recusado só queima reputação com o adquirente — e cada tentativa recusada
 * conta contra a loja.
 */
export const DIAS_DE_RETENTATIVA: readonly number[] = [1, 3, 7, 14];

/**
 * Quantos dias depois do vencimento a barbearia sai do ar.
 *
 * Vinte e um: três semanas em que o produto continua funcionando com a conta
 * vencida. É deliberadamente longo — a barbearia tem agenda marcada para os
 * próximos dias, e tirá-la do ar cancela o dia de trabalho de gente que não
 * decidiu nada sobre pagamento.
 */
export const DIAS_ATE_BLOQUEIO = 21;

const DIA_MS = 86_400_000;

export type PassoDaRegua =
  /** Nada a fazer com esta fatura agora. */
  | 'nada'
  /** Falta pouco para vencer e o dono ainda não foi avisado. */
  | 'avisar_vencimento'
  /** Venceu: a assinatura passa a `past_due` e o dono é avisado. */
  | 'marcar_vencida'
  /** Está na hora de tentar cobrar de novo. */
  | 'retentar'
  /** Esgotou a janela: a barbearia sai do ar. */
  | 'bloquear';

export interface EstadoDaFatura {
  /** `open` é a única que a régua move; `paid` e `void` já terminaram. */
  readonly status: 'open' | 'paid' | 'void';
  readonly vencimento: Date;
  /** Quantas cobranças já foram tentadas nesta fatura. */
  readonly tentativas: number;
  /** Quando o aviso de vencimento próximo saiu, se saiu. */
  readonly avisadaEm: Date | null;
  /** Quando a fatura foi marcada como vencida, se já foi. */
  readonly vencidaEm: Date | null;
}

const diasEntre = (de: Date, ate: Date): number =>
  Math.floor((ate.getTime() - de.getTime()) / DIA_MS);

/**
 * O que fazer com uma fatura agora.
 *
 * Um passo por chamada, e de propósito: cada passo escreve estado, e quem
 * devolvesse uma lista obrigaria quem chama a decidir a ordem — que é
 * exatamente a decisão que este arquivo existe para tomar.
 *
 * A ordem é do mais grave para o menos: bloquear vence retentar, que vence
 * marcar vencida. Uma fatura que passou de 21 dias sem ninguém rodar a régua
 * (worker parado, por exemplo) não fica presa tentando cobrar — ela bloqueia.
 */
export function proximoPassoDaRegua(fatura: EstadoDaFatura, agora: Date): PassoDaRegua {
  if (fatura.status !== 'open') return 'nada';

  const dias = diasEntre(fatura.vencimento, agora);

  if (dias >= DIAS_ATE_BLOQUEIO) return 'bloquear';

  if (dias >= 0) {
    if (fatura.vencidaEm === null) return 'marcar_vencida';

    /**
     * `tentativas` conta cobranças **feitas**, e a primeira é a da emissão.
     *
     * Ela não é uma retentativa: é o débito na hora, fora da régua. Por isso a
     * fatura chega vencida já com `tentativas = 1`, e a próxima retentativa —
     * a primeira da escada, `DIAS_DE_RETENTATIVA[0]` — é `tentativas - 1`.
     *
     * A primeira versão indexava pelo contador cru e adiava toda a escada em um
     * degrau: a cobrança de D+1 saía em D+3, e a última nunca saía.
     */
    const proxima = DIAS_DE_RETENTATIVA[fatura.tentativas - 1];
    if (proxima !== undefined && dias >= proxima) return 'retentar';
    return 'nada';
  }

  if (fatura.avisadaEm === null && -dias <= ANTECEDENCIA_DO_AVISO_DIAS) {
    return 'avisar_vencimento';
  }

  return 'nada';
}

/**
 * Quanto falta para a barbearia sair do ar, em dias.
 *
 * É o número que o aviso carrega e que a tela do dono mostra. Negativo não
 * existe aqui: passado o prazo, a resposta é zero — "hoje", e não "faz três
 * dias que devia".
 */
export function diasAteOBloqueio(vencimento: Date, agora: Date): number {
  return Math.max(0, DIAS_ATE_BLOQUEIO - diasEntre(vencimento, agora));
}

export interface Rateio {
  /** O que se cobra agora pela troca. Zero ou positivo. */
  readonly cobrarCents: number;
  /** O que sobra a favor da barbearia. Zero ou positivo. */
  readonly creditarCents: number;
  readonly diasRestantes: number;
  readonly diasDoPeriodo: number;
}

/**
 * O rateio proporcional da troca de plano no meio do período.
 *
 * Sem ele, o botão de trocar de plano cobra mês cheio por meio mês — que é o
 * motivo pelo qual a troca ficou de fora do bloco 27.
 *
 * ## As três decisões
 *
 * 1. **Proporcional ao dia, não à hora.** A unidade de cobrança do produto é o
 *    dia; ratear por hora produziria centavos diferentes conforme o minuto do
 *    clique, e ninguém consegue conferir isso num extrato.
 *
 * 2. **O dia da troca conta para o plano novo.** Quem sobe de plano ao meio-dia
 *    usa o recurso novo naquela tarde. Contá-lo para o plano velho entregaria de
 *    graça o dia inteiro; contar para os dois cobraria duas vezes.
 *
 * 3. **O arredondamento é a favor da barbearia.** A parte a cobrar desce
 *    (`floor`) e a parte a creditar sobe (`ceil`). São centavos, e a alternativa
 *    — arredondar a favor de quem emite a fatura — é a decisão que ninguém
 *    escreve no contrato e todo mundo descobre depois.
 */
export function ratear(entrada: {
  readonly precoAtualCents: number;
  readonly precoNovoCents: number;
  readonly periodoInicio: Date;
  readonly periodoFim: Date;
  readonly agora: Date;
}): Rateio {
  const diasDoPeriodo = Math.max(1, diasEntre(entrada.periodoInicio, entrada.periodoFim));
  const decorridos = Math.min(diasDoPeriodo, Math.max(0, diasEntre(entrada.periodoInicio, entrada.agora)));
  const diasRestantes = diasDoPeriodo - decorridos;

  const aCobrar = Math.floor((entrada.precoNovoCents * diasRestantes) / diasDoPeriodo);
  const aCreditar = Math.ceil((entrada.precoAtualCents * diasRestantes) / diasDoPeriodo);
  const saldo = aCobrar - aCreditar;

  return {
    cobrarCents: Math.max(0, saldo),
    creditarCents: Math.max(0, -saldo),
    diasRestantes,
    diasDoPeriodo,
  };
}
