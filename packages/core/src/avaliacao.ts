/**
 * Avaliações e recuperação de nota baixa (bloco 43, SPEC §4.10).
 *
 * ## A avaliação nasce de um atendimento que aconteceu
 *
 * "Avaliação só existe vinculada a atendimento real concluído" é a primeira
 * linha da seção, e é o que separa este produto de review aberta de
 * marketplace: aqui não há como avaliar quem você nunca visitou, nem a
 * concorrência derrubar a nota da casa ao lado.
 *
 * ## A janela é de recuperação, não de censura
 *
 * Nota baixa não vai imediatamente para o perfil público — a barbearia tem 48
 * horas para ligar, oferecer retrabalho ou dar crédito. **Depois disso ela
 * publica de qualquer forma**, e é isso que torna a janela honesta. A SPEC
 * escreve o limite em letras maiúsculas, e ele está aqui em código:
 *
 * - resolver **não** cancela a publicação. `estaPublicada` não olha a resolução;
 * - a média interna conta a nota desde o primeiro segundo, publicada ou não;
 * - não existe função para apagar avaliação, e não é esquecimento.
 *
 * ## A publicação é calculada, nunca guardada
 *
 * Uma coluna `publicada` estaria errada todo minuto entre o fim da janela e a
 * varredura passar — e é justamente aí que o gestor abre a tela para ver se
 * ainda dá tempo. Mesma decisão do estado do pacote e da oferta de vaga: a tela
 * mostra o estado **de verdade**, não o gravado.
 */

export const NOTAS = [1, 2, 3, 4, 5] as const;
export type Nota = (typeof NOTAS)[number];

/** As quatro da SPEC §4.10, todas opcionais. */
export const CATEGORIAS_DA_AVALIACAO = [
  'atendimento',
  'qualidade',
  'pontualidade',
  'ambiente',
] as const;
export type CategoriaDaAvaliacao = (typeof CATEGORIAS_DA_AVALIACAO)[number];

export const ROTULO_DA_CATEGORIA: Readonly<Record<CategoriaDaAvaliacao, string>> = {
  atendimento: 'Atendimento',
  qualidade: 'Qualidade do corte',
  pontualidade: 'Pontualidade',
  ambiente: 'Ambiente',
};

/**
 * Até três estrelas abre a janela de recuperação.
 *
 * O corte é da SPEC ("nota ≤ 3"). Três é o meio da escala e no Brasil é o "foi
 * ok" que costuma esconder um problema concreto — é exatamente a nota que vale
 * um telefonema.
 */
export const NOTA_QUE_SEGURA: Nota = 3;

/** As 48 horas da SPEC §4.10. */
export const JANELA_DE_RECUPERACAO_HORAS = 48;

/**
 * Quanto tempo depois do atendimento ainda dá para avaliar.
 *
 * Sem teto, a avaliação de um corte de março chegaria em dezembro e entraria na
 * média do mês errado — e ninguém lembra do atendimento para recuperar nada.
 * Trinta dias é largo o bastante para quem só abre o aplicativo uma vez por mês.
 */
export const PRAZO_PARA_AVALIAR_DIAS = 30;

export const MINIMO_DO_COMENTARIO = 0;
export const MAXIMO_DO_COMENTARIO = 1000;
export const MAXIMO_DA_RESOLUCAO = 1000;

/** O que a barbearia fez a respeito. A lista é a da SPEC §4.10. */
export const DESFECHOS_DA_RECUPERACAO = [
  'contato',
  'retrabalho',
  'credito',
  'sem_retorno',
] as const;
export type DesfechoDaRecuperacao = (typeof DESFECHOS_DA_RECUPERACAO)[number];

export const ROTULO_DO_DESFECHO: Readonly<Record<DesfechoDaRecuperacao, string>> = {
  contato: 'Falei com o cliente',
  retrabalho: 'Ofereci refazer o serviço',
  credito: 'Dei crédito na conta dele',
  sem_retorno: 'Tentei e não consegui contato',
};

/**
 * O vocabulário da recuperação, num lugar só.
 *
 * `tratar` é o que a barbearia **faz** — ligar, refazer o corte, dar crédito —,
 * e `Registrar` é o que o botão faz quando é apertado. Não são dois nomes para
 * a mesma transição: é a regra que `vocabulario.ts` já escreve, de o verbo dizer
 * o que vai acontecer e não como as coisas ficam depois.
 *
 * Moram aqui e não na tela porque a recepção fala essas palavras em voz alta,
 * com o cliente na frente, e a ficha, o painel e a trilha precisam usar as
 * mesmas.
 */
export const VERBO_DA_RECUPERACAO = 'Registrar';
export const ESTADO_TRATADA = 'Tratada';
export const PRAZO_PARA_TRATAR = (horas: number) => `${horas}h para tratar`;

export interface Avaliacao {
  readonly id: string;
  readonly nota: Nota;
  readonly comentario: string | null;
  readonly criadaEm: Date;
  readonly resolvidaEm: Date | null;
}

