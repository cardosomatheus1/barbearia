/**
 * O risco de abandono, e o **porquê** dele (bloco 62, SPEC §4.5).
 *
 * > *"Score sem explicação não gera ação — o dono não confia e ignora. A
 * > explicação é requisito funcional, não enfeite."*
 *
 * É a frase que decide este arquivo, e ela tem uma consequência que um score
 * comum não tem: **o número e a explicação saem da mesma conta**. Cada sinal
 * contribui com pontos e com uma frase, e a frase diz o que aquele sinal
 * contribuiu. Uma explicação escrita depois, a partir do score pronto, seria
 * texto plausível ao lado de um número — e no primeiro caso em que os dois
 * discordassem, o dono descobriria que não pode confiar em nenhum dos dois.
 *
 * ## Por que não é probabilidade
 *
 * A SPEC escreve "risco de churn: 78%", e o produto **não** entrega uma
 * probabilidade calibrada: não há modelo treinado, não há rótulo de "abandonou"
 * gravado em lugar nenhum, e chamar de probabilidade uma soma de pesos é dar
 * cara de estatística a um palpite. O que sai daqui é um risco de 0 a 100 com os
 * motivos ao lado, que é o que produz a ação — e o dia em que houver base para
 * calibrar, a escala continua a mesma.
 *
 * ## Os sete sinais são os da SPEC, e a ordem é a da força
 *
 * *"desvio do ciclo próprio · avaliação baixa recente · ausência de agendamento
 * futuro · saída do barbeiro preferido · cancelamento recente · assinatura
 * vencida sem renovação · queda de ticket."*
 *
 * O primeiro é o que mais pesa porque é o único que sozinho já é o fato: quem
 * passou do próprio ritmo e não voltou **está** indo embora. Os outros seis
 * explicam por quê, e é para isso que servem.
 */

/** O ritmo desta pessoa, do bloco 61. Nulo para quem ainda não tem ciclo. */
export interface RitmoParaChurn {
  readonly medianaDias: number;
  readonly folgaDias: number;
}

export interface SinaisDeChurn {
  readonly ritmo: RitmoParaChurn | null;
  /** Dias desde a última visita. Nulo para quem nunca veio. */
  readonly diasSemVir: number | null;
  /** A nota da avaliação mais recente, de 1 a 5. Nula se nunca avaliou. */
  readonly ultimaNota: number | null;
  readonly temAgendamentoFuturo: boolean;
  /** O barbeiro de sempre saiu da equipe (inativo ou apagado). */
  readonly barbeiroHabitualSaiu: boolean;
  readonly nomeDoBarbeiroHabitual: string | null;
  /** Cancelou ou faltou no último atendimento marcado. */
  readonly cancelouRecentemente: boolean;
  /** Tinha assinatura e ela terminou sem renovar. */
  readonly assinaturaVencida: boolean;
  /** Assinatura ativa. Ela **segura** a pessoa, e o risco cai. */
  readonly assinaturaAtiva: boolean;
  /** O ticket médio das últimas visitas contra o das anteriores, em centavos. */
  readonly ticketRecenteCents: number | null;
  readonly ticketAnteriorCents: number | null;
}

export interface MotivoDeChurn {
  /** A chave é do domínio; a frase é o que a tela mostra. */
  readonly sinal: SinalDeChurn;
  readonly frase: string;
  readonly pontos: number;
}

export const SINAIS_DE_CHURN = [
  'atraso_no_ciclo',
  'nota_baixa',
  'sem_proximo',
  'barbeiro_saiu',
  'cancelou',
  'assinatura_vencida',
  'ticket_caindo',
  'assinatura_ativa',
] as const;
export type SinalDeChurn = (typeof SINAIS_DE_CHURN)[number];

export interface RiscoDeChurn {
  /** De 0 a 100. Não é probabilidade — ver o cabeçalho. */
  readonly risco: number;
  /**
   * Os motivos, do que mais pesou para o que menos pesou.
   *
   * Vazio significa risco zero e a tela diz isso com uma frase própria. Uma
   * lista vazia ao lado de um número é o que ensina o dono a não olhar.
   */
  readonly motivos: readonly MotivoDeChurn[];
  /**
   * Se dá para responder. Falso quando não há ritmo — e aí o risco é zero, não
   * baixo.
   *
   * A diferença importa na tela: "risco 0" sobre quem veio uma vez é uma
   * afirmação que o produto não tem como fazer, e some no meio de uma lista
   * ordenada por risco como se fosse boa notícia.
   */
  readonly temBase: boolean;
}

