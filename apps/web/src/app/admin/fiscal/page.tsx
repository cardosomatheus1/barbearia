import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DA_NOTA,
  EXPLICACAO_DO_REGIME,
  REGIMES_FISCAIS,
  ROTULO_DA_NOTA,
  ROTULO_DO_REGIME,
} from '@barbearia/core';
import {
  configuracaoFiscalNaApi,
  notasNaApi,
  type NotaNaTela,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoCancelarNota, acaoSair, acaoSalvarFiscal } from '../acoes';
import { secao } from '../secoes';

/**
 * Nota fiscal (bloco 53, SPEC §3.11).
 *
 * A tela responde duas perguntas em ordem: *"a casa está pronta para emitir?"* e
 * *"o que saiu?"*. O cadastro vem primeiro porque sem ele a lista é sempre
 * vazia — e uma lista vazia sem explicação é o pior estado que uma tela pode
 * ter.
 *
 * ## O que a tela **não** faz
 *
 * Não escolhe regra municipal, não numera RPS, não pergunta por certificado. Se
 * um dia aparecer aqui um campo perguntando como Salvador numera nota, a decisão
 * de arquitetura da SPEC §3.11 já foi perdida — e ela existe para o time manter
 * produto, não integração fiscal.
 */

export const metadata: Metadata = {
  title: 'Nota fiscal',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  cnpj_invalido: 'Confira o CNPJ: os dígitos verificadores não fecham.',
  regime_invalido: 'Escolha um regime.',
  codigo_de_servico_obrigatorio: 'Informe o código de serviço municipal.',
  aliquota_invalida: 'O ISS vai de 0 a 5% — é o teto da lei complementar.',
  municipio_obrigatorio: 'O código IBGE do município tem 7 dígitos.',
  nao_configurado: 'Cadastre CNPJ e regime antes de emitir nota.',
  nota_nao_encontrada: 'Esta nota não existe.',
  nota_nao_cancelavel: 'Só uma nota autorizada pode ser cancelada.',
  motivo_obrigatorio: 'Escreva o motivo do cancelamento.',
  venda_nao_encontrada: 'Esta venda não existe.',
  nao_emite: 'Esta venda não gera nota.',
  forbidden: 'Sua conta não mexe no fiscal da casa.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

/** Pontos-base viram porcentagem só na hora de mostrar. */
const percent = (bps: number): string => (bps / 100).toFixed(2).replace('.', ',');

const dataCurta = (iso: string): string => {
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}` : iso;
};

/** "11.222.333/0001-81" — só para ler; o que vai e volta são os dígitos. */
function cnpjBonito(digitos: string): string {
  if (digitos.length !== 14) return digitos;
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`;
}

function Nota({ nota, podeEmitir }: { readonly nota: NotaNaTela; readonly podeEmitir: boolean }) {
  return (
    <li>
      <article
        className={`item-cadastro${nota.estado === 'cancelada' ? ' item-cadastro--fora' : ''}`}
      >
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">
              {nota.numero ? `Nota ${nota.numero}` : 'Nota sem número ainda'}
            </h3>
            <p className="item-cadastro__linha">
              {dataCurta(nota.pedidaEm)} · {nota.clienteNome ?? 'Consumidor'} ·{' '}
              {ROTULO_DA_NOTA[nota.estado]}
            </p>
            <p className="item-cadastro__linha">{EXPLICACAO_DA_NOTA[nota.estado]}</p>
            {nota.motivoDaRecusa ? (
              <p className="item-cadastro__linha item-cadastro__risco">{nota.motivoDaRecusa}</p>
            ) : null}
            {/* A repartição do Salão-Parceiro só chega para quem tem
                `commission.view_all` — ela é a comissão do profissional naquela
                venda. Para a recepção o campo simplesmente não vem. */}
            {nota.parceiroCents !== undefined && nota.parceiroCents > 0 ? (
              <p className="item-cadastro__linha">
                Parcela do profissional: {reais(nota.parceiroCents)} · da casa:{' '}
                {reais(nota.casaCents ?? nota.servicoCents - nota.parceiroCents)}
              </p>
            ) : null}
          </div>
          <span className="conta__valor tabular">{reais(nota.servicoCents)}</span>
        </div>

        {/*
          Toda nota leva à venda que a gerou. Sem isto, a recusa da prefeitura
          era um beco: a linha dizia "corrija e emita de novo" e a única tela
          com o botão de emitir — a da comanda — não tinha como ser alcançada
          daqui (§6, pergunta 1). É também para onde se vai conferir o que foi
          vendido quando o valor da nota parece errado.
        */}
        <p className="item-cadastro__acao">
          <a className="ui-button ui-button--ghost" href={`/admin/comanda/${nota.orderId}`}>
            Ver a venda
          </a>
          {nota.linkPdf ? (
            <a className="ui-button ui-button--ghost" href={nota.linkPdf}>
              Abrir o PDF
            </a>
          ) : null}
        </p>

        {podeEmitir && nota.estado === 'autorizada' ? (
          <details className="dobra">
            <summary className="dobra__titulo">Cancelar na prefeitura</summary>
            <form action={acaoCancelarNota} className="formulario">
              <input name="notaId" type="hidden" value={nota.id} />
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={`motivo-${nota.id}`}>
                  Por quê
                </label>
                <input
                  className="ui-field__input"
                  id={`motivo-${nota.id}`}
                  minLength={3}
                  name="motivo"
                  placeholder="Valor lançado errado"
                  required
                />
                <p className="ui-field__hint">
                  A nota some da vitrine do cliente, mas o número que foi à prefeitura fica
                  registrado aqui — é ele que o contador procura.
                </p>
              </div>
              <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                Cancelar esta nota
              </button>
            </form>
          </details>
        ) : null}
      </article>
    </li>
  );
}

