import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  comissaoDoPeriodo,
  fechamentosDeComissao,
  type FechamentoDeComissao,
  type LinhaDeComissao,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoFecharComissao, acaoSair } from '../acoes';
import { BalcaoNav } from '../balcao-nav';

/**
 * Comissão.
 *
 * A mesma tela serve a duas pessoas muito diferentes, e é de propósito.
 *
 * O **barbeiro** abre para responder "quanto eu tenho a receber". Ele vê uma
 * linha: a dele. Não é filtro de tela — é o que a API devolve, porque quem tem
 * só `commission.view_own` recebe o próprio recorte cravado na consulta.
 *
 * O **dono** abre para conferir a folha e fechar o mês. Vê todo mundo, o total,
 * e o botão que congela.
 *
 * O que a tela precisa dizer e quase nenhum sistema diz: **quem vendeu e não
 * tem regra**. Sem isso, falta de configuração e comissão zero são o mesmo
 * número na tela, e o barbeiro descobre no dia do acerto.
 */

export const metadata: Metadata = {
  title: 'Comissão',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  periodo_ja_fechado: 'Este período já foi fechado.',
  periodo_invalido: 'O fim do período vem antes do início.',
  nada_a_fechar: 'Não há comissão em aberto neste período.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não fecha comissão.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

/** `2026-09-01` → `1 de setembro`. Data por extenso não vira ambiguidade. */
function porExtenso(dia: string): string {
  const [ano = '', mes = '', d = ''] = dia.split('-');
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' }).format(
    new Date(Number(ano), Number(mes) - 1, Number(d)),
  );
}

function Linha({ linha, sozinho }: { readonly linha: LinhaDeComissao; readonly sozinho: boolean }) {
  return (
    <li className="linha-comissao">
      <div className="linha-comissao__quem">
        <span className="linha-comissao__nome">{sozinho ? 'A receber' : linha.professionalName}</span>
        <span className="linha-comissao__detalhe">
          {linha.lancamentos === 1 ? '1 item' : `${linha.lancamentos} itens`} · base{' '}
          {reais(linha.baseCents)}
        </span>
      </div>
      <span className="linha-comissao__valor">{reais(linha.comissaoCents)}</span>
    </li>
  );
}

function Fechado({ fechamento }: { readonly fechamento: FechamentoDeComissao }) {
  return (
    <li className="fechamento-comissao">
      <div className="fechamento-comissao__cabeca">
        <span className="fechamento-comissao__periodo">
          {porExtenso(fechamento.de)} a {porExtenso(fechamento.ate)}
        </span>
        <span className="fechamento-comissao__total">{reais(fechamento.totalCents)}</span>
      </div>
      <ul className="fechamento-comissao__linhas">
        {fechamento.linhas.map((linha) => (
          <li key={linha.professionalName}>
            <span>{linha.professionalName}</span>
            <span>{reais(linha.comissaoCents)}</span>
          </li>
        ))}
      </ul>
      <p className="fechamento-comissao__quem">Fechado por {fechamento.fechadoPor}</p>
    </li>
  );
}

export default async function ComissaoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const erro = first(query['erro']);
  const fechou = first(query['fechado']) === '1';
  const podeFechar = podeNaTela(estado, 'commission.edit_rules');
  // A mesma pergunta que a API faz, e ela decide **qual rota** chamar: a folha
  // inteira exige segundo fator, o próprio holerite não.
  const veTodos = podeNaTela(estado, 'commission.view_all');

  const [extrato, historico] = await Promise.all([
    comissaoDoPeriodo(token, { daCasa: veTodos }),
    fechamentosDeComissao(token, veTodos),
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

  if (!extrato.ok) {
    if (extrato.code === 'mfa_required' || extrato.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=caixa');
    }
    return (
      <main className="ui-container painel__conteudo" data-secao="comissao">
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[extrato.code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const conta = extrato.dados;

  return (
    <main className="ui-container painel__conteudo" data-secao="comissao">
      {topo}
      <BalcaoNav atual="/admin/comissao" />

      <h1 className="painel__titulo">Comissão</h1>
      <p className="painel__sub">
        {porExtenso(conta.de)} a {porExtenso(conta.ate)}
        {veTodos ? '' : ' · a sua'}
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {fechou ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Período fechado. Os valores estão congelados — ajuste a partir de agora vira lançamento
          novo no período seguinte.
        </div>
      ) : null}

      <section className="gaveta">
        <p className="gaveta__rotulo">{veTodos ? 'Total do período' : 'Você tem a receber'}</p>
        <p className="gaveta__valor">{reais(conta.totalComissaoCents)}</p>
        <p className="gaveta__quem">sobre {reais(conta.totalBaseCents)} de serviço</p>
      </section>

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Em aberto</h2>
        {conta.linhas.length === 0 ? (
          <p className="vazio">
            Nada em aberto neste período. A comissão aparece aqui assim que a comanda é fechada.
          </p>
        ) : (
          <ul className="linhas-comissao">
            {conta.linhas.map((linha) => (
              <Linha key={linha.professionalId} linha={linha} sozinho={!veTodos} />
            ))}
          </ul>
        )}
      </section>

      {conta.semRegra.length > 0 ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="alert">
          <strong>Sem regra de comissão:</strong>{' '}
          {conta.semRegra
            .map((s) => `${s.professionalName} (${s.itens} ${s.itens === 1 ? 'item' : 'itens'})`)
            .join(', ')}
          . Esses atendimentos não geraram comissão nenhuma — não é zero, é falta de regra.
          {podeFechar ? (
            <>
              {' '}
              <a href="/admin/comissao/regras">Cadastrar agora</a>
            </>
          ) : null}
        </div>
      ) : null}

      {podeFechar && conta.linhas.length > 0 ? (
        <details className="dobra dobra--fechar">
          <summary className="dobra__titulo">Fechar o período</summary>
          <form action={acaoFecharComissao} className="formulario">
            {/* O período vem do que a tela mostrou, não digitado de novo: o que
                se fecha tem que ser exatamente o que se conferiu. */}
            <input name="de" type="hidden" value={conta.de} />
            <input name="ate" type="hidden" value={conta.ate} />

            <p className="cartao-balcao__texto">
              Vai congelar {reais(conta.totalComissaoCents)} para{' '}
              {conta.linhas.length === 1 ? '1 profissional' : `${conta.linhas.length} profissionais`}
              . Depois disso o valor não muda mais — nem se a regra mudar, nem se uma venda for
              estornada. O ajuste vira lançamento novo no período seguinte.
            </p>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="notas">
                Observação <span className="ui-field__opcional">(opcional)</span>
              </label>
              <input
                className="ui-field__input"
                id="notas"
                maxLength={500}
                name="notas"
                placeholder="Pago em 05/10"
              />
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Fechar e congelar
            </button>
          </form>
        </details>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Fechamentos anteriores</h2>
        {!historico.ok || historico.dados.fechamentos.length === 0 ? (
          <p className="vazio">Nenhum período fechado ainda.</p>
        ) : (
          <ul className="fechamentos-comissao">
            {historico.dados.fechamentos.map((fechamento) => (
              <Fechado fechamento={fechamento} key={fechamento.id} />
            ))}
          </ul>
        )}
      </section>

      {podeFechar ? (
        <a className="ui-button ui-button--ghost ui-button--block" href="/admin/comissao/regras">
          Regras de comissão
        </a>
      ) : null}
    </main>
  );
}
