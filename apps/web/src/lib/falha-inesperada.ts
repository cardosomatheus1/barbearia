/**
 * O que fazer com o erro que ninguém previu, numa borda do Next.
 *
 * Route Handler que lança devolve a página **crua** do Next — o "500 | Internal
 * Server Error" sobre fundo preto, sem passar pelo `error.tsx` do admin. Duas
 * coisas ruins de uma vez: quem opera lê uma tela que não diz nada e não oferece
 * volta, e quem depura recebe uma linha sem endereço.
 *
 * Aconteceu: `TypeError: Invalid URL { input: 'null' }`, duas vezes, sem stack e
 * sem rota. Sobrou eliminar candidatos lendo código — e a leitura não achou.
 *
 * ## Por que o `stack` vai para o log e não para a tela
 *
 * É a regra de sempre deste produto: erro para quem está do outro lado é
 * genérico, o detalhe vai para o log. O que muda aqui é que o detalhe **passou a
 * existir** — antes ele morria dentro do Next.
 *
 * ## O `NEXT_REDIRECT` tem que continuar subindo
 *
 * `redirect()` e `notFound()` do Next funcionam **lançando**: o framework
 * reconhece o erro pelo `digest` e faz a navegação. Um `catch` que os engolisse
 * transformaria todo redirecionamento do produto em página de erro — o conserto
 * seria pior que o defeito, e falharia exatamente nos caminhos felizes.
 */

/** `redirect()` e `notFound()` do Next se identificam pelo `digest`. */
export function ehControleDeFluxoDoNext(erro: unknown): boolean {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND');
}

/**
 * Registra a falha com stack e diz se ela é de verdade.
 *
 * Devolve `false` para o controle de fluxo do Next, e quem chama **relança**.
 */
export function registrarFalhaInesperada(onde: string, erro: unknown): boolean {
  if (ehControleDeFluxoDoNext(erro)) return false;
  const detalhe = erro instanceof Error ? (erro.stack ?? erro.message) : String(erro);
  // `console.error` e não um logger: esta é a borda do Next, que não tem o
  // logger da API, e o que se quer é a linha no `docker compose logs web`.
  console.error(`[falha inesperada] ${onde}\n${detalhe}`);
  return true;
}
