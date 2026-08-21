import { Fragment, type ReactNode } from 'react';

/**
 * O casco: a moldura fixa do painel.
 *
 * Três colunas — trilho de módulos,
 * navegação de contexto e a área de trabalho. Antes disso cada tela do admin era
 * uma coluna solta no meio da página: funcionava, e parecia um formulário, não
 * um sistema.
 *
 * ## Trilho e contexto não são a mesma lista
 *
 * A primeira versão repetia os onze destinos nas duas colunas e escondia a
 * segunda no celular. A guarda reprovou, e estava certa por mérito: era o mesmo
 * link duas vezes no DOM, e quem usa leitor de tela ouviria a lista em dobro.
 *
 * A estrutura certa é a do mock: **o trilho são os módulos** — três ícones —, e
 * **o contexto são as telas de dentro do módulo aberto**. Um link, um lugar.
 *
 * ## Sem um byte de JavaScript
 *
 * O mock abre e fecha o trilho, tem paleta de comandos, gaveta e brinde de
 * notificação — tudo JavaScript. Aqui tudo é link, e o que decide o que aparece
 * é CSS: cada tela declara `data-secao` no próprio `<main>`, e o casco usa
 * `:has()` para acender o módulo e revelar o bloco de contexto dele. Trocar isso
 * por um componente de cliente custaria o primeiro JavaScript do produto — só
 * para saber em que página estamos.
 */

import { modulosVisiveis, type Modulo } from './secoes';

export type { Modulo, Secao } from './secoes';
export { secao, SECOES_POR_MODULO } from './secoes';

/** Traço fino, sem preenchimento: é o desenho do mock, não um emoji. */
const traco = (d: string, tamanho = 20) => (
  <svg aria-hidden="true" fill="none" height={tamanho} viewBox="0 0 24 24" width={tamanho}>
    <path
      d={d}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
  </svg>
);

/** O desenho de cada módulo. O registro é dado; o ícone é desenho, e mora aqui. */
const ICONE: Readonly<Record<Modulo, ReactNode>> = {
  inicio: traco('M4 4h6v7H4zM14 4h6v4h-6zM4 15h6v5H4zM14 12h6v8h-6z'),
  atendimento: traco('M5 4v3M19 4v3M4 9h16M5 6h14v14H5z'),
  financeiro: traco('M3 8h18v10H3zM3 8l2-3h14l2 3M12 12v3'),
  // Um megafone: o módulo é sobre o que a casa **manda** para fora.
  marketing: traco('M4 10v4h3l6 4V6l-6 4H4zM17 9a4 4 0 010 6'),
  cadastros: traco('M4 5h16v14H4zM8 9h8M8 13h8M8 17h5'),
  // Dois elos: o que fala com o mundo lá fora.
  integracoes: traco('M9 15l6-6M10 6l1.5-1.5a4 4 0 015.5 5.5L15.5 11M8.5 13L7 14.5a4 4 0 005.5 5.5L14 18.5'),
  administracao: traco('M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4'),
};

export function Casco({
  children,
  nome,
  papel,
  barbearia,
  unidade,
  recursos,
  permissoes,
}: {
  readonly children: ReactNode;
  readonly nome: string;
  readonly papel: string;
  readonly barbearia: string;
  /** A loja da sessão, quando a barbearia tem mais de uma. */
  readonly unidade: string | null;
  readonly recursos: readonly string[];
  /**
   * O que esta conta pode, pela mesma lista que a `PermissaoGuard` aplica.
   *
   * Vem da sessão (`/v1/admin/state`) e não é recalculada aqui: permissão
   * exibida na tela sai da mesma função que a API aplica.
   */
  readonly permissoes: readonly string[];
}) {
  const modulos = modulosVisiveis(recursos, permissoes);

  const iniciais = nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((parte) => parte[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="casco">
      <nav aria-label="Módulos" className="trilho">
        <a className="trilho__selo" href="/admin/dia" title="Barber Dock">
          <img alt="Barber Dock" height={384} src="/barber-dock.png" width={384} />
        </a>

        {modulos.map((modulo) => (
          <a
            className="trilho__botao"
            data-modulo={modulo.id}
            href={modulo.telas[0]?.href ?? '/admin/dia'}
            key={modulo.id}
            title={modulo.nome}
          >
            {ICONE[modulo.id]}
            <span className="trilho__legenda">{modulo.nome}</span>
          </a>
        ))}
      </nav>

      <aside className="contexto">
        <div className="contexto__topo">
          <p className="contexto__casa">{barbearia}</p>
          {/*
            A loja em que a pessoa está, e só numa rede.

            A tela de Unidades prometia "trocar aqui troca em todas as telas" e
            nenhuma das outras dizia qual era — a recepcionista que atende nas
            duas abria o Caixa sem saber qual gaveta ia abrir. Numa barbearia de
            uma loja só a linha não aparece: seria repetir o nome da casa.
          */}
          {unidade ? <p className="contexto__unidade">{unidade}</p> : null}
          <p className="contexto__sub">Painel de gestão</p>
        </div>

        {/* Todos os blocos são renderizados; o CSS revela o do módulo aberto.
            Não é "esconder no celular" — é condicional por seção, e vale igual
            em qualquer largura. */}
        <div className="contexto__lista">
          {modulos.map((modulo) => (
            <div className="contexto__bloco" data-modulo={modulo.id} key={modulo.id}>
              <p className="contexto__grupo">{modulo.nome}</p>
              {/*
                Os links numa faixa própria, e não soltos ao lado do título.
                No celular o bloco é uma tira que rola na horizontal: com o nome
                do módulo dentro dela, "CADASTROS" comia 40% dos 360px e o
                primeiro cartão já nascia cortado. Fora da faixa, o título ocupa
                a linha inteira e os cartões ficam com a tela toda.
              */}
              <div className="contexto__faixa">
              {modulo.telas.map((tela, i) => (
                <Fragment key={tela.href}>
                  {/*
                    O rótulo do subgrupo sai quando o grupo **muda**, e não de
                    uma segunda lista ao lado: a ordem da tela é a ordem do
                    registro, e um grupo escrito duas vezes vira dois rótulos
                    iguais na tela — erro visível, que é o que se quer.
                  */}
                  {tela.grupo && tela.grupo !== modulo.telas[i - 1]?.grupo ? (
                    <p className="contexto__secao">{tela.grupo}</p>
                  ) : null}
                  <a className="contexto__link" data-para={tela.secao} href={tela.href}>
                    <span className="contexto__link-nome">{tela.nome}</span>
                    <span className="contexto__link-nota">{tela.nota}</span>
                  </a>
                </Fragment>
              ))}
              </div>
            </div>
          ))}
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
