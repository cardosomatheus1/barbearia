import { instantToLocal, localToInstant } from './zone.js';

/**
 * Quando avisar, e quando **não** avisar.
 *
 * Lógica pura: o relógio entra por parâmetro e o fuso vem da unidade, nunca do
 * processo. É o mesmo cuidado da grade — errar o fuso aqui manda lembrete às
 * quatro da manhã, e o número da barbearia é o que paga.
 *
 * O lembrete é o recurso de maior retorno do produto: a SPEC §1 abre dizendo
 * que barbearias que o implementam relatam **40% a 70% menos faltas**. Também é
 * o que mais rápido destrói a reputação de um número de WhatsApp se for feito
 * sem regra. Daí as quatro proteções deste arquivo.
 *
 * 1. **Janela de silêncio.** Nada entre 21h e 8h. Mensagem que cairia dentro
 *    dela é empurrada para as 8h — não descartada, porque o lembrete de amanhã
 *    ainda serve.
 *
 * 2. **Lembrete que chegaria depois da hora não é enviado.** Empurrar às cegas
 *    produziria "não esqueça do seu horário das 9h" às 10h. Pior que não
 *    lembrar: parece sistema quebrado, e o cliente deixa de confiar no próximo.
 *
 * 3. **Transacional ≠ promocional.** Confirmação e lembrete são o serviço que a
 *    pessoa contratou e ignoram opt-out de marketing. "Volte sempre" é
 *    promoção, respeita o opt-out e conta no teto.
 *
 * 4. **Teto por cliente.** Quatro por mês somando canais, só para promocional.
 *    Automação sem teto vira spam e queima o número (SPEC §4.11).
 */

export const TIPOS_DE_NOTIFICACAO = [
  'confirmacao',
  'lembrete_24h',
  'lembrete_2h',
  'sua_vez',
  'senha_de_acesso',
  'retorno',
] as const;
export type TipoDeNotificacao = (typeof TIPOS_DE_NOTIFICACAO)[number];

export type NaturezaDaMensagem = 'transacional' | 'promocional';

/**
 * O que é serviço e o que é marketing.
 *
 * A separação decide quem pode recusar: ninguém "opta por não receber" a
 * confirmação do próprio agendamento — ela é parte do que foi contratado.
 * Tratar as duas coisas igual leva a um de dois erros, e os dois são caros:
 * mandar promoção para quem pediu para parar, ou deixar de avisar quem tem
 * hora marcada porque recusou promoção meses atrás.
 */
export function naturezaDe(tipo: TipoDeNotificacao): NaturezaDaMensagem {
  return tipo === 'retorno' ? 'promocional' : 'transacional';
}

/** Antecedência de cada lembrete, em minutos. */
export const ANTECEDENCIA: Readonly<Partial<Record<TipoDeNotificacao, number>>> = {
  lembrete_24h: 24 * 60,
  lembrete_2h: 2 * 60,
};

export const SILENCIO_COMECA_MINUTO = 21 * 60;
export const SILENCIO_TERMINA_MINUTO = 8 * 60;

/** Teto mensal de mensagens promocionais por cliente (SPEC §4.11). */
export const TETO_PROMOCIONAL_MES = 4;

/**
 * Empurra para fora da janela de silêncio, se preciso.
 *
 * Antes das 8h: mesma manhã. Depois das 21h: manhã seguinte. O horário local
 * sai do fuso **da unidade** — o cliente pode estar viajando, e o que importa é
 * a hora civil de onde a barbearia está, que é a hora que ele associa ao corte.
 */
export function foraDoSilencio(instante: Date, timeZone: string): Date {
  const local = instantToLocal(timeZone, instante);

  if (local.minutes >= SILENCIO_TERMINA_MINUTO && local.minutes < SILENCIO_COMECA_MINUTO) {
    return instante;
  }

  if (local.minutes < SILENCIO_TERMINA_MINUTO) {
    return localToInstant(timeZone, local.date, SILENCIO_TERMINA_MINUTO);
  }

  // Depois das 21h: as 8h do dia seguinte.
  const [ano = 0, mes = 0, dia = 0] = local.date.split('-').map(Number);
  const amanha = new Date(Date.UTC(ano, mes - 1, dia + 1));
  return localToInstant(timeZone, amanha.toISOString().slice(0, 10), SILENCIO_TERMINA_MINUTO);
}

export type MotivoDeNaoEnviar =
  | 'ja_enviada'
  | 'passou_da_hora'
  | 'sem_telefone'
  | 'cancelado'
  | 'optou_por_nao_receber'
  | 'teto_do_mes';

export interface DecisaoDeEnvio {
  readonly enviar: boolean;
  readonly quando: Date | null;
  readonly motivo: MotivoDeNaoEnviar | null;
}

const NAO = (motivo: MotivoDeNaoEnviar): DecisaoDeEnvio => ({
  enviar: false,
  quando: null,
  motivo,
});

