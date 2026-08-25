import { redirect } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import {
  diagnosticoDoCatalogo,
  insightsDoPainel,
  painelDeDinheiro,
  painelOperacional,
  type Comparado,
  type InsightNaTela,
  type PainelDeDinheiro,
  type PeriodoPainel,
  type PeriodoPedido,
} from '@/lib/admin-api';
import type { DestinoDoInsight } from '@barbearia/core';
import { casaDoPapel, painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';
import { marcaDaRecusa } from '../falha-da-leitura';

export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const primeiro = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const DIA = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});
const MES = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const ROTULO_PERIODO: Readonly<Record<PeriodoPainel, string>> = {
  dia: 'Hoje',
  '7d': '7 dias',
  mes: 'Mês',
};

function periodoSeguro(valor: string | undefined): PeriodoPainel {
  return valor === 'dia' || valor === '7d' || valor === 'mes' ? valor : 'dia';
}

/**
 * A janela em dias que veio do link do assistente (bloco 128).
 *
 * O piso e o teto são os mesmos da borda da API — um dia e um ano. Fora disso,
 * ou sem `dias`, a tela cai no seletor de sempre: o link malformado não pode
 * deixar o painel em branco, e "trinta dias" pedido como `dias=abc` é entrada
 * inválida, não uma janela nova.
 */
function diasPedidos(valor: string | undefined): number | null {
  if (!valor) return null;
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
}

function comparacao(dado: Comparado, melhorQuandoCai = false): { texto: string; classe: string } {
  if (dado.variacao === null) return { texto: 'Sem base de comparação', classe: '' };
  if (dado.variacao === 0) return { texto: 'Igual ao período anterior', classe: '' };
  const subiu = dado.variacao > 0;
  const bom = melhorQuandoCai ? !subiu : subiu;
  return {
    texto: `${subiu ? '↗' : '↘'} ${Math.abs(dado.variacao)}% ${subiu ? 'acima' : 'abaixo'} do período anterior`,
    classe: bom ? ' numero__nota--bom' : ' numero__nota--ruim',
  };
}

function comparacaoOcupacao(dado: Comparado): { texto: string; classe: string } {
  const diferenca = dado.valor - dado.anterior;
  if (dado.anterior <= 0) return { texto: 'Sem base de comparação', classe: '' };
  if (diferenca === 0) return { texto: 'Igual ao período anterior', classe: '' };
  return {
    texto: `${diferenca > 0 ? '↗' : '↘'} ${Math.abs(diferenca)} p.p. vs. período anterior`,
    classe: diferenca > 0 ? ' numero__nota--bom' : ' numero__nota--ruim',
  };
}

function diasNoMes(dia: string): number {
  const [ano, mes] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano ?? 1970, mes ?? 1, 0)).getUTCDate();
}

function serieAcumulada(dinheiro: PainelDeDinheiro): readonly number[] {
  let soma = 0;
  return (dinheiro.serie ?? []).map((ponto) => {
    soma += ponto.faturamentoCents;
    return soma;
  });
}