/**
 * Esta avaliação já está no perfil público?
 *
 * Duas maneiras de estar: nota boa, que publica na hora, ou janela vencida, que
 * publica **mesmo sem ninguém ter feito nada**. É a segunda que carrega o limite
 * ético da SPEC — sem ela, deixar o alerta parado no painel seria um jeito de
 * nunca publicar, e o produto viria com um filtro de censura embutido.
 *
 * Repare no que **não** está aqui: `resolvidaEm`. Resolver é registrar o que a
 * casa fez, e não compra o direito de esconder a nota.
 */
export function estaPublicada(avaliacao: Avaliacao, agora: Date): boolean {
  if (avaliacao.nota > NOTA_QUE_SEGURA) return true;
  return agora.getTime() >= fimDaJanela(avaliacao).getTime();
}

export function fimDaJanela(avaliacao: Avaliacao): Date {
  return new Date(avaliacao.criadaEm.getTime() + JANELA_DE_RECUPERACAO_HORAS * 3_600_000);
}

/**
 * Quanto tempo resta para agir, em horas cheias arredondadas para baixo.
 *
 * Zero significa "acabou", e a tela diz "já publicou" em vez de "restam 0h" —
 * indicador que fica em zero para sempre é o que ensina a não olhar.
 */
export function horasRestantes(avaliacao: Avaliacao, agora: Date): number {
  const falta = fimDaJanela(avaliacao).getTime() - agora.getTime();
  return falta <= 0 ? 0 : Math.floor(falta / 3_600_000);
}

/** A avaliação que ainda pede uma atitude da casa. */
export function precisaDeRecuperacao(avaliacao: Avaliacao, agora: Date): boolean {
  return (
    avaliacao.nota <= NOTA_QUE_SEGURA &&
    avaliacao.resolvidaEm === null &&
    horasRestantes(avaliacao, agora) > 0
  );
}

export type RecusaDaAvaliacao =
  | 'atendimento_nao_concluido'
  | 'ja_avaliado'
  | 'prazo_vencido'
  | 'nota_invalida'
  | 'comentario_longo';

/**
 * Este atendimento pode ser avaliado agora?
 *
 * `completed` e nada mais: um agendamento cancelado ou faltado não gerou
 * serviço, e uma nota sobre ele não diria nada sobre o corte. A falta tem outro
 * lugar no produto — o score de confiabilidade.
 */
export function podeAvaliar(
  atendimento: {
    readonly status: string;
    readonly terminouEm: Date | null;
    readonly jaAvaliado: boolean;
  },
  agora: Date,
): { readonly pode: true } | { readonly recusa: RecusaDaAvaliacao } {
  if (atendimento.status !== 'completed' || !atendimento.terminouEm) {
    return { recusa: 'atendimento_nao_concluido' };
  }
  if (atendimento.jaAvaliado) return { recusa: 'ja_avaliado' };

  const limite = atendimento.terminouEm.getTime() + PRAZO_PARA_AVALIAR_DIAS * 86_400_000;
  if (agora.getTime() > limite) return { recusa: 'prazo_vencido' };

  return { pode: true };
}

export function validarNota(valor: number): valor is Nota {
  return Number.isInteger(valor) && valor >= 1 && valor <= 5;
}

/**
 * A média, com uma casa decimal.
 *
 * Sobre **todas** as notas, publicadas ou não. A SPEC é explícita: "a nota
 * interna e a média real sempre contam para o gestor e para os indicadores,
 * mesmo quando não publicadas". Uma média que só somasse o que está no ar seria
 * o painel mentindo para quem decide.
 *
 * Sem avaliação nenhuma devolve nulo, e não zero: zero é uma nota péssima, e a
 * barbearia que abriu ontem não merece aparecer com ela.
 */
export function media(notas: readonly number[]): number | null {
  if (notas.length === 0) return null;
  const soma = notas.reduce((total, nota) => total + nota, 0);
  return Math.round((soma / notas.length) * 10) / 10;
}

/**
 * O que a página pública mostra sobre a reputação da casa.
 *
 * Só o que está publicado — a média interna é outra, e é do gestor. Abaixo de um
 * mínimo a nota não aparece: "5,0 de uma avaliação" é ruído estatístico com cara
 * de excelência, e é como marketplace nenhum se deixa ler.
 */
export const AVALIACOES_PARA_MOSTRAR = 3;

export function resumoPublico(notasPublicadas: readonly number[]): {
  readonly media: number | null;
  readonly total: number;
} {
  const total = notasPublicadas.length;
  return {
    media: total >= AVALIACOES_PARA_MOSTRAR ? media(notasPublicadas) : null,
    total,
  };
}

/** "Nota 2 de Carlos, atendimento de hoje às 14:00" — o alerta da SPEC §4.10. */
export function estrelas(nota: Nota): string {
  return '★'.repeat(nota) + '☆'.repeat(5 - nota);
}
