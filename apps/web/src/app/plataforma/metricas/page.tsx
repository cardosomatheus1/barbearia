import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  metricasDaPlataforma,
  saudeDasBarbearias,
  type ResumoDaPlataforma,
  type SaudeDaBarbearia,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';

/**
 * Como vai a plataforma.
 *
 * Duas leituras, e a ordem entre elas é a decisão de desenho desta tela.
 *
 * Em cima, o que o negócio vale: MRR, contas ativas, churn do período. Embaixo,
 * **a lista ordenada de quem tem menos movimento** — que é o oposto do que um
 * painel de SaaS costuma mostrar primeiro.
 *
 * O motivo é o comportamento real de quem cancela: ninguém avisa. A barbearia
 * simplesmente para de marcar, e trinta dias depois o cartão é recusado. Uma
 * lista ordenada por faturamento colocaria essa barbearia no rodapé, onde
 * ninguém rola — e o número que a plataforma mais precisa ver ficaria escondido
 * atrás dos clientes que já estão bem.
 */

export const metadata: Metadata = {
  title: 'Métricas',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const JANELAS = [7, 30, 90] as const;

const reais = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const dia = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

function Numero({
  rotulo,
  valor,
  nota,
  tom,
}: {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota?: string;
  readonly tom?: 'alerta';
}) {
  return (
    <div className={`indicador ${tom === 'alerta' ? 'indicador--alerta' : ''}`}>
      <p className="indicador__rotulo">{rotulo}</p>
      <p className="indicador__valor">{valor}</p>
      {nota ? <p className="indicador__nota">{nota}</p> : null}
    </div>
  );
}

/**
 * Quantos dias uma barbearia está sem marcar nada.
 *
 * Calculado contra o último dia apurado, e não contra hoje: o painel inteiro
 * fala de uma janela que termina ontem, e misturar as duas réguas faria toda
 * barbearia parecer um dia mais parada do que está.
 */
function paradaHa(ultimoDia: string | null, ate: string): number | null {
  if (!ultimoDia) return null;
  const fim = new Date(`${ate}T00:00:00Z`).getTime();
  const ultimo = new Date(`${ultimoDia}T00:00:00Z`).getTime();
  return Math.round((fim - ultimo) / 86_400_000);
}

function Linha({ b, ate }: { readonly b: SaudeDaBarbearia; readonly ate: string }) {
  const parada = paradaHa(b.ultimoDia, ate);
  const semSinal = b.agendamentos === 0;

  return (
    <tr className={semSinal ? 'saude__linha saude__linha--sem-sinal' : 'saude__linha'}>
      <th className="saude__nome" scope="row">
        {b.nome}
        {b.bloqueada ? <span className="conta__selo">bloqueada</span> : null}
      </th>
      <td>{b.planoCode ?? '—'}</td>
      <td className="saude__num">{b.agendamentos}</td>
      <td className="saude__num">{b.adocaoOnlineEmPontos}%</td>
      <td className="saude__num">{b.ocupacaoEmPontos}%</td>
      <td className="saude__num">{b.faltasEmPontos}%</td>
      <td className="saude__num">{reais(b.receitaCents)}</td>
      <td className="saude__quando">
        {b.ultimoDia === null ? (
          // Nunca apurou movimento é diferente de ter parado: é a barbearia que
          // criou a conta e não chegou a usar. As duas pedem ligações
          // diferentes, então a tela não pode dizer a mesma coisa.
          <span className="saude__nunca">nunca marcou</span>
        ) : parada !== null && parada > 0 ? (
          <span className="saude__parada">há {parada} dia{parada === 1 ? '' : 's'}</span>
        ) : (
          dia(b.ultimoDia)
        )}
      </td>
    </tr>
  );
}

function Cabecalho({ resumo, ate }: { readonly resumo: ResumoDaPlataforma; readonly ate: string }) {
  return (
    <div className="indicadores">
      <Numero
        rotulo="Receita recorrente"
        valor={reais(resumo.mrrCents)}
        nota={`${resumo.barbeariasAtivas} conta${resumo.barbeariasAtivas === 1 ? '' : 's'} ativa${
          resumo.barbeariasAtivas === 1 ? '' : 's'
        }${resumo.semPlano > 0 ? ` · ${resumo.semPlano} sem plano` : ''}`}
      />
      <Numero
        rotulo={`Churn em ${resumo.dias} dias`}
        valor={`${resumo.churnEmPontos}%`}
        nota={`${resumo.saidasNoPeriodo} saíram · ${resumo.entradasNoPeriodo} entraram`}
        {...(resumo.saidasNoPeriodo > resumo.entradasNoPeriodo ? { tom: 'alerta' as const } : {})}
      />
      <Numero
        rotulo="Agendamentos"
        valor={resumo.agendamentos.toLocaleString('pt-BR')}
        // Sobre o total de contas, não sobre as ativas: conta bloqueada tem
        // histórico dentro da janela, e o denominador menor produzia "3 de 2".
        nota={`${resumo.barbeariasComMovimento} de ${
          resumo.barbeariasAtivas + resumo.barbeariasBloqueadas
        } com movimento`}
      />
      <Numero
        rotulo="Marcado pelo cliente"
        valor={`${resumo.adocaoOnlineEmPontos}%`}
        nota="o resto foi a recepção que digitou"
      />
      <Numero rotulo="Ocupação" valor={`${resumo.ocupacaoEmPontos}%`} nota="da jornada cadastrada" />
      <Numero
        rotulo="Faltas"
        valor={`${resumo.faltasEmPontos}%`}
        nota={`movimento até ${dia(ate)}`}
        {...(resumo.faltasEmPontos >= 15 ? { tom: 'alerta' as const } : {})}
      />
    </div>
  );
}

export default async function MetricasPage({ searchParams }: Props) {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const query = await searchParams;
  const pedido = Number(Array.isArray(query['dias']) ? query['dias'][0] : query['dias']);
  const dias = JANELAS.includes(pedido as (typeof JANELAS)[number]) ? pedido : 30;

  const [metricas, saude] = await Promise.all([
    metricasDaPlataforma(token, dias),
    saudeDasBarbearias(token, dias),
  ]);

  if (!metricas.ok) {
    if (metricas.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Métricas</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as métricas. Recarregue a página.
        </div>
      </main>
    );
  }

  const { ate, resumo } = metricas.dados;
  const barbearias = saude.ok ? saude.dados.barbearias : [];
  const apurouAlgo = resumo.agendamentos > 0 || resumo.receitaCents > 0;

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Métricas</h1>
      <p className="painel__sub">
        Movimento apurado até {dia(ate)} — o último dia fechado em todos os fusos.
      </p>

      <nav aria-label="Janela" className="janelas">
        {JANELAS.map((n) => (
          <a
            aria-current={n === dias ? 'page' : undefined}
            className={`janelas__opcao ${n === dias ? 'janelas__opcao--atual' : ''}`}
            href={`/plataforma/metricas?dias=${n}`}
            key={n}
          >
            {n} dias
          </a>
        ))}
      </nav>

      <Cabecalho ate={ate} resumo={resumo} />

      <h2 className="painel__secao">Por barbearia</h2>
      <p className="painel__sub">
        Quem tem menos movimento vem primeiro. Ninguém avisa que vai cancelar — só para de marcar.
      </p>

      {!apurouAlgo ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum dia apurado ainda</p>
          <p className="vazio__saida">
            A apuração roda uma vez por dia, às 9h UTC, depois que o dia anterior fechou em todos os
            fusos. Se isto continuar vazio amanhã, o worker está parado.
          </p>
        </div>
      ) : (
        <div className="ui-scroll-x saude-rolagem">
          <table className="saude">
            <caption className="saude__legenda">
              Movimento de cada barbearia nos últimos {dias} dias.
            </caption>
            <thead>
              <tr>
                <th scope="col">Barbearia</th>
                <th scope="col">Plano</th>
                <th scope="col">Agend.</th>
                <th scope="col">Online</th>
                <th scope="col">Ocup.</th>
                <th scope="col">Faltas</th>
                <th scope="col">Receita</th>
                <th scope="col">Último</th>
              </tr>
            </thead>
            <tbody>
              {barbearias.map((b) => (
                <Linha ate={ate} b={b} key={b.tenantId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
