/**
 * A vida de um atendimento no dia.
 *
 * Lógica pura: quais transições existem, e o que a recepção precisa enxergar
 * sobre quem ainda não chegou. Sem banco e sem relógio — o "agora" entra por
 * parâmetro, como no resto de `core`.
 *
 * A máquina de estados é a da SPEC (Parte 2 §2.11) e já estava no schema desde
 * o bloco 1. Até aqui ninguém a percorria: todo agendamento nascia `pending` e
 * morria `pending`.
 */

/**
 * Lista fechada, e não só um tipo.
 *
 * Estado novo precisa ganhar rótulo em `vocabulario.ts`, e o teste que cobra
 * isso precisa de algo para percorrer. Um tipo sozinho some em tempo de
 * execução, e o rótulo faltando viraria `undefined` na tela.
 */
export const STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'waiting',
  'in_progress',
  'completed',
  'cancelled_customer',
  'cancelled_business',
  'no_show',
  'rescheduled',
] as const;

export type AppointmentStatus = (typeof STATUSES)[number];

/**
 * Os quatro estados em que o horário **devolve a cadeira**.
 *
 * São exatamente os que a constraint `appointments_no_overlap` exclui do
 * `EXCLUDE USING gist`: cancelado pelo cliente, cancelado pela casa, falta e
 * remarcado. Todo o resto — inclusive `waiting`, que é quem foi chamado e ainda
 * não sentou — segura o horário e conta como ocupação.
 */
export const ESTADOS_QUE_LIBERAM_A_AGENDA = [
  'cancelled_customer',
  'cancelled_business',
  'no_show',
  'rescheduled',
] as const;

/**
 * Os estados que ocupam a agenda, **derivados** e não escritos.
 *
 * Três consultas de `ocupacao.ts` escreviam esta lista à mão e as três
 * esqueceram `waiting`: a ocupação medida saía menor que a real justamente na
 * hora cheia, que é onde ela decide se o cliente paga sinal e se o preço sobe.
 * Escrita quatro vezes, a lista divergiu — que é o que este código já pagou com
 * `secoes.ts`, com os rótulos de campanha e com o estado que ocupa uma venda.
 *
 * Derivar do complemento também amarra o dia em que o enum crescer: um estado
 * novo entra ocupando, que é o padrão seguro — contar a mais numa ocupação faz
 * a casa parecer cheia, contar a menos faz o produto deixar de cobrar sinal e
 * de sugerir preço num sábado lotado.
 */
export const ESTADOS_QUE_OCUPAM_A_AGENDA: readonly AppointmentStatus[] = STATUSES.filter(
  (estado) => !(ESTADOS_QUE_LIBERAM_A_AGENDA as readonly string[]).includes(estado),
);

/**
 * Os tipos de cadeira, iguais ao enum `professional_kind` do banco.
 *
 * A borda aceitava `station` e `room`, que não existem no enum: escolher
 * "Estação" na tela respondia 500, porque o domínio faz
 * `${input.kind}::professional_kind`. Não havia como cadastrar uma cadeira que
 * não fosse profissional — e por isso o defeito D12, o balcão contado como
 * cadeira no relatório de ocupação, estava inalcançável em vez de consertado.
 *
 * `counter` é o balcão da recepção; `resource_only` é sala ou lavatório;
 * `external` é quem atende fora. Nenhum dos três é cadeira para efeito de
 * receita por cadeira ou de hora aberta.
 */
export const TIPOS_DE_CADEIRA = ['professional', 'counter', 'resource_only', 'external'] as const;

export type TipoDeCadeira = (typeof TIPOS_DE_CADEIRA)[number];

/** O que o balcão pode fazer com um atendimento. Fechada, pelo mesmo motivo. */
export const ACOES = [
  'confirm',
  'check_in',
  'wait',
  'start',
  'complete',
  'no_show',
  'undo_no_show',
  'cancel',
] as const;

export type AttendanceAction = (typeof ACOES)[number];

/**
 * A ação veio de um formulário? — a mesma lista, uma vez só.
 *
 * A tela tinha a própria cópia dos oito nomes, e ela vivia dentro de um arquivo
 * `'use server'`. Duas coisas ruins de uma vez: lista paralela que diverge no
 * primeiro estado novo, e — porque um arquivo `'use server'` só exporta função
 * assíncrona — uma lista que o handler que precisa dela **não consegue
 * importar**. O build reprova, e é o build que contou.
 */
export function ehAcaoDeAtendimento(valor: string): valor is AttendanceAction {
  return (ACOES as readonly string[]).includes(valor);
}

