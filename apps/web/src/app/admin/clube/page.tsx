import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DO_MODO_DA_ASSINATURA,
  MODOS_DA_ASSINATURA,
  ROTULO_DO_MODO_DA_ASSINATURA,
  fraseDaSimulacao,
  fraseDoBloqueio,
} from '@barbearia/core';
import {
  catalogoDeServicos,
  clubeNaApi,
  faturasDoClubeNaApi,
  planosContadosNaApi,
  rentabilidadeDoClubeNaApi,
  simulacaoDaAssinaturaNaApi,
  planosNaApi,
  type FaturaDoClubeNaTela,
  type PlanoNaTela,
  type RentabilidadeDoClubeNaTela,
  type SimulacaoDaAssinaturaNaTela,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoCancelarFatura,
  acaoPagarFatura,
  acaoSair,
  acaoSalvarModeloDaAssinatura,
  acaoSalvarPlano,
} from '../acoes';
import { secao } from '../secoes';

/**
 * O clube de assinatura (bloco 45, SPEC §4.6).
 *
 * ## A tela abre pelo número que decide tudo
 *
 * O MRR — quanto entra todo mês independentemente de quem aparecer. É o que a
 * SPEC chama de *"transformar receita variável em receita mínima previsível"*, e
 * é o único número do produto que responde "quanto eu ganho se ninguém vier".
 *
 * ## O cooldown aparece ao lado de "ilimitado", sempre
 *
 * Porque um sem o outro é a armadilha que a SPEC nomeia: *"Sem cooldown,
 * 'ilimitado' é prejuízo garantido no primeiro assinante entusiasmado."* A tela
 * avisa quando o dono monta um plano ilimitado sem intervalo — não impede, mas
 * não deixa acontecer por distração.
 */

export const metadata: Metadata = {
  title: 'Clube',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  plano_invalido: 'Confira os números: preço acima de zero e cota positiva.',
  servico_nao_encontrado: 'Um dos serviços não existe mais no catálogo.',
  plano_nao_encontrado: 'Este plano não existe mais.',
  fatura_nao_encontrada: 'Esta mensalidade já foi baixada ou cancelada.',
  motivo_obrigatorio: 'Escreva o motivo do cancelamento.',
  aliquota_invalida: 'O teto vai de 0% a 100%.',
  forbidden: 'Sua conta não mexe no clube.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const FEITO: Record<string, string> = {
  pagou: 'Pagamento registrado. O plano voltou a valer.',
  cancelou_fatura: 'Mensalidade cancelada. A linha continua no histórico.',
  modelo: 'Modelo salvo. Ele vale a partir do próximo fechamento de comissão.',
};

const dinheiro = (cents: number) => `R$ ${reaisDoCampo(cents)}`;

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;

