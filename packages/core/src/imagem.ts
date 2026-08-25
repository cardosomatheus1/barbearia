/**
 * Endereço de imagem que a página pública pode exibir.
 *
 * As colunas `cover_url`, `photo_url` e `logo_url` existem no schema desde o
 * bloco 1 e o perfil público já as devolvia — **nada nunca as preencheu**. O
 * resultado é uma página de barbearia sem nenhuma imagem, num negócio em que a
 * escolha do cliente é visual (CLAUDE.md §5).
 *
 * As imagens públicas da barbearia passam a usar `/media/...`, hospedado pelo
 * próprio produto. `https://` continua aceito aqui porque a mesma função ainda
 * lê fotos históricas e o portfólio do cliente, cuja migração exige preservar
 * as regras de consentimento e exclusão — aceitar na leitura não significa que
 * a tela de Fotos continue permitindo cadastrar host externo.
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
const MEDIA_LOCAL = /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f-]{36}\.(?:webp|jpg|png)$/i;

/** Caractere de controle não tem uso legítimo numa URL e quebra cabeçalho. */
const CONTROLE = /[\u0000-\u001f\u007f]/;

/**
 * Aceita a URL como veio, ou devolve `null`.
 *
 * **Só `https` externo ou `/media/...` hospedado por nós.** A rota local é
 * fechada no formato que o armazenamento gera; qualquer outro caminho relativo
 * continua recusado. Para endereço externo, três motivos, nesta ordem:
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
  if (!HTTPS.test(texto) && !MEDIA_LOCAL.test(texto)) return null;

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
