/**
 * Para onde voltar depois de entrar.
 *
 * Só caminho interno da própria barbearia. Sem isto o parâmetro `destino` vira
 * redirecionador aberto: um link no domínio verdadeiro da barbearia — enviado
 * pelo WhatsApp, que é o canal do produto — jogaria o cliente numa cópia da
 * tela de login, e o código de 6 dígitos é o único fator que protege cancelar e
 * remarcar.
 *
 * Mora aqui, e não junto das server actions, porque a página também redireciona
 * (quem já tem sessão não vê o formulário) e é justamente esse caminho que um
 * link montado por terceiro alcança. A primeira versão validava só nas ações e
 * deixava a página aberta.
 */
export function destinoSeguro(bruto: string | null | undefined, slug: string): string {
  const padrao = `/${slug}/meus-agendamentos`;
  if (!bruto) return padrao;

  // `//outro.site` é caminho relativo de protocolo: o navegador o trata como
  // externo. Exigir uma barra só é o que fecha essa porta.
  if (bruto.startsWith('//')) return padrao;
  if (!bruto.startsWith(`/${slug}/`)) return padrao;

  return bruto;
}

/**
 * Para onde voltar depois de mover um atendimento no balcão.
 *
 * Mesmo risco de `destinoSeguro`, com o alvo mais sensível: o cookie do painel
 * altera catálogo, equipe e preço. A lista é fechada — duas telas movem
 * atendimento, e nenhuma outra.
 *
 * Mora aqui, e não junto das server actions, pelo mesmo motivo da função
 * acima: guarda de redirecionamento sem teste é guarda que ninguém confere. Ela
 * viveu quatro blocos dentro de `acoes.ts`, que é `'use server'` e por isso não
 * dá para importar num teste — e foi assim que ela deixou de aceitar
 * `/admin/meu-dia` sem ninguém notar, fazendo o barbeiro rodar dois
 * redirecionamentos a cada botão.
 */
const DESTINOS_DO_BALCAO = ['/admin/dia', '/admin/meu-dia'] as const;

export function destinoDoBalcao(bruto: string): string {
  const padrao = '/admin/dia';
  if (!bruto) return padrao;
  // `//outro.site` é caminho relativo de protocolo: o navegador o trata como
  // externo. Exigir uma barra só é o que fecha essa porta.
  if (bruto.startsWith('//')) return padrao;

  const aceito = DESTINOS_DO_BALCAO.some(
    (destino) => bruto === destino || bruto.startsWith(`${destino}?`),
  );
  return aceito ? bruto : padrao;
}

/**
 * Para onde voltar depois de confirmar o segundo fator da plataforma.
 *
 * Terceira vez que este parâmetro aparece, e a terceira vez que ele precisa de
 * lista fechada. Aqui o alvo é o pior dos três: a `/security-review` do bloco 26
 * descreveu o ataque inteiro — um link no **domínio verdadeiro**, apontando para
 * uma tela legítima que pede o código TOTP, e um `destino` externo logo depois.
 * O Super Admin tem todo motivo para digitar o código; ele acaba de digitá-lo, a
 * sessão fica provada por trinta minutos, e o navegador cai numa cópia da tela
 * de entrada dizendo "sessão expirada". O prêmio do phishing é a base inteira de
 * clientes de todas as barbearias.
 *
 * A lista é fechada porque as telas que pedem o segundo fator são conhecidas: a
 * de barbearias, que é de onde se entra numa conta, e a própria de segurança.
 */
const DESTINOS_DA_PLATAFORMA = [
  '/plataforma',
  '/plataforma/seguranca',
  '/plataforma/faturas',
] as const;

export function destinoDaPlataforma(bruto: string | null | undefined): string {
  const padrao = '/plataforma';
  if (!bruto) return padrao;
  if (bruto.startsWith('//')) return padrao;

  const aceito = DESTINOS_DA_PLATAFORMA.some(
    (destino) => bruto === destino || bruto.startsWith(`${destino}?`),
  );
  return aceito ? bruto : padrao;
}
