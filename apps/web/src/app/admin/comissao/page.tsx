import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DO_KYC,
  EXPLICACAO_DO_SPLIT,
  ROTULO_DA_PARTE,
  ROTULO_DO_KYC,
  ROTULO_DO_SPLIT,
  ROTULO_DO_VALE,
} from '@barbearia/core';
import {
  comissaoDoPeriodo,
  fechamentosDeComissao,
  type FechamentoDeComissao,
  type LinhaDeComissao,
  meusRepassesNaApi,
  recebedoresNaApi,
  splitDoPeriodoNaApi,
  valesNaApi,
  type ValeNaTela,
  type ConfiguracaoDoSplitNaTela,
  type RepasseNaTela,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoAdiantarVale,
  acaoCadastrarRecebedor,
  acaoCancelarVale,
  acaoFecharComissao,
  acaoSair,
  acaoSalvarSplit,
} from '../acoes';
import { randomUUID } from 'node:crypto';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

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

/**
 * Vale / adiantamento (bloco 52, SPEC §3.10).
 *
 * Fica na tela de comissão e não numa própria pela mesma razão do repasse
 * direto: é a **mesma pergunta** — quanto a casa deve a quem. O vale muda o
 * número que o barbeiro recebe no acerto, e ver as duas coisas em telas
 * separadas faria a recepção somar errado.
 *
 * O teto não aparece aqui de propósito: quem decide se cabe é a API, dentro da
 * transação, com a comissão acumulada lida do banco. Um número calculado na tela
 * ficaria velho entre carregar a página e clicar.
 */
