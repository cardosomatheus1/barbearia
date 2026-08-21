import { componentesDo } from '@barbearia/core';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { dreNaApi, type LinhaDoDre, type VariacaoDaLinha } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * O resultado do mês (bloco 52, SPEC §3.10).
 *
 * A tela responde uma pergunta só — *"sobrou quanto, e por causa de quê?"* — e
 * por isso ela abre no resultado, não na receita. Faturamento sozinho é o
 * número que faz a barbearia achar que vai bem no mês em que a distribuidora
 * cobrou dobrado.
 *
 * ## O comparativo é a tela, não um extra
 *
 * Cada linha traz o período anterior ao lado, e o **sentido** vem do domínio: em
 * "Comissões" uma alta é piora, em "Serviços" é melhora. Uma seta verde para
 * cima em custo seria a tela dizendo o contrário do número.
 */

export const metadata: Metadata = {
  title: 'Resultado',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não vê o resultado da barbearia — só quem tem acesso à margem vê.',
  invalid_request: 'Confira o período e tente de novo.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};


/** "36,1%" — pontos-base viram porcentagem só na hora de mostrar. */
const porcento = (bps: number | null): string =>
  bps === null ? '—' : `${(bps / 100).toFixed(1).replace('.', ',')}%`;

const dataCurta = (iso: string): string => {
  const [ano, mes, dia] = iso.split('-');
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : iso;
};

function Variacao({ linha }: { readonly linha: VariacaoDaLinha }) {
  if (linha.sentido === 'igual') {
    return <span className="dre__variacao dre__variacao--igual">igual</span>;
  }
  const seta = linha.deltaCents > 0 ? '↑' : '↓';
  return (
    <span className={`dre__variacao dre__variacao--${linha.sentido}`}>
      {seta} {linha.variacaoBps === null ? reais(linha.deltaCents) : porcento(linha.variacaoBps)}
    </span>
  );
}

function Linha({
  linha,
  ressalva,
}: {
  readonly linha: LinhaDoDre;
  /**
   * O que o número **não** conta, dito ao lado dele.
   *
   * Hoje só a despesa tem uma: o DRE é de caixa e soma a conta paga, então um
   * mês em que nada foi pago mostra despesa zero — com a seta verde de queda de
   * 100%, que é a tela afirmando uma melhora sobre o dono não ter pago o
   * aluguel. Ela também apaga a seta: uma variação que a ressalva explica não é
   * desempenho.
   */
  readonly ressalva?: string | undefined;
}) {
  return (
    <li className={`dre__linha dre__linha--${linha.natureza}`}>
      <span className="dre__rotulo">{linha.rotulo}</span>
      <span className="dre__valor tabular">
        {linha.natureza === 'custo' ? '−' : ''}
        {reais(linha.atualCents)}
      </span>
      <span className="dre__antes tabular">
        <span className="dre__antes-rotulo">antes </span>
        {reais(linha.anteriorCents)}
      </span>
      {ressalva ? <span className="dre__ressalva">{ressalva}</span> : <Variacao linha={linha} />}
    </li>
  );
}

export default async function DrePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  /**
   * O período **não** é decidido aqui.
   *
   * Sem `de` e `ate` a API devolve o mês corrente da unidade, e é ela quem sabe
   * qual é: o dia de hoje vem do fuso da barbearia, nunca do aparelho nem do
   * processo que renderiza. Calcular o mês nesta tela reintroduziria o defeito
   * D2 pela porta dos fundos.
   */
  const de = first(query['de']);
  const ate = first(query['ate']);

  const dre = await dreNaApi(token, de, ate);
  const erro = first(query['erro']);

  const topo = (
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
  );

  if (!dre.ok) {
    if (dre.code === 'mfa_required' || dre.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=dre');
    }
    return (
      <main className="ui-container painel__conteudo" {...secao('dre')}>
        {topo}
        <h1 className="painel__titulo">Resultado</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[dre.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const { atual, linhas, receitaBruta, resultado } = dre.dados;
  const receitas = linhas.filter((l) => l.natureza === 'receita');
  const custos = linhas.filter((l) => l.natureza === 'custo');
  // A conta que venceu no período e não foi paga. Não entra em soma nenhuma —
  // o DRE é de caixa —, mas é o que explica uma despesa que "caiu".
  const emAbertoCents = atual.despesasEmAbertoCents;
  const semMovimento = atual.receitaBrutaCents === 0 && atual.custoTotalCents === 0;

  return (
    <main className="ui-container painel__conteudo" {...secao('dre')}>
      {topo}

      <h1 className="painel__titulo">Resultado</h1>
      <p className="painel__sub">
        De {dataCurta(dre.dados.de)} a {dataCurta(dre.dados.ate)}, comparado com{' '}
        {dataCurta(dre.dados.comparadoDe)} a {dataCurta(dre.dados.comparadoAte)}.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      <form className="dre__periodo" method="get">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="de">
            De
          </label>
          <input
            className="ui-field__input"
            defaultValue={dre.ok ? dre.dados.de : de}
            id="de"
            name="de"
            type="date"
          />
        </div>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="ate">
            Até
          </label>
          <input
            className="ui-field__input"
            defaultValue={dre.ok ? dre.dados.ate : ate}
            id="ate"
            name="ate"
            type="date"
          />
        </div>
        <button className="ui-button ui-button--secondary" type="submit">
          Ver período
        </button>
      </form>

      {semMovimento ? (
        <section className="ui-card vazio">
          <h2 className="vazio__titulo">Nenhum movimento neste período</h2>
          <p>
            O resultado aparece quando houver comanda fechada, conta paga ou mensalidade recebida.
            Se você esperava números aqui, confira o período acima.
          </p>
        </section>
      ) : (
        <>
          <section className="resumo-contas">
            <div className="resumo-contas__numeros">
              <article className="gaveta">
                <p className="gaveta__rotulo">Entrou</p>
                <p className="gaveta__valor tabular">{reais(atual.receitaBrutaCents)}</p>
                <p className="gaveta__quem">
                  <Variacao linha={receitaBruta} /> sobre o período anterior
                </p>
              </article>

              <article className="gaveta">
                <p className="gaveta__rotulo">Saiu</p>
                <p className="gaveta__valor tabular">{reais(atual.custoTotalCents)}</p>
                {/* Derivada de LINHAS_DO_DRE: escrita à mão, a legenda omitia
                    "desconto" — um dos seis componentes do número acima. */}
                <p className="gaveta__quem">{componentesDo('custo')}</p>
              </article>

              <article className={`gaveta${atual.resultadoCents < 0 ? ' gaveta--risco' : ''}`}>
                <p className="gaveta__rotulo">Sobrou</p>
                <p className="gaveta__valor tabular">{reais(atual.resultadoCents)}</p>
                <p className="gaveta__quem">
                  margem de {porcento(atual.margemBps)} · <Variacao linha={resultado} />
                </p>
              </article>
            </div>
          </section>

          <section className="painel__grupo">
            <h2 className="rotulo">O que entrou</h2>
            {/* Sem linha de cabeçalho: cada célula se apresenta.
                A versão com cabeçalho precisava sumir no celular, onde quatro
                colunas quebram em 2×2 e deixam de casar com o que está embaixo —
                e esconder no celular é decidir que aquilo não importava. Com o
                rótulo dentro da célula a tabela lê igual nas quatro larguras. */}
            <ul className="dre">
              {receitas.map((linha) => (
                <Linha key={linha.campo} linha={linha} />
              ))}
            </ul>
          </section>

          <section className="painel__grupo">
            <h2 className="rotulo">O que saiu</h2>
            <ul className="dre">
              {custos.map((linha) => (
                <Linha
                  key={linha.campo}
                  linha={linha}
                  ressalva={
                    linha.campo === 'despesasCents' && emAbertoCents > 0
                      ? `${reais(emAbertoCents)} venceu e não foi pago`
                      : undefined
                  }
                />
              ))}
            </ul>
          </section>

          <p className="painel__nota">
            A venda de pacote não entra como receita no dia em que foi vendida: ela é reconhecida a
            cada unidade consumida. Venda estornada sai de todas as linhas. A despesa é a conta
            paga no período, pela data do pagamento — é quando o dinheiro saiu.
          </p>
        </>
      )}
    </main>
  );
}