/** Minutos desde a meia-noite para `HH:mm`. */
const emHora = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function CamposDoPlano({
  plano,
  servicos,
  prefixo,
}: {
  readonly plano?: PlanoNaTela;
  readonly servicos: readonly ServicoDoCatalogo[];
  readonly prefixo: string;
}) {
  const beneficioDe = (serviceId: string) =>
    plano?.beneficios.find((b) => b.serviceId === serviceId);

  return (
    <form action={acaoSalvarPlano} className="formulario">
      {plano ? <input name="id" type="hidden" value={plano.id} /> : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-nome`}>
          Nome do plano
        </label>
        <input
          className="ui-field__input"
          defaultValue={plano?.nome ?? ''}
          id={`${prefixo}-nome`}
          maxLength={80}
          minLength={2}
          name="nome"
          placeholder="Premium"
          required
        />
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-precoReais`}>
            Mensalidade (R$)
          </label>
          <input
            className="ui-field__input"
            defaultValue={plano ? reaisDoCampo(plano.precoCents) : ''}
            id={`${prefixo}-precoReais`}
            inputMode="decimal"
            name="precoReais"
            placeholder="149,00"
            required
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-descontoPercent`}>
            Desconto em produtos (%)
          </label>
          <input
            className="ui-field__input"
            defaultValue={plano ? (plano.descontoEmProdutoBps / 100).toString() : '0'}
            id={`${prefixo}-descontoPercent`}
            inputMode="decimal"
            max={50}
            min={0}
            name="descontoPercent"
            step="1"
            type="number"
          />
        </div>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-descricao`}>
          Descrição
        </label>
        <input
          className="ui-field__input"
          defaultValue={plano?.descricao ?? ''}
          id={`${prefixo}-descricao`}
          maxLength={300}
          name="descricao"
          placeholder="Para quem corta toda semana"
        />
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-janelaDias`}>
          Marca com quantos dias de antecedência
        </label>
        <input
          className="ui-field__input"
          defaultValue={plano?.janelaDeAgendamentoDias ?? 0}
          id={`${prefixo}-janelaDias`}
          inputMode="numeric"
          max={180}
          min={0}
          name="janelaDias"
          type="number"
        />
        {/* O outro lado da prioridade na fila: quem assina vê o sábado antes e
            por isso o pega antes. Zero é a mesma janela de todo mundo. */}
        <p className="ui-field__hint">
          Zero é a mesma janela de quem não assina. Acima disso, o assinante enxerga a agenda mais
          longe — e pega o sábado antes.
        </p>
      </div>

      {/*
        Onde o plano cobre, numa rede (bloco 59).

        Fica no plano e não na barbearia porque é assim que ela vende: o clube
        da Pituba pode ser da loja e o Premium pode valer na rede, e um
        interruptor único obrigaria a escolher pelo pior dos dois.
      */}
      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-escopo`}>
          Onde o plano cobre
        </label>
        <select
          className="ui-field__input"
          defaultValue={plano?.escopo ?? 'empresa'}
          id={`${prefixo}-escopo`}
          name="escopo"
        >
          <option value="empresa">Em todas as unidades</option>
          <option value="unidade">Só na unidade onde a pessoa assinou</option>
        </select>
        <p className="ui-field__hint">
          Quem já assinava antes continua coberto em toda parte. Com uma unidade só, os dois
          significam a mesma coisa.
        </p>
      </div>

      <fieldset className="plano__servicos">
        <legend className="ui-field__label">Quando o plano não vale</legend>
        <p className="ui-field__hint">
          Deixe vazio para o plano valer o dia inteiro. Bloquear o sábado de manhã é o que impede
          o plano barato de ocupar a hora que a casa vende cheia — e aí o clube soma receita em
          vez de substituir.
        </p>

        {DIAS.map((nome, dia) => {
          const atual = plano?.bloqueios.find((b) => b.diaDaSemana === dia);
          return (
            <div className="campos-lado" key={dia}>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={`${prefixo}-bi-${dia}`}>
                  {nome} — a partir de
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={atual ? emHora(atual.inicio) : ''}
                  id={`${prefixo}-bi-${dia}`}
                  name={`blk-ini-${dia}`}
                  placeholder="09:00"
                />
              </div>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={`${prefixo}-bf-${dia}`}>
                  até
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={atual ? emHora(atual.fim) : ''}
                  id={`${prefixo}-bf-${dia}`}
                  name={`blk-fim-${dia}`}
                  placeholder="13:00"
                />
              </div>
            </div>
          );
        })}
      </fieldset>

      <fieldset className="plano__servicos">
        <legend className="ui-field__label">O que o plano dá</legend>
        <p className="ui-field__hint">
          Deixe a quantidade em branco para ilimitado — e aí o intervalo é o que segura a conta.
        </p>

        {servicos.map((servico) => {
          const b = beneficioDe(servico.id);
          return (
            <div className="plano__servico" key={servico.id}>
              <input name="servicoId" type="hidden" value={servico.id} />
              <label className="opcao-simples">
                <input
                  defaultChecked={b !== undefined}
                  name={`inclui-${servico.id}`}
                  type="checkbox"
                />
                <span>
                  <span className="opcao-simples__nome">{servico.name}</span>
                  <span className="opcao-simples__sobre">
                    Avulso: {dinheiro(servico.priceCents)}
                  </span>
                </span>
              </label>

              <div className="campos-lado">
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`${prefixo}-q-${servico.id}`}>
                    Quantos por mês
                  </label>
                  <input
                    className="ui-field__input"
                    defaultValue={b?.quantidade ?? ''}
                    id={`${prefixo}-q-${servico.id}`}
                    inputMode="numeric"
                    min={1}
                    name={`qtd-${servico.id}`}
                    placeholder="ilimitado"
                    type="number"
                  />
                </div>

                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`${prefixo}-c-${servico.id}`}>
                    Intervalo mínimo (dias)
                  </label>
                  <input
                    className="ui-field__input"
                    defaultValue={b?.cooldownDias ?? 0}
                    id={`${prefixo}-c-${servico.id}`}
                    inputMode="numeric"
                    max={90}
                    min={0}
                    name={`cd-${servico.id}`}
                    type="number"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </fieldset>

      <label className="opcao-simples">
        <input defaultChecked={plano?.ativo ?? true} name="ativo" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">Aceitando assinaturas novas</span>
          <span className="opcao-simples__sobre">
            Desmarque para parar de vender. Quem já assina continua com o preço que fechou.
          </span>
        </span>
      </label>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {plano ? 'Salvar plano' : 'Criar plano'}
      </button>
    </form>
  );
}

