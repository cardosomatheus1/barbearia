import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DA_CAMPANHA,
  FILTROS_DE_CAMPANHA,
  JANELA_MAXIMA_DIAS,
  NOME_DO_DIA,
  NUMERO_DO_FILTRO,
  ROTULO_DA_CAMPANHA,
  ROTULO_DA_FAIXA,
  ROTULO_DO_FILTRO,
  TIPOS_DE_CAMPANHA,
  campanhaEnviavel,
  nomeDaCelula,
} from '@barbearia/core';
import {
  campanhasNaApi,
  segmentosNaApi,
  type CampanhaNaTelaDoAdmin,
  type CelulaNaTelaDoAdmin,
  type ClienteEmRiscoNaTela,
  type SegmentoNaTela,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoCriarCampanha, acaoEnviarCampanha, acaoSair } from '../acoes';
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

/**
 * O nome de cada público sai de `packages/core`, nunca escrito aqui.
 *
 * Ele estava escrito à mão nesta tela até o bloco 61, que acrescentou três
 * públicos — a tela teria continuado oferecendo quatro com a API aceitando sete,
 * e nada ficaria vermelho.
 */
const nomeDoFiltro = (filtro: string): string =>
  filtro in ROTULO_DO_FILTRO
    ? ROTULO_DO_FILTRO[filtro as keyof typeof ROTULO_DO_FILTRO]
    : filtro;

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

/**
 * A base repartida por segmento, com o público em risco nomeado (bloco 61).
 *
 * Mora nesta tela e não numa própria pelo motivo do heatmap: *"a célula fria é
 * clicável e vira campanha — não é relatório, é ponto de partida de ação"*. Uma
 * contagem numa tela e o formulário em outra deixariam a pessoa com o número na
 * cabeça e sem o que fazer com ele.
 *
 * Os nomes vêm junto porque "vinte e três em risco" sem eles obriga a abrir a
 * base e procurar um por um. A lista é curta de propósito: quem precisa falar
 * com todos usa a campanha, que é o botão ao lado.
 */
