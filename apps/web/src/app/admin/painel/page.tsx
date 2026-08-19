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
} from '@/lib/admin-api';
import type { DestinoDoInsight } from '@barbearia/core';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';

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
  return valor === 'dia' || valor === '7d' || valor === 'mes' ? valor : 'mes';
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
  const query = await searchParams;
  const periodo = periodoSeguro(primeiro(query['periodo']));

  /**
   * Os insights entram sob a mesma condição do faturamento (bloco 67).
   *
   * A rota exige `finance.view` porque o cartão traz dinheiro; pedi-la sem a
   * permissão devolveria 403 em toda abertura do painel da recepção, e o bloco
   * "O que fazer primeiro" apareceria vazio para quem nunca poderá vê-lo.
   */
  const [operacao, hoje, dinheiro, diagnostico, insights] = await Promise.all([
    painelOperacional(token, undefined, periodo),
    periodo === 'dia' ? Promise.resolve(null) : painelOperacional(token, undefined, 'dia'),
    podeVerDinheiro ? painelDeDinheiro(token, undefined, periodo) : Promise.resolve(null),
    podeCadastro ? diagnosticoDoCatalogo(token) : Promise.resolve(null),
    podeVerDinheiro ? insightsDoPainel(token) : Promise.resolve(null),
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
    return (
      <main className="ui-container painel__conteudo" {...secao('painel')}>
        {topo}
        <h1 className="painel__titulo">Painel</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          Não deu para carregar os números. Tente de novo.
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/painel">Recarregar</a>
        </div>
      </main>
    );
  }

  const operacaoHoje = hoje?.ok ? hoje.dados : operacao.dados;
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
  if (operacao.dados.noShow.valor >= 7) {
    alertas.push({
      selo: 'Atenção',
      titulo: `Faltas estão em ${operacao.dados.noShow.valor}% no período`,
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
      texto: 'Faltas e cadastro não apresentam um desvio que peça ação imediata.',
      href: '/admin/dia',
      acao: 'Ver o dia',
      tom: 'ok',
    });
  }

  const meta = dadosDinheiro?.metaCents ?? 0;
  const percentualMeta = dadosDinheiro?.percentualMeta ?? 0;
  const periodoTexto = periodo === 'dia'
    ? DIA.format(new Date(`${operacao.dados.dia}T12:00:00Z`))
    : periodo === '7d'
      ? 'Últimos 7 dias'
      : `${MES.format(new Date(`${operacao.dados.dia}T12:00:00Z`))} · até hoje`;

  return (
    <main className="ui-container painel__conteudo painel-negocio" {...secao('painel')}>
      {topo}

      <h1 className="painel__titulo">Painel</h1>
      <p className="painel__sub">{periodoTexto}. Veja o resultado da casa e o que merece ação agora.</p>

      <nav aria-label="Período do painel" className="balcao__regua painel-periodos">
        {(Object.keys(ROTULO_PERIODO) as PeriodoPainel[]).map((item) => (
          <a
            aria-current={periodo === item ? 'page' : undefined}
            className={periodo === item ? 'filtro filtro--ativo' : 'filtro'}
            href={`/admin/painel?periodo=${item}`}
            key={item}
          >
            {ROTULO_PERIODO[item]}
          </a>
        ))}
      </nav>

      <section className="painel-resumo" aria-label="Resultado principal">
        {dadosDinheiro ? (
          <article className="quadro painel-faturamento">
            <div className="quadro__topo">
              <div>
                <p className="quadro__titulo">Faturamento {periodo === 'dia' ? 'de hoje' : periodo === '7d' ? 'dos últimos 7 dias' : 'do mês'}</p>
                <p className="quadro__sub">Resultado realizado no período selecionado</p>
              </div>
              {periodo === 'mes' && dadosDinheiro.projecaoCents ? (
                <span className="selo selo--agora tabular">Projeção {reais(dadosDinheiro.projecaoCents)}</span>
              ) : null}
            </div>
            <div className="quadro__corpo">
              <p className="painel-faturamento__valor tabular">{reais(dadosDinheiro.faturamentoCents.valor)}</p>
              {faturamentoComp ? <p className={`numero__nota${faturamentoComp.classe}`}>{faturamentoComp.texto}</p> : null}
              {periodo === 'mes' && meta > 0 ? (
                <div className="painel-meta">
                  <div className="meta__barra" aria-hidden="true">
                    <span
                      className={`meta__parte${percentualMeta < 70 ? ' meta__parte--atras' : ''}`}
                      style={{ '--parte': `${Math.min(100, percentualMeta)}%` } as CSSProperties}
                    />
                  </div>
                  <p className="meta__pe tabular">{percentualMeta}% da meta de {reais(meta)}</p>
                </div>
              ) : null}
            </div>
          </article>
        ) : (
          <article className="quadro painel-faturamento">
            <div className="quadro__topo">
              <div>
                <p className="quadro__titulo">Faturamento</p>
                <p className="quadro__sub">Informação financeira protegida</p>
              </div>
            </div>
            <div className="quadro__corpo">
              <p className="painel-faturamento__valor painel-faturamento__valor--protegido">Protegido</p>
              <p className="numero__nota">Confirme o segundo fator para visualizar os valores.</p>
              <a className="defeito__link" href="/admin/seguranca?de=painel">Confirmar agora →</a>
            </div>
          </article>
        )}

        <dl className="numeros painel-kpis">
          <Numero
            rotulo="Ocupação"
            valor={`${operacao.dados.ocupacao.valor}%`}
            nota={ocupacaoComp.texto}
            classe={ocupacaoComp.classe}
          />
          <Numero
            rotulo="Ticket médio"
            valor={dadosDinheiro ? reais(dadosDinheiro.ticketMedioCents.valor) : '—'}
            nota={ticketComp?.texto ?? 'Disponível após confirmar o segundo fator'}
            classe={ticketComp?.classe ?? ''}
          />
        </dl>
      </section>

      {podeVerDinheiro ? (
        <>
          <div className="painel-secao__cabeca">
            <h2 className="avisos__titulo">O que fazer primeiro</h2>
            {/* O limite de três é regra da SPEC §4.19, e a tela diz por quê:
                sem a frase, "só três?" parece falta de dado. */}
            <span className="painel-secao__nota">no máximo três, do mais caro</span>
          </div>
          {oportunidades.length === 0 ? (
            /* Estado vazio desenhado, e aqui vazio é boa notícia. */
            <p className="painel-insights__vazio">
              Nada com dinheiro parado agora: a agenda de amanhã e a ocupação da equipe não
              apontam nenhuma oportunidade que valha interromper o dia.
            </p>
          ) : (
            <ul className="painel-insights">
              {oportunidades.map((insight) => (
                <li key={`${insight.tipo}-${insight.titulo}`}>
                  <Oportunidade insight={insight} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <div className="painel-secao__cabeca">
        <h2 className="avisos__titulo">Hoje</h2>
        <a className="quadro__acao" href="/admin/dia">Ver operação →</a>
      </div>
      <section className="balcao__totais painel-hoje" aria-label="Resumo de hoje">
        <div className="totalzinho"><strong className="totalzinho__valor tabular">{operacaoHoje.agendamentos.valor}</strong><span className="totalzinho__nome">Marcados</span></div>
        <div className="totalzinho"><strong className="totalzinho__valor tabular">{operacaoHoje.atendidos.valor}</strong><span className="totalzinho__nome">Atendidos</span></div>
        <div className="totalzinho"><strong className="totalzinho__valor tabular">{operacaoHoje.noShow.valor}%</strong><span className="totalzinho__nome">Faltas</span></div>
        <div className="totalzinho"><strong className="totalzinho__valor tabular">{operacaoHoje.novosClientes.valor}</strong><span className="totalzinho__nome">Clientes novos</span></div>
      </section>

      <div className="painel-secao__cabeca">
        <h2 className="avisos__titulo">Sinais de hoje</h2>
        <a className="quadro__acao" href="/admin/dia">Ver operação →</a>
      </div>
      <ul className="defeitos painel-alertas">
        {alertas.slice(0, 3).map((alerta) => (
          <li className={`defeito painel-alerta painel-alerta--${alerta.tom}`} key={`${alerta.href}-${alerta.titulo}`}>
            <a className="painel-alerta__link" href={alerta.href}>
              <p className="defeito__selo">{alerta.selo}</p>
              <p className="defeito__titulo">{alerta.titulo}</p>
              <p className="defeito__conserto">{alerta.texto}</p>
              <span className="defeito__link">{alerta.acao} →</span>
            </a>
          </li>
        ))}
      </ul>

      {(dadosDinheiro?.serie?.length ?? 0) > 1 || (operacao.dados.equipe?.length ?? 0) > 0 ? (
        <>
          <div className="painel-secao__cabeca">
            <h2 className="avisos__titulo">Desempenho</h2>
            <a className="quadro__acao" href="/admin/profissionais">Ver profissionais →</a>
          </div>
          <section className="painel-desempenho">
            {dadosDinheiro && (dadosDinheiro.serie?.length ?? 0) > 1 ? (
              <article className="quadro">
                <div className="quadro__topo">
                  <div>
                    <p className="quadro__titulo">Faturamento acumulado</p>
                    <p className="quadro__sub">{periodo === 'mes' && meta > 0 ? 'Realizado x ritmo da meta' : 'Evolução no período'}</p>
                  </div>
                  <span className="selo tabular">{reais(dadosDinheiro.faturamentoCents.valor)}</span>
                </div>
                <div className="quadro__corpo">
                  <GraficoFaturamento dinheiro={dadosDinheiro} periodo={periodo} />
                  <div className="dashboard-legenda"><span>— Realizado</span>{periodo === 'mes' && meta > 0 ? <span>┄ Ritmo da meta</span> : null}</div>
                </div>
              </article>
            ) : null}

            {(operacao.dados.equipe?.length ?? 0) > 0 ? (
              <article className="quadro">
                <div className="quadro__topo">
                  <div>
                    <p className="quadro__titulo">Ocupação da equipe</p>
                    <p className="quadro__sub">Uso da agenda por profissional</p>
                  </div>
                </div>
                <div className="quadro__corpo painel-equipe">
                  {operacao.dados.equipe?.map((pessoa) => (
                    <div className="painel-equipe__linha" key={pessoa.professionalId}>
                      <div className="painel-equipe__nome">
                        <span>{pessoa.professionalName}</span>
                        <strong className="tabular">{pessoa.ocupacao}%</strong>
                      </div>
                      <div className="meta__barra" aria-hidden="true">
                        <span
                          className={`meta__parte${pessoa.ocupacao < 65 ? ' meta__parte--atras' : ''}`}
                          style={{ '--parte': `${Math.min(100, pessoa.ocupacao)}%` } as CSSProperties}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ) : null}
          </section>
        </>
      ) : null}

      {dinheiro && !dinheiro.ok && (dinheiro.code === 'mfa_required' || dinheiro.code === 'mfa_setup_required') ? (
        <div className="ui-alert ui-alert--warning painel__aviso painel-negocio__mfa" role="status">
          O faturamento continua protegido pelo segundo fator. A operação acima permanece disponível normalmente.
        </div>
      ) : null}
    </main>
  );
}
