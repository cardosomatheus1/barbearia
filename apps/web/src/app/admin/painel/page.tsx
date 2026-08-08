import { redirect } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import {
  diagnosticoDoCatalogo,
  painelDeDinheiro,
  painelOperacional,
  type Comparado,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * O painel do proprietário — SPEC §5.9.
 *
 * > "Toda métrica traz comparação com o período anterior. **Número sem
 * > comparação não gera decisão.**"
 *
 * A comparação é com o **mesmo dia da semana**, não com ontem: barbearia tem
 * semana com forma, e sábado contra sexta produziria alta toda semana e queda
 * toda segunda.
 *
 * **O dinheiro é uma segunda chamada, e não é detalhe de implementação.**
 * `finance.view` está no grupo que exige segundo fator; quem opera o balcão vê
 * a operação e não vê a receita. A tela pede as duas coisas e desenha o que
 * conseguiu — em vez de esconder um bloco atrás de um cadeado, que a SPEC §5.9
 * proíbe explicitamente ("não ficam cinza com cadeado").
 *
 * O alerta do validador vem antes dos números, e é de propósito: um combo
 * cadastrado errado corrói a agenda todo dia, e é a única coisa nesta tela que
 * pede ação hoje.
 */

export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

const DIA = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});

/**
 * A seta da comparação.
 *
 * Para no-show, cair é bom — daí `melhorQuandoCai`. Sem isso a tela pintaria de
 * verde a semana em que mais gente faltou.
 */
function Metrica({
  rotulo,
  dado,
  formatar,
  melhorQuandoCai,
  unidade,
}: {
  readonly rotulo: string;
  readonly dado: Comparado;
  readonly formatar?: ((valor: number) => string) | undefined;
  readonly melhorQuandoCai?: boolean;
  readonly unidade?: string | undefined;
}) {
  const texto = formatar ? formatar(dado.valor) : `${dado.valor}${unidade ?? ''}`;
  const subiu = dado.variacao !== null && dado.variacao > 0;
  const bom = dado.variacao === null || dado.variacao === 0
    ? null
    : melhorQuandoCai ? !subiu : subiu;

  return (
    <div className="numero">
      <dt className="numero__rotulo">{rotulo}</dt>
      <dd className="numero__valor tabular">{texto}</dd>
      <dd className={`numero__nota${bom === null ? '' : bom ? ' numero__nota--bom' : ' numero__nota--ruim'}`}>
        {dado.variacao === null
          ? 'sem comparação'
          : `${dado.variacao > 0 ? '+' : ''}${dado.variacao}% que na semana passada`}
      </dd>
    </div>
  );
}

