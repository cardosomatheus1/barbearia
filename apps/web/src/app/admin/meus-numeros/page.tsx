import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { fraseDaMeta,
  notaExibida,
} from '@barbearia/core';
import { comissaoDoPeriodo, meusNumeros } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { ProNav } from '../pro-nav';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

/**
 * Os números do barbeiro — SPEC §4.21.
 *
 * Separada de "Meu dia" de propósito: são duas perguntas com frequências
 * diferentes. O dia se olha a cada cliente; isto se olha uma vez pela manhã e
 * uma vez no fim do mês, e misturar as duas faria a tela operacional carregar
 * dinheiro que ninguém precisa ver com o cliente sentado na cadeira.
 *
 * **A comparação é com o próprio passado, nunca com o colega.** A SPEC §4.21 é
 * explícita: ranking entre barbeiros produz disputa por cliente bom, empurra
 * produto e faz recusar atendimento rápido. Não há nome de outra pessoa nesta
 * tela, e não é omissão — é a decisão.
 *
 * A meta vem antes dos indicadores porque é a única coisa aqui que muda o que
 * o barbeiro faz hoje. O resto é leitura.
 */

export const metadata: Metadata = {
  title: 'Meus números',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  sem_cadeira: 'Sua conta ainda não está ligada a uma cadeira. Peça para o dono te convidar pelo cadastro da equipe.',
  forbidden: 'Sua conta não vê estes números.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};


const MES = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });

function Numero({
  rotulo,
  valor,
  nota,
}: {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota?: string | undefined;
}) {
  return (
    <div className="numero">
      <dt className="numero__rotulo">{rotulo}</dt>
      <dd className="numero__valor tabular">{valor}</dd>
      {nota ? <dd className="numero__nota">{nota}</dd> : null}
    </div>
  );
}

export default async function MeusNumerosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const erro = first(query['erro']);

  // Duas chamadas em paralelo: os números e a comissão do período. A tela é uma
  // só, e esperar uma para pedir a outra dobraria a espera à toa.
  const [numeros, comissao] = await Promise.all([meusNumeros(token), comissaoDoPeriodo(token)]);

  const topo = (
    <header className="painel__topo">
      <span className="painel__marca">{estado.businessName}</span>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!numeros.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('meus-numeros')}>
        {topo}
        <ProNav atual="/admin/meus-numeros" />
        <h1 className="painel__titulo">Meus números</h1>
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(numeros.code)}>
          {FALHA[numeros.code] ?? FALHA['request_failed']}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/meu-dia">
            Voltar para o meu dia
          </a>
        </div>
      </main>
    );
  }

  const { meta, mesAtual, hoje, variacaoDoFaturamento, nota, notaAnterior } = numeros.dados;
  const nomeDoMes = MES.format(new Date(`${numeros.dados.mes}T12:00:00Z`));
  const minha = comissao.ok ? comissao.dados : null;
  const meuTotal = minha?.linhas.find((l) => l.professionalId === numeros.dados.professionalId);

  return (
    <main className="ui-container meu-dia" {...secao('meus-numeros')}>
      {topo}
      <ProNav atual="/admin/meus-numeros" />

      <h1 className="painel__titulo">Meus números</h1>
      <p className="painel__sub">{nomeDoMes}, até hoje.</p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      <section className={`meta${meta.metaCents === 0 ? ' meta--sem' : ''}`}>
        <p className="meta__frase">{fraseDaMeta(meta, reais)}</p>

        {meta.metaCents > 0 ? (
          <>
            <p className="meta__valores">
              <strong className="tabular">{reais(meta.realizadoCents)}</strong>
              <span className="meta__de"> de {reais(meta.metaCents)}</span>
            </p>
            {/* A barra é decoração do número, não o número: quem não a enxerga
                lê o mesmo na linha acima e na porcentagem. */}
            <div
              aria-hidden="true"
              className="meta__barra"
              style={{ '--parte': `${Math.min(100, meta.percentual)}%` } as React.CSSProperties}
            >
              <span className={`meta__parte${meta.noRitmo ? '' : ' meta__parte--atras'}`} />
            </div>
            <p className="meta__pe tabular">{meta.percentual}%</p>
          </>
        ) : null}
      </section>

      <h2 className="avisos__titulo">Hoje</h2>
      <dl className="numeros">
        <Numero rotulo="Faturei" valor={reais(hoje.faturamentoCents)} />
        <Numero rotulo="Atendi" valor={String(hoje.atendimentos)} />
      </dl>

      <h2 className="avisos__titulo">No mês</h2>
      <dl className="numeros">
        <Numero
          rotulo="Faturamento"
          valor={reais(mesAtual.faturamentoCents)}
          {...(variacaoDoFaturamento !== null
            ? {
                nota:
                  variacaoDoFaturamento >= 0
                    ? `+${variacaoDoFaturamento}% que o mês passado`
                    : `${variacaoDoFaturamento}% que o mês passado`,
              }
            : { nota: 'primeiro mês' })}
        />
        <Numero rotulo="Atendimentos" valor={String(mesAtual.atendimentos)} />
        <Numero rotulo="Ticket médio" valor={reais(mesAtual.ticketMedioCents)} />
        <Numero
          rotulo="Saíram com horário"
          valor={`${mesAtual.taxaDeRetorno}%`}
          nota="de quem você atendeu"
        />
        <Numero rotulo="Produtos vendidos" valor={String(mesAtual.produtosVendidos)} />
        {/*
          A gorjeta (SPEC §3.6, bloco 124).

          Ela era gravada, subtraída do faturamento em toda tela e nunca
          atribuída: o único lugar em que aparecia positiva era o total do dia no
          caixa, sem nome. Repasse e não receita — não entra na base de comissão
          nem no faturamento —, e por isso vem com a frase ao lado: sem ela, um
          número de dinheiro no meio dos outros lê como se somasse.
        */}
        <Numero
          rotulo="Gorjetas"
          valor={reais(mesAtual.gorjetaCents)}
          nota="100% suas — fora da comissão"
        />
        {/*
          A sua nota (bloco 43, SPEC §4.21: comparada com o **seu** passado,
          nunca com a do colega). Sem avaliação nenhuma o número é `—`, e a nota
          diz por quê — um indicador que fica em `—` sem explicação é o que
          ensina a não olhar.
        */}
        <Numero
          rotulo="Sua nota"
          valor={notaExibida(nota.media)}
          nota={
            nota.media === null
              ? 'ninguém avaliou ainda este mês'
              : notaAnterior.media === null
                ? `${nota.total} ${nota.total === 1 ? 'avaliação' : 'avaliações'}`
                : `mês passado: ${notaExibida(notaAnterior.media)}`
          }
        />
      </dl>

      {meuTotal ? (
        <>
          <h2 className="avisos__titulo">Comissão do período</h2>
          <dl className="numeros">
            <Numero rotulo="Base" valor={reais(meuTotal.baseCents)} />
            <Numero
              rotulo="A receber"
              valor={reais(meuTotal.comissaoCents)}
              nota="ainda em aberto, fecha no fim do período"
            />
          </dl>
        </>
      ) : null}

      <p className="painel__nota">
        Estes números são só seus. Ninguém da equipe vê os do outro — comparar barbeiro com
        barbeiro é o que faz um recusar o corte rápido para pegar o do vizinho.
      </p>
    </main>
  );
}
