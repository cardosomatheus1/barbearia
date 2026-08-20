import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDePacotesNaApi,
  catalogoDeServicos,
  receitaDePacotesNaApi,
  type PacoteNoCatalogo,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair, acaoSalvarPacote } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * Pacotes (bloco 42, SPEC §4.7).
 *
 * ## A tela mostra o número que o bloco existe para dar
 *
 * Vender R$ 250 de pacote **não** é faturar R$ 250: é receber por cinco cortes
 * que ainda não aconteceram. O painel do topo separa as três coisas — vendido,
 * reconhecido e a receber — porque sem ele o DRE mostra um mês excelente
 * seguido de meses falsamente ruins, que é o motivo escrito na SPEC.
 *
 * "A receber" é o passivo, e é a leitura que muda decisão: R$ 4.200 ali são
 * quatro mil e duzentos reais de trabalho já pago que a casa ainda deve.
 *
 * ## Um serviço por pacote, e a tela diz isso
 *
 * "5 cortes por R$ 250" é o exemplo da SPEC e é como a barbearia de bairro
 * vende. Um pacote misto exigiria decidir qual unidade some quando o cliente usa
 * uma barba — e a resposta muda o preço da outra.
 */

export const metadata: Metadata = {
  title: 'Pacotes',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  pacote_invalido: 'Confira os números: são pelo menos duas unidades e um preço acima de zero.',
  catalogo_nao_encontrado: 'Este serviço não existe mais no catálogo.',
  forbidden: 'Sua conta não administra o cadastro da barbearia.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const dinheiro = reais;

/** O formulário de um pacote — o mesmo para criar e para editar. */
function CamposDoPacote({
  pacote,
  servicos,
  prefixo,
}: {
  readonly pacote?: PacoteNoCatalogo;
  readonly servicos: readonly ServicoDoCatalogo[];
  readonly prefixo: string;
}) {
  const quantidade = pacote?.quantidade ?? 5;
  const precoCents = pacote?.precoCents ?? 0;

  return (
    <form action={acaoSalvarPacote} className="formulario">
      {pacote ? <input name="id" type="hidden" value={pacote.id} /> : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-nome`}>
          Nome
        </label>
        <input
          className="ui-field__input"
          defaultValue={pacote?.nome ?? ''}
          id={`${prefixo}-nome`}
          maxLength={80}
          minLength={2}
          name="nome"
          placeholder="5 cortes"
          required
        />
        <p className="ui-field__hint">É o nome que a recepção procura na comanda.</p>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-serviceId`}>
          Serviço que o pacote cobre
        </label>
        <select
          className="ui-field__input"
          defaultValue={pacote?.serviceId ?? servicos[0]?.id ?? ''}
          id={`${prefixo}-serviceId`}
          name="serviceId"
          required
        >
          {servicos.map((servico) => (
            <option key={servico.id} value={servico.id}>
              {servico.name} — {dinheiro(servico.priceCents)}
            </option>
          ))}
        </select>
        <p className="ui-field__hint">
          Um serviço por pacote. Misturar corte e barba obrigaria a decidir qual unidade some
          quando o cliente usa a barba — e isso muda o preço da outra.
        </p>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-quantidade`}>
            Quantas unidades
          </label>
          <input
            className="ui-field__input"
            defaultValue={quantidade}
            id={`${prefixo}-quantidade`}
            inputMode="numeric"
            max={100}
            min={2}
            name="quantidade"
            required
            type="number"
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-precoReais`}>
            Preço do pacote (R$)
          </label>
          <input
            className="ui-field__input"
            defaultValue={precoCents > 0 ? reaisDoCampo(precoCents) : ''}
            id={`${prefixo}-precoReais`}
            inputMode="decimal"
            name="precoReais"
            placeholder="250,00"
            required
          />
        </div>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-validadeDias`}>
          Validade, em dias
        </label>
        <input
          className="ui-field__input"
          defaultValue={pacote?.validadeDias ?? ''}
          id={`${prefixo}-validadeDias`}
          inputMode="numeric"
          max={3650}
          min={7}
          name="validadeDias"
          placeholder="não vence"
          type="number"
        />
        <p className="ui-field__hint">
          Vazio significa que o pacote não vence. Com validade, o que sobrar depois do prazo não é
          devolvido — e é bom que o cliente saiba disso na hora da compra.
        </p>
      </div>

      {/*
        O `hidden` acompanhando a caixa é o que faz "desmarcado" chegar como
        `false` em vez de sumir do formulário — sem ele, desmarcar não desligaria
        nada. Mesmo padrão da exigência de sinal no cadastro do serviço.
      */}
      <input name="transferivel" type="hidden" value="off" />
      <label className="opcao-simples">
        <input defaultChecked={pacote?.transferivel ?? false} name="transferivel" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">O cliente pode passar para outra pessoa</span>
          <span className="opcao-simples__sobre">
            Pacote transferível é um vale ao portador. Nasce desligado de propósito.
          </span>
        </span>
      </label>

      <input name="ativo" type="hidden" value="off" />
      <label className="opcao-simples">
        <input defaultChecked={pacote?.ativo ?? true} name="ativo" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">À venda</span>
          <span className="opcao-simples__sobre">
            Desmarque para parar de vender. Quem já comprou continua usando o que pagou.
          </span>
        </span>
      </label>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {pacote ? 'Salvar alterações' : 'Adicionar pacote'}
      </button>
    </form>
  );
}

function Pacote({
  pacote,
  servicos,
  podeMexer,
}: {
  readonly pacote: PacoteNoCatalogo;
  readonly servicos: readonly ServicoDoCatalogo[];
  readonly podeMexer: boolean;
}) {
  const unidade = Math.floor(pacote.precoCents / pacote.quantidade);

  return (
    <li className={`item-cadastro ${pacote.ativo ? '' : 'item-cadastro--fora'}`}>
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {pacote.nome}
            {pacote.ativo ? null : <span className="item-cadastro__selo">fora de venda</span>}
            {pacote.transferivel ? (
              <span className="item-cadastro__selo">transferível</span>
            ) : null}
          </h3>
          <p className="item-cadastro__linha">
            {pacote.servicoNome} · <span className="tabular">{pacote.quantidade} unidades</span> ·{' '}
            <span className="tabular">{dinheiro(pacote.precoCents)}</span>
          </p>
          {/*
            O valor da unidade é a conta que a barbearia faz de cabeça e erra:
            cinco cortes por R$ 250 são R$ 50 cada, e é esse número que decide se
            o pacote vale a pena contra o preço de tabela.
          */}
          <p className="item-cadastro__linha">
            Sai a <span className="tabular">{dinheiro(unidade)}</span> a unidade ·{' '}
            {pacote.validadeDias === null ? 'não vence' : `vence em ${pacote.validadeDias} dias`}
          </p>
        </div>
      </div>

      {podeMexer ? (
        <details className="dobra">
          <summary className="dobra__titulo">Editar</summary>
          <CamposDoPacote pacote={pacote} prefixo={`p-${pacote.id}`} servicos={servicos} />
        </details>
      ) : null}
    </li>
  );
}

export default async function PacotesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'settings.manage');
  const podeVerDinheiro = podeNaTela(estado, 'finance.view');

  const [resposta, servicosResp, receitaResp] = await Promise.all([
    catalogoDePacotesNaApi(token, true),
    catalogoDeServicos(token),
    // A receita só é pedida a quem pode vê-la: a rota exige `finance.view`, e
    // chamá-la sem a permissão produziria um erro na tela por um número que o
    // usuário não deveria nem saber que existe.
    podeVerDinheiro ? receitaDePacotesNaApi(token) : Promise.resolve(null),
  ]);

  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  const volta = (
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

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('pacotes')}>
        {volta}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const pacotes = resposta.dados.pacotes;
  const servicos = servicosResp.ok
    ? servicosResp.dados.services.filter((servico) => servico.active)
    : [];
  const receita = receitaResp?.ok ? receitaResp.dados : null;

  return (
    <main className="ui-container painel__conteudo" {...secao('pacotes')}>
      {volta}

      <h1 className="painel__titulo">Pacotes</h1>
      <p className="painel__sub">
        O cliente paga adiantado por várias unidades do mesmo serviço. O dinheiro entra hoje; a
        receita aparece conforme ele usa.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Pacote salvo.
        </div>
      ) : null}

      {receita ? (
        <section className="pacotes__contas">
          <h2 className="rotulo">Hoje</h2>
          <dl className="pacotes__numeros">
            <div className="pacotes__numero">
              <dt>Vendido</dt>
              <dd className="tabular">{dinheiro(receita.vendidoCents)}</dd>
              <p className="pacotes__nota">Entrou no caixa. Ainda não é receita.</p>
            </div>
            <div className="pacotes__numero">
              <dt>Virou receita</dt>
              <dd className="tabular">{dinheiro(receita.reconhecidoCents)}</dd>
              <p className="pacotes__nota">O que foi atendido hoje com pacote.</p>
            </div>
            <div className="pacotes__numero pacotes__numero--peso">
              <dt>A receber em serviço</dt>
              <dd className="tabular">{dinheiro(receita.diferidoCents)}</dd>
              <p className="pacotes__nota">Já pago e ainda não entregue. É a dívida da casa.</p>
            </div>
          </dl>
        </section>
      ) : null}

      {pacotes.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Nenhum pacote ainda</p>
          <p className="vazio__saida">
            {podeMexer
              ? 'Comece pelo mais simples: cinco unidades do serviço mais pedido, com desconto contra o preço de tabela.'
              : 'Quem administra a barbearia cadastra os pacotes.'}
          </p>
        </div>
      ) : (
        <ul className="lista-cadastro">
          {pacotes.map((pacote) => (
            <Pacote key={pacote.id} pacote={pacote} podeMexer={podeMexer} servicos={servicos} />
          ))}
        </ul>
      )}

      {podeMexer && servicos.length > 0 ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Adicionar pacote</h2>
          <CamposDoPacote prefixo="novo" servicos={servicos} />
        </section>
      ) : null}

      {podeMexer && servicos.length === 0 ? (
        <div className="ui-alert ui-alert--warning painel__aviso">
          Um pacote cobre um serviço, e ainda não há nenhum no catálogo.{' '}
          <a href="/admin/catalogo">Cadastre o primeiro serviço</a>.
        </div>
      ) : null}

      <p className="painel__nota">
        A venda e o uso acontecem na <a href="/admin/comanda">comanda</a>. Os pacotes de cada
        pessoa ficam na ficha dela, junto com o reembolso da parte não usada.
      </p>
    </main>
  );
}