export default async function FiscalPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const podeCadastrar = podeNaTela(estado, 'fiscal.settings');
  const podeEmitir = podeNaTela(estado, 'fiscal.issue');
  // A listagem devolve muitas notas com valor: é faturamento por outro caminho,
  // e a rota exige `finance.view` junto. Pedir sem ela daria 403 na abertura.
  const veLista = podeNaTela(estado, 'fiscal.view') && podeNaTela(estado, 'finance.view');

  const hoje = new Date().toISOString().slice(0, 10);
  const trintaDias = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [config, notas] = await Promise.all([
    podeCadastrar ? configuracaoFiscalNaApi(token) : Promise.resolve(null),
    veLista ? notasNaApi(token, trintaDias, hoje) : Promise.resolve(null),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  const feito = first(query['feito']);
  const atual = config?.ok ? config.dados.configuracao : null;
  const lista = notas?.ok ? notas.dados.notas : [];

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

  return (
    <main className="ui-container painel__conteudo" {...secao('fiscal')}>
      {topo}

      <h1 className="painel__titulo">Nota fiscal</h1>
      <p className="painel__sub">
        A emissão é feita por um emissor contratado — a barbearia cadastra o CNPJ e o regime, e a
        nota sai sozinha.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Cadastro fiscal salvo.
        </div>
      ) : null}

      {feito === 'nota' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Nota pedida. Ela vai para a prefeitura em alguns minutos e o estado aparece aqui.
        </div>
      ) : null}

      {feito === 'nota-cancelada' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Nota cancelada na prefeitura.
        </div>
      ) : null}

      {podeCadastrar ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">O fiscal da casa</h2>

          {!atual ? (
            <p className="painel__nota">
              Ainda não cadastrado. Enquanto não estiver, nenhuma nota é emitida — e a comanda
              fecha normalmente, como sempre.
            </p>
          ) : null}

          <form action={acaoSalvarFiscal} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="cnpj">
                CNPJ
              </label>
              <input
                className="ui-field__input"
                defaultValue={atual ? cnpjBonito(atual.cnpj) : ''}
                id="cnpj"
                inputMode="numeric"
                name="cnpj"
                placeholder="11.222.333/0001-81"
                required
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="regime">
                Regime
              </label>
              <select
                className="ui-field__input"
                defaultValue={atual?.regime ?? 'simples'}
                id="regime"
                name="regime"
              >
                {REGIMES_FISCAIS.map((r) => (
                  <option key={r} value={r}>
                    {ROTULO_DO_REGIME[r]}
                  </option>
                ))}
              </select>
              {/* Só a explicação do regime **em vigor**.
                  As três juntas viravam um parágrafo de cinco linhas que ninguém
                  lê — e o produto não tem componente de cliente para trocar o
                  texto ao mexer no seletor. Quem muda vê a explicação nova
                  depois de salvar, que é quando ela passa a valer. */}
              <p className="ui-field__hint">
                {EXPLICACAO_DO_REGIME[atual?.regime ?? 'simples']}
              </p>
            </div>

            <div className="campos-lado">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="codigoDeServico">
                  Código de serviço
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={atual?.codigoDeServico ?? '14.01'}
                  id="codigoDeServico"
                  name="codigoDeServico"
                  required
                />
                <p className="ui-field__hint">Quase toda cidade usa 14.01. O contador confirma.</p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="issPercent">
                  ISS (%)
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={percent(atual?.issBps ?? 0)}
                  id="issPercent"
                  inputMode="decimal"
                  name="issPercent"
                />
                <p className="ui-field__hint">Máximo 5%, por lei complementar.</p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="municipioIbge">
                  Código IBGE
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={atual?.municipioIbge ?? ''}
                  id="municipioIbge"
                  inputMode="numeric"
                  name="municipioIbge"
                  placeholder="2927408"
                  required
                />
                <p className="ui-field__hint">Sete dígitos. Salvador é 2927408.</p>
              </div>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="inscricaoMunicipal">
                Inscrição municipal <span className="ui-field__hint">(se a cidade exigir)</span>
              </label>
              <input
                className="ui-field__input"
                defaultValue={atual?.inscricaoMunicipal ?? ''}
                id="inscricaoMunicipal"
                name="inscricaoMunicipal"
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="emitirAutomaticamente">
                Quando emitir
              </label>
              <select
                className="ui-field__input"
                defaultValue={atual?.emitirAutomaticamente ? '1' : '0'}
                id="emitirAutomaticamente"
                name="emitirAutomaticamente"
              >
                <option value="0">Só quando eu pedir, comanda por comanda</option>
                <option value="1">Sozinha, toda vez que uma comanda fechar</option>
              </select>
              <p className="ui-field__hint">
                Comece pelo primeiro e confira as primeiras notas. Cada rejeição queima um número
                na prefeitura.
              </p>
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Salvar cadastro fiscal
            </button>
          </form>
        </section>
      ) : null}

      {veLista ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Notas dos últimos 30 dias</h2>
          {lista.length === 0 ? (
            <div className="ui-card vazio">
              <h3 className="vazio__titulo">Nenhuma nota ainda</h3>
              <p>
                {atual
                  ? 'A nota aparece aqui assim que uma comanda com serviço for fechada.'
                  : 'Cadastre CNPJ e regime acima para começar a emitir.'}
              </p>
            </div>
          ) : (
            <ul className="lista-cadastro">
              {lista.map((nota) => (
                <Nota key={nota.id} nota={nota} podeEmitir={podeEmitir} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {!podeCadastrar && !veLista ? (
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA['forbidden']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      ) : null}
    </main>
  );
}
