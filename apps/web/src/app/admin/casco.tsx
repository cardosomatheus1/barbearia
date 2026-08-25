import { Fragment, type ReactNode } from 'react';
import { SkipLink } from '@barbearia/ui';
import { BuscaGlobal, type DestinoDaBuscaGlobal } from './busca-global';

/**
 * O casco: a moldura fixa do painel.
 *
 * Dois eixos — trilho de áreas e abas horizontais da área — mais a área de
 * trabalho. Antes disso cada tela do admin era
 * uma coluna solta no meio da página: funcionava, e parecia um formulário, não
 * um sistema.
 *
 * ## Trilho e contexto não são a mesma lista
 *
 * A primeira versão repetia os onze destinos nas duas colunas e escondia a
 * segunda no celular. A guarda reprovou, e estava certa por mérito: era o mesmo
 * link duas vezes no DOM, e quem usa leitor de tela ouviria a lista em dobro.
 *
 * V3 fecha a ambiguidade: **o trilho escolhe a área** e **a faixa horizontal
 * escolhe a tela dentro dela**. A migalha, derivada do mesmo registro, diz onde
 * a pessoa chegou. Um link, um papel.
 *
 * ## O casco continua server-first
 *
 * V11 acrescenta uma ilha pequena e deliberada para a busca global. Todo o resto
 * do casco — módulo ativo, orientação e abas — continua derivado no servidor e
 * aceso por CSS. Não se paga JavaScript para descobrir onde a pessoa está; paga-se
 * somente pelo comportamento que precisa de teclado, foco e consulta incremental.
 */

