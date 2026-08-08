import type { AppointmentStatus } from './attendance.js';

/**
 * O dia do barbeiro.
 *
 * A mesma agenda do balcão, respondendo outra pergunta. A recepção pergunta
 * "como está o salão?" e precisa de densidade: cinco cadeiras, trinta linhas,
 * tudo na tela. O barbeiro pergunta **"quem é o próximo e o que ele gosta?"** —
 * uma pessoa de cada vez, no celular, com a máquina na outra mão.
 *
 * Por isso este arquivo existe em vez de a tela filtrar a lista do balcão: a
 * diferença não é de filtro, é de recorte. O que o barbeiro precisa saber é
 * quem está na cadeira **agora**, quem entra **depois** e quanto tempo existe
 * entre os dois — e nada disso é uma coluna da tabela do balcão.
 *
 * Puro, como todo `core`: entra a lista e o instante, sai a decisão.
 */

/** O mínimo que o recorte precisa saber de um atendimento. */
export interface AtendimentoDoDia {
  readonly id: string;
  readonly status: AppointmentStatus;
  /** Instante ISO do início do serviço. */
  readonly startsAt: string;
}

/**
 * Quem ainda vai acontecer.
 *
 * `no_show` fica de fora mesmo sendo reversível: quem faltou não é próximo. Se
 * o cliente aparecer depois, o balcão desfaz a falta e ele volta à fila — pela
 * transição, não porque a tela ficou fingindo que ele vinha.
 */
const PENDENTES: readonly AppointmentStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'waiting',
];

export interface MeuDia<T extends AtendimentoDoDia> {
  /** Quem está na cadeira agora. Nulo entre um atendimento e outro. */
  readonly agora: T | null;
  /** Quem entra em seguida. Nulo quando o dia acabou. */
  readonly proximo: T | null;
  /** O resto, na ordem em que chega. */
  readonly depois: readonly T[];
  /** Quantos ainda vão acontecer, contando o próximo. */
  readonly restam: number;
  readonly concluidos: number;
  readonly faltaram: number;
  /**
   * Minutos até o próximo começar. Negativo quando ele já era para ter
   * começado, nulo quando não há próximo.
   *
   * É o número que decide se dá para tomar um café — e é por isso que ele é
   * assinado em vez de zerado no piso: "atrasado 12 minutos" e "começa agora"
   * levam a decisões opostas.
   */
  readonly minutosAteProximo: number | null;
}

/**
 * Recorta o dia de um barbeiro a partir dos atendimentos dele.
 *
 * **A lista recebida já vem filtrada por profissional.** Filtrar aqui exigiria
 * que este módulo soubesse de `professionalId`, e o recorte por profissional é
 * decisão de autorização — ela vive na guarda da API, que já a toma a partir de
 * `staff.professionalId` e nunca de um parâmetro da requisição.
 *
 * A ordem é a do relógio, não a do status. Quem fez check-in às 14h e está
 * esperando aparece antes de quem tem hora marcada às 15h, mesmo que o segundo
 * já tenha confirmado — porque a cadeira vaga na ordem em que as pessoas
 * chegaram à agenda, não na ordem em que avisaram que vêm.
 */
export function recortarMeuDia<T extends AtendimentoDoDia>(
  atendimentos: readonly T[],
  agora: Date,
): MeuDia<T> {
  const emOrdem = [...atendimentos].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const agoraNaCadeira = emOrdem.find((item) => item.status === 'in_progress') ?? null;
  const pendentes = emOrdem.filter((item) => PENDENTES.includes(item.status));

  const [proximo = null, ...depois] = pendentes;

  return {
    agora: agoraNaCadeira,
    proximo,
    depois,
    restam: pendentes.length,
    concluidos: emOrdem.filter((item) => item.status === 'completed').length,
    faltaram: emOrdem.filter((item) => item.status === 'no_show').length,
    minutosAteProximo: proximo ? minutosEntre(agora, new Date(proximo.startsAt)) : null,
  };
}

function minutosEntre(de: Date, ate: Date): number {
  return Math.round((ate.getTime() - de.getTime()) / 60_000);
}