/**
 * Quando (ou se) uma notificação de agendamento deve sair.
 *
 * Uma função só para as três decisões que costumam ficar espalhadas: se ainda
 * faz sentido, se o cliente aceita, e a que horas. Espalhadas, cada nova
 * mensagem reimplementa duas delas e esquece a terceira.
 */
export function decidirEnvioDeAgendamento(params: {
  readonly tipo: TipoDeNotificacao;
  /** Início do atendimento, em instante. */
  readonly comecaEm: Date;
  readonly timeZone: string;
  readonly agora: Date;
  readonly temTelefone: boolean;
  /** Status terminal (cancelado, falta) desliga o lembrete. */
  readonly aindaVale: boolean;
  readonly jaEnviada: boolean;
  readonly aceitaPromocional?: boolean;
  readonly promocionaisNoMes?: number;
}): DecisaoDeEnvio {
  if (params.jaEnviada) return NAO('ja_enviada');
  if (!params.temTelefone) return NAO('sem_telefone');
  if (!params.aindaVale) return NAO('cancelado');

  if (naturezaDe(params.tipo) === 'promocional') {
    if (params.aceitaPromocional === false) return NAO('optou_por_nao_receber');
    if ((params.promocionaisNoMes ?? 0) >= TETO_PROMOCIONAL_MES) return NAO('teto_do_mes');
  }

  const antecedencia = ANTECEDENCIA[params.tipo] ?? 0;
  /**
   * Sem antecedência, o alvo é **agora**, não a hora do corte.
   *
   * A confirmação é resposta a um fato que acabou de acontecer — a pessoa
   * marcou. Derivá-la de `comecaEm` a agendaria para o horário do próprio
   * atendimento, e o cliente receberia "seu horário está marcado" sentado na
   * cadeira. Foi o que a primeira versão fazia; o teste da madrugada pegou.
   */
  const alvo =
    antecedencia > 0
      ? new Date(params.comecaEm.getTime() - antecedencia * 60_000)
      : params.agora;

  /**
   * Lembrete cujo momento já passou não sai — não é remarcado para agora.
   *
   * Quem marcou às 22h para as 9h da manhã seguinte não recebe "faltam 24
   * horas": faltam onze. Empurrar a mensagem para o primeiro horário livre
   * entregaria o texto errado, e texto errado sobre horário é o que faz o
   * cliente parar de ler os próximos.
   *
   * A confirmação escapa porque ela **não** promete tempo: diz que está
   * marcado, e isso continua verdadeiro a qualquer distância do corte.
   */
  if (antecedencia > 0 && alvo < params.agora) return NAO('passou_da_hora');

  const quando = foraDoSilencio(alvo < params.agora ? params.agora : alvo, params.timeZone);

  // E o que a janela de silêncio empurrou para depois da hora também não sai:
  // "não esqueça das 8h" às 8h em ponto é constrangedor, não útil.
  if (antecedencia > 0 && quando >= params.comecaEm) return NAO('passou_da_hora');

  return { enviar: true, quando, motivo: null };
}

/**
 * A mensagem de retorno: o cliente sumiu.
 *
 * O intervalo sai do ciclo da própria pessoa quando ele é conhecido, e do
 * padrão da barbearia quando não é — mandar "sentimos sua falta" com trinta
 * dias para quem corta de dois em dois meses é a forma mais rápida de virar
 * ruído. O ciclo individual por histórico é do bloco 61; aqui entra o número
 * que a barbearia configurou.
 */
export function decidirRetorno(params: {
  readonly ultimaVisita: Date | null;
  readonly diasParaRetorno: number;
  readonly agora: Date;
  readonly timeZone: string;
  readonly temTelefone: boolean;
  readonly aceitaPromocional: boolean;
  readonly promocionaisNoMes: number;
  readonly jaEnviada: boolean;
}): DecisaoDeEnvio {
  if (params.jaEnviada) return NAO('ja_enviada');
  if (!params.temTelefone) return NAO('sem_telefone');
  if (!params.aceitaPromocional) return NAO('optou_por_nao_receber');
  if (params.promocionaisNoMes >= TETO_PROMOCIONAL_MES) return NAO('teto_do_mes');
  // Nunca veio: não é retorno, é aquisição — e aquisição é outra conversa.
  if (!params.ultimaVisita) return NAO('cancelado');

  const vence = new Date(
    params.ultimaVisita.getTime() + params.diasParaRetorno * 24 * 60 * 60_000,
  );
  if (vence > params.agora) return NAO('passou_da_hora');

  return { enviar: true, quando: foraDoSilencio(params.agora, params.timeZone), motivo: null };
}

/**
 * A chave que impede mandar duas vezes.
 *
 * Entrega duplicada de um evento não pode virar duas mensagens (CLAUDE.md §2).
 * A chave é determinística e é o índice único do banco que a faz valer — não
 * uma consulta antes de inserir, que tem janela de corrida.
 */
export const chaveDaNotificacao = (
  tipo: TipoDeNotificacao,
  alvoId: string,
): string => `${tipo}:${alvoId}`;
