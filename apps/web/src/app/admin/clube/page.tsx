import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { fraseDoBloqueio } from '@barbearia/core';
import {
  catalogoDeServicos,
  clubeNaApi,
  planosContadosNaApi,
  planosNaApi,
  type PlanoNaTela,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair, acaoSalvarPlano } from '../acoes';
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
  forbidden: 'Sua conta não mexe no clube.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
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

export default async function ClubePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'finance.subscription_manage');
  const veDinheiro = podeMexer && podeNaTela(estado, 'finance.view');

  const [resposta, catalogo, clube] = await Promise.all([
    // Com a contagem só para quem pode ver o MRR: ela × preço é o faturamento
    // recorrente da casa, e a rota aberta devolve zero de propósito.
    veDinheiro ? planosContadosNaApi(token, true) : planosNaApi(token, true),
    catalogoDeServicos(token),
    // A rota exige as duas permissões que ela devolve; pedir sem elas produziria
    // um erro por um número que a conta não deveria nem saber que existe.
    veDinheiro ? clubeNaApi(token) : Promise.resolve(null),
  ]);

  const query = await searchParams;
  const erro = first(query['erro']);
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