function Plano({
  plano,
  servicos,
  podeMexer,
}: {
  readonly plano: PlanoNaTela;
  readonly servicos: readonly ServicoDoCatalogo[];
  readonly podeMexer: boolean;
}) {
  /*
    O aviso que a SPEC §4.6 pede em letras: sem intervalo, "ilimitado" é
    prejuízo garantido no primeiro assinante entusiasmado. Não impede — a
    barbearia pode querer —, mas não deixa acontecer por distração.
  */
  const semTravaNoIlimitado = plano.beneficios.filter(
    (b) => b.quantidade === null && b.cooldownDias === 0,
  );

  return (
    <li className={`item-cadastro ${plano.ativo ? '' : 'item-cadastro--fora'}`}>
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {plano.nome}
            {plano.ativo ? null : <span className="item-cadastro__selo">fora de venda</span>}
          </h3>
          <p className="item-cadastro__linha">
            <span className="tabular">{dinheiro(plano.precoCents)}</span> por mês ·{' '}
            <span className="tabular">{plano.assinantes}</span>{' '}
            {plano.assinantes === 1 ? 'assinante' : 'assinantes'}
            {plano.descontoEmProdutoBps > 0
              ? ` · ${plano.descontoEmProdutoBps / 100}% em produtos`
              : ''}
          </p>

          <ul className="plano__lista">
            {plano.beneficios.map((b) => (
              <li key={b.serviceId}>
                {b.quantidade === null ? `${b.servicoNome} ilimitado` : `${b.quantidade}× ${b.servicoNome}`}
                {b.cooldownDias > 0 ? `, a cada ${b.cooldownDias} dias` : ''}
              </li>
            ))}
            {plano.beneficios.length === 0 ? <li>Nenhum serviço incluído ainda.</li> : null}
          </ul>

          {plano.bloqueios.length > 0 ? (
            <p className="item-cadastro__linha">
              Não vale {plano.bloqueios.map((b) => fraseDoBloqueio(b)).join('; ')}.
            </p>
          ) : null}
          {plano.janelaDeAgendamentoDias > 0 ? (
            <p className="item-cadastro__linha">
              Marca com <span className="tabular">{plano.janelaDeAgendamentoDias}</span> dias de
              antecedência.
            </p>
          ) : null}

          {semTravaNoIlimitado.length > 0 ? (
            <p className="item-cadastro__aviso">
              {semTravaNoIlimitado.map((b) => b.servicoNome).join(', ')} está ilimitado{' '}
              <strong>sem intervalo mínimo</strong>. Um assinante entusiasmado pode cortar todo dia
              por {dinheiro(plano.precoCents)} no mês.
            </p>
          ) : null}
        </div>
      </div>

      {podeMexer ? (
        <details className="dobra">
          <summary className="dobra__titulo">Editar</summary>
          <CamposDoPlano plano={plano} prefixo={`p-${plano.id}`} servicos={servicos} />
        </details>
      ) : null}
    </li>
  );
}

