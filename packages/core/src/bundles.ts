/**
 * Combo do cardápio que sai mais barato que a escolha avulsa.
 *
 * Lógica pura: recebe o que o cliente marcou e os combos vendáveis da unidade,
 * devolve a troca que economiza. Nada de banco.
 *
 * Existe porque o cardápio real tem as duas formas do mesmo atendimento — os
 * serviços soltos e o combo — e nada as ligava. Quem montava a escolha à mão
 * pagava a mais sem saber que a própria barbearia oferecia mais barato.
 */

export interface SellableBundle {
  /** Serviço do cardápio que vende o conjunto. */
  readonly serviceId: string;
  readonly name: string;
  readonly priceCents: number;
  /** Serviços que ele substitui. */
  readonly componentIds: readonly string[];
}

export interface BundleSuggestion {
  readonly serviceId: string;
  readonly name: string;
  readonly priceCents: number;
  /** Quanto o cliente deixa de pagar ao trocar. */
  readonly savesCents: number;
  /** O que sai do carrinho na troca. */
  readonly replacesIds: readonly string[];
}

/**
 * A melhor troca disponível, ou `null`.
 *
 * Uma sugestão só, a de maior economia: duas ou três transformam a tela num
 * balcão de ofertas e o cliente pára de decidir.
 *
 * O combo precisa estar **contido** na escolha, não ser igual a ela: quem marcou
 * cabelo, barba e sobrancelha também economiza trocando cabelo+barba pelo combo,
 * e deixar isso de fora esconderia o desconto justamente de quem gasta mais.
 */
export function suggestBundle(
  selectedIds: readonly string[],
  priceOf: (serviceId: string) => number | undefined,
  bundles: readonly SellableBundle[],
): BundleSuggestion | null {
  const selected = new Set(selectedIds);
  let best: BundleSuggestion | null = null;

  for (const bundle of bundles) {
    // Já está no carrinho: não faz sentido sugerir o que a pessoa escolheu.
    if (selected.has(bundle.serviceId)) continue;
    // Um "combo" de um item só não é combo; e conjunto vazio casaria com tudo.
    if (bundle.componentIds.length < 2) continue;
    if (!bundle.componentIds.every((id) => selected.has(id))) continue;

    let soma = 0;
    let completo = true;
    for (const id of bundle.componentIds) {
      const preco = priceOf(id);
      // Componente fora do cardápio visível: sem preço não dá para comparar, e
      // afirmar economia sem saber a soma seria mentir.
      if (preco === undefined) {
        completo = false;
        break;
      }
      soma += preco;
    }
    if (!completo) continue;

    const economia = soma - bundle.priceCents;
    if (economia <= 0) continue;

    if (!best || economia > best.savesCents) {
      best = {
        serviceId: bundle.serviceId,
        name: bundle.name,
        priceCents: bundle.priceCents,
        savesCents: economia,
        replacesIds: bundle.componentIds,
      };
    }
  }

  return best;
}

/** Aplica a troca: tira os componentes, põe o combo, preservando a ordem. */
export function applyBundle(
  selectedIds: readonly string[],
  suggestion: BundleSuggestion,
): string[] {
  const removidos = new Set(suggestion.replacesIds);
  const restantes = selectedIds.filter((id) => !removidos.has(id));
  // O combo entra onde o primeiro componente estava, para a lista não embaralhar
  // sob os olhos de quem acabou de escolher.
  const posicao = selectedIds.findIndex((id) => removidos.has(id));
  restantes.splice(posicao < 0 ? restantes.length : posicao, 0, suggestion.serviceId);
  return restantes;
}