/**
 * Quanto o atraso no ciclo pesa, no teto.
 *
 * O nome diz **no ciclo** porque `confiabilidade.ts` já tem um `PESO_DO_ATRASO`,
 * e ele é outra coisa: lá "atraso" é chegar depois da hora marcada, aqui é estar
 * vencido para voltar. Duas coisas diferentes com o mesmo nome é como uma passa
 * a ser lida como a outra — e o compilador só reclamou porque as duas moram no
 * mesmo barril de exportação.
 *
 * Metade da escala num sinal só, porque ele é o único que **é** o fato: os
 * outros seis são circunstâncias que tornam a volta menos provável. Um score em
 * que cinco circunstâncias somassem mais que o abandono em curso ordenaria a
 * lista pelo que é mais fácil de medir, não pelo que é mais urgente.
 */
export const PESO_DO_ATRASO_NO_CICLO = 50;

export const PESO_DA_NOTA_BAIXA = 15;
export const PESO_SEM_PROXIMO = 10;
export const PESO_DO_BARBEIRO = 12;
export const PESO_DO_CANCELAMENTO = 8;
export const PESO_DA_ASSINATURA_VENCIDA = 10;
export const PESO_DO_TICKET = 8;

/**
 * O desconto de quem assina, e por que ele é negativo em vez de ausente.
 *
 * Assinatura ativa é a coisa que mais segura uma pessoa neste produto — há uma
 * mensalidade correndo e um benefício a perder. Sem o desconto, um assinante
 * atrasado apareceria no topo da lista de risco ao lado de quem não tem vínculo
 * nenhum, e o dono gastaria a campanha na pessoa errada.
 *
 * Ele **não** zera o risco: assinante que sumiu é justamente quem cancela a
 * mensalidade no fim do mês, e o bloco 61 já decidiu que ele é olhado como quem
 * está indo embora, não como assinante.
 */
export const DESCONTO_DE_ASSINANTE = -15;

/** Abaixo desta nota a avaliação conta como sinal. */
export const NOTA_QUE_PREOCUPA = 3;

/** A queda de ticket que conta, em pontos-base do ticket anterior. */
export const QUEDA_DE_TICKET_BPS = 2500;

const limitar = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Quanto do atraso já foi consumido, de 0 a 1.
 *
 * Zero até o fim da folga — quem está dentro do próprio ritmo não deve nada — e
 * cheio ao dobro do ciclo, que é onde o bloco 61 chama de perdido. Entre os dois
 * a subida é linear, e é de propósito: uma curva mais esperta seria um parâmetro
 * a mais para ninguém conseguir explicar no balcão, e a explicação é o requisito.
 */
function fracaoDoAtraso(ritmo: RitmoParaChurn, diasSemVir: number): number {
  const inicio = ritmo.medianaDias + ritmo.folgaDias;
  const fim = ritmo.medianaDias * 2;
  if (diasSemVir <= inicio) return 0;
  if (fim <= inicio) return 1;
  return Math.min(1, (diasSemVir - inicio) / (fim - inicio));
}

const dias = (n: number) => `${n} ${n === 1 ? 'dia' : 'dias'}`;

/**
 * O risco e os motivos, na mesma conta.
 *
 * `agora` não entra aqui: quem converte instante em "dias sem vir" é o
 * repositório, que já precisou do relógio para carregar a janela. Receber os
 * dois seria duas fontes para a mesma verdade.
 */
