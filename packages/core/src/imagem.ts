/**
 * Endereço de imagem que a página pública pode exibir.
 *
 * As colunas `cover_url`, `photo_url` e `logo_url` existem no schema desde o
 * bloco 1 e o perfil público já as devolvia — **nada nunca as preencheu**. O
 * resultado é uma página de barbearia sem nenhuma imagem, num negócio em que a
 * escolha do cliente é visual (CLAUDE.md §5).
 *
 * Enquanto não há armazenamento próprio, o endereço vem de fora: a barbearia
 * cola o link da foto que já publicou. Isso torna o campo entrada externa, e
 * entrada externa é validada na borda.
 */

/** Teto generoso, mas teto: URL sem limite é armazenamento gratuito. */
const MAX_LENGTH = 500;

/**
 * `https://` seguido de um host não vazio.
 *
 * Escrito à mão em vez de `new URL()` porque `URL` não é do ECMAScript — vem do
 * DOM ou do `@types/node`, e `packages/core` não depende de nenhum dos dois.
 * Há teste que falha se alguém der dependência a este pacote, e abrir exceção
 * para uma validação de string seria o primeiro passo para o motor de
 * disponibilidade precisar de um runtime.
 *
 * O host é tudo até a primeira `/`, `?` ou `#`, e precisa ter ao menos um
 * caractere: é isso que separa `https://exemplo.com/a.jpg` de `https://`.
 */
const HTTPS = /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;

/** Caractere de controle não tem uso legítimo numa URL e quebra cabeçalho. */
const CONTROLE = /[\u0000-\u001f\u007f]/;

/**
 * Aceita a URL como veio, ou devolve `null`.
 *
 * **Só `https`.** Três motivos, nesta ordem:
 *
 * - `javascript:` num `href` é execução de script. Aqui o destino é `src` de
 *   `<img>`, onde não executa — mas a mesma coluna alimenta `og:image`, e uma
 *   lista fechada de esquemas custa menos que rastrear todos os consumidores.
 * - `data:` transformaria a coluna em depósito de arquivo, sem limite prático.
 * - `http:` simples é bloqueado pelo navegador como conteúdo misto numa página
 *   servida por HTTPS. Aceitar seria prometer uma imagem que nunca aparece.
 *
 * Devolver `null` em vez de lançar é deliberado: a foto é opcional, e uma URL
 * ruim não pode impedir a barbearia de salvar o resto do cadastro. Quem chama
 * decide se avisa.
 */
export function imagemPublica(bruto: string | null | undefined): string | null {
  if (!bruto) return null;

  const texto = bruto.trim();
  if (texto.length === 0 || texto.length > MAX_LENGTH) return null;

  if (CONTROLE.test(texto)) return null;
  if (!HTTPS.test(texto)) return null;

  return texto;
}

/**
 * Proporção declarada para cada papel de imagem.
 *
 * Existe no domínio, e não só no CSS, porque a mesma proporção precisa ir no
 * atributo `width`/`height` do `<img>`: sem ela o navegador não reserva o
 * espaço e a foto empurra o conteúdo ao carregar — que é exatamente o toque
 * errado no horário errado, com o cliente em pé na rua.
 */
export const PROPORCAO = {
  /** Fachada e ambiente: panorâmica, para não roubar a dobra da agenda. */
  capa: { width: 1600, height: 900 },
  /** Retrato do barbeiro. */
  pessoa: { width: 800, height: 800 },
  /** O corte, o resultado. Quadrado casa com o que a barbearia já posta. */
  servico: { width: 600, height: 600 },
} as const;
