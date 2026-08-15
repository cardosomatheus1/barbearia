import type { ReactNode } from 'react';
import localFont from 'next/font/local';
// Tokens e componentes vêm do pacote, não de uma cópia. Copiar o CSS criaria
// uma segunda fonte que envelhece em silêncio a cada mudança no design system.
import '@barbearia/ui/tokens.css';
import './globals.css';

/**
 * As letras da marca, servidas do nosso domínio — e os arquivos moram **aqui**,
 * versionados ao lado do código.
 *
 * `next/font/google` também serve do nosso domínio, mas baixa os arquivos
 * durante o `next build`: o build passa a depender de a máquina que compila
 * alcançar `fonts.gstatic.com`. Numa rede que não alcança, ele falha inteiro
 * depois de três tentativas por arquivo — foi o que derrubou o build do
 * contêiner em produção, num commit que não tinha nada a ver com fonte.
 *
 * O `@import` do Google Fonts continua fora de questão: ele faria o navegador
 * de cada cliente pedir a fonte a um terceiro e entregar o IP dele junto —
 * dado pessoal saindo da barbearia a cada visita, por causa de uma fonte.
 *
 * Só o subconjunto `latin`, que é o que `subsets: ['latin']` já trazia e o que
 * o português precisa. As duas são fontes variáveis: um arquivo por família
 * cobre a faixa inteira de peso, e sai menor que os sete estáticos.
 *
 * Os arquivos moram **fora** de `app/`: tudo que é pasta ali dentro é segmento
 * de rota, e uma pasta de fontes viraria um endereço de primeiro nível
 * disputando espaço com o slug das barbearias.
 *
 * `display: 'swap'` de propósito: o cliente agenda em pé, na rua, em 4G. Texto
 * invisível esperando fonte é pior que texto na fonte do sistema por 200 ms.
 */
const oswald = localFont({
  src: '../fontes/oswald-latin.woff2',
  weight: '200 700',
  style: 'normal',
  variable: '--font-oswald',
  display: 'swap',
});

const dmSans = localFont({
  src: '../fontes/dm-sans-latin.woff2',
  weight: '100 1000',
  style: 'normal',
  variable: '--font-dm-sans',
  display: 'swap',
});

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={`${oswald.variable} ${dmSans.variable}`} lang="pt-BR" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