/**
 * Transições permitidas, por estado de origem.
 *
 * Duas escolhas que merecem explicação:
 *
 * - **`pending` aceita `check_in` direto.** O cliente que chega sem ter
 *   confirmado é o caso comum, não a exceção; obrigar a recepção a confirmar
 *   antes de marcar presença seria um toque a mais com o cliente na frente dela.
 *
 * - **`checked_in` e `waiting` ainda aceitam `no_show`.** Parece contraditório —
 *   a pessoa chegou —, mas é o cliente que cansou de esperar e foi embora. Sem
 *   isso a recepção teria que cancelar em nome da barbearia, e o registro diria
 *   que a culpa foi da casa.
 */
const TRANSICOES: Readonly<Record<AppointmentStatus, readonly AttendanceAction[]>> = {
  pending: ['confirm', 'check_in', 'no_show', 'cancel'],
  confirmed: ['check_in', 'no_show', 'cancel'],
  checked_in: ['wait', 'start', 'no_show', 'cancel'],
  waiting: ['start', 'no_show', 'cancel'],
  in_progress: ['complete', 'cancel'],
  completed: [],
  cancelled_customer: [],
  cancelled_business: [],
  // Reversão manual da falta, que a SPEC §2.11 exige explicitamente: marcar
  // falta por engano não pode ser definitivo.
  no_show: ['undo_no_show'],
  rescheduled: [],
};

const DESTINO: Readonly<Record<AttendanceAction, AppointmentStatus>> = {
  confirm: 'confirmed',
  check_in: 'checked_in',
  wait: 'waiting',
  start: 'in_progress',
  complete: 'completed',
  no_show: 'no_show',
  // Volta como "chegou": desfazer a falta é dizer que o cliente estava lá.
  undo_no_show: 'checked_in',
  cancel: 'cancelled_business',
};

export function allowedActions(status: AppointmentStatus): readonly AttendanceAction[] {
  return TRANSICOES[status] ?? [];
}

export function canApply(status: AppointmentStatus, action: AttendanceAction): boolean {
  return allowedActions(status).includes(action);
}

export function statusAfter(action: AttendanceAction): AppointmentStatus {
  return DESTINO[action];
}

/** Situação de quem ainda não chegou, do ponto de vista de quem olha a tela. */
export type Punctuality =
  | { readonly kind: 'upcoming'; readonly minutesUntil: number }
  | { readonly kind: 'due' }
  | { readonly kind: 'late'; readonly minutesLate: number; readonly noShowInMinutes: number }
  | { readonly kind: 'no_show_due'; readonly minutesLate: number };

/**
 * Quanto falta, ou quanto já passou.
 *
 * `noShowInMinutes` é quanto ainda falta da tolerância da unidade — e desde o
 * bloco 20 ele é uma **contagem regressiva de verdade**: passado o prazo, a
 * tarefa `agendamento.marcar_falta` vira o status sozinha. O aviso continua
 * existindo pelo mesmo motivo de antes, invertido: a recepção precisa poder
 * fazer check-in antes de o sistema decidir por ela.
 *
 * `toleranceMinutes` zero significa que a unidade não tem prazo de tolerância;
 * aí o atrasado permanece atrasado até alguém decidir.
 */
export function punctuality(
  minutesSinceStart: number,
  toleranceMinutes: number,
): Punctuality {
  if (minutesSinceStart < 0) return { kind: 'upcoming', minutesUntil: -minutesSinceStart };
  if (minutesSinceStart === 0) return { kind: 'due' };

  if (toleranceMinutes <= 0) {
    return { kind: 'late', minutesLate: minutesSinceStart, noShowInMinutes: Infinity };
  }
  if (minutesSinceStart >= toleranceMinutes) {
    return { kind: 'no_show_due', minutesLate: minutesSinceStart };
  }
  return {
    kind: 'late',
    minutesLate: minutesSinceStart,
    noShowInMinutes: toleranceMinutes - minutesSinceStart,
  };
}

/**
 * Duração real de um atendimento, em minutos.
 *
 * `null` quando não terminou. É o insumo da estimativa de espera da fila
 * presencial (SPEC §2.10), que precisa da duração **praticada**, não da
 * cadastrada — barbeiro que leva 40 minutos no corte de 30 faz a fila inteira
 * mentir se a conta usar o catálogo.
 */
export function realDuration(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const minutos = Math.round((completedAt.getTime() - startedAt.getTime()) / 60000);
  return minutos >= 0 ? minutos : null;
}