function caminho(valores: readonly number[], teto: number, largura = 600, altura = 122): string {
  if (valores.length === 0) return '';
  const divisor = Math.max(1, teto);
  const ultimo = Math.max(1, valores.length - 1);
  return valores
    .map((valor, indice) => {
      const x = (indice / ultimo) * largura;
      const y = altura - Math.min(altura, (valor / divisor) * altura);
      return `${indice === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function GraficoFaturamento({ dinheiro, periodo }: { readonly dinheiro: PainelDeDinheiro; readonly periodo: PeriodoPainel }) {
  const acumulado = serieAcumulada(dinheiro);
  const meta = dinheiro.metaCents ?? 0;
  const projetado = dinheiro.projecaoCents ?? dinheiro.faturamentoCents.valor;
  const teto = Math.max(...acumulado, meta > 0 ? meta : 0, projetado, 1);
  const real = caminho(acumulado, teto);
  const ritmo = periodo === 'mes' && meta > 0 && acumulado.length > 0
    ? acumulado.map((_, indice) => Math.round((meta / diasNoMes(dinheiro.dia)) * (indice + 1)))
    : [];
  const metaPath = caminho(ritmo, teto);

  return (
    <div className="dashboard-grafico" aria-label="Faturamento acumulado no período">
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 600 122">
        {metaPath ? <path className="dashboard-grafico__meta" d={metaPath} /> : null}
        {real ? <path className="dashboard-grafico__real" d={real} /> : null}
      </svg>
    </div>
  );
}

/**
 * Onde cada insight leva.
 *
 * `Record` sobre a união dos destinos que `core` declara: destino novo lá faz o
 * compilador cobrar o caminho aqui, em vez de a tela desenhar um botão que não
 * vai a lugar nenhum — que é a primeira das seis perguntas da §6.
 *
 * O parâmetro é usado de verdade nos dois: a campanha abre já no público que o
 * cartão contou, e a jornada abre na pessoa de quem o cartão falou.
 */
const CAMINHO_DO_INSIGHT: Readonly<
  Record<DestinoDoInsight, (p: Record<string, string>) => string>
> = {
  campanha: (p) => `/admin/campanhas?filtro=${p['filtro'] ?? 'em_risco'}`,
  jornada_do_profissional: (p) => `/admin/profissionais?pessoa=${p['profissionalId'] ?? ''}`,
  estoque: () => '/admin/estoque',
};

function Oportunidade({ insight }: { readonly insight: InsightNaTela }) {
  const caminhoDe = CAMINHO_DO_INSIGHT[insight.acao.destino as DestinoDoInsight];
  return (
    <article className="painel-insight">
      <div className="painel-insight__corpo">
        <p className="painel-insight__titulo">{insight.titulo}</p>
        <p className="painel-insight__texto">{insight.texto}</p>
      </div>
      <div className="painel-insight__pe">
        {/* "Até", e nunca "vai render": o número é o teto do que está sendo
            deixado na mesa, não uma previsão. Anunciar teto como previsão é o
            produto prometendo faturamento que ele não controla. */}
        <p className="painel-insight__impacto tabular">
          até {reais(insight.impactoCents)}
          <span className="painel-insight__impacto-nota">deixados na mesa</span>
        </p>
        <a
          className="ui-button ui-button--secondary painel-insight__acao"
          href={caminhoDe ? caminhoDe(insight.acao.parametros) : '/admin/painel'}
        >
          {insight.acao.rotulo}
        </a>
      </div>
    </article>
  );
}

function Numero({ rotulo, valor, nota, classe = '' }: {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota: string;
  readonly classe?: string;
}) {
  return (
    <div className="numero">
      <dt className="numero__rotulo">{rotulo}</dt>
      <dd className="numero__valor tabular">{valor}</dd>
      <dd className={`numero__nota${classe}`}>{nota}</dd>
    </div>
  );
}

export default async function PainelPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeVerDinheiro = podeNaTela(estado, 'finance.view');
  const podeCadastro = podeNaTela(estado, 'settings.manage');
  const podeVerInsights =
    podeNaTela(estado, 'appointments.view_all_professionals') &&
    podeNaTela(estado, 'customers.view') &&
    podeNaTela(estado, 'customers.view_notes') &&
    podeNaTela(estado, 'finance.view') &&
    podeNaTela(estado, 'inventory.view');
  const query = await searchParams;
  const periodo = periodoSeguro(primeiro(query['periodo']));
  const dias = diasPedidos(primeiro(query['dias']));
  /**
   * O que vai à API: a janela em dias vence o nome do seletor.
   *
   * Quem manda `dias` é o link do assistente, que sabe exatamente quantos dias a
   * resposta cobriu — e é esse link que existe para o dono clicar, ver o mesmo
   * número e passar a confiar nos dois.
   */
  const pedido: PeriodoPedido = dias === null ? periodo : { dias };

  /**
   * Os insights entram somente quando a tela possui todas as permissões que a rota agrega (bloco 67).
   *
   * A rota cruza agenda da equipe, clientes/segmentos, dinheiro e estoque; pedi-la sem
   * qualquer uma dessas permissões devolveria 403 em toda abertura do painel da recepção, e o bloco
   * "O que fazer primeiro" apareceria vazio para quem nunca poderá vê-lo.
   */
  const [operacao, dinheiro, diagnostico, insights] = await Promise.all([
    painelOperacional(token, undefined, pedido),
    podeVerDinheiro ? painelDeDinheiro(token, undefined, pedido) : Promise.resolve(null),
    podeCadastro ? diagnosticoDoCatalogo(token) : Promise.resolve(null),
    podeVerInsights ? insightsDoPainel(token) : Promise.resolve(null),
  ]);

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/dia">← {estado.businessName}</a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
      </form>
    </header>
  );

  if (!operacao.ok) {
    /**
     * Recusa por permissão não é falha de rede (bloco 114).
     *
     * `GET /dashboard` exige `reports.operational`, que nem a recepção nem o
     * barbeiro têm — cinco das oito contas de equipe do piloto batem aqui. Elas
     * liam "não deu para carregar, tente de novo" e um botão **Recarregar** que
     * nunca ia funcionar: diagnóstico falso e saída inexistente, que é a §6
     * pergunta 3.
     *
     * A tela irmã já acerta: o DRE diz "sua conta não vê o resultado da
     * barbearia — só quem tem acesso à margem vê", e manda para onde a pessoa
     * pode ir.
     */
    const semPermissao = operacao.code === 'forbidden';
    return (
      <main className="ui-container painel__conteudo" {...secao('painel')}>
        {topo}
        <h1 className="painel__titulo">Painel</h1>
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(operacao.code)}>
          {semPermissao ? (
            <>
              Sua conta não vê os números do negócio — eles são de quem acompanha o resultado da
              barbearia.
              <a className="ui-button ui-button--secondary painel__saida" href={casaDoPapel(estado)}>
                Ir para a minha tela
              </a>
            </>
          ) : (
            <>
              Não deu para carregar os números. Tente de novo.
              <a className="ui-button ui-button--secondary painel__saida" href="/admin/painel">
                Recarregar
              </a>
            </>
          )}
        </div>
      </main>
    );
  }

  const dadosDinheiro = dinheiro?.ok ? dinheiro.dados : null;
  const ocupacaoComp = comparacaoOcupacao(operacao.dados.ocupacao);
  const faturamentoComp = dadosDinheiro ? comparacao(dadosDinheiro.faturamentoCents) : null;
  const ticketComp = dadosDinheiro ? comparacao(dadosDinheiro.ticketMedioCents) : null;
  const achados = diagnostico?.ok ? diagnostico.dados.achados : [];
  const urgentes = achados.filter((a) => a.severidade !== 'aviso');

  const oportunidades = insights?.ok ? insights.dados.insights : [];

  /**
   * O alerta de "ainda há capacidade" saiu daqui no bloco 67.
   *
   * Ele dizia a mesma coisa que o insight de hora ociosa e dizia pior: sobre
   * hoje — quando já não dá para encher —, sem público, sem valor e com um botão
   * que só abria a agenda. Dois cartões afirmando "sua agenda tem espaço", em
   * ordens diferentes, na mesma tela, é o defeito de coerência da §6: quem opera
   * não sabe qual dos dois responder primeiro.
   */
  const alertas: Array<{ selo: string; titulo: string; texto: string; href: string; acao: string; tom: 'aviso' | 'grave' | 'ok' }> = [];
  const referenciaDoPeriodo = dias !== null
    ? dias === 1 ? 'hoje' : `nos últimos ${dias} dias`
    : periodo === 'dia' ? 'hoje' : periodo === '7d' ? 'nos últimos 7 dias' : 'no mês, até hoje';
  /**
   * O número **do período**, sob um título que diz "de hoje" (bloco 114).
   *
   * A seção chama-se "Sinais de hoje" e o alerta trazia a falta do período
   * selecionado: com `periodo=mes`, a tela mostrava "Hoje → 33% Faltas" logo
   * acima de "Faltas estão em 7% no período". Duas porcentagens de falta
   * adjacentes, uma delas sob um cabeçalho que a contradiz.
   *
   * O alerta é do período — é ele que tem massa para dizer alguma coisa —, e o
   * texto passa a dizer qual período é, em vez de o cabeçalho decidir por ele.
   */
  if (operacao.dados.noShow.valor >= 7) {
    alertas.push({
      selo: 'Atenção',
      titulo: `Faltas ${referenciaDoPeriodo}: ${operacao.dados.noShow.valor}%`,
      texto: 'Revise confirmações e lembretes dos próximos horários para proteger a ocupação.',
      href: '/admin/avisos',
      acao: 'Ver lembretes',
      tom: 'aviso',
    });
  }
  if (urgentes.length > 0) {
    alertas.push({
      selo: 'Cadastro',
      titulo: `${urgentes.length} ${urgentes.length === 1 ? 'problema de cadastro pode' : 'problemas de cadastro podem'} afetar a agenda`,
      texto: 'Há serviços, combinações ou configurações que merecem correção.',
      href: '/admin/catalogo/diagnostico',
      acao: 'Abrir diagnóstico',
      tom: 'grave',
    });
  }
  const equipeOrdenada = [...(operacao.dados.equipe ?? [])].sort((a, b) => b.ocupacao - a.ocupacao);
  if (equipeOrdenada.length >= 2) {
    const mediaEquipe = equipeOrdenada.reduce((soma, pessoa) => soma + pessoa.ocupacao, 0) / equipeOrdenada.length;
    const menor = equipeOrdenada[equipeOrdenada.length - 1];
    if (menor && mediaEquipe - menor.ocupacao >= 15) {
      alertas.push({
        selo: 'Equipe',
        titulo: `${menor.professionalName} está ${Math.round(mediaEquipe - menor.ocupacao)} p.p. abaixo da ocupação média`,
        texto: 'Vale conferir a distribuição da agenda e a jornada antes de mexer em meta ou comissão.',
        href: `/admin/profissionais?pessoa=${encodeURIComponent(menor.professionalId)}`,
        acao: 'Ver profissional',
        tom: 'aviso',
      });
    }
  }
  if (alertas.length === 0) {
    alertas.push({
      selo: 'Tudo certo',
      titulo: 'Operação sem alerta crítico agora',
      /**
       * Sem citar ocupação — ela saiu daqui no bloco 67.
       *
       * O print mostrou este cartão dizendo "ocupação não apresenta desvio" logo
       * abaixo de um insight anunciando 121 horários vagos amanhã. Duas seções
       * afirmando o contrário sobre o mesmo fato é a §6 pergunta 6, e o texto
       * era a metade errada: quem fala de agenda vazia agora é o cartão de cima.
       */
      /* O período no texto, como no título do alerta ativo.
         O bloco 114 pôs o período no título de quem dispara e deixou o "tudo
         certo" mudo: com `periodo=mes`, a seção "Sinais de hoje" dizia
         "Operação sem alerta crítico agora" ao lado do bloco Hoje mostrando 33%
         de faltas. As duas estavam certas sobre janelas diferentes, e nenhuma
         dizia qual. */
      texto: `Faltas e cadastro ${referenciaDoPeriodo} não apresentam um desvio que peça ação imediata.`,
      href: '/admin/dia',
      acao: 'Ver o dia',
      tom: 'ok',
    });
  }

  const meta = dadosDinheiro?.metaCents ?? 0;
  const percentualMeta = dadosDinheiro?.percentualMeta ?? 0;
  const periodoTexto = dias !== null
    ? dias === 1 ? 'Hoje' : `Últimos ${dias} dias`
    : periodo === 'dia'
      ? DIA.format(new Date(`${operacao.dados.dia}T12:00:00Z`))
      : periodo === '7d'
        ? 'Últimos 7 dias'
        : `${MES.format(new Date(`${operacao.dados.dia}T12:00:00Z`))} · até hoje`;

  const ocupacao = operacao.dados.ocupacao.valor;
  const folga = Math.max(0, 100 - ocupacao);
  const tituloPeriodo = dias !== null
    ? dias === 1 ? 'Como estamos hoje' : `Como estamos nos últimos ${dias} dias`
    : periodo === 'dia'
      ? 'Como estamos hoje'
      : periodo === '7d'
        ? 'Como estamos nos últimos 7 dias'
        : 'Como estamos no mês';

  return (
    <main className="ui-container painel__conteudo painel-negocio painel-v6" {...secao('painel')}>
      {topo}

      <div className="painel-v6__cabeca">
        <div>
          <h1 className="painel__titulo">Painel</h1>
          <p className="painel__sub">{periodoTexto}. Resultado, capacidade, equipe e o que merece decisão.</p>
        </div>
        <nav aria-label="Período do painel" className="balcao__regua painel-periodos">
          {(Object.keys(ROTULO_PERIODO) as PeriodoPainel[]).map((item) => (
            <a
              aria-current={dias === null && periodo === item ? 'page' : undefined}
              className={dias === null && periodo === item ? 'filtro filtro--ativo' : 'filtro'}
              href={`/admin/painel?periodo=${item}`}
              key={item}
            >
              {ROTULO_PERIODO[item]}
            </a>
          ))}
          {dias !== null ? (
            <a aria-current="page" className="filtro filtro--ativo" href={`/admin/painel?dias=${dias}`}>
              {dias === 1 ? 'Hoje' : `Últimos ${dias} dias`}
            </a>
          ) : null}
        </nav>
      </div>

      <section className="painel-v6__resultado" data-nivel="primario" aria-labelledby="painel-como-estamos">
        <p className="painel-v6__rotulo" id="painel-como-estamos">{tituloPeriodo}</p>
        {dadosDinheiro ? (
          <div className="painel-v6__numero-principal">
            <strong className="tabular">{reais(dadosDinheiro.faturamentoCents.valor)}</strong>
            <span>faturados</span>
            {faturamentoComp ? <small className={faturamentoComp.classe}>{faturamentoComp.texto}</small> : null}
          </div>
        ) : (
          <div className="painel-v6__numero-principal painel-v6__numero-principal--protegido">
            <strong>Protegido</strong>
            <span>faturamento exige segundo fator</span>
            <a href="/admin/seguranca?de=painel">Confirmar agora →</a>
          </div>
        )}
        <div className="painel-v6__secundarios">
          <span><strong className="tabular">{operacao.dados.atendidos.valor}</strong> atendimentos</span>
          <span><strong className="tabular">{operacao.dados.noShow.valor}%</strong> faltas</span>
          {dadosDinheiro ? <span><strong className="tabular">{reais(dadosDinheiro.ticketMedioCents.valor)}</strong> ticket médio</span> : null}
        </div>
      </section>

      <section className="painel-v6__secao" data-nivel="contexto" aria-labelledby="painel-agenda">
        <div className="painel-v6__secao-cabeca">
          <div>
            <p className="painel-v6__rotulo">Agenda</p>
            <h2 id="painel-agenda">{ocupacao}% ocupada</h2>
          </div>
          <a href="/admin/agenda">Abrir agenda →</a>
        </div>
        <div className="painel-v6__ocupacao" aria-label={`${ocupacao}% da agenda ocupada`}>
          <span style={{ '--parte': `${Math.min(100, ocupacao)}%` } as CSSProperties} />
        </div>
        <p className="painel-v6__agenda-nota">
          <strong className="tabular">{operacao.dados.agendamentos.valor}</strong> agendamentos no período ·{' '}
          <strong className="tabular">{folga}%</strong> da jornada ainda está livre.
        </p>
      </section>

      {equipeOrdenada.length > 0 ? (
        <section className="painel-v6__secao" data-nivel="contexto" aria-labelledby="painel-equipe">
          <div className="painel-v6__secao-cabeca">
            <div>
              <p className="painel-v6__rotulo">Equipe</p>
              <h2 id="painel-equipe">Ocupação por profissional</h2>
            </div>
            <a href="/admin/profissionais">Ver equipe →</a>
          </div>
          <div className="painel-v6__equipe">
            {equipeOrdenada.map((pessoa) => (
              <a className="painel-v6__pessoa" href={`/admin/profissionais?pessoa=${encodeURIComponent(pessoa.professionalId)}`} key={pessoa.professionalId}>
                <span>{pessoa.professionalName}</span>
                <strong className="tabular">{pessoa.ocupacao}%</strong>
                <span className="painel-v6__mini-barra" aria-hidden="true">
                  <i style={{ '--parte': `${Math.min(100, pessoa.ocupacao)}%` } as CSSProperties} />
                </span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="painel-v6__secao" data-nivel="detalhe" aria-labelledby="painel-atencao">
        <div className="painel-v6__secao-cabeca">
          <div>
            <p className="painel-v6__rotulo">O que merece atenção</p>
            <h2 id="painel-atencao">Sinais que pedem decisão</h2>
          </div>
        </div>
        <ul className="painel-v6__atencao">
          {alertas.slice(0, 3).map((alerta) => (
            <li key={`${alerta.href}-${alerta.titulo}`}>
              <a href={alerta.href}>
                <span className={`painel-v6__sinal painel-v6__sinal--${alerta.tom}`}>{alerta.selo}</span>
                <strong>{alerta.titulo}</strong>
                <span>{alerta.texto}</span>
                <em>{alerta.acao} →</em>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {podeVerDinheiro ? (
        <section className="painel-v6__secao painel-v6__acoes" data-nivel="detalhe" aria-labelledby="painel-acoes">
          <div className="painel-v6__secao-cabeca">
            <div>
              <p className="painel-v6__rotulo">O que dá para fazer</p>
              <h2 id="painel-acoes">Ações com maior impacto agora</h2>
            </div>
            <span className="painel-v6__limite">até três, do maior impacto</span>
          </div>
          {oportunidades.length === 0 ? (
            <p className="painel-insights__vazio">Nada com dinheiro parado que justifique interromper o dia agora.</p>
          ) : (
            <ul className="painel-insights">
              {oportunidades.map((insight) => (
                <li key={`${insight.tipo}-${insight.titulo}`}><Oportunidade insight={insight} /></li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {dinheiro && !dinheiro.ok && (dinheiro.code === 'mfa_required' || dinheiro.code === 'mfa_setup_required') ? (
        <div className="ui-alert ui-alert--warning painel__aviso painel-negocio__mfa" role="status">
          O faturamento continua protegido pelo segundo fator. Os números operacionais permanecem disponíveis normalmente.
        </div>
      ) : null}
    </main>
  );
}
