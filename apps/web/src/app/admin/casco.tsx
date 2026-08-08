import type { ReactNode } from 'react';

/**
 * O casco: a moldura fixa do painel.
 *
 * Três colunas, como no mock interno do Barber Dock — trilho de módulos,
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

export type Modulo = 'operacao' | 'dinheiro' | 'casa';

interface Destino {
  readonly href: string;
  readonly nome: string;
  readonly secao: string;
  /** Uma frase do que a tela faz. É o que o mock põe embaixo de cada item. */
  readonly nota: string;
}

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

const MODULOS: readonly {
  readonly id: Modulo;
  readonly nome: string;
  readonly icone: ReactNode;
  readonly telas: readonly Destino[];
}[] = [
  {
    id: 'operacao',
    nome: 'Operação',
    icone: traco('M4 7h16M4 12h16M4 17h10'),
    telas: [
      { href: '/admin/dia', nome: 'O dia', secao: 'dia', nota: 'quem chegou e quem falta' },
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', nota: 'dia, semana e lista' },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'quem veio sem marcar' },
      { href: '/admin/avisos', nome: 'Avisos', secao: 'avisos', nota: 'lembretes e retorno' },
    ],
  },
  {
    id: 'dinheiro',
    nome: 'Dinheiro',
    icone: traco('M3 8h18v10H3zM3 8l2-3h14l2 3M12 12v3'),
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', nota: 'abertura e fechamento' },
      { href: '/admin/comanda', nome: 'Comanda', secao: 'comanda', nota: 'cobrar o atendimento' },
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', nota: 'quem ficou devendo' },
      { href: '/admin/comissao', nome: 'Comissão', secao: 'comissao', nota: 'período e fechamento' },
    ],
  },
  {
    id: 'casa',
    nome: 'A casa',
    icone: traco('M4 11l8-6 8 6v9H4zM10 20v-5h4v5'),
    telas: [
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', nota: 'os números do dia' },
      { href: '/admin/catalogo', nome: 'Cadastro', secao: 'cadastro', nota: 'serviços e equipe' },
      { href: '/admin/equipe', nome: 'Equipe', secao: 'equipe', nota: 'contas e permissões' },
      { href: '/admin/importar', nome: 'Trazer base', secao: 'importar', nota: 'migrar de outro sistema' },
      { href: '/admin/trilha', nome: 'Trilha', secao: 'trilha', nota: 'quem mexeu em quê' },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'segundo fator' },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'janela e políticas' },
    ],
  },
];

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
      <nav aria-label="Módulos" className="trilho">
        <a className="trilho__selo" href="/admin/dia" title="Barber Dock">
          <img alt="Barber Dock" height={384} src="/barber-dock.png" width={384} />
        </a>

        {MODULOS.map((modulo) => (
          <a
            className="trilho__botao"
            data-modulo={modulo.id}
            href={modulo.telas[0]?.href ?? '/admin/dia'}
            key={modulo.id}
            title={modulo.nome}
          >
            {modulo.icone}
            <span className="trilho__legenda">{modulo.nome}</span>
          </a>
        ))}
      </nav>

      <aside className="contexto">
        <div className="contexto__topo">
          <p className="contexto__casa">{barbearia}</p>
          <p className="contexto__sub">Painel de gestão</p>
        </div>

        {/* Todos os blocos são renderizados; o CSS revela o do módulo aberto.
            Não é "esconder no celular" — é condicional por seção, e vale igual
            em qualquer largura. */}
        <div className="contexto__lista">
          {MODULOS.map((modulo) => (
            <div className="contexto__bloco" data-modulo={modulo.id} key={modulo.id}>
              <p className="contexto__grupo">{modulo.nome}</p>
              {modulo.telas.map((tela) => (
                <a
                  className="contexto__link"
                  data-para={tela.secao}
                  href={tela.href}
                  key={tela.href}
                >
                  <span className="contexto__link-nome">{tela.nome}</span>
                  <span className="contexto__link-nota">{tela.nota}</span>
                </a>
              ))}
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

/** As seções de cada módulo — o CSS precisa delas para acender o par certo. */
export const SECOES_POR_MODULO: Readonly<Record<Modulo, readonly string[]>> = {
  operacao: MODULOS[0]!.telas.map((t) => t.secao),
  dinheiro: MODULOS[1]!.telas.map((t) => t.secao),
  casa: MODULOS[2]!.telas.map((t) => t.secao),
};
