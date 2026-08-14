/**
 * Franquia: o padrão da rede e o preço que ninguém impõe (bloco 76).
 *
 * ## O que este arquivo decide
 *
 * Como se compara o preço praticado por uma franqueada com o preço de
 * referência da franqueadora, e o que a tela é obrigada a dizer sobre essa
 * distância. Não sabe o que é uma franquia no banco, não vai ao banco, não
 * decide se alguém pode.
 *
 * ## A distância é informação, não julgamento
 *
 * A franqueadora enxerga que a franqueada de Feira cobra R$ 45 num corte cujo
 * padrão é R$ 55. O produto **não** diz que isso está errado, e a razão não é
 * diplomacia: a franqueada é outra empresa, e impor preço de revenda a um
 * distribuidor independente é infração à ordem econômica (Lei 12.529/2011,
 * art. 36 §3º IX). Um relatório que chamasse a diferença de "desvio" ou pintasse
 * de vermelho estaria ensinando o cliente a cometer a infração pela ferramenta
 * que ele comprou.
 *
 * O que existe aqui é a distância, com sinal e sem adjetivo.
 */

/**
 * A partir de quanto a distância vira assunto.
 *
 * Dez por cento, e o número é de produto: abaixo disso a diferença é
 * arredondamento de tabela — R$ 50 contra R$ 55 — e marcar tudo faria a lista
 * inteira acender, que é o mesmo que nada acender.
 */
export const DISTANCIA_RELEVANTE_BPS = 1000;

export type SentidoDoPreco = 'acima' | 'abaixo' | 'igual';

export interface DistanciaDoPadrao {
  /** Em pontos-base, sempre positivo. O sentido vem separado. */
  readonly bps: number;
  readonly sentido: SentidoDoPreco;
  readonly diferencaCents: number;
  /** Se passa de `DISTANCIA_RELEVANTE_BPS`. */
  readonly relevante: boolean;
}

/**
 * Quanto o preço praticado se afasta do de referência.
 *
 * Devolve `null` quando o de referência é zero — divisão com denominador zero
 * num relatório devolve `null`, nunca `Infinity`, e a franqueadora que cadastra
 * um item de cortesia é exatamente quem veria "distância de ∞%".
 */
export function distanciaDoPadrao(
  referenciaCents: number,
  praticadoCents: number,
): DistanciaDoPadrao | null {
  if (referenciaCents <= 0) return null;

  const diferencaCents = praticadoCents - referenciaCents;
  if (diferencaCents === 0) {
    return { bps: 0, sentido: 'igual', diferencaCents: 0, relevante: false };
  }

  const bps = Math.round((Math.abs(diferencaCents) * 10_000) / referenciaCents);
  return {
    bps,
    sentido: diferencaCents > 0 ? 'acima' : 'abaixo',
    diferencaCents,
    relevante: bps >= DISTANCIA_RELEVANTE_BPS,
  };
}

/**
 * A frase que a tela mostra, e ela é neutra de propósito.
 *
 * "12% abaixo do padrão" descreve; "12% abaixo do que deveria" prescreve, e a
 * segunda é a que o produto não pode dizer. O rótulo mora aqui e não na tela
 * porque as duas telas — a da franqueadora e a da franqueada — mostram o mesmo
 * fato, e duas telas que classificam a mesma coisa usam o mesmo cálculo.
 */
export function fraseDaDistancia(d: DistanciaDoPadrao | null): string {
  if (!d) return 'sem preço de referência';
  if (d.sentido === 'igual') return 'igual ao padrão';
  const pct = (d.bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return `${pct}% ${d.sentido} do padrão`;
}

/**
 * O que a adoção copia, e o que ela não copia.
 *
 * Nome, descrição e duração vêm da franqueadora, porque padrão de operação é
 * dela por contrato. O preço vem **uma vez**, no momento da adoção, e a partir
 * dali é da franqueada — inclusive quando o padrão muda depois.
 *
 * Esta função existe para que a regra tenha um lugar e um teste. Sem ela, o
 * "copia isto e não aquilo" ficaria escrito dentro de um `INSERT`, e o bloco
 * seguinte que precisasse adotar por outro caminho copiaria o preço de novo.
 */
export interface ItemDoPadrao {
  readonly name: string;
  readonly description: string | null;
  readonly referenciaCents: number;
  readonly durationMinutes: number;
}

export interface ServicoAdotado {
  readonly name: string;
  readonly description: string | null;
  readonly priceCents: number;
  readonly durationMinutes: number;
}

export function adotar(item: ItemDoPadrao): ServicoAdotado {
  return {
    name: item.name,
    description: item.description,
    priceCents: item.referenciaCents,
    durationMinutes: item.durationMinutes,
  };
}

/**
 * O que a **readoção** aplica num item que a franqueada já vende.
 *
 * **Nada de preço.** Nome, descrição e duração vêm do padrão atualizado; o
 * preço fica onde está, porque virou dela na primeira adoção.
 *
 * Quem chama isto é sempre a franqueada, nunca a franqueadora: um lado publica,
 * o outro decide se aplica. Escrever o preço aqui sobrescreveria a escolha que
 * ela tomou, e a barbearia descobriria pelo cliente que o corte mudou de valor
 * da noite para o dia sem ninguém de lá ter decidido — que é imposição de preço
 * de revenda com outro nome.
 */
export function republicar(item: ItemDoPadrao): Omit<ServicoAdotado, 'priceCents'> {
  return {
    name: item.name,
    description: item.description,
    durationMinutes: item.durationMinutes,
  };
}
