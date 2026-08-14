/**
 * Destaque pago na busca (bloco 75).
 *
 * ## O que este arquivo decide
 *
 * Onde o patrocinado entra na lista, e o que a tela é obrigada a dizer sobre
 * ele. Não decide preço, não sabe o que é uma fatura, não vai ao banco.
 *
 * ## Rótulo, não ordenação
 *
 * O card patrocinado aparece **em cima e marcado**, e a lista orgânica continua
 * ordenada pelo que a pessoa pediu. Misturar o pago no meio do orgânico é o que
 * faz uma busca deixar de responder à pergunta de quem busca — e é o contrário
 * do que este produto vende desde o bloco 72, onde a promessa comercial é uma
 * promessa negativa sobre o que a plataforma **não** cobra.
 *
 * Uma barbearia patrocinada não aparece duas vezes: ela sai da lista orgânica,
 * senão a busca de uma cidade pequena viraria a mesma casa três vezes seguidas.
 */

/**
 * Quantos lugares de destaque existem por cidade.
 *
 * Três, e o número é produto: com cinquenta, destaque deixa de valer alguma
 * coisa — para quem compra e para quem busca. A escassez é imposta pelo banco,
 * numa constraint de exclusão; esta constante é a mesma verdade do lado de cá,
 * e a `CHECK` da coluna cita o mesmo teto.
 */
export const LUGARES_EM_DESTAQUE = 3;

/**
 * A chave do casamento é a **unidade**, não o slug.
 *
 * `marketplace_listings.slug` vem de `tenant_slugs`: numa rede, todas as lojas
 * carregam o mesmo. Casar por ele fazia um anúncio comprado para a loja de
 * Salvador promover — e rotular "Patrocinado" — o card de outra unidade da
 * mesma barbearia, a que tivesse caído por último na lista. Achado da revisão
 * do bloco 75.
 */
export interface ResultadoOrdenavel {
  readonly locationId: string;
}

export interface ComPatrocinio<T> {
  readonly casa: T;
  /**
   * Se este card foi pago.
   *
   * A tela **tem** que dizer isso em letras. Um resultado pago sem rótulo é
   * publicidade disfarçada de recomendação, e é a única coisa que faria a busca
   * deste produto valer menos que um diretório.
   */
  readonly patrocinado: boolean;
}

/**
 * Põe os patrocinados em cima, sem repetir ninguém.
 *
 * A ordem entre os próprios patrocinados é a dos **lugares comprados** — quem
 * comprou o lugar 1 aparece antes de quem comprou o 2 —, e não a ordem da
 * consulta: sem isso a lista trocaria entre dois carregamentos sem nada ter
 * mudado, e o que a barbearia comprou deixaria de ser o que ela recebe.
 */
export function comDestaques<T extends ResultadoOrdenavel>(
  organicos: readonly T[],
  patrocinados: readonly { readonly locationId: string; readonly lugar: number }[],
): readonly ComPatrocinio<T>[] {
  const porUnidade = new Map(organicos.map((c) => [c.locationId, c]));

  const emCima: ComPatrocinio<T>[] = [];
  const jaMostrados = new Set<string>();

  for (const pago of [...patrocinados].sort((a, b) => a.lugar - b.lugar)) {
    const casa = porUnidade.get(pago.locationId);
    /**
     * O anúncio só rende se a casa **passou nos filtros**.
     *
     * Quem comprou destaque em Salvador e não tem vaga hoje não aparece numa
     * busca por "disponível hoje": o destaque compra posição entre resultados
     * válidos, não o direito de contrariar o que a pessoa pediu. Sem isso, o
     * primeiro card da lista seria o que menos serve a quem está lendo.
     */
    if (!casa || jaMostrados.has(pago.locationId)) continue;
    jaMostrados.add(pago.locationId);
    emCima.push({ casa, patrocinado: true });
  }

  const resto = organicos
    .filter((c) => !jaMostrados.has(c.locationId))
    .map((casa) => ({ casa, patrocinado: false }));

  return [...emCima, ...resto];
}

/**
 * Quanto custa um destaque, em centavos, para um período de dias.
 *
 * Tabela por dia e não por clique: cobrança por clique exigiria contar cliques,
 * e contar clique de anúncio é o começo de rastrear quem clicou — que é
 * exatamente o oposto do que este produto faz com dado de pessoa. O período é
 * previsível para quem compra e para quem vende.
 */
export const PRECO_DO_DESTAQUE_POR_DIA_CENTS = 900;

export function precoDoDestaque(dias: number): number {
  if (dias <= 0) return 0;
  return dias * PRECO_DO_DESTAQUE_POR_DIA_CENTS;
}
