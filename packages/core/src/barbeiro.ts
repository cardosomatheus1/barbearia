/**
 * O perfil público do barbeiro (bloco 73, SPEC §5.2).
 *
 * > ```
 * > João Silva                    ⭐ 4,92 · 1.842 atendimentos
 * > Especialidades: fade · degradê · barba · corte social
 * > [ portfólio ]  [ horários ]  [ Agendar com João ]
 * > ```
 *
 * ## Por que a lista de especialidades é fechada
 *
 * Texto livre produziria "fade", "Fade", "degrade" e "degradê" como quatro
 * coisas diferentes na mesma barbearia — e o filtro por especialidade, que é o
 * passo seguinte do marketplace, nasceria impossível. É a decisão de
 * `locations.amenities` no bloco 7, cujo próprio comentário dizia que texto
 * livre "impossibilitaria filtro no marketplace".
 *
 * A lista sai do vocabulário da barbearia brasileira, não de uma tradução: é o
 * que o barbeiro diz que faz quando alguém pergunta.
 */

export const ESPECIALIDADES = [
  'fade',
  'degrade',
  'corte_social',
  'navalhado',
  'barba',
  'barboterapia',
  'infantil',
  'platinado',
  'coloracao',
  'progressiva',
  'sobrancelha',
  'pezinho',
] as const;

export type Especialidade = (typeof ESPECIALIDADES)[number];

/**
 * O rótulo com acento, para a tela.
 *
 * O valor guardado é sem acento e sem espaço, porque ele vai virar filtro de
 * URL; o rótulo mora aqui, escrito **uma vez**. Uma segunda lista dentro da
 * tela é como o bloco que acrescentasse uma especialidade deixaria a página
 * oferecendo onze com o cadastro aceitando doze — e nada ficaria vermelho,
 * porque a tela sozinha continuaria coerente.
 */
export const ROTULO_DA_ESPECIALIDADE: Readonly<Record<Especialidade, string>> = {
  fade: 'Fade',
  degrade: 'Degradê',
  corte_social: 'Corte social',
  navalhado: 'Navalhado',
  barba: 'Barba',
  barboterapia: 'Barboterapia',
  infantil: 'Corte infantil',
  platinado: 'Platinado',
  coloracao: 'Coloração',
  progressiva: 'Progressiva',
  sobrancelha: 'Sobrancelha',
  pezinho: 'Pezinho',
};

/** Quantas especialidades cabem num perfil. Doze seria "faço tudo", que não informa. */
export const MAXIMO_DE_ESPECIALIDADES = 6;

export const ehEspecialidade = (valor: string): valor is Especialidade =>
  (ESPECIALIDADES as readonly string[]).includes(valor);

/**
 * O endereço público a partir do nome, para a barbearia não ter que inventá-lo.
 *
 * Sem acento, sem caixa e sem pontuação — o mesmo tratamento do slug da casa.
 * Nome que não sobra nada legível (só símbolos) devolve nulo, e quem chama
 * pergunta em vez de gravar um endereço vazio.
 */
export function slugDoBarbeiro(nome: string): string | null {
  const limpo = nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // O `CHECK` do banco exige de 3 a 60 caracteres: devolver algo fora disso
  // seria empurrar para o banco uma recusa que dá para explicar aqui.
  if (limpo.length < 3) return null;
  return limpo.slice(0, 60).replace(/-+$/g, '');
}

export interface PerfilDoBarbeiro {
  readonly nome: string;
  readonly slug: string;
  readonly fotoUrl: string | null;
  readonly bio: string | null;
  readonly especialidades: readonly Especialidade[];
  /** A nota pública, em pontos-base. Nula abaixo do mínimo de avaliações. */
  readonly notaBps: number | null;
  readonly avaliacoes: number;
  /** Atendimentos concluídos. É o número que a SPEC põe ao lado da nota. */
  readonly atendimentos: number;
}

/**
 * A frase das especialidades, na ordem da lista e não na do banco.
 *
 * `ESPECIALIDADES` é a ordem; um `array` vindo do Postgres tem a ordem em que
 * alguém marcou as caixas, e ela mudaria a cada edição sem nada ter mudado de
 * verdade. É a mesma razão de a ordem de exibição sair da constante do domínio
 * e nunca de `Object.entries`.
 */
export function frasedasEspecialidades(especialidades: readonly Especialidade[]): string {
  const conjunto = new Set(especialidades);
  return ESPECIALIDADES.filter((e) => conjunto.has(e))
    .map((e) => ROTULO_DA_ESPECIALIDADE[e])
    .join(' · ');
}
