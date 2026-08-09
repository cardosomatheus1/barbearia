/**
 * Fronteira entre os minutos locais do motor e os instantes UTC do banco.
 *
 * O motor de disponibilidade é puro e trabalha em minutos locais da unidade
 * (ver `time.ts`). A conversão para instante acontece só aqui, usando o fuso
 * IANA da unidade — nunca o fuso do processo e nunca o do dispositivo do
 * cliente.
 *
 * Resolve o defeito D2: o sistema analisado enviava `getTimezoneOffset()` do
 * navegador no corpo da requisição, então um cliente viajando ou com o relógio
 * errado via a grade deslocada.
 *
 * Sem dependências: usa apenas a Intl nativa.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

export function parseDate(value: string): CalendarDate {
  const match = DATE_ONLY.exec(value);
  if (!match) throw new RangeError(`Data inválida: "${value}" (esperado YYYY-MM-DD)`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) throw new RangeError(`Mês inválido em "${value}"`);
  if (day < 1 || day > 31) throw new RangeError(`Dia inválido em "${value}"`);

  // Rejeita 31/02 e afins.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`Data inexistente: "${value}"`);
  }
  return { year, month, day };
}

export function formatDate(date: CalendarDate): string {
  return [
    String(date.year).padStart(4, '0'),
    String(date.month).padStart(2, '0'),
    String(date.day).padStart(2, '0'),
  ].join('-');
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new RangeError(`Fuso horário desconhecido: "${timeZone}"`);
  }
  formatterCache.set(timeZone, created);
  return created;
}

/** O cálculo exato, via Intl. É a fonte da verdade; o cache acima só o evita. */
function offsetPeloIntl(timeZone: string, instant: Date): number {
  const parts = formatter(timeZone).formatToParts(instant);

  // Uma passada só. `parts.find()` por campo eram seis varreduras e seis
  // closures por chamada, e esta função é a mais quente do produto.
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let lidos = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year': year = Number(part.value); lidos++; break;
      case 'month': month = Number(part.value); lidos++; break;
      case 'day': day = Number(part.value); lidos++; break;
      case 'hour': hour = Number(part.value); lidos++; break;
      case 'minute': minute = Number(part.value); lidos++; break;
      case 'second': second = Number(part.value); lidos++; break;
      default: break;
    }
  }
  if (lidos < 6) throw new Error(`Intl não devolveu a data completa para ${timeZone}`);

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Arredonda ao minuto: alguns fusos históricos têm offset com segundos.
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

const DIA_MS = 86_400_000;

/**
 * Offset por dia UTC — ou `null` quando o dia tem transição dentro dele.
 *
 * O `Intl.DateTimeFormat` já era reaproveitado; o **resultado** não era, e é
 * ele que custa. Uma consulta de sete dias × cinco cadeiras chamava
 * `formatToParts` cerca de vinte mil vezes, e o perfil de CPU mostrou esta
 * função sozinha em 69% do tempo não-ocioso da API.
 */
const offsetPorDia = new Map<string, number | null>();

/**
 * Teto do cache.
 *
 * Uma entrada por fuso por dia consultado. Um processo de vida longa
 * atravessando anos de agenda cresceria sem limite — pequeno, mas sem limite é
 * vazamento. Ao estourar, esvazia inteiro: é cache, não estado.
 */
const TETO_DO_CACHE = 4096;

/**
 * Deslocamento do fuso, em minutos, no instante dado. Leste do meridiano é positivo.
 *
 * ## Por que dá para guardar por dia sem errar o horário de verão
 *
 * O offset de um fuso é constante entre transições, e transição acontece no
 * máximo duas vezes por ano. Guardar "o offset deste dia" seria errado
 * **exatamente** no dia da virada — então o dia não é aceito no cache sem
 * antes provar que ele é uniforme: mede-se o primeiro e o último instante do
 * dia UTC, e só se os dois derem igual o valor é reaproveitado. No dia da
 * transição eles diferem, o dia é marcado como irregular e todo instante dele
 * volta a passar pelo Intl.
 *
 * Continua sendo função pura do par (fuso, instante): mesma entrada, mesma
 * saída, com ou sem cache. Há teste que percorre a virada de Nova York minuto
 * a minuto comparando as duas.
 */
