import { type Confiabilidade } from './confiabilidade.js';

/**
 * Sinal seletivo e política de reembolso (SPEC §2.12, camada 2).
 *
 * ## O problema que ele resolve
 *
 * Cobrar sinal de todo mundo espanta o cliente novo — que é justamente quem a
 * barbearia mais quer. Não cobrar de ninguém deixa a agenda exposta a quem já
 * faltou três vezes. A regra é condicional, e é isso que a torna vendável.
 *
 * ## Quem decide o quê
 *
 * Este arquivo decide **se** e **quanto**. Ele não cobra: a cobrança é do
 * adquirente (bloco 35 e 36), e o reembolso também. Aqui não há rede, banco nem
 * relógio — só a regra, que precisa poder ser lida e discutida por quem opera.
 *
 * ## O que a SPEC pede e este bloco não entrega
 *
 * A condição literal tem quatro termos:
 *
 *     exigir_sinal = score < limiar
 *                 OR ticket > valor_limite
 *                 OR (cliente_novo AND horario_de_pico)
 *                 OR servico.always_require_deposit
 *
 * O terceiro fica de fora, e é decisão declarada: **não existe "horário de
 * pico" no produto**. Nem coluna, nem cálculo de demanda, nem tela onde a
 * barbearia diga quais são as suas horas cheias. Escrever o termo aqui criaria
 * um parâmetro que ninguém preenche — o defeito de `blocks`, que este
 * repositório já pagou uma vez. Está na tabela de lacunas do ROADMAP, com a
 * dependência escrita.
 *
 * "Cartão de garantia" — cartão registrado e cobrado só em caso de falta — fica
 * de fora pelo mesmo critério: exige tokenizar cartão e capturar depois, que é
 * outro contrato com o adquirente.
 */

/** Como a barbearia cobra o sinal, quando cobra. */
export const MODALIDADES_DE_SINAL = ['nenhum', 'fixo', 'percentual', 'total'] as const;
export type ModalidadeDeSinal = (typeof MODALIDADES_DE_SINAL)[number];

/**
 * Abaixo disto o sinal é obrigatório, e acima daquilo ele é dispensado.
 *
 * Os dois números são da SPEC §2.13 e são o **padrão**, não a lei: cada
 * barbearia ajusta o limiar. O piso de dispensa não é configurável de propósito
 * — ele é a promessa ao cliente fiel, e uma barbearia que o baixasse estaria
 * cobrando sinal de quem nunca faltou.
 */
export const LIMIAR_PADRAO_DE_SINAL = 60;
export const SCORE_QUE_DISPENSA_SINAL = 85;

export interface PoliticaDeSinal {
  readonly modalidade: ModalidadeDeSinal;
  /** Usado quando a modalidade é `fixo`. */
  readonly valorFixoCents: number;
  /** Pontos-base sobre o ticket, quando a modalidade é `percentual`. 3000 = 30%. */
  readonly percentualBps: number;
  /** Score abaixo do qual o sinal passa a ser exigido. */
  readonly limiarDeScore: number;
  /**
   * Ticket acima do qual o sinal é exigido de qualquer um. Zero desliga.
   *
   * É o segundo termo da SPEC, e ele existe para o caso que o score não cobre:
   * um cliente impecável marcando quatro serviços num sábado. A perda de uma
   * falta ali não é a de um corte.
   */
  readonly tetoSemSinalCents: number;
  /**
   * Horas de antecedência para o cancelamento devolver o sinal.
   *
   * Separada de `cancel_min_hours`, que diz se o cancelamento é **permitido**.
   * São perguntas diferentes: a barbearia pode aceitar cancelamento até uma hora
   * antes e ainda assim reter o sinal de quem cancela em cima.
   */
  readonly horasParaReembolso: number;
}

export const POLITICA_SEM_SINAL: PoliticaDeSinal = {
  modalidade: 'nenhum',
  valorFixoCents: 0,
  percentualBps: 0,
  limiarDeScore: LIMIAR_PADRAO_DE_SINAL,
  tetoSemSinalCents: 0,
  horasParaReembolso: 24,
};

export interface PedidoDeSinal {
  readonly politica: PoliticaDeSinal;
  readonly confianca: Confiabilidade;
  readonly ticketCents: number;
  /** Algum dos serviços marcados sempre exige sinal. */
  readonly servicoSempreExige: boolean;
}

export type MotivoDoSinal = 'servico' | 'score' | 'ticket';

export interface DecisaoDeSinal {
  readonly exigido: boolean;
  /** Por que foi exigido. Nulo quando não foi. */
  readonly motivo: MotivoDoSinal | null;
  readonly valorCents: number;
}

/**
 * Quanto o sinal custaria, se fosse exigido.
 *
 * Nunca passa do ticket: um sinal maior que o serviço seria a barbearia
 * cobrando adiantado mais do que vai faturar, e o cliente pagando para marcar.
 */
