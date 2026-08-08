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