export default async function PainelPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeVerDinheiro = podeNaTela(estado, 'finance.view');
  const podeCadastro = podeNaTela(estado, 'settings.manage');

  // Em paralelo: a tela é uma só, e encadear as chamadas triplicaria a espera.
  const [operacao, dinheiro, diagnostico] = await Promise.all([
    painelOperacional(token),
    podeVerDinheiro ? painelDeDinheiro(token) : Promise.resolve(null),
    podeCadastro ? diagnosticoDoCatalogo(token) : Promise.resolve(null),
  ]);

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

  if (!operacao.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('painel')}>
        {topo}
        <h1 className="painel__titulo">Painel</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          Não deu para carregar os números. Tente de novo.
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/painel">
            Recarregar
          </a>
        </div>
      </main>
    );
  }

  const dia = operacao.dados.dia;
  const achados = diagnostico?.ok ? diagnostico.dados : null;
  const urgentes = achados?.achados.filter((a) => a.severidade !== 'aviso') ?? [];

  return (
    <main className="ui-container painel__conteudo" {...secao('painel')}>
      {topo}

      <h1 className="painel__titulo">Painel</h1>
      <p className="painel__sub">
        {DIA.format(new Date(`${dia}T12:00:00Z`))}, comparado com o mesmo dia da semana passada.
      </p>

      {achados && achados.achados.length > 0 ? (
        <a className={`alerta-catalogo${urgentes.length > 0 ? ' alerta-catalogo--grave' : ''}`}
           href="/admin/catalogo/diagnostico">
          <span className="alerta-catalogo__contagem tabular">{achados.achados.length}</span>
          <span className="alerta-catalogo__texto">
            {urgentes.length > 0
              ? `${urgentes.length} ${urgentes.length === 1 ? 'problema' : 'problemas'} no cadastro atrapalhando a agenda`
              : `${achados.achados.length} ${achados.achados.length === 1 ? 'melhoria possível' : 'melhorias possíveis'} no cardápio`}
          </span>
          <span className="alerta-catalogo__seta" aria-hidden="true">→</span>
        </a>
      ) : null}

      <h2 className="avisos__titulo">Hoje</h2>

      {/* A ocupação sai da grade e vira anel: é a única métrica desta tela que é
          uma fração de um todo conhecido — minutos vendidos sobre minutos de
          jornada —, e fração é o que anel sabe mostrar. As outras são contagem,
          e contagem em anel seria desenho sem denominador. */}
      <div className="quadro">
        <div className="quadro__topo">
          <div>
            <p className="quadro__titulo">Ocupação</p>
            <p className="quadro__sub">minutos vendidos sobre a jornada da equipe</p>
          </div>
        </div>
        <div className="quadro__corpo anel-linha">
          <div
            className="anel"
            style={{ '--anel-parte': `${Math.min(100, operacao.dados.ocupacao.valor)}%` } as CSSProperties}
          >
            <span className="anel__valor tabular">{operacao.dados.ocupacao.valor}%</span>
          </div>
          <div className="anel-linha__texto">
            <p className="painel__sub">
              {operacao.dados.ocupacao.variacao === null
                ? 'Primeiro dia com este número — ainda não há com o que comparar.'
                : `${operacao.dados.ocupacao.variacao > 0 ? '+' : ''}${operacao.dados.ocupacao.variacao}% que no mesmo dia da semana passada.`}
            </p>
            <p className="painel__nota">
              Buraco na agenda é dinheiro que não volta: a hora que passou vazia não
              é vendida amanhã.
            </p>
          </div>
        </div>
      </div>

      <dl className="numeros">
        <Metrica dado={operacao.dados.agendamentos} rotulo="Agendamentos" />
        <Metrica dado={operacao.dados.atendidos} rotulo="Atendidos" />
        <Metrica dado={operacao.dados.noShow} melhorQuandoCai rotulo="Faltas" unidade="%" />
        <Metrica dado={operacao.dados.novosClientes} rotulo="Clientes novos" />
      </dl>

      {dinheiro?.ok ? (
        <>
          <h2 className="avisos__titulo">Dinheiro</h2>
          <dl className="numeros">
            <Metrica dado={dinheiro.dados.faturamentoCents} formatar={reais} rotulo="Faturamento" />
            <Metrica dado={dinheiro.dados.ticketMedioCents} formatar={reais} rotulo="Ticket médio" />
          </dl>
        </>
      ) : null}

      {dinheiro && !dinheiro.ok && (dinheiro.code === 'mfa_required' || dinheiro.code === 'mfa_setup_required') ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="status">
          O faturamento pede o código do segundo fator.
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/seguranca?de=painel">
            Confirmar agora
          </a>
        </div>
      ) : null}

      <p className="painel__nota">
        {podeCadastro ? (
          <>
            A conferência do cardápio roda a cada carga desta tela e está em{' '}
            <a href="/admin/catalogo/diagnostico">Diagnóstico do catálogo</a>. O registro de quem
            mexeu em quê está na <a href="/admin/trilha">trilha</a>.
          </>
        ) : (
          'Estes números são da unidade toda. O que cada barbeiro fez é da tela dele.'
        )}
      </p>
    </main>
  );
}