function Segmentos({
  segmentos,
  emRisco,
}: {
  readonly segmentos: readonly SegmentoNaTela[];
  readonly emRisco: readonly ClienteEmRiscoNaTela[];
}) {
  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Quem é a sua base hoje</h2>
      <p className="cartao-balcao__texto">
        Cada pessoa entra num grupo só, e o grupo é recalculado toda vez que esta tela abre — não
        existe rótulo velho.
      </p>

      <ul className="segmentos">
        {segmentos.map((s) => (
          <li className={`segmentos__item segmentos__item--${s.chave}`} key={s.chave}>
            <span className="segmentos__quantos">{s.quantos}</span>
            <span className="segmentos__rotulo">{s.rotulo}</span>
          </li>
        ))}
      </ul>

      <h3 className="cartao-balcao__subtitulo">Passaram do ritmo e ainda não voltaram</h3>
      {emRisco.length === 0 ? (
        <p className="cartao-balcao__texto">
          Ninguém está atrasado agora. Quando alguém passar do próprio ritmo, o nome aparece aqui.
        </p>
      ) : (
        <>
          <ul className="lista-cadastro">
            {emRisco.map((c) => (
              <li key={c.customerId}>
                <a className="item-cadastro item-cadastro--link" href={`/admin/cliente/${c.customerId}`}>
                  <span className="item-cadastro__nome">{c.nome}</span>
                  <span className="item-cadastro__linha">
                    Corta a cada {c.cicloDias} dias · faz {c.diasSemVir}{' '}
                    {c.diasSemVir === 1 ? 'dia' : 'dias'} que não vem
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <p className="cartao-balcao__texto">
            Para chamar todos de uma vez, escolha <strong>{ROTULO_DO_FILTRO['em_risco']}</strong> no
            formulário abaixo.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Uma campanha, com a saída do estado em que ela está.
 *
 * O botão "Enviar" nasceu aqui no bloco 82, e a falta dele era o defeito da §6
 * pergunta 3 na forma mais cara: `rascunho` era alcançável, era o estado em que
 * **toda** campanha nascia, e não tinha caminho para fora na tela. A pessoa
 * montava o público, via "3 pessoas", e não havia o que apertar.
 */
function Campanha({
  campanha,
  podeMexer,
}: {
  readonly campanha: CampanhaNaTelaDoAdmin;
  readonly podeMexer: boolean;
}) {
  const estado = campanha.estado;
  return (
    <li>
      <article className="item-cadastro">
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{campanha.nome}</h3>
            <p className="item-cadastro__linha">
              {/* O estado é dito em letras e a cor só reforça: quem tem baixa
                  visão precisa da palavra. Mesmo padrão da entrega do bloco 79. */}
              <span className={`campanha-estado campanha-estado--${estado}`}>
                {ROTULO_DA_CAMPANHA[estado]}
              </span>{' '}
              · {nomeDoFiltro(campanha.filtro)}
              {campanha.diaDaSemana !== null && campanha.valorDoFiltro !== null
                ? ` · ${nomeDaCelula({ diaDaSemana: campanha.diaDaSemana, hora: campanha.valorDoFiltro })}`
                : ''}{' '}
              · {campanha.publico} pessoa{campanha.publico === 1 ? '' : 's'}
            </p>
            <p className="item-cadastro__linha">{EXPLICACAO_DA_CAMPANHA[estado]}</p>
            {/* As seis colunas da SPEC §4.13, na ordem em que ela as escreve. */}
            <p className="item-cadastro__linha">
              {campanha.enviados} enviados · {campanha.entregues} entregues · {campanha.lidos}{' '}
              lidos · {campanha.cliques} cliques · {campanha.agendamentos} voltaram
            </p>
            <p className="item-cadastro__linha">
              <strong>{reais(campanha.receitaCents)}</strong> de receita atribuída
            </p>
          </div>

          {podeMexer && campanhaEnviavel(estado) ? (
            <form action={acaoEnviarCampanha}>
              <input name="id" type="hidden" value={campanha.id} />
              <button className="ui-button ui-button--primary" type="submit">
                Enviar para {campanha.publico}
              </button>
            </form>
          ) : null}
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

  const [resposta, base] = await Promise.all([
    podeMexer ? campanhasNaApi(token) : Promise.resolve(null),
    podeNaTela(estado, 'customers.view') ? segmentosNaApi(token) : Promise.resolve(null),
  ]);
  const campanhas = resposta?.ok ? resposta.dados.campanhas : [];
  const grade = resposta?.ok ? resposta.dados.grade : [];

  const diaEscolhido = first(query['dia']);
  const horaEscolhida = first(query['hora']);
  const erro = first(query['erro']);
  const feito = first(query['feito']);
  const criada = feito === 'criada';
  const enviando = feito === 'enviando';
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
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {erro === 'ja_enviada'
            ? 'Esta campanha não está mais em rascunho. Só um rascunho pode ser enviado.'
            : 'Não deu para criar a campanha. Confira o nome e o público.'}
        </div>
      ) : null}
      {criada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Campanha criada com {publico ?? 0} pessoa{publico === '1' ? '' : 's'} no público. Ela
          fica em rascunho até você apertar <strong>Enviar</strong>.
        </div>
      ) : null}
      {/* "Entrou na fila", e não "enviada": prometer o segundo faria a pessoa
          recarregar procurando um número que ainda vai demorar. */}
      {enviando ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          A campanha entrou na fila. As mensagens saem aos poucos, e nunca entre 21h e 8h — os
          números abaixo vão se preenchendo.
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

      {base?.ok ? <Segmentos emRisco={base.dados.emRisco} segmentos={base.dados.segmentos} /> : null}

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
                {FILTROS_DE_CAMPANHA.map((valor) => (
                  <option key={valor} value={valor}>
                    {ROTULO_DO_FILTRO[valor]}
                    {NUMERO_DO_FILTRO[valor] ? ` · pede ${NUMERO_DO_FILTRO[valor]}` : ''}
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">
                Os três últimos saem do ritmo de cada cliente, não de um número que você digita:
                quem corta a cada 45 dias não está atrasado no dia 30.
              </p>
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
                Só os públicos marcados com &quot;pede&quot; usam este campo. Os outros ignoram o
                que estiver aqui.
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
                {TIPOS_DE_CAMPANHA.map((t) => (
                  <option key={t} value={t}>
                    {NOME_DO_AVISO[t] ?? t}
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">
                Só textos de campanha aparecem aqui. Lembrete e confirmação são do agendamento —
                mandá-los como campanha prometeria um horário que a pessoa não tem.
              </p>
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
              <Campanha campanha={c} key={c.id} podeMexer={podeMexer} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
