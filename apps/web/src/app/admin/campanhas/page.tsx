import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  JANELA_MAXIMA_DIAS,
  NOME_DO_DIA,
  ROTULO_DA_FAIXA,
  TIPOS_DE_NOTIFICACAO,
  nomeDaCelula,
} from '@barbearia/core';
import {
  campanhasNaApi,
  type CampanhaNaTelaDoAdmin,
  type CelulaNaTelaDoAdmin,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoCriarCampanha, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * Campanhas, com o heatmap em cima (bloco 57, SPEC §4.13 e §5.9).
 *
 * > *"Célula fria é clicável e vira campanha direcionada — o heatmap não é
 * > relatório, é ponto de partida de ação."*
 *
 * É por isso que as duas coisas moram na mesma tela e nesta ordem. A grade
 * responde "onde está o buraco"; a campanha é o que se faz com a resposta. Um
 * relatório numa tela e um formulário em outra deixariam a pessoa com o número
 * na cabeça e sem o que fazer com ele.
 *
 * ## A célula fria vira formulário preenchido
 *
 * Sem componente de cliente: cada célula fria é um **link** que traz dia e hora
 * na consulta, e o formulário abaixo nasce com eles. É o mesmo mecanismo do
 * resto do painel, que não manda JavaScript para o navegador.
 *
 * ## A última coluna
 *
 * *"A última coluna é a única que importa."* A receita atribuída fecha cada
 * linha da lista, e é o único número que responde se a campanha valeu o que
 * custou — as outras cinco explicam por que ela deu no que deu.
 */

export const metadata: Metadata = {
  title: 'Campanhas',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

const NOME_DO_AVISO: Record<string, string> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
};

const NOME_DO_FILTRO: Record<string, string> = {
  inativos: 'Quem sumiu',
  aniversariantes: 'Aniversariantes do mês',
  todos: 'Toda a base',
  celula_fria: 'Quem costuma vir naquele horário',
};

function Heatmap({ grade }: { readonly grade: readonly CelulaNaTelaDoAdmin[] }) {
  const horas = [...new Set(grade.map((c) => c.hora))].sort((a, b) => a - b);
  const porChave = new Map(grade.map((c) => [`${c.diaDaSemana}:${c.hora}`, c]));

  return (
    /* A grade rola dentro do próprio recipiente. Sete colunas em 360px é
       exatamente o conteúdo que leva a página junto se não houver isto. */
    <div className="ui-scroll-x">
      <div className="heatmap">
        <span className="heatmap__canto" />
        {NOME_DO_DIA.map((dia) => (
          <span className="heatmap__dia" key={dia}>
            {dia.slice(0, 3)}
          </span>
        ))}

        {horas.map((hora) => (
          <>
            <span className="heatmap__hora" key={`h${hora}`}>
              {String(hora).padStart(2, '0')}h
            </span>
            {NOME_DO_DIA.map((_, dia) => {
              const celula = porChave.get(`${dia}:${hora}`);
              const faixa = celula?.faixa ?? 'fechado';
              const texto =
                celula?.ocupacaoBps === null || celula === undefined
                  ? '—'
                  : `${Math.round(celula.ocupacaoBps / 100)}%`;
              const rotulo = `${nomeDaCelula({ diaDaSemana: dia, hora })}: ${ROTULO_DA_FAIXA[faixa]}`;

              /* A célula fria é um link que preenche o formulário abaixo. As
                 outras não são clicáveis: não há campanha a fazer sobre uma
                 hora cheia, e uma hora fechada não tem o que encher. */
              return faixa === 'fria' ? (
                <a
                  className={`heatmap__celula heatmap__celula--${faixa}`}
                  href={`/admin/campanhas?dia=${dia}&hora=${hora}`}
                  key={`${dia}:${hora}`}
                  title={rotulo}
                >
                  {texto}
                </a>
              ) : (
                <span
                  className={`heatmap__celula heatmap__celula--${faixa}`}
                  key={`${dia}:${hora}`}
                  title={rotulo}
                >
                  {texto}
                </span>
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}

function Campanha({ campanha }: { readonly campanha: CampanhaNaTelaDoAdmin }) {
  return (
    <li>
      <article className="item-cadastro">
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{campanha.nome}</h3>
            <p className="item-cadastro__linha">
              {NOME_DO_FILTRO[campanha.filtro] ?? campanha.filtro}
              {campanha.diaDaSemana !== null && campanha.valorDoFiltro !== null
                ? ` · ${nomeDaCelula({ diaDaSemana: campanha.diaDaSemana, hora: campanha.valorDoFiltro })}`
                : ''}{' '}
              · {campanha.publico} pessoa{campanha.publico === 1 ? '' : 's'}
            </p>
            {/* As seis colunas da SPEC §4.13, na ordem em que ela as escreve. */}
            <p className="item-cadastro__linha">
              {campanha.enviados} enviados · {campanha.entregues} entregues · {campanha.lidos}{' '}
              lidos · {campanha.cliques} cliques · {campanha.agendamentos} voltaram
            </p>
            <p className="item-cadastro__linha">
              <strong>{reais(campanha.receitaCents)}</strong> de receita atribuída
            </p>
          </div>
        </div>
      </article>
    </li>
  );
}

export default async function CampanhasPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const podeMexer = podeNaTela(estado, 'marketing.send');

  const resposta = podeMexer ? await campanhasNaApi(token) : null;
  const campanhas = resposta?.ok ? resposta.dados.campanhas : [];
  const grade = resposta?.ok ? resposta.dados.grade : [];

  const diaEscolhido = first(query['dia']);
  const horaEscolhida = first(query['hora']);
  const erro = first(query['erro']);
  const criada = first(query['feito']) === 'criada';
  const publico = first(query['publico']);

  return (
    <main className="ui-container painel__conteudo" {...secao('campanhas')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Campanhas</h1>
      <p className="painel__sub">
        Onde a agenda está vazia, e quem chamar para encher. A última coluna de cada campanha é a
        que diz se ela valeu o que custou.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--erro painel__aviso" role="alert">
          Não deu para criar a campanha. Confira o nome e o público.
        </div>
      ) : null}
      {criada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Campanha criada com {publico ?? 0} pessoa{publico === '1' ? '' : 's'} no público.
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Ocupação das últimas oito semanas</h2>
        <p className="cartao-balcao__texto">
          Toque numa hora vazia para montar uma campanha com quem costuma vir naquele horário.
        </p>
        {grade.length === 0 ? (
          <p className="cartao-balcao__texto">
            Ainda não há movimento suficiente para desenhar a grade. Ela aparece depois das
            primeiras semanas de agenda.
          </p>
        ) : (
          <Heatmap grade={grade} />
        )}
      </section>

      {podeMexer ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Nova campanha</h2>
          <form action={acaoCriarCampanha} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                defaultValue={
                  diaEscolhido && horaEscolhida
                    ? `Encher ${nomeDaCelula({
                        diaDaSemana: Number(diaEscolhido),
                        hora: Number(horaEscolhida),
                      })}`
                    : ''
                }
                id="nome"
                maxLength={80}
                name="nome"
                required
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="filtro">
                Quem recebe
              </label>
              <select
                className="ui-field__input"
                defaultValue={diaEscolhido ? 'celula_fria' : 'inativos'}
                id="filtro"
                name="filtro"
              >
                {Object.entries(NOME_DO_FILTRO).map(([valor, rotulo]) => (
                  <option key={valor} value={valor}>
                    {rotulo}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="valorDoFiltro">
                O número do filtro
              </label>
              <input
                className="ui-field__input"
                defaultValue={horaEscolhida ?? ''}
                id="valorDoFiltro"
                inputMode="numeric"
                name="valorDoFiltro"
              />
              <p className="ui-field__hint">
                Para quem sumiu, é o número de dias. Para uma hora vazia, é a hora — e o dia vai
                no campo abaixo.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="diaDaSemana">
                O dia da semana
              </label>
              <select
                className="ui-field__input"
                defaultValue={diaEscolhido ?? ''}
                id="diaDaSemana"
                name="diaDaSemana"
              >
                <option value="">Não se aplica</option>
                {NOME_DO_DIA.map((nome, i) => (
                  <option key={nome} value={String(i)}>
                    {nome}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipo">
                Qual mensagem
              </label>
              <select className="ui-field__input" defaultValue="retorno" id="tipo" name="tipo">
                {TIPOS_DE_NOTIFICACAO.map((t) => (
                  <option key={t} value={t}>
                    {NOME_DO_AVISO[t] ?? t}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="janelaDias">
                Contar a receita por quantos dias
              </label>
              <input
                className="ui-field__input"
                defaultValue="7"
                id="janelaDias"
                inputMode="numeric"
                max={JANELA_MAXIMA_DIAS}
                min={1}
                name="janelaDias"
              />
              <p className="ui-field__hint">
                Janela larga demais dá crédito a esta campanha por uma venda que aconteceria de
                qualquer jeito.
              </p>
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Criar campanha
            </button>
          </form>
        </section>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">O que já saiu</h2>
        {campanhas.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhuma campanha ainda. Comece por uma hora vazia da grade acima — é o público que
            mais provavelmente volta.
          </p>
        ) : (
          <ul className="lista-cadastro">
            {campanhas.map((c) => (
              <Campanha campanha={c} key={c.id} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
