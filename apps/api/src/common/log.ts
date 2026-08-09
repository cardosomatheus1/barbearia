/**
 * A linha de log de uma requisição.
 *
 * Log estruturado é pedido da SPEC §5.12, mas o que decide se ele presta não é
 * o formato — é **o que fica de fora**. Uma linha por requisição com a URL
 * inteira parece inofensiva e é o vazamento de dado pessoal mais comum que
 * existe: telefone em rota de OTP, nome em busca do balcão, código de
 * verificação em parâmetro de consulta. Log vai para agregador, agregador é
 * lido por gente que não precisaria ver aquilo, e a retenção dele é medida em
 * meses (CLAUDE.md §2).
 *
 * Por isso a montagem da linha mora aqui, pura: dá para provar item a item o
 * que entra e o que não entra, sem subir aplicação nenhuma.
 */

/** O que sai. Nada aqui é conteúdo de cliente. */
export interface LinhaDeLog {
  readonly nivel: 'info' | 'aviso' | 'erro';
  readonly rota: string;
  readonly metodo: string;
  readonly status: number;
  readonly duracaoMs: number;
  readonly requisicaoId: string;
  /**
   * UUID da barbearia, quando a requisição foi autenticada.
   *
   * Ausente em rota pública **de propósito**, e sem perda: ali o slug já está
   * dentro de `rota` (`/v1/b/barbearia-do-ze/availability`), que é justamente o
   * que agrupa por barbearia. Preencher os dois seria a mesma informação em
   * duas chaves, e aí nenhuma agrupa direito.
   */
  readonly tenantId?: string;
  /** Código de erro do domínio, quando houve. Nunca a mensagem. */
  readonly erro?: string;
}

/**
 * Só o caminho, sem consulta e sem fragmento.
 *
 * `/v1/b/barbearia-x/availability?serviceIds=...&dateFrom=...` vira
 * `/v1/b/barbearia-x/availability`. O que se perde é a variação da consulta; o
 * que se ganha é não guardar telefone que chegou por engano num parâmetro.
 */
export function semConsulta(url: string): string {
  const corte = url.search(/[?#]/);
  return corte === -1 ? url : url.slice(0, corte);
}

/**
 * Troca identificador por marcador na rota.
 *
 * Sem isso, cada agendamento vira uma rota diferente e o log deixa de agrupar:
 * "quantas vezes /appointments/:id falhou hoje" não tem resposta se existem
 * quatro mil rotas de uma chamada cada. E o id do agendamento é a credencial do
 * comprovante — ele **é** segredo, ainda que pareça só um número.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** ULID: 26 caracteres em Crockford base32. */
const ULID = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
/** Sequência longa de dígitos — telefone que escapou para o caminho. */
const DIGITOS = /\b\d{6,}\b/g;

export function rotaGenerica(caminho: string): string {
  return caminho.replace(UUID, ':id').replace(ULID, ':id').replace(DIGITOS, ':n');
}

const NIVEL = (status: number): LinhaDeLog['nivel'] => {
  if (status >= 500) return 'erro';
  if (status >= 400) return 'aviso';
  return 'info';
};

export function montarLinha(entrada: {
  readonly metodo: string;
  readonly url: string;
  readonly status: number;
  readonly duracaoMs: number;
  readonly requisicaoId: string;
  readonly tenantId?: string | undefined;
  readonly erro?: string | undefined;
}): LinhaDeLog {
  return {
    nivel: NIVEL(entrada.status),
    metodo: entrada.metodo,
    rota: rotaGenerica(semConsulta(entrada.url)),
    status: entrada.status,
    // Milissegundo inteiro: fração aqui é ruído, e log de requisição é o
    // volume que mais cresce.
    duracaoMs: Math.round(entrada.duracaoMs),
    requisicaoId: entrada.requisicaoId,
    ...(entrada.tenantId ? { tenantId: entrada.tenantId } : {}),
    ...(entrada.erro ? { erro: entrada.erro } : {}),
  };
}

/**
 * O identificador que atravessa a requisição inteira.
 *
 * Vem do proxy quando ele manda (`x-request-id`), para que a mesma chamada
 * tenha o mesmo nome do balanceador até o banco. Quando não vem, é sorteado
 * aqui. Volta no cabeçalho da resposta de propósito: é o número que a pessoa
 * cola no chamado, e sem ele o suporte procura por horário e nome do cliente —
 * que é justamente o que não está no log.
 */
export function idDaRequisicao(
  cabecalho: string | string[] | undefined,
  sortear: () => string,
): string {
  const bruto = Array.isArray(cabecalho) ? cabecalho[0] : cabecalho;
  if (typeof bruto !== 'string') return sortear();

  const limpo = bruto.trim();
  // Entrada externa: cabeçalho é do cliente, e ele vai parar no log e no
  // cabeçalho de resposta. Alfabeto fechado e tamanho com teto eliminam quebra
  // de linha forjada — que é como se injeta uma entrada falsa no agregador.
  if (limpo.length === 0 || limpo.length > 64) return sortear();
  if (!/^[A-Za-z0-9._-]+$/.test(limpo)) return sortear();

  return limpo;
}
