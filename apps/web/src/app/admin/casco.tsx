import type { ReactNode } from 'react';

/**
 * O casco: a moldura fixa do painel.
 *
 * Três colunas, como no mock interno do Barber Dock — trilho de ícones,
 * navegação de contexto e a área de trabalho. Antes disso cada tela do admin era
 * uma coluna solta no meio da página: funcionava, e parecia um formulário, não
 * um sistema.
 *
 * ## Sem um byte de JavaScript
 *
 * O mock abre e fecha o trilho, tem paleta de comandos, gaveta e brinde de
 * notificação — tudo JavaScript. Aqui o trilho é um `<nav>` de links, e a
 * navegação de contexto é uma lista. No celular as duas colunas viram uma faixa
 * que rola acima do conteúdo, porque em 360px não existe coluna lateral: existe
 * conteúdo e o resto.
 *
 * ## Uma navegação só, não duas
 *
 * A primeira versão repetia os onze destinos nas duas colunas e escondia a
 * segunda no celular. A guarda reprovou, e estava certa por mérito: não era
 * conteúdo refluindo, era o mesmo link duas vezes no DOM — quem usa leitor de
 * tela ouviria a lista inteira em dobro.
 *
 * Agora o trilho é a navegação, e só ela. A coluna de contexto carrega o que o
 * mock de fato põe lá além dos links: de que casa é esta tela e quem está
 * logado. A navegação de dentro de cada seção continua onde já estava — nas
 * barras que as próprias telas de cadastro e de balcão desenham.
 *
 * ## O item ativo sai do CSS, não do servidor
 *
 * `layout.tsx` não conhece a rota no App Router. Em vez de transformar o casco
 * num componente de cliente só para isso, cada tela declara `data-secao` no
 * próprio `<main>` e o CSS acende o item com `:has()`. Tela que ainda não
 * declarou simplesmente não acende nada — degrada para uma navegação comum, não
 * para uma quebrada.
 */

interface Destino {
  readonly href: string;
  readonly nome: string;
  readonly secao: string;
  readonly icone: ReactNode;
}

/** Traço fino, 1.6px, sem preenchimento: é o desenho do mock, não um emoji. */
const traco = (d: string) => (
  <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
    <path
      d={d}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
  </svg>
);

const OPERACAO: readonly Destino[] = [
  {
    href: '/admin/dia',
    nome: 'O dia',
    secao: 'dia',
    icone: traco('M4 7h16M4 12h16M4 17h10'),
  },
  {
    href: '/admin/agenda',
    nome: 'Agenda',
    secao: 'agenda',
    icone: traco('M4 6h16v14H4zM8 3v4M16 3v4M4 10h16'),
  },
  {
    href: '/admin/fila',
    nome: 'Fila',
    secao: 'fila',
    icone: traco('M6 5v14M12 8v11M18 3v16'),
  },
];

const DINHEIRO: readonly Destino[] = [
  {
    href: '/admin/caixa',
    nome: 'Caixa',
    secao: 'caixa',
    icone: traco('M3 8h18v10H3zM3 8l2-3h14l2 3M12 12v3'),
  },
  {
    href: '/admin/comanda',
    nome: 'Comanda',
    secao: 'comanda',
    icone: traco('M7 3h10v18l-5-3-5 3zM10 8h4'),
  },
  {
    href: '/admin/fiado',
    nome: 'Fiado',
    secao: 'fiado',
    icone: traco('M4 6h16v12H4zM4 10h16M8 14h4'),
  },
  {
    href: '/admin/comissao',
    nome: 'Comissão',
    secao: 'comissao',
    icone: traco('M6 18L18 6M8 8h.01M16 16h.01'),
  },
];

const CASA: readonly Destino[] = [
  {
    href: '/admin/painel',
    nome: 'Painel',
    secao: 'painel',
    icone: traco('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  },
  {
    href: '/admin/catalogo',
    nome: 'Cadastro',
    secao: 'cadastro',
    icone: traco('M4 5h16v6H4zM4 15h10v4H4z'),
  },
  {
    href: '/admin/equipe',
    nome: 'Equipe',
    secao: 'equipe',
    icone: traco('M8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 100-6M16 15c3 0 6 2 6 5'),
  },
  {
    href: '/admin/importar',
    nome: 'Trazer base',
    secao: 'importar',
    icone: traco('M12 4v10M8 10l4 4 4-4M4 18h16'),
  },
  {
    href: '/admin/trilha',
    nome: 'Trilha',
    secao: 'trilha',
    icone: traco('M12 3v18M6 8l6-5 6 5M6 16l6 5 6-5'),
  },
];

const GRUPOS: readonly (readonly [string, readonly Destino[]])[] = [
  ['Operação', OPERACAO],
  ['Dinheiro', DINHEIRO],
  ['A casa', CASA],
];

function Item({ destino }: { readonly destino: Destino }) {
  return (
    <a className="trilho__botao" data-para={destino.secao} href={destino.href}>
      {destino.icone}
      <span className="trilho__legenda">{destino.nome}</span>
    </a>
  );
}

export function Casco({
  children,
  nome,
  papel,
  barbearia,
}: {
  readonly children: ReactNode;
  readonly nome: string;
  readonly papel: string;
  readonly barbearia: string;
}) {
  const iniciais = nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((parte) => parte[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="casco">
      {/* O trilho: a navegação do painel, agrupada. No celular ele deita e vira
          uma faixa que rola; a partir do notebook ele fica de pé na lateral. */}
      <nav aria-label="Seções do painel" className="trilho ui-scroll-x">
        <a className="trilho__selo" href="/admin/dia" title="Barber Dock">
          <img alt="Barber Dock" height={384} src="/barber-dock.png" width={384} />
        </a>
        {GRUPOS.map(([grupo, destinos]) => (
          <div className="trilho__grupo" key={grupo}>
            <p className="trilho__rotulo">{grupo}</p>
            {destinos.map((destino) => (
              <Item destino={destino} key={destino.href} />
            ))}
          </div>
        ))}
      </nav>

      {/* A navegação de contexto, com o nome da casa e os grupos. */}
      <aside className="contexto">
        <div className="contexto__topo">
          <p className="contexto__casa">{barbearia}</p>
          <p className="contexto__sub">Painel de gestão</p>
        </div>

        <div className="contexto__pe">
          <p className="contexto__quem">
            <span className="contexto__iniciais" aria-hidden="true">
              {iniciais}
            </span>
            <span className="contexto__identidade">
              {nome}
              <small>{papel}</small>
            </span>
          </p>
        </div>
      </aside>

      <div className="trabalho">{children}</div>
    </div>
  );
}
