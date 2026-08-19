import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  aliquotasDoAdquirente,
  catalogoDeServicos,
  equipeDoCadastro,
  regrasDeComissao,
  type RegraDeComissao,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoAliquotaDoAdquirente,
  acaoConfiguracaoDeComissao,
  acaoRemoverRegraDeComissao,
  acaoSair,
  acaoSalvarRegraDeComissao,
} from '../../acoes';
import { secao } from '../../secoes';

/**
 * Regras de comissão.
 *
 * A tela existe para uma pergunta que a barbearia faz em voz alta: "quanto o
 * Ruan ganha na barba?". As regras se sobrepõem de propósito — 40% no geral,
 * 50% na barba, 45% na barba do Ruan — e a mais específica ganha.
 *
 * Por isso a lista é ordenada da mais geral para a mais específica, e cada
 * linha diz a quem se aplica em português. Uma tabela de ids ordenada por data
 * de criação obrigaria o dono a simular a resolução de cabeça.
 *
 * As duas configurações do topo são as que a SPEC §3.4 exige que sejam
 * explícitas. Implícitas, viram a pergunta "por que caiu minha comissão neste
 * mês?" — e ninguém sabe responder.
 */

export const metadata: Metadata = {
  title: 'Regras de comissão',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

/**
 * Os meios que costumam custar taxa, na ordem do extrato do adquirente.
 *
 * `fiado` fica de fora: não é meio de pagamento, é dívida — a taxa vem depois,
 * quando o cliente volta e paga de verdade. Incluí-lo cobraria a maquininha de
 * um dinheiro que não passou por ela.
 */
const MEIOS_COM_TAXA = [
  { valor: 'credit', rotulo: 'Crédito' },
  { valor: 'debit', rotulo: 'Débito' },
  { valor: 'pix', rotulo: 'Pix' },
  { valor: 'link', rotulo: 'Link de pagamento' },
  { valor: 'transfer', rotulo: 'Transferência' },
] as const;

/** Pontos-base para o que o dono digita: 319 → `3,19`. Vazio quando não há. */
const porcentagem = (bps: number | undefined): string =>
  bps === undefined ? '' : (bps / 100).toFixed(2).replace('.', ',');

const FALHA: Record<string, string> = {
  aliquota_invalida: 'Confira a alíquota: use um número entre 0 e 100, como 40 ou 42,5.',
  regra_invalida: 'Regra inválida. Confira a alíquota e as faixas.',
  regra_nao_encontrada: 'Esta regra não existe mais.',
  faixas_ausentes: 'Informe pelo menos uma faixa.',
  valor_invalido: 'Confira o valor: use só números, como 15,00.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não edita regras de comissão.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** 4250 pontos-base viram "42,5%". */
const emPorcento = (pontosBase: number): string =>
  `${(pontosBase / 100).toFixed(2).replace('.', ',').replace(/,?0+$/, '')}%`;

/** "Ruan na Barba", "Na Barba", "Para todos" — a quem a regra se aplica. */
function aQuem(regra: RegraDeComissao): string {
  const alvo = regra.serviceName ?? regra.categoryName;
  if (regra.professionalName && alvo) return `${regra.professionalName} · ${alvo}`;
  if (regra.professionalName) return `${regra.professionalName} · tudo`;
  if (alvo) return `Todos · ${alvo}`;
  return 'Todos · tudo';
}

function comoPaga(regra: RegraDeComissao): string {
  if (regra.modo === 'percent') return emPorcento(regra.valor);
  if (regra.modo === 'fixed') return `${reais(regra.valor)} por item`;
  return regra.faixas
    .map((faixa) =>
      faixa.ateCents === null
        ? `acima: ${emPorcento(faixa.pontosBase)}`
        : `até ${reais(faixa.ateCents)}: ${emPorcento(faixa.pontosBase)}`,
    )
    .join(' · ');
}

export default async function RegrasDeComissaoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const [dados, equipe, catalogo, taxas] = await Promise.all([
    regrasDeComissao(token),
    equipeDoCadastro(token),
    catalogoDeServicos(token),
    aliquotasDoAdquirente(token),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/comissao">
        ← Comissão
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!dados.ok) {
    if (dados.code === 'mfa_required' || dados.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=caixa');
    }
    return (
      <main className="ui-container painel__conteudo" {...secao('comissao')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[dados.code] ?? FALHA['request_failed']} <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const { regras, configuracao } = dados.dados;
  const aliquotas = new Map(
    taxas.ok ? taxas.dados.aliquotas.map((a) => [a.forma, a.bps] as const) : [],
  );
  const profissionais = equipe.ok ? equipe.dados.professionals.filter((p) => p.active) : [];
  const servicos = catalogo.ok ? catalogo.dados.services.filter((s) => s.active) : [];

  return (
    <main className="ui-container painel__conteudo" {...secao('comissao')}>
      {topo}

      <h1 className="painel__titulo">Regras de comissão</h1>
      <p className="painel__sub">
        Quando mais de uma regra serve, vale a <strong>mais específica</strong>: a do profissional
        no serviço ganha da do serviço, que ganha da geral.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Salvo. Vale para as próximas vendas — o que já foi vendido mantém a regra do dia.
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Como a base é calculada</h2>
        <form action={acaoConfiguracaoDeComissao} className="formulario">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="base">
              A comissão incide sobre
            </label>
            <select className="ui-field__input" defaultValue={configuracao.base} id="base" name="base">
              <option value="liquido">O valor líquido, depois do desconto</option>
              <option value="bruto">O valor cheio, antes do desconto</option>
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="tratamentoDoDesconto">
              Quando há desconto na comanda
            </label>
            <select
              className="ui-field__input"
              defaultValue={configuracao.tratamentoDoDesconto}
              id="tratamentoDoDesconto"
              name="tratamentoDoDesconto"
            >
              {/*
                Rótulos curtos porque o seletor é cortado em 390px (bloco 103).
                "O barbeiro divide o desconto com a c…" faz a pessoa escolher sem
                saber o que escolheu, e o significado que muda por opção mora
                **dentro** da opção — a dica abaixo teria que listar os dois de
                uma vez, e vira parágrafo que ninguém lê.
              */}
              <option value="reduz_base">Barbeiro divide o desconto</option>
              <option value="custo_da_casa">Desconto é custo da casa</option>
            </select>
            <p className="ui-field__hint">
              O desconto costuma ser decisão do dono. Fazer o barbeiro pagar por uma cortesia que
              ele não ofereceu é a segunda maior fonte de discussão, depois da própria alíquota.
            </p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="tratamentoDaTaxa">
              A taxa da maquininha
            </label>
            <select
              className="ui-field__input"
              defaultValue={configuracao.tratamentoDaTaxa}
              id="tratamentoDaTaxa"
              name="tratamentoDaTaxa"
            >
              <option value="absorvida">É custo da casa; a base não cai</option>
              <option value="rateada">O barbeiro divide a taxa com a casa</option>
            </select>
            <p className="ui-field__hint">
              Diferente do desconto num ponto que importa: o desconto é decisão de alguém, a taxa
              não é de ninguém — quem escolheu crédito em três vezes foi o cliente. Só vale se
              você cadastrar as alíquotas abaixo.
            </p>
          </div>

          <button className="ui-button ui-button--ghost ui-button--block" type="submit">
            Salvar
          </button>
        </form>
      </section>

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">O que cada meio de pagamento custa</h2>
        <p className="cartao-balcao__texto">
          O que o adquirente cobra da barbearia, por forma de pagamento. Cadastre só o que você
          paga — o que ficar em branco não custa nada. A alíquota é congelada em cada venda:
          renegociar a maquininha não muda comissão que já foi fechada.
        </p>

        <ul className="aliquotas">
          {MEIOS_COM_TAXA.map((meio) => (
            <li className="aliquotas__item" key={meio.valor}>
              <form action={acaoAliquotaDoAdquirente} className="aliquotas__linha">
                <input name="forma" type="hidden" value={meio.valor} />
                {/*
                  A unidade no rótulo (bloco 103). "Crédito 3,19" sem o símbolo
                  lê tão bem como R$ 3,19 quanto como 3,19% — e duas seções
                  abaixo, na mesma tela, as regras de comissão aparecem como
                  "40%". O número alimenta `orders.fee_cents`, que é congelado
                  em cada venda: errar a leitura aqui erra a comissão de todo
                  mundo até alguém notar.
                */}
                <label className="ui-field__label aliquotas__nome" htmlFor={`bps-${meio.valor}`}>
                  {meio.rotulo} (%)
                </label>
                <input
                  className="ui-field__input aliquotas__campo"
                  defaultValue={porcentagem(aliquotas.get(meio.valor))}
                  id={`bps-${meio.valor}`}
                  inputMode="decimal"
                  name="bps"
                  placeholder="0,00"
                />
                <button className="ui-button ui-button--ghost aliquotas__botao" type="submit">
                  Salvar
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Regras</h2>
        {regras.length === 0 ? (
          <p className="vazio">
            Nenhuma regra ainda — e sem regra <strong>nenhuma comissão é gerada</strong>. Comece
            pela geral: uma alíquota que vale para todo mundo em tudo.
          </p>
        ) : (
          <ul className="regras-comissao">
            {regras.map((regra) => (
              <li className="regra-comissao" key={regra.id}>
                <div className="regra-comissao__quem">
                  <span className="regra-comissao__alvo">{aQuem(regra)}</span>
                  <span className="regra-comissao__como">{comoPaga(regra)}</span>
                </div>
                <form action={acaoRemoverRegraDeComissao}>
                  <input name="id" type="hidden" value={regra.id} />
                  <button
                    aria-label={`Remover a regra de ${aQuem(regra)}`}
                    className="ui-button ui-button--ghost regra-comissao__tirar"
                    type="submit"
                  >
                    Remover
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="dobra">
        <summary className="dobra__titulo">Nova regra</summary>
        <form action={acaoSalvarRegraDeComissao} className="formulario">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="professionalId">
              Para quem
            </label>
            <select className="ui-field__input" id="professionalId" name="professionalId">
              <option value="">Todos os profissionais</option>
              {profissionais.map((pro) => (
                <option key={pro.id} value={pro.id}>
                  {pro.name}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="serviceId">
              Em qual serviço
            </label>
            <select className="ui-field__input" id="serviceId" name="serviceId">
              <option value="">Todos os serviços</option>
              {servicos.map((servico) => (
                <option key={servico.id} value={servico.id}>
                  {servico.name}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="modo">
              Como paga
            </label>
            <select className="ui-field__input" defaultValue="percent" id="modo" name="modo">
              <option value="percent">Porcentagem do valor</option>
              <option value="fixed">Valor fixo por item</option>
              <option value="tiers">Faixas progressivas</option>
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="aliquota">
              Porcentagem
            </label>
            <input
              className="ui-field__input"
              id="aliquota"
              inputMode="decimal"
              name="aliquota"
              placeholder="40"
            />
            <p className="ui-field__hint">Só para “porcentagem do valor”.</p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="valorFixo">
              Valor fixo
            </label>
            <input
              className="ui-field__input"
              id="valorFixo"
              inputMode="decimal"
              name="valorFixo"
              placeholder="15,00"
            />
            <p className="ui-field__hint">Só para “valor fixo por item”.</p>
          </div>

          <fieldset className="faixas-comissao">
            <legend className="faixas-comissao__legenda">Faixas progressivas</legend>
            <p className="ui-field__hint">
              Cada faixa vale <strong>só sobre a parte que cai nela</strong>, como imposto de renda:
              com 40% até R$ 5.000 e 45% acima, faturar R$ 6.000 rende R$ 2.000 + R$ 450. A última
              faixa não tem teto.
            </p>

            {[0, 1, 2].map((i) => (
              <div className="faixas-comissao__linha" key={i}>
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`faixaAte${i}`}>
                    {i === 2 ? 'Acima disso' : `Até`}
                  </label>
                  <input
                    className="ui-field__input"
                    disabled={i === 2}
                    id={`faixaAte${i}`}
                    inputMode="decimal"
                    name={`faixaAte${i}`}
                    placeholder={i === 2 ? 'sem teto' : '5000,00'}
                  />
                </div>
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`faixaPontos${i}`}>
                    Paga
                  </label>
                  <input
                    className="ui-field__input"
                    id={`faixaPontos${i}`}
                    inputMode="decimal"
                    name={`faixaPontos${i}`}
                    placeholder="40"
                  />
                </div>
              </div>
            ))}
          </fieldset>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Salvar regra
          </button>
        </form>
      </details>
    </main>
  );
}