export function valorDoSinal(politica: PoliticaDeSinal, ticketCents: number): number {
  const bruto = (() => {
    switch (politica.modalidade) {
      case 'nenhum':
        return 0;
      case 'fixo':
        return politica.valorFixoCents;
      case 'percentual':
        // Centavos inteiros, arredondados uma vez. Pontos-base porque é assim
        // que toda alíquota deste produto é escrita.
        return Math.round((ticketCents * politica.percentualBps) / 10_000);
      case 'total':
        return ticketCents;
    }
  })();
  return Math.max(0, Math.min(bruto, ticketCents));
}

/**
 * Se este agendamento pede sinal, e quanto.
 *
 * ## A ordem dos termos é a ordem da explicação
 *
 * O motivo devolvido é o **primeiro** que se aplica, e a ordem não é acidental:
 * é a que a recepção usa para explicar ao cliente. "Este serviço sempre pede
 * sinal" é uma frase sobre o serviço; "seu histórico" é uma frase sobre a
 * pessoa, e ninguém quer dizê-la se houver outra verdadeira antes.
 *
 * ## Quem nunca faltou não paga sinal
 *
 * A dispensa por score alto vence **tudo**, inclusive o serviço que sempre
 * exige. É a contrapartida que torna a cobrança justa: se nem o cliente
 * impecável escapa, o sinal deixa de ser seletivo e vira pedágio.
 *
 * O teto de ticket é a exceção da exceção — ali o risco não é a pessoa, é o
 * tamanho da reserva, e uma falta de quatro serviços num sábado custa o sábado.
 */
export function decidirSinal(pedido: PedidoDeSinal): DecisaoDeSinal {
  const { politica, confianca, ticketCents, servicoSempreExige } = pedido;
  const nao: DecisaoDeSinal = { exigido: false, motivo: null, valorCents: 0 };

  if (politica.modalidade === 'nenhum') return nao;

  const acimaDoTeto = politica.tetoSemSinalCents > 0 && ticketCents > politica.tetoSemSinalCents;

  // Cliente impecável não paga sinal — menos quando o risco é o tamanho da
  // reserva, e não ele.
  const dispensado =
    confianca.temEfeito && confianca.score >= SCORE_QUE_DISPENSA_SINAL && !acimaDoTeto;
  if (dispensado) return nao;

  const valorCents = valorDoSinal(politica, ticketCents);
  const sim = (motivo: MotivoDoSinal): DecisaoDeSinal => ({ exigido: true, motivo, valorCents });

  if (servicoSempreExige) return sim('servico');
  // `temEfeito` é o que protege o cliente novo: sem três agendamentos, o score é
  // 100 por presunção e não pode exigir nada.
  if (confianca.temEfeito && confianca.score < politica.limiarDeScore) return sim('score');
  if (acimaDoTeto) return sim('ticket');

  return nao;
}

export type DesfechoDoSinal = 'devolver' | 'reter';

export interface PedidoDeReembolso {
  readonly politica: PoliticaDeSinal;
  /** Quem encerrou o agendamento. */
  readonly quem: 'cliente' | 'casa' | 'falta';
  /** Horas entre o cancelamento e o início do serviço. Nulo quando desconhecido. */
  readonly horasDeAntecedencia: number | null;
}

export interface DecisaoDeReembolso {
  readonly desfecho: DesfechoDoSinal;
  readonly porque: string;
}

/**
 * O sinal volta ou fica.
 *
 * A regra espelha a do score de propósito: **avisar cedo não custa nada**. Um
 * produto que retivesse o sinal de quem cancela com dois dias de antecedência
 * ensinaria o cliente a não cancelar — e a vaga que voltaria para a grade
 * viraria cadeira parada.
 *
 * A antecedência desconhecida devolve. Ela só é nula em agendamento anterior à
 * migração que passou a carimbar o cancelamento, e reter o dinheiro de alguém
 * por causa de um registro que a casa não fez é cobrar pelo próprio buraco.
 */
export function decidirReembolso(pedido: PedidoDeReembolso): DecisaoDeReembolso {
  if (pedido.quem === 'casa') {
    return { desfecho: 'devolver', porque: 'a barbearia cancelou' };
  }
  if (pedido.quem === 'falta') {
    // É exatamente o caso para o qual o sinal existe: cadeira parada, ninguém
    // avisou, e a vaga não teve como ser revendida.
    return { desfecho: 'reter', porque: 'o cliente não compareceu e não avisou' };
  }
  if (pedido.horasDeAntecedencia === null) {
    return { desfecho: 'devolver', porque: 'não há registro de quando o cancelamento aconteceu' };
  }
  return pedido.horasDeAntecedencia >= pedido.politica.horasParaReembolso
    ? { desfecho: 'devolver', porque: 'o cliente avisou dentro do prazo' }
    : { desfecho: 'reter', porque: 'o cliente cancelou depois do prazo de reembolso' };
}
