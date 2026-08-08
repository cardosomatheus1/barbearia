/**
 * Quais horários a página pública mostra na dobra.
 *
 * O herói desta página é a disponibilidade (`docs/03-direcao-visual.md`), e ela
 * estava se sabotando: a grade sai ordenada por horário, então os primeiros
 * catorze de um dia com 126 vagas eram `12:30 12:35 12:40 12:45 …` — a mesma
 * hora repetida, com o mesmo barbeiro, seguida de "e mais 122 horários".
 *
 * Isso não é escolha, é o começo de uma lista. Quem olha quer saber se dá para
 * ir **hoje de manhã, na hora do almoço ou depois do trabalho** — e a resposta
 * a essas três perguntas estava escondida atrás de um "e mais".
 */

export interface VitrineSlot {
  readonly start: string;
  readonly professionalId: string;
}

/**
 * Escolhe horários espalhados pelo dia, não os primeiros da fila.
 *
 * Duas etapas:
 *
 * 1. **Um cartão por horário.** Dois barbeiros livres às 14:00 são uma opção
 *    para quem escolhe, não duas — a atribuição é do sistema.
 * 2. **Amostra espaçada, com as pontas presas.** O primeiro horário livre é a
 *    informação mais útil da página ("dá para ir agora?") e o último desenha o
 *    fim do expediente. O meio é distribuído por igual.
 *
 * Não ordena: a grade já vem ordenada por horário do repositório, e reordenar
 * aqui esconderia um defeito lá.
 */
export function horariosEmDestaque<T extends VitrineSlot>(
  slots: readonly T[],
  maximo: number,
): readonly T[] {
  if (maximo <= 0) return [];

  const unicos: T[] = [];
  const vistos = new Set<string>();
  for (const slot of slots) {
    if (vistos.has(slot.start)) continue;
    vistos.add(slot.start);
    unicos.push(slot);
  }

  if (unicos.length <= maximo) return unicos;
  if (maximo === 1) return [unicos[0] as T];

  // O passo é sobre `length - 1` e não sobre `length` para que o último índice
  // caia exatamente no fim. Com `length`, o último ponto ficaria antes do fim e
  // o horário de fechamento nunca apareceria.
  const passo = (unicos.length - 1) / (maximo - 1);
  const escolhidos: T[] = [];
  for (let i = 0; i < maximo; i += 1) {
    const item = unicos[Math.round(i * passo)];
    if (item) escolhidos.push(item);
  }
  return escolhidos;
}

/**
 * Quantos horários sobraram fora da amostra.
 *
 * Conta **horários distintos**, não vagas: dizer "e mais 122" quando existem 40
 * horários com três barbeiros cada é número inflado, e número inflado numa
 * página de venda é o começo de não confiar em nenhum.
 */
export function horariosRestantes(
  slots: readonly VitrineSlot[],
  mostrados: number,
): number {
  const distintos = new Set(slots.map((slot) => slot.start)).size;
  return Math.max(0, distintos - mostrados);
}