const dia = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

const METODOS = [
  ['pix', 'Pix'],
  ['dinheiro', 'Dinheiro'],
  ['cartao', 'Cartão'],
  ['transferencia', 'Transferência'],
] as const;

/**
 * Uma mensalidade em aberto.
 *
 * A linha diz três coisas, nesta ordem: **de quem**, **quanto** e **quanto falta
 * para o plano pausar**. A terceira é o que a recepção usa para escolher a quem
 * ligar hoje — um indicador que fica sempre em branco é pior que indicador
 * nenhum, e este só existe quando há atraso de verdade.
 */
function Fatura({
  fatura,
  podeMexer,
}: {
  readonly fatura: FaturaDoClubeNaTela;
  readonly podeMexer: boolean;
}) {
  const atrasada = fatura.diasAteSuspender !== null;

  return (
    <li className="item-cadastro">
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {fatura.cliente}
            {atrasada ? <span className="item-cadastro__selo">em atraso</span> : null}
          </h3>
          <p className="item-cadastro__linha">
            <span className="tabular">{dinheiro(fatura.valorCents)}</span> ·{' '}
            {fatura.plano ?? 'plano removido'} · venceu {dia(fatura.vencimento)}
          </p>
          {atrasada ? (
            <p className="item-cadastro__linha">
              {fatura.diasAteSuspender === 0
                ? 'O plano pausa hoje.'
                : `O plano pausa em ${fatura.diasAteSuspender} dias — até lá ele continua cortando.`}
            </p>
          ) : null}
          {fatura.tentativas > 0 ? (
            <p className="item-cadastro__linha">
              <span className="tabular">{fatura.tentativas}</span>{' '}
              {fatura.tentativas === 1 ? 'tentativa' : 'tentativas'} no cartão
              {fatura.ultimoErro ? `: ${fatura.ultimoErro}` : ''}.
            </p>
          ) : null}
        </div>
      </div>

      {podeMexer ? (
        <div className="fatura__acoes">
          <form action={acaoPagarFatura} className="fatura__baixa">
            <input name="id" type="hidden" value={fatura.id} />
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`m-${fatura.id}`}>
                Recebeu como
              </label>
              <select className="ui-field__input" id={`m-${fatura.id}`} name="metodo">
                {METODOS.map(([valor, nome]) => (
                  <option key={valor} value={valor}>
                    {nome}
                  </option>
                ))}
              </select>
            </div>
            <button className="ui-button ui-button--primary" type="submit">
              Registrar pagamento
            </button>
          </form>

          <details className="dobra">
            <summary className="dobra__titulo">Cancelar esta mensalidade</summary>
            <form action={acaoCancelarFatura} className="formulario">
              <input name="id" type="hidden" value={fatura.id} />
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={`mot-${fatura.id}`}>
                  Por quê
                </label>
                <input
                  className="ui-field__input"
                  id={`mot-${fatura.id}`}
                  maxLength={300}
                  name="motivo"
                  placeholder="ex.: cliente saiu antes do ciclo"
                  required
                  type="text"
                />
                <p className="ui-field__hint">
                  Cancelar é perdoar a dívida do mês. A linha continua no histórico com o valor.
                </p>
              </div>
              <button className="ui-button ui-button--secondary" type="submit">
                Cancelar mensalidade
              </button>
            </form>
          </details>
        </div>
      ) : null}
    </li>
  );
}