function Vales({
  vales,
  linhas,
  de,
  ate,
  chave,
  podeAdiantar,
}: {
  readonly vales: readonly ValeNaTela[];
  readonly linhas: readonly LinhaDeComissao[];
  readonly de: string;
  readonly ate: string;
  readonly chave: string;
  readonly podeAdiantar: boolean;
}) {
  const abertos = vales.filter((v) => v.estado === 'aberto');
  const totalAberto = abertos.reduce((soma, v) => soma + v.valorCents, 0);

  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Vales</h2>

      {vales.length === 0 ? (
        <p className="vazio">
          Nenhum adiantamento neste período. O vale sai da gaveta hoje e é descontado no
          fechamento — ele não é despesa, é empréstimo.
        </p>
      ) : (
        <ul className="lista-cadastro">
          {vales.map((vale) => (
            <li key={vale.id}>
              <article
                className={`item-cadastro${vale.estado === 'aberto' ? '' : ' item-cadastro--fora'}`}
              >
                <div className="item-cadastro__cabeca">
                  <div className="item-cadastro__quem">
                    <h3 className="item-cadastro__nome">{vale.professionalName}</h3>
                    <p className="item-cadastro__linha">
                      {vale.concedidoEm.slice(8, 10)}/{vale.concedidoEm.slice(5, 7)} ·{' '}
                      {ROTULO_DO_VALE[vale.estado]}
                      {vale.pelaGaveta ? ' · saiu da gaveta' : ''}
                      {vale.motivo ? ` · ${vale.motivo}` : ''}
                    </p>
                  </div>
                  <span className="conta__valor tabular">{reais(vale.valorCents)}</span>
                </div>

                {podeAdiantar && vale.estado === 'aberto' ? (
                  <details className="dobra">
                    <summary className="dobra__titulo">Cancelar</summary>
                    <form action={acaoCancelarVale} className="formulario">
                      <input name="valeId" type="hidden" value={vale.id} />
                      <div className="ui-field">
                        <label className="ui-field__label" htmlFor={`motivo-${vale.id}`}>
                          Por quê
                        </label>
                        <input
                          className="ui-field__input"
                          id={`motivo-${vale.id}`}
                          name="motivo"
                          placeholder="Lançado no profissional errado"
                          required
                        />
                        <p className="ui-field__hint">
                          {vale.pelaGaveta
                            ? 'O dinheiro volta para a gaveta na mesma hora. Precisa de caixa aberto.'
                            : 'A dívida some do próximo acerto.'}
                        </p>
                      </div>
                      <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                        Cancelar este vale
                      </button>
                    </form>
                  </details>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}

      {abertos.length > 0 ? (
        <p className="painel__nota">
          {reais(totalAberto)} a descontar no próximo fechamento.
        </p>
      ) : null}

      {podeAdiantar && linhas.length > 0 ? (
        <details className="dobra">
          <summary className="dobra__titulo">Adiantar</summary>
          <form action={acaoAdiantarVale} className="formulario">
            {/* A chave nasce com a página: o segundo toque no botão manda a
                mesma, e a API devolve o vale já lançado. */}
            <input name="chave" type="hidden" value={chave} />
            <input name="de" type="hidden" value={de} />
            <input name="ate" type="hidden" value={ate} />

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="vale-quem">
                Para quem
              </label>
              <select className="ui-field__input" id="vale-quem" name="professionalId">
                {linhas.map((linha) => (
                  <option key={linha.professionalId} value={linha.professionalId}>
                    {linha.professionalName} — {reais(linha.comissaoCents)} acumulado
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="vale-valor">
                Quanto
              </label>
              <input
                className="ui-field__input"
                id="vale-valor"
                inputMode="decimal"
                name="valorCents"
                placeholder="200,00"
                required
              />
              {/* Sem campo de data: o vale é sempre de hoje, e o dia é o da
                  unidade — decidido pela API, não pelo aparelho. */}
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="vale-gaveta">
                Por onde
              </label>
              <select
                className="ui-field__input"
                defaultValue="1"
                id="vale-gaveta"
                name="pelaGaveta"
              >
                <option value="1">Pela gaveta do caixa</option>
                <option value="0">Por fora da gaveta (Pix, transferência)</option>
              </select>
              <p className="ui-field__hint">
                Não dá para adiantar mais do que o profissional já fez no período — o vale é
                descontado inteiro no fechamento, e a diferença ficaria sem como ser cobrada.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="vale-motivo">
                Motivo <span className="ui-field__hint">(opcional)</span>
              </label>
              <input
                className="ui-field__input"
                id="vale-motivo"
                maxLength={300}
                name="motivo"
                placeholder="Pediu adiantamento"
              />
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Adiantar
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

export default async function ComissaoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const erro = first(query['erro']);
  const fechou = first(query['fechado']) === '1';
  const feito = first(query['feito']);
  const podeFechar = podeNaTela(estado, 'commission.edit_rules');
  // A mesma pergunta que a API faz, e ela decide **qual rota** chamar: a folha
  // inteira exige segundo fator, o próprio holerite não.
  const veTodos = podeNaTela(estado, 'commission.view_all');

  /**
   * A janela vem do **extrato**, e não é calculada aqui (bloco 103).
   *
   * A versão anterior montava o mês com `Date.UTC` e o comparava com o
   * cabeçalho que a API imprime — que sai do fuso **da unidade**. São duas
   * janelas na mesma tela: no último dia do mês, entre 21h e meia-noite em
   * Salvador, o relógio UTC já virou, o subtítulo dizia "1 a 31 de agosto" e as
   * seções de vale e repasse pediam setembro, vazias. É o horário em que o
   * gerente fecha o mês.
   *
   * É o defeito D2 pela porta dos fundos, e a tela do DRE ao lado já recusa
   * explicitamente fazer isto. O custo é uma ida a mais ao servidor antes das
   * outras quatro, que continuam em paralelo.
   */
  const extrato = await comissaoDoPeriodo(token, { daCasa: veTodos });
  const de = extrato.ok ? extrato.dados.de : '';
  const ate = extrato.ok ? extrato.dados.ate : '';

  const [historico, repasses, contas, vales] = await Promise.all([
    fechamentosDeComissao(token, veTodos),
    // A rota da casa exige `commission.view_all`; a do próprio, `view_own`. Quem
    // decide qual chamar é a mesma pergunta que a API faz.
    veTodos ? splitDoPeriodoNaApi(token, de, ate) : meusRepassesNaApi(token, de, ate),
    // Quem já pode receber direto, e quanto está retido esperando cadastro. É
    // dinheiro por profissional, como o extrato: `commission.view_all`.
    veTodos ? recebedoresNaApi(token) : Promise.resolve(null),
    // Ler quanto cada um adiantou é a mesma informação da folha, vista pelo
    // outro lado: a rota exige `commission.view_all`, como o extrato da casa.
    veTodos ? valesNaApi(token, de, ate) : Promise.resolve(null),
  ]);

  const podeMexerNoSplit = podeNaTela(estado, 'finance.split_manage');
  const dadosDoSplit = repasses.ok ? repasses.dados : null;
  /*
    O barbeiro chama a rota do próprio holerite, que não devolve configuração —
    ele não decide se o split está ligado, e a rota que decide exige uma
    permissão que ele não tem. A leitura estreita é o que garante isso no tipo.
  */
  const configuracao: ConfiguracaoDoSplitNaTela | null =
    dadosDoSplit && 'configuracao' in dadosDoSplit
      ? (dadosDoSplit.configuracao as ConfiguracaoDoSplitNaTela)
      : null;
  const ligado = configuracao?.ligado ?? false;
  const plataformaPercent = (configuracao?.plataformaBps ?? 0) / 100;
  const listaDeRepasses: readonly RepasseNaTela[] = dadosDoSplit?.repasses ?? [];
  const listaDeContas = contas?.ok ? contas.dados.recebedores : [];
  const listaDeVales = vales?.ok ? vales.dados.vales : [];
  const podeAdiantarVale = podeNaTela(estado, 'finance.advance');
  /**
   * Uma chave por montagem da página, gerada no servidor.
   *
   * Ela precisa ser diferente a cada abertura da tela e a mesma dentro de uma:
   * um valor derivado do formulário faria dois vales legítimos iguais no mesmo
   * dia colidirem, e eles acontecem — R$ 100 de manhã e R$ 100 à tarde.
   */
  const chaveDoVale = randomUUID();

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
      <main className="ui-container painel__conteudo" {...secao('comissao')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(extrato.code)}>
          {FALHA[extrato.code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const conta = extrato.dados;

  return (
    <main className="ui-container painel__conteudo" {...secao('comissao')}>
      {topo}

      {/**
       * O título diz de quem é o dinheiro, porque a tela serve aos dois lados
       * dele.
       *
       * "Comissão" para os dois era a mesma palavra respondendo a duas
       * perguntas opostas: o dono abre para saber **quanto vai pagar**, o
       * barbeiro para saber **quanto vai receber**. Quem tinha as duas contas
       * — o dono que também corta — não tinha como saber qual das duas estava
       * na tela, e o único sinal era um " · a sua" no fim da linha da data.
       */}
      <h1 className="painel__titulo">{veTodos ? 'Comissão da equipe' : 'Minha comissão'}</h1>
      <p className="painel__sub">
        {porExtenso(conta.de)} a {porExtenso(conta.ate)} ·{' '}
        {veTodos ? 'o que a casa tem a pagar' : 'o que você tem a receber'}
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {fechou ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Período fechado. Os valores estão congelados — ajuste a partir de agora vira lançamento
          novo no período seguinte.
        </div>
      ) : null}
      {feito === 'split' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Repasse direto salvo.
        </div>
      ) : null}
      {feito === 'recebedor' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Dados enviados ao adquirente. A análise costuma levar de algumas horas a alguns dias — o
          estado aparece aqui quando ele responder.
        </div>
      ) : null}

      <section className="gaveta">
        <p className="gaveta__rotulo">{veTodos ? 'A casa tem a pagar' : 'Você tem a receber'}</p>
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
                Observação <span className="ui-field__hint">(opcional)</span>
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

      {/*
        Os vales (bloco 52, SPEC §3.10). Ficam antes do repasse porque mudam o
        número que o barbeiro recebe **no acerto**, e o repasse é sobre o que já
        saiu direto do adquirente.
      */}
      {veTodos ? (
        <Vales
          ate={conta.ate}
          chave={chaveDoVale}
          de={conta.de}
          linhas={conta.linhas}
          podeAdiantar={podeAdiantarVale}
          vales={listaDeVales}
        />
      ) : null}

      {/*
        O repasse direto (bloco 49, SPEC §3.5).

        Fica na tela de comissão e não numa própria porque é a **mesma
        pergunta**: quanto a casa deve a quem. A diferença é só se o adquirente
        já pagou direto ou se o acerto sai no fechamento — e ver as duas coisas
        em telas separadas faria a recepção somar duas vezes.
      */}
      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Repasse direto</h2>

        {!ligado ? (
          <>
            <p className="vazio">
              Desligado. O cliente paga a barbearia, e a comissão sai no fechamento do período,
              como sempre.
            </p>
            {podeMexerNoSplit ? (
              <p className="painel__nota">
                Ligado, o adquirente manda a parte de cada barbeiro <strong>direto para a conta
                dele</strong> no momento do pagamento. Exige que cada profissional tenha cadastro
                aprovado no adquirente — enquanto não tiver, a parte dele fica com a casa e o
                acerto continua no fechamento.
              </p>
            ) : null}
          </>
        ) : listaDeRepasses.length === 0 ? (
          <p className="vazio">
            Ligado, e nenhuma venda paga pelo nosso adquirente neste período ainda. O repasse
            aparece quando o cliente pagar pelo Pix ou pelo link.
          </p>
        ) : (
          <div className="ui-scroll-x">
            <table className="repasses">
              <thead>
                <tr>
                  <th scope="col">Dia</th>
                  <th scope="col">Para quem</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {listaDeRepasses.map((r) => (
                  <tr key={r.id}>
                    <td className="tabular">{r.quando.slice(8, 10)}/{r.quando.slice(5, 7)}</td>
                    <td>{r.profissional ?? ROTULO_DA_PARTE[r.parte]}</td>
                    <td className="tabular">R$ {reaisDoCampo(r.valorCents)}</td>
                    <td title={EXPLICACAO_DO_SPLIT[r.estado]}>{ROTULO_DO_SPLIT[r.estado]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
          Quem já pode receber direto (bloco 50).

          `retidoCents` é o número que move o dono: o cadastro no adquirente é
          burocracia que ninguém faz por gosto, e "R$ 40 do Ruan passaram pela
          casa porque ele não terminou o cadastro" é o que faz o cadastro
          acontecer.
        */}
        {ligado && listaDeContas.length > 0 ? (
          <details className="dobra">
            <summary className="dobra__titulo">
              Quem recebe direto ({listaDeContas.filter((c) => c.kyc === 'aprovado').length} de{' '}
              {listaDeContas.length})
            </summary>

            <ul className="recebedores">
              {listaDeContas.map((conta) => (
                <li className="recebedor" key={conta.professionalId}>
                  <div className="recebedor__quem">
                    <p className="recebedor__nome">
                      {conta.nome}
                      <span className="item-cadastro__selo">{ROTULO_DO_KYC[conta.kyc]}</span>
                    </p>
                    <p className="recebedor__frase">{EXPLICACAO_DO_KYC[conta.kyc]}</p>
                    {conta.retidoCents > 0 ? (
                      <p className="recebedor__retido">
                        R$ {reaisDoCampo(conta.retidoCents)} passaram pela casa neste período por
                        falta de cadastro. A comissão dele sai no fechamento, como sempre.
                      </p>
                    ) : null}
                    {conta.motivo ? (
                      <p className="recebedor__frase">O adquirente disse: {conta.motivo}</p>
                    ) : null}
                  </div>

                  {podeMexerNoSplit && conta.kyc !== 'aprovado' ? (
                    <details className="dobra">
                      <summary className="dobra__titulo">
                        {conta.kyc === 'ausente' ? 'Cadastrar a conta dele' : 'Tentar de novo'}
                      </summary>
                      <form action={acaoCadastrarRecebedor} className="formulario">
                        <input
                          name="professionalId"
                          type="hidden"
                          value={conta.professionalId}
                        />
                        <div className="ui-field">
                          <label
                            className="ui-field__label"
                            htmlFor={`doc-${conta.professionalId}`}
                          >
                            CPF ou CNPJ dele
                          </label>
                          <input
                            className="ui-field__input"
                            id={`doc-${conta.professionalId}`}
                            inputMode="numeric"
                            name="documento"
                            required
                            type="text"
                          />
                        </div>
                        <div className="campos-lado">
                          <div className="ui-field">
                            <label
                              className="ui-field__label"
                              htmlFor={`banco-${conta.professionalId}`}
                            >
                              Banco
                            </label>
                            <input
                              className="ui-field__input"
                              id={`banco-${conta.professionalId}`}
                              name="banco"
                              placeholder="260"
                              required
                              type="text"
                            />
                          </div>
                          <div className="ui-field">
                            <label
                              className="ui-field__label"
                              htmlFor={`ag-${conta.professionalId}`}
                            >
                              Agência
                            </label>
                            <input
                              className="ui-field__input"
                              id={`ag-${conta.professionalId}`}
                              name="agencia"
                              required
                              type="text"
                            />
                          </div>
                          <div className="ui-field">
                            <label
                              className="ui-field__label"
                              htmlFor={`cc-${conta.professionalId}`}
                            >
                              Conta
                            </label>
                            <input
                              className="ui-field__input"
                              id={`cc-${conta.professionalId}`}
                              name="conta"
                              required
                              type="text"
                            />
                          </div>
                        </div>
                        <p className="ui-field__hint">
                          Estes dados vão para o adquirente e <strong>não ficam guardados
                          aqui</strong>. O que fica é a referência dele. A análise costuma levar de
                          algumas horas a alguns dias — enquanto isso a comissão sai no fechamento,
                          como sempre.
                        </p>
                        <button className="ui-button ui-button--secondary" type="submit">
                          Enviar ao adquirente
                        </button>
                      </form>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {podeMexerNoSplit ? (
          <details className="dobra">
            <summary className="dobra__titulo">
              {ligado ? 'Mexer no repasse direto' : 'Ligar o repasse direto'}
            </summary>
            <form action={acaoSalvarSplit} className="formulario">
              <label className="opcao-simples">
                <input defaultChecked={ligado} name="ligado" type="checkbox" />
                <span>
                  <span className="opcao-simples__nome">Repassar direto ao barbeiro</span>
                  <span className="opcao-simples__sobre">
                    O adquirente divide o pagamento no ato. A comissão continua sendo a mesma —
                    ela só chega antes, e na conta dele.
                  </span>
                </span>
              </label>

              {plataformaPercent > 0 ? (
                <p className="ui-field__hint">
                  A taxa do produto sobre cada venda paga pelo nosso adquirente é de{' '}
                  <strong>{plataformaPercent}%</strong>, combinada no seu contrato. Ela não é
                  editável por aqui.
                </p>
              ) : null}

              <button className="ui-button ui-button--secondary" type="submit">
                Salvar
              </button>
            </form>
          </details>
        ) : null}
      </section>

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