export function offsetMinutesAt(timeZone: string, instant: Date): number {
  const t = instant.getTime();
  const dia = Math.floor(t / DIA_MS);
  const chave = `${timeZone}|${dia}`;

  const guardado = offsetPorDia.get(chave);
  if (guardado !== undefined) {
    return guardado === null ? offsetPeloIntl(timeZone, instant) : guardado;
  }

  const inicio = offsetPeloIntl(timeZone, new Date(dia * DIA_MS));
  const fim = offsetPeloIntl(timeZone, new Date(dia * DIA_MS + DIA_MS - 1));
  const uniforme = inicio === fim ? inicio : null;

  if (offsetPorDia.size >= TETO_DO_CACHE) offsetPorDia.clear();
  offsetPorDia.set(chave, uniforme);

  return uniforme === null ? offsetPeloIntl(timeZone, instant) : uniforme;
}

/**
 * Converte data local + minuto local em instante UTC.
 *
 * Faz duas passadas para acertar transições de horário de verão: a primeira
 * estimativa usa o offset do palpite, a segunda usa o offset do resultado.
 * Brasil não tem mais DST desde 2019, mas o produto não pode assumir isso.
 */
export function localToInstant(timeZone: string, date: string, minutes: number): Date {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    throw new RangeError(`Minuto fora do dia: ${minutes}`);
  }
  const { year, month, day } = parseDate(date);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * 60_000;

  const firstOffset = offsetMinutesAt(timeZone, new Date(naive));
  const firstGuess = naive - firstOffset * 60_000;

  const secondOffset = offsetMinutesAt(timeZone, new Date(firstGuess));
  if (secondOffset === firstOffset) return new Date(firstGuess);

  return new Date(naive - secondOffset * 60_000);
}

/** Converte instante UTC em minutos locais dentro da data local correspondente. */
export function instantToLocal(
  timeZone: string,
  instant: Date,
): { date: string; minutes: number } {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Intl não devolveu "${type}" para ${timeZone}`);
    return Number(part.value);
  };

  return {
    date: formatDate({ year: read('year'), month: read('month'), day: read('day') }),
    minutes: read('hour') * 60 + read('minute'),
  };
}

/**
 * Minuto local "agora" na unidade, ou `null` se a data pedida não é hoje lá.
 *
 * É assim que o chamador calcula `earliestStartMinute` sem que o motor precise
 * ler o relógio: continua sendo função pura, o efeito fica na borda.
 */
export function cutoffMinuteFor(
  timeZone: string,
  date: string,
  now: Date,
  minLeadMinutes: number,
): number | null {
  const local = instantToLocal(timeZone, now);
  if (local.date < date) return null; // data futura: sem corte
  if (local.date > date) return 24 * 60 + 1; // data passada: nada é agendável
  return local.minutes + minLeadMinutes;
}

/** Dia da semana no fuso da unidade. 0 = domingo, 6 = sábado. */
export function weekdayIn(timeZone: string, date: string): number {
  // Meio-dia evita que o offset empurre a data para o dia anterior ou seguinte.
  const noon = localToInstant(timeZone, date, 12 * 60);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  if (index < 0) throw new Error(`Dia da semana não reconhecido: ${name}`);
  return index;
}

/**
 * A janela de um dia da barbearia, em instantes UTC.
 *
 * O relatório do dia é `[meia-noite local, meia-noite local do dia seguinte)` —
 * semiaberto, como todo intervalo deste sistema. Calcular com `new Date(dia)`
 * daria meia-noite **UTC**, e uma barbearia em Salvador veria as três últimas
 * horas de ontem somadas ao faturamento de hoje: o fechamento de caixa não
 * bateria com o relatório e ninguém saberia qual dos dois está certo.
 *
 * `dia` nulo significa "hoje na unidade" — e hoje é resolvido pelo fuso dela,
 * nunca pelo do aparelho de quem abriu a tela (defeito D2).
 */
export function diaNaUnidade(
  dia: string | null,
  timeZone: string,
  now: Date,
): { readonly dia: string; readonly de: Date; readonly ate: Date } {
  const escolhido = dia ?? instantToLocal(timeZone, now).date;
  // Valida o formato: dia inválido viraria intervalo silenciosamente errado.
  const partes = parseDate(escolhido);
  const seguinte = new Date(Date.UTC(partes.year, partes.month - 1, partes.day + 1));

  return {
    dia: escolhido,
    de: localToInstant(timeZone, escolhido, 0),
    ate: localToInstant(
      timeZone,
      formatDate({
        year: seguinte.getUTCFullYear(),
        month: seguinte.getUTCMonth() + 1,
        day: seguinte.getUTCDate(),
      }),
      0,
    ),
  };
}
