/**
 * Os fusos do Brasil, com o nome que o gestor reconhece (bloco 58).
 *
 * ## Por que a lista é fechada
 *
 * `locations.timezone` alimenta `AT TIME ZONE` em toda consulta de dia. Um texto
 * livre inválido não falharia no cadastro — falharia no fechamento do caixa,
 * semanas depois, como erro de banco sobre uma tela que não fala de fuso.
 *
 * ## Por que ela mora em `core`
 *
 * Porque a borda da API e o `<select>` da tela precisam da **mesma** lista, e
 * duas listas escritas separadamente é como uma envelhece em silêncio: a tela
 * ofereceria um fuso que o schema recusa, e o erro sairia como "confira os
 * dados" sobre um campo que estava certo.
 *
 * ## Por que o rótulo é a cidade
 *
 * Ninguém no balcão sabe se Salvador é `America/Bahia` ou `America/Sao_Paulo`,
 * e as duas existem — têm o mesmo deslocamento hoje e tiveram horários de verão
 * diferentes, que é o que o histórico do banco carrega.
 */

export interface FusoDaUnidade {
  readonly id: string;
  readonly rotulo: string;
}

export const FUSOS_DO_BRASIL: readonly FusoDaUnidade[] = [
  { id: 'America/Sao_Paulo', rotulo: 'Brasília, São Paulo, Rio (UTC−3)' },
  { id: 'America/Bahia', rotulo: 'Salvador (UTC−3)' },
  { id: 'America/Fortaleza', rotulo: 'Fortaleza (UTC−3)' },
  { id: 'America/Recife', rotulo: 'Recife (UTC−3)' },
  { id: 'America/Belem', rotulo: 'Belém (UTC−3)' },
  { id: 'America/Manaus', rotulo: 'Manaus (UTC−4)' },
  { id: 'America/Cuiaba', rotulo: 'Cuiabá (UTC−4)' },
  { id: 'America/Campo_Grande', rotulo: 'Campo Grande (UTC−4)' },
  { id: 'America/Porto_Velho', rotulo: 'Porto Velho (UTC−4)' },
  { id: 'America/Boa_Vista', rotulo: 'Boa Vista (UTC−4)' },
  { id: 'America/Rio_Branco', rotulo: 'Rio Branco (UTC−5)' },
  { id: 'America/Noronha', rotulo: 'Fernando de Noronha (UTC−2)' },
];

export const IDS_DE_FUSO: readonly string[] = FUSOS_DO_BRASIL.map((f) => f.id);

export function fusoConhecido(id: string): boolean {
  return IDS_DE_FUSO.includes(id);
}