import { modulosVisiveis, orientacoesVisiveis, telasDoMenu, utilitariosVisiveis, type Modulo } from './secoes';

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
  hoje: traco('M5 4v3M19 4v3M4 9h16M5 6h14v14H5zM8 13h3M8 16h5'),
  agenda: traco('M4 5h16v15H4zM8 3v4M16 3v4M4 9h16M8 13h3M14 13h2M8 17h2'),
  clientes: traco('M15 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9 11a4 4 0 100-8 4 4 0 000 8zM17 11a3 3 0 100-6M19 19v-1a4 4 0 00-3-3.87'),
  atendimento: traco('M5 19v-1a4 4 0 014-4h6a4 4 0 014 4v1M12 11a4 4 0 100-8 4 4 0 000 8z'),
  financeiro: traco('M3 8h18v10H3zM3 8l2-3h14l2 3M12 12v3'),
  crescimento: traco('M4 10v4h3l6 4V6l-6 4H4zM17 9a4 4 0 010 6'),
  gestao: traco('M4 5h16v14H4zM8 15l3-3 2 2 4-5M8 9h2'),
  configuracoes: traco('M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4'),
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
  const orientacoes = orientacoesVisiveis(modulos);
  const modulosPrincipais = modulos.filter((modulo) => modulo.categoria !== 'configuracao');
  const moduloConfiguracao = modulos.find((modulo) => modulo.categoria === 'configuracao');
  const destinosDaBusca: readonly DestinoDaBuscaGlobal[] = modulos.flatMap((modulo) =>
    modulo.telas.map((tela) => ({
      href: tela.href,
      nome: tela.nome,
      modulo: modulo.nome,
      nota: tela.nota,
    })),
  );

  const iniciais = nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((parte) => parte[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="casco">
      <SkipLink targetId="conteudo-principal" />
      <nav aria-label="Módulos" className="trilho">
        <a className="trilho__selo" href="/admin" title="Barber Dock">
          <img alt="Barber Dock" height={384} src="/barber-dock.png" width={384} />
        </a>

        <div aria-label="Áreas de trabalho" className="trilho__grupo trilho__grupo--principal" data-categoria="principal" role="group">
          {modulosPrincipais.map((modulo) => {
            const primeira = telasDoMenu(modulo)[0];
            if (!primeira) return null;

            return (
              <a
                className="trilho__botao"
                data-modulo={modulo.id}
                href={primeira.href}
                key={modulo.id}
                title={modulo.nome}
              >
                {ICONE[modulo.id]}
                <span className="trilho__legenda">{modulo.nome}</span>
              </a>
            );
          })}
        </div>

        {moduloConfiguracao && telasDoMenu(moduloConfiguracao)[0] ? (
          <div aria-label="Configurações" className="trilho__grupo trilho__grupo--configuracao" data-categoria="configuracao" role="group">
            <span aria-hidden="true" className="trilho__separador" />
            <a
              className="trilho__botao trilho__botao--configuracao"
              data-modulo={moduloConfiguracao.id}
              href={telasDoMenu(moduloConfiguracao)[0]!.href}
              title={moduloConfiguracao.nome}
            >
              {ICONE[moduloConfiguracao.id]}
              <span className="trilho__legenda">{moduloConfiguracao.nome}</span>
            </a>
          </div>
        ) : null}
      </nav>

      <aside className="contexto">
        <div className="contexto__casa-bloco">
          <p className="contexto__casa">{barbearia}</p>
          {unidade ? <p className="contexto__unidade">{unidade}</p> : null}
        </div>

        <div className="contexto__acoes">
          <BuscaGlobal destinos={destinosDaBusca} />
          {utilitariosVisiveis(modulos).map((tela) => (
            <a
              className="contexto__atalho"
              data-para={tela.secao}
              href={tela.href}
              key={tela.href}
            >
              {tela.nome}
            </a>
          ))}
          <p className="contexto__quem" title={`${nome} · ${papel}`}>
            <span className="contexto__iniciais" aria-hidden="true">
              {iniciais}
            </span>
            <span className="contexto__identidade">
              {nome}
              <small>{papel}</small>
            </span>
          </p>
        </div>

        {/*
          V3: a localização vem do mesmo registro que decide o menu. Todos os
          candidatos estão no DOM e `data-secao` da tela revela exatamente um,
          sem `usePathname` e sem uma segunda lista escrita à mão.
        */}
        <div className="contexto__orientacoes">
          {orientacoes.map((tela) => {
            const repeteModulo = tela.nome === tela.moduloNome;
            return (
              <div className="contexto__orientacao" data-para={tela.secao} key={`${tela.modulo}:${tela.secao}`}>
                <nav aria-label="Localização" className="migalha">
                  {repeteModulo ? (
                    <span aria-current="page">{tela.nome}</span>
                  ) : (
                    <>
                      <a href={tela.moduloHref}>{tela.moduloNome}</a>
                      <span aria-hidden="true" className="migalha__separador">›</span>
                      <span aria-current="page">{tela.nome}</span>
                    </>
                  )}
                </nav>
                <p className="contexto__nota">{tela.nota}</p>
              </div>
            );
          })}
        </div>

        {/*
          O segundo eixo agora é sempre horizontal. O trilho escolhe a área; a
          faixa escolhe a tela dentro dela. Módulo de destino único não inventa
          uma aba redundante — a migalha já oferece a porta de volta às telas
          internas, como a ficha do cliente.
        */}
        <div className="contexto__lista">
          {modulos.map((modulo) => {
            const telas = telasDoMenu(modulo);
            if (telas.length <= 1) return null;

            return (
              <div className="contexto__bloco" data-modulo={modulo.id} key={modulo.id}>
                <div className="contexto__faixa" aria-label={`${modulo.nome}: páginas`}>
                  {telas.map((tela, i) => (
                    <Fragment key={tela.href}>
                      {tela.grupo && tela.grupo !== telas[i - 1]?.grupo ? (
                        <span className="contexto__secao">{tela.grupo}</span>
                      ) : null}
                      <a className="contexto__link" data-para={tela.secao} href={tela.href}>
                        <span className="contexto__link-nome">{tela.nome}</span>
                        <span className="contexto__link-nota">{tela.nota}</span>
                      </a>
                    </Fragment>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="trabalho" id="conteudo-principal" tabIndex={-1}>{children}</div>
    </div>
  );
}
