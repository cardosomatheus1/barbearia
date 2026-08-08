/**
 * Exceções de agenda: folga, feriado, horário diferente e bloqueio pontual.
 *
 * `schedule_exceptions` existe desde o bloco 1 — com os cinco tipos, o alvo
 * (profissional **ou** unidade), índice, RLS, e a precedência resolvida e
 * testada em `schedule.ts`. **Nada nunca escreveu nessa tabela.** O motor sabia
 * recortar a grade e o barbeiro não tinha como avisar que ia faltar na sexta.
 *
 * Este arquivo é a metade que faltava: as regras de **o que é uma exceção
 * válida**, puras, antes de qualquer ida ao banco. A precedência continua em
 * `schedule.ts`; aqui é só a porta de entrada.
 */

/**
 * Os cinco tipos, e o que cada um significa na barbearia.
 *
 * A diferença entre eles não é rótulo: `block` recorta um pedaço do dia e vence
 * todo o resto; `custom_hours` **substitui** a jornada daquele dia; os outros
 * três fecham o dia inteiro e existem separados porque a barbearia lê o motivo
 * na tela — "feriado" e "férias do Ruan" não são a mesma conversa.
 */
export const TIPOS_DE_EXCECAO = [
  'block',
  'day_off',
  'holiday',
  'vacation',
  'custom_hours',
] as const;

export type TipoDeExcecao = (typeof TIPOS_DE_EXCECAO)[number];

/** Os que exigem faixa de horário. Os outros fecham o dia inteiro. */
const COM_FAIXA: readonly TipoDeExcecao[] = ['block', 'custom_hours'];

export function exigeFaixa(tipo: TipoDeExcecao): boolean {
  return COM_FAIXA.includes(tipo);
}

export type FalhaDaExcecao =
  | 'tipo_invalido'
  | 'data_invalida'
  | 'faixa_ausente'
  | 'faixa_invertida'
  | 'faixa_fora_do_dia'
  | 'faixa_indevida'
  | 'alvo_ausente'
  | 'alvo_duplo';

export interface EntradaDeExcecao {
  readonly tipo: TipoDeExcecao;
  /** Data local da unidade, YYYY-MM-DD. */
  readonly data: string;
  readonly startMinute?: number | null;
  readonly endMinute?: number | null;
  /** Um dos dois, nunca os dois nem nenhum. */
  readonly professionalId?: string | null;
  readonly locationId?: string | null;
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const MINUTOS_NO_DIA = 24 * 60;

/**
 * Valida a exceção antes de o banco ver.
 *
 * O banco tem as mesmas garantias em `CHECK` — e é ele a autoridade. Esta
 * função existe para que o erro chegue à tela como **motivo**, não como
 * violação de constraint: "o intervalo terminou antes de começar" é acionável;
 * `schedule_exceptions_minutes_range` não é.
 */
export function validarExcecao(entrada: EntradaDeExcecao): FalhaDaExcecao | null {
  if (!TIPOS_DE_EXCECAO.includes(entrada.tipo)) return 'tipo_invalido';
  if (!DATA.test(entrada.data)) return 'data_invalida';

  const temProfissional = Boolean(entrada.professionalId);
  const temUnidade = Boolean(entrada.locationId);
  if (!temProfissional && !temUnidade) return 'alvo_ausente';
  // `num_nonnulls(...) = 1` no banco. Aceitar os dois faria a precedência —
  // que distingue exceção do profissional da exceção da unidade — perder o
  // sentido, porque a mesma linha seria as duas coisas.
  if (temProfissional && temUnidade) return 'alvo_duplo';

  const inicio = entrada.startMinute ?? null;
  const fim = entrada.endMinute ?? null;

  if (!exigeFaixa(entrada.tipo)) {
    // Dia inteiro com faixa é pedido contraditório, e engolir a faixa
    // silenciosamente gravaria uma folga que fecha só metade do dia.
    if (inicio !== null || fim !== null) return 'faixa_indevida';
    return null;
  }

  if (inicio === null || fim === null) return 'faixa_ausente';
  if (!Number.isInteger(inicio) || !Number.isInteger(fim)) return 'faixa_invertida';
  if (inicio < 0 || fim > MINUTOS_NO_DIA) return 'faixa_fora_do_dia';
  // Semiaberto, como todo intervalo do sistema: encostar não é sobrepor.
  if (inicio >= fim) return 'faixa_invertida';

  return null;
}

/** A mensagem que a tela mostra. O código estável fica para a API. */
export const MOTIVO_DA_FALHA: Readonly<Record<FalhaDaExcecao, string>> = {
  tipo_invalido: 'Este tipo de exceção não existe.',
  data_invalida: 'Informe a data no formato AAAA-MM-DD.',
  faixa_ausente: 'Informe a hora de início e a de fim.',
  faixa_invertida: 'A hora de fim precisa ser depois da de início.',
  faixa_fora_do_dia: 'O horário precisa estar dentro do dia.',
  faixa_indevida: 'Este tipo fecha o dia inteiro e não aceita horário.',
  alvo_ausente: 'Escolha se vale para um profissional ou para a barbearia toda.',
  alvo_duplo: 'Escolha um profissional **ou** a barbearia toda, não os dois.',
};

/**
 * Um agendamento cai dentro desta exceção?
 *
 * Serve para avisar **antes** de gravar: bloquear as 14h de sexta com três
 * clientes marcados ali não é proibido — a barbearia pode ter um motivo —, mas
 * fazê-lo sem ver os nomes é como o cliente descobre no dia.
 *
 * Puro e em minutos locais, como o resto do motor. O `null` de `startMinute`
 * significa dia inteiro, e aí qualquer horário do dia conflita.
 */
export function conflitaComExcecao(params: {
  readonly agendamento: { readonly startMinute: number; readonly endMinute: number };
  readonly excecao: { readonly startMinute: number | null; readonly endMinute: number | null };
}): boolean {
  const { startMinute, endMinute } = params.excecao;
  if (startMinute === null || endMinute === null) return true;

  return params.agendamento.startMinute < endMinute && params.agendamento.endMinute > startMinute;
}