export default async function ClubePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'finance.subscription_manage');
  const veDinheiro = podeMexer && podeNaTela(estado, 'finance.view');
  const veMargem =
    podeNaTela(estado, 'finance.view') && podeNaTela(estado, 'finance.view_profit');
  // Escolher o modelo é mexer em regra de comissão, e a rota exige as duas.
  const mexeNaComissao = podeMexer && podeNaTela(estado, 'commission.edit_rules');

  const [resposta, catalogo, clube, cobrancas, simulada, rendeu] = await Promise.all([
    // Com a contagem só para quem pode ver o MRR: ela × preço é o faturamento
    // recorrente da casa, e a rota aberta devolve zero de propósito.
    veDinheiro ? planosContadosNaApi(token, true) : planosNaApi(token, true),
    catalogoDeServicos(token),
    // A rota exige as duas permissões que ela devolve; pedir sem elas produziria
    // um erro por um número que a conta não deveria nem saber que existe.
    veDinheiro ? clubeNaApi(token) : Promise.resolve(null),
    /**
     * As mensalidades exigem `finance.view` **e** `customers.view`: a lista traz
     * nome de gente ao lado de valor. Pedir sem as duas produziria um erro por
     * dado que a conta não deveria nem saber que existe.
     */
    veDinheiro && podeNaTela(estado, 'customers.view')
      ? faturasDoClubeNaApi(token)
      : Promise.resolve(null),
    /*
      A simulação diz **quanto sobra** da mensalidade em cada modelo, e sobra é
      margem: `finance.view_profit`, não `finance.view`. O gerente padrão tem a
      segunda e não a primeira, de propósito — é como o dono delega a operação
      sem entregar a estratégia. Achado da revisão deste bloco.
    */
    veMargem ? simulacaoDaAssinaturaNaApi(token) : Promise.resolve(null),
    // A rentabilidade traz nome de gente ao lado da margem.
    veMargem && podeNaTela(estado, 'customers.view')
      ? rentabilidadeDoClubeNaApi(token)
      : Promise.resolve(null),
  ]);

  const query = await searchParams;
  const erro = first(query['erro']);
  const feito = first(query['feito']);
  const salvo = first(query['salvo']) === '1';

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

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('clube')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const lista = resposta.dados.planos;
  const faturas = cobrancas?.ok ? cobrancas.dados.faturas : null;
  const simulacao: SimulacaoDaAssinaturaNaTela | null = simulada?.ok ? simulada.dados : null;
  const rentabilidade: RentabilidadeDoClubeNaTela | null = rendeu?.ok ? rendeu.dados : null;
  const emAberto = (faturas ?? []).filter((f) => f.estado === 'aberta');
  const fechadas = (faturas ?? []).filter((f) => f.estado !== 'aberta');
  const totalEmAberto = emAberto.reduce((soma, f) => soma + f.valorCents, 0);
  const servicos = catalogo.ok ? catalogo.dados.services.filter((s) => s.active) : [];
  const numeros = clube?.ok ? clube.dados : null;

  return (
    <main className="ui-container painel__conteudo" {...secao('clube')}>
      {topo}

      <h1 className="painel__titulo">Clube</h1>
      <p className="painel__sub">
        Corte tem ciclo de três a quatro semanas — é o serviço mais assinável que existe. O clube
        troca receita variável por receita que entra mesmo no mês fraco.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}
      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Plano salvo.
        </div>
      ) : null}
      {feito && FEITO[feito] ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {FEITO[feito]}
        </div>
      ) : null}

      {numeros ? (
        <section className="pacotes__contas">
          <h2 className="rotulo">Todo mês</h2>
          <dl className="pacotes__numeros">
            <div className="pacotes__numero pacotes__numero--peso">
              <dt>Entra mesmo sem ninguém vir</dt>
              <dd className="tabular">{dinheiro(numeros.mrrCents)}</dd>
              <p className="pacotes__nota">A mensalidade de quem assina, somada.</p>
            </div>
            <div className="pacotes__numero">
              <dt>Assinantes</dt>
              <dd className="tabular">{numeros.ativas}</dd>
              <p className="pacotes__nota">Ativos e em atraso — os dois usam o plano.</p>
            </div>
            <div className="pacotes__numero">
              <dt>Em atraso</dt>
              <dd className="tabular">{numeros.inadimplentes}</dd>
              <p className="pacotes__nota">
                Continuam usando de propósito: cortar no primeiro erro de cartão perde o cliente.
              </p>
            </div>
          </dl>
        </section>
      ) : null}

      {simulacao ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Quanto o clube rende</h2>
          <p className="painel__sub">
            {fraseDaSimulacao({
              receitaCents: simulacao.receitaCents,
              atendimentos: simulacao.atendimentos,
              emUso: simulacao.emUso,
              modelos: simulacao.modelos,
            })}
          </p>

          {/*
            Sem atendimento pago por plano, os três cartões seriam R$ 0,00 lado a
            lado — três números que prometem uma resposta e nunca a dão, que é o
            defeito que o §6 do CLAUDE.md chama de indicador sempre `—`. O estado
            vazio é desenhado e diz o que fará ele aparecer.
          */}
          {simulacao.atendimentos === 0 ? (
            <div className="ui-card vazio">
              <p className="vazio__titulo">Ainda não há o que comparar</p>
              <p className="vazio__saida">
                A comparação aparece quando um assinante for atendido e a comanda fechar com o
                plano como forma de pagamento. Até lá, a comissão do clube segue o modelo em uso:{' '}
                {ROTULO_DO_MODO_DA_ASSINATURA[simulacao.emUso].toLowerCase()}.
              </p>
            </div>
          ) : null}

          {/*
            Os três lado a lado, com o que está em uso marcado. É o que a SPEC
            §3.4 pede em letras: "o sistema precisa mostrar ao dono, antes de ele
            escolher, a simulação dos três sobre os dados reais dele".
          */}
          <div className="modelos">
            {simulacao.modelos.map((m) => (
              <div
                className={`modelo ${m.modo === simulacao.emUso ? 'modelo--em-uso' : ''}`}
                key={m.modo}
              >
                <p className="modelo__nome">
                  {ROTULO_DO_MODO_DA_ASSINATURA[m.modo]}
                  {m.modo === simulacao.emUso ? (
                    <span className="item-cadastro__selo">em uso</span>
                  ) : null}
                </p>
                {/*
                  O número só aparece quando existe. Zero aqui não é "custou
                  zero": é "não houve atendimento" — e as duas coisas na mesma
                  fonte grande é a tela mentindo sobre o que sabe.
                */}
                {simulacao.atendimentos > 0 ? (
                  <>
                    <p className="modelo__valor tabular">{dinheiro(m.comissaoCents)}</p>
                    <p className="modelo__nota">
                      de comissão sobre {dinheiro(simulacao.receitaCents)} de mensalidade —{' '}
                      {Math.round(m.pesoBps / 100)}%
                    </p>
                  </>
                ) : null}
                <p className="modelo__nota">{EXPLICACAO_DO_MODO_DA_ASSINATURA[m.modo]}</p>
              </div>
            ))}
          </div>

          {mexeNaComissao ? (
            <form action={acaoSalvarModeloDaAssinatura} className="formulario">
              <div className="campos-lado">
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="modo">
                    Como pagar a comissão do assinante
                  </label>
                  <select className="ui-field__input" defaultValue={simulacao.emUso} id="modo" name="modo">
                    {MODOS_DA_ASSINATURA.map((modo) => (
                      <option key={modo} value={modo}>
                        {ROTULO_DO_MODO_DA_ASSINATURA[modo]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="teto">
                    Teto do híbrido (% da mensalidade)
                  </label>
                  <input
                    className="ui-field__input"
                    defaultValue={60}
                    id="teto"
                    inputMode="numeric"
                    max={100}
                    min={0}
                    name="tetoPercent"
                    type="number"
                  />
                  <p className="ui-field__hint">Só vale no modelo com teto.</p>
                </div>
              </div>
              <button className="ui-button ui-button--secondary" type="submit">
                Salvar modelo
              </button>
              <p className="painel__nota">
                Vale a partir do próximo fechamento. Período já fechado não muda — a comissão paga
                fica como foi paga.
              </p>
            </form>
          ) : null}

          {rentabilidade && rentabilidade.assinantes.length > 0 ? (
            <details className="dobra">
              <summary className="dobra__titulo">
                Assinante a assinante ({rentabilidade.assinantes.length})
              </summary>
              <p className="ui-field__hint">
                Do que menos sobra para o que mais sobra. Margem negativa não é necessariamente
                erro: um plano que enche a terça pode valer a pena. O que não pode é você não saber.
              </p>
              <div className="ui-scroll-x">
                <table className="clube-faturas">
                  <thead>
                    <tr>
                      <th scope="col">Assinante</th>
                      <th scope="col">Usos</th>
                      <th scope="col">Pagou</th>
                      <th scope="col">Custou</th>
                      <th scope="col">Sobrou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rentabilidade.assinantes.map((a) => (
                      <tr key={a.assinaturaId}>
                        <td>{a.cliente}</td>
                        <td className="tabular">{a.usos}</td>
                        <td className="tabular">{dinheiro(a.mensalidadeCents)}</td>
                        <td className="tabular">
                          {dinheiro(a.comissaoCents + a.insumoCents)}
                        </td>
                        <td className={`tabular ${a.margemCents < 0 ? 'modelo__negativo' : ''}`}>
                          {dinheiro(a.margemCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {faturas ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Mensalidades a receber</h2>

          {emAberto.length === 0 ? (
            <div className="ui-card vazio">
              <p className="vazio__titulo">Nenhuma mensalidade em aberto</p>
              <p className="vazio__saida">
                Todo mundo está em dia. A cobrança do ciclo novo é emitida de madrugada, no dia em
                que o ciclo de cada assinante vira.
              </p>
            </div>
          ) : (
            <>
              <p className="painel__sub">
                <span className="tabular">{dinheiro(totalEmAberto)}</span> em{' '}
                <span className="tabular">{emAberto.length}</span>{' '}
                {emAberto.length === 1 ? 'mensalidade' : 'mensalidades'}. Quem está em atraso
                continua cortando — o plano só pausa depois de quinze dias, e sempre avisado.
              </p>
              <ul className="lista-cadastro">
                {emAberto.map((fatura) => (
                  <Fatura fatura={fatura} key={fatura.id} podeMexer={podeMexer} />
                ))}
              </ul>
            </>
          )}

          {fechadas.length > 0 ? (
            <details className="dobra">
              <summary className="dobra__titulo">
                Histórico ({fechadas.length})
              </summary>
              <div className="ui-scroll-x">
                <table className="clube-faturas">
                  <thead>
                    <tr>
                      <th scope="col">Cliente</th>
                      <th scope="col">Ciclo</th>
                      <th scope="col">Valor</th>
                      <th scope="col">Como ficou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fechadas.map((f) => (
                      <tr key={f.id}>
                        <td>{f.cliente}</td>
                        <td className="tabular">{dia(f.periodoDe)}</td>
                        <td className="tabular">{dinheiro(f.valorCents)}</td>
                        <td>
                          {f.estado === 'paga'
                            ? `Paga em ${f.pagaEm ? dia(f.pagaEm) : '—'}${
                                f.metodo ? ` (${f.metodo})` : ''
                              }`
                            : 'Cancelada'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      <h2 className="rotulo">Planos</h2>

      {lista.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Nenhum plano ainda</p>
          <p className="vazio__saida">
            Comece por um só, com o serviço mais pedido. Dois cortes por mês a um preço abaixo de
            dois cortes avulsos é o formato que mais funciona — e o intervalo mínimo é o que faz
            um plano ilimitado caber no caixa.
          </p>
        </div>
      ) : (
        <ul className="lista-cadastro">
          {lista.map((plano) => (
            <Plano key={plano.id} plano={plano} podeMexer={podeMexer} servicos={servicos} />
          ))}
        </ul>
      )}

      {podeMexer && servicos.length > 0 ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Criar plano</h2>
          <CamposDoPlano prefixo="novo" servicos={servicos} />
        </section>
      ) : null}

      <p className="painel__nota">
        Para assinar alguém, abra a ficha do cliente. O uso do plano acontece na{' '}
        <a href="/admin/comanda">comanda</a>, como forma de pagamento — o item continua com o
        preço de tabela, para a comissão do barbeiro não cair porque o cliente é assinante.
      </p>
    </main>
  );
}
