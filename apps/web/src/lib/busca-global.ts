/** Lógica pura da paleta do V11, compartilhada por servidor e ilha de cliente. */
export interface DestinoDaBuscaGlobal {
  readonly href: string;
  readonly nome: string;
  readonly modulo: string;
  readonly nota: string;
}

export const normalizarBusca = (texto: string): string =>
  texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    // Singular/plural muito comum no vocabulário do painel: comissão/comissões,
    // configuração/configurações, ação/ações. Sem isto a paleta parece falhar
    // justamente quando a pessoa digita a palavra como pensa.
    .replace(/\b([a-z]+)oes\b/g, '$1ao')
    .trim();

export function filtrarDestinos(
  destinos: readonly DestinoDaBuscaGlobal[],
  consulta: string,
  limite = 6,
): readonly DestinoDaBuscaGlobal[] {
  const q = normalizarBusca(consulta);
  if (!q) return destinos.slice(0, limite);
  return destinos
    .filter((destino) => normalizarBusca(`${destino.nome} ${destino.modulo} ${destino.nota}`).includes(q))
    .slice(0, limite);
}