/**
 * A frase do intervalo entre atendimentos.
 *
 * Existe aqui, e não na tela, pela mesma razão que `frasePosicao` na fila: é
 * decisão de negócio disfarçada de texto. O corte em "dá tempo de um café" está
 * em 20 minutos porque é quanto leva sair, tomar e voltar — e alguém vai querer
 * mudar isso por barbearia um dia. Melhor que esteja num lugar só.
 */
export function fraseDoIntervalo(minutosAteProximo: number | null): string {
  if (minutosAteProximo === null) return 'Seu dia acabou.';
  if (minutosAteProximo < 0) return `Atrasado ${Math.abs(minutosAteProximo)} min.`;
  if (minutosAteProximo === 0) return 'É agora.';
  if (minutosAteProximo < 5) return `Em ${minutosAteProximo} min.`;
  if (minutosAteProximo < 20) return `Em ${minutosAteProximo} min — dá para arrumar a estação.`;
  return `Em ${minutosAteProximo} min — dá tempo de um café.`;
}

/**
 * Como o cliente gosta de ser atendido (SPEC §4.1).
 *
 * Cinco campos livres e um fechado. O fechado é `conversa` porque ele muda o
 * comportamento de quem atende, e precisa ser legível de relance com a mesma
 * palavra sempre — "quieto", "não gosta de conversa" e "silêncio" leem como
 * três coisas para quem está com pressa.
 */
export const CONVERSAS = ['silencioso', 'indiferente', 'conversa'] as const;
export type Conversa = (typeof CONVERSAS)[number];

export function ehConversa(valor: string): valor is Conversa {
  return (CONVERSAS as readonly string[]).includes(valor);
}

export interface Preferencias {
  readonly maquinaLaterais: string | null;
  readonly tipoDegrade: string | null;
  readonly topo: string | null;
  readonly barbaEstilo: string | null;
  readonly produtosEvitar: string | null;
  readonly conversa: Conversa;
  readonly observacoes: string | null;
}

export const PREFERENCIAS_VAZIAS: Preferencias = {
  maquinaLaterais: null,
  tipoDegrade: null,
  topo: null,
  barbaEstilo: null,
  produtosEvitar: null,
  conversa: 'indiferente',
  observacoes: null,
};

/**
 * A ficha tem alguma coisa escrita?
 *
 * `conversa: 'indiferente'` não conta: é o padrão que a coluna dá a quem nunca
 * foi perguntado, e tratá-lo como preenchido faria toda ficha em branco parecer
 * preenchida — que é como o barbeiro aprende a não confiar na tela.
 */
export function fichaEstaVazia(preferencias: Preferencias): boolean {
  const { conversa, ...livres } = preferencias;
  return conversa === 'indiferente' && Object.values(livres).every((valor) => !valor?.trim());
}

/**
 * O que a tela mostra em destaque, na ordem em que importa para o corte.
 *
 * "Produtos a evitar" vem primeiro apesar de ser o campo menos preenchido, e é
 * de propósito: é o único cuja falha machuca. Alergia a pós-barba com álcool
 * lida depois da navalha não serviu para nada.
 */
export function destaquesDaFicha(
  preferencias: Preferencias,
): readonly { readonly rotulo: string; readonly valor: string }[] {
  const candidatos: readonly [string, string | null][] = [
    ['Evitar', preferencias.produtosEvitar],
    ['Laterais', preferencias.maquinaLaterais],
    ['Degradê', preferencias.tipoDegrade],
    ['Topo', preferencias.topo],
    ['Barba', preferencias.barbaEstilo],
  ];

  return candidatos
    .filter((par): par is [string, string] => Boolean(par[1]?.trim()))
    .map(([rotulo, valor]) => ({ rotulo, valor: valor.trim() }));
}

/** A frase de `conversa`, para quem lê de relance com a máquina na mão. */
export function fraseDaConversa(conversa: Conversa): string | null {
  if (conversa === 'silencioso') return 'Prefere atendimento silencioso';
  if (conversa === 'conversa') return 'Gosta de conversar';
  return null;
}