export function riscoDeChurn(sinais: SinaisDeChurn): RiscoDeChurn {
  const motivos: MotivoDeChurn[] = [];

  /**
   * Sem ritmo não há resposta, e a resposta é dizer isso.
   *
   * Quem veio uma vez pode estar indo embora ou pode voltar semana que vem — não
   * há como distinguir, e um número baixo afirmaria a segunda coisa.
   */
  if (!sinais.ritmo || sinais.diasSemVir === null) {
    return { risco: 0, motivos: [], temBase: false };
  }

  const atraso = fracaoDoAtraso(sinais.ritmo, sinais.diasSemVir);
  if (atraso > 0) {
    motivos.push({
      sinal: 'atraso_no_ciclo',
      frase: `Normalmente volta a cada ${dias(sinais.ritmo.medianaDias)} e está há ${dias(
        sinais.diasSemVir,
      )} sem voltar`,
      pontos: Math.round(PESO_DO_ATRASO_NO_CICLO * atraso),
    });
  }

  if (sinais.ultimaNota !== null && sinais.ultimaNota <= NOTA_QUE_PREOCUPA) {
    motivos.push({
      sinal: 'nota_baixa',
      frase: `A última avaliação dele foi nota ${sinais.ultimaNota}`,
      pontos: PESO_DA_NOTA_BAIXA,
    });
  }

  if (!sinais.temAgendamentoFuturo) {
    motivos.push({
      sinal: 'sem_proximo',
      frase: 'Não tem horário marcado',
      pontos: PESO_SEM_PROXIMO,
    });
  }

  if (sinais.barbeiroHabitualSaiu) {
    motivos.push({
      sinal: 'barbeiro_saiu',
      /**
       * O nome sai quando existe.
       *
       * "O barbeiro de sempre saiu da equipe" é verdade e não ajuda ninguém a
       * agir; "João saiu da equipe" é o que faz a recepção saber com quem
       * remarcar. O nome é de funcionário, não de cliente — não é dado pessoal
       * de titular que o produto proteja.
       */
      frase: sinais.nomeDoBarbeiroHabitual
        ? `${sinais.nomeDoBarbeiroHabitual}, que sempre o atendia, saiu da equipe`
        : 'O profissional que sempre o atendia saiu da equipe',
      pontos: PESO_DO_BARBEIRO,
    });
  }

  if (sinais.cancelouRecentemente) {
    motivos.push({
      sinal: 'cancelou',
      frase: 'O último horário marcado não aconteceu',
      pontos: PESO_DO_CANCELAMENTO,
    });
  }

  if (sinais.assinaturaVencida) {
    motivos.push({
      sinal: 'assinatura_vencida',
      frase: 'A assinatura dele terminou e não foi renovada',
      pontos: PESO_DA_ASSINATURA_VENCIDA,
    });
  }

  const queda = quedaDeTicket(sinais);
  if (queda !== null) {
    motivos.push({
      sinal: 'ticket_caindo',
      frase: `Está gastando ${queda}% menos por visita do que gastava`,
      pontos: PESO_DO_TICKET,
    });
  }

  if (sinais.assinaturaAtiva) {
    motivos.push({
      sinal: 'assinatura_ativa',
      frase: 'Tem assinatura ativa, o que segura a volta',
      pontos: DESCONTO_DE_ASSINANTE,
    });
  }

  /**
   * A ordem é a do peso, e o desconto vai para o fim por ser negativo.
   *
   * Quem lê a explicação lê de cima para baixo e para quando entendeu. O motivo
   * mais forte primeiro é o que faz três linhas bastarem.
   */
  motivos.sort((a, b) => b.pontos - a.pontos);

  return {
    risco: limitar(motivos.reduce((soma, m) => soma + m.pontos, 0)),
    motivos,
    temBase: true,
  };
}

/**
 * Quanto o ticket caiu, em pontos percentuais inteiros, ou nulo.
 *
 * Só conta queda acima do piso: variação de um corte para um corte com barba é
 * normal, e um sinal que dispara com qualquer oscilação vira ruído em toda a
 * base. Ticket anterior zero devolve nulo em vez de infinito — é a mesma decisão
 * da divisão por zero nos relatórios do bloco 55.
 */
function quedaDeTicket(sinais: SinaisDeChurn): number | null {
  const antes = sinais.ticketAnteriorCents;
  const agora = sinais.ticketRecenteCents;
  if (antes === null || agora === null || antes <= 0) return null;
  const quedaBps = Math.round(((antes - agora) / antes) * 10_000);
  if (quedaBps < QUEDA_DE_TICKET_BPS) return null;
  return Math.round(quedaBps / 100);
}

/**
 * A faixa que a tela pinta, derivada do risco.
 *
 * Três e não cinco: o dono age ou não age, e a faixa do meio é a que ele olha
 * quando tem tempo. Uma escala de cinco níveis obrigaria a decidir a diferença
 * entre "médio" e "médio-alto", que ninguém consegue explicar no balcão.
 */
export type FaixaDeChurn = 'baixo' | 'medio' | 'alto';

export const ROTULO_DA_FAIXA_DE_CHURN: Readonly<Record<FaixaDeChurn, string>> = {
  baixo: 'Risco baixo',
  medio: 'Risco médio',
  alto: 'Risco alto',
};

export function faixaDeChurn(risco: number): FaixaDeChurn {
  if (risco >= 60) return 'alto';
  if (risco >= 30) return 'medio';
  return 'baixo';
}
