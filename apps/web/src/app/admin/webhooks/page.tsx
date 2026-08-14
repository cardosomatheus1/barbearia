import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { EVENTOS_DE_WEBHOOK, ROTULO_DO_EVENTO, ehEventoDeWebhook } from '@barbearia/core';
import { webhooksNaApi, type EndpointNaApi, type EntregaNaApi } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSenhaDeUmaVez, lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoCadastrarWebhook, acaoDesligarWebhook, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * Webhooks para terceiros (bloco 79).
 *
 * ## A tela diz o que sai, porque o que sai é pouco de propósito
 *
 * O corpo carrega id do objeto, tipo do evento e instante — e nada sobre uma
 * pessoa. A barbearia precisa saber disso antes de cadastrar o endereço do
 * sistema de outra empresa, senão ela promete ao integrador um dado que nunca
 * vai chegar.
 *
 * ## O segredo aparece uma vez
 *
 * Mesmo mecanismo da chave de API: cookie `httpOnly` de dois minutos com
 * caminho restrito. A diferença é que aqui o banco guarda o segredo cifrado,
 * porque quem assina somos nós — e mesmo assim a tela não o mostra de novo:
 * devolvê-lo faria toda abertura da tela mandar credencial viva pela rede.
 */

export const metadata: Metadata = {
  title: 'Webhooks',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const quando = (iso: string): string =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const ROTULO_DO_ESTADO: Readonly<Record<string, string>> = {
  pendente: 'na fila',
  entregue: 'entregue',
  falhou: 'falhou',
  desistiu: 'desistiu',
};

function Entrega({ entrega }: { readonly entrega: EntregaNaApi }) {
  const rotulo = ehEventoDeWebhook(entrega.evento)
    ? ROTULO_DO_EVENTO[entrega.evento]
    : entrega.evento;

  return (
    <tr>
      <td>{rotulo}</td>
      <td className="tabular">{quando(entrega.criadaEm)}</td>
      <td>
        <span className={`entrega-estado entrega-estado--${entrega.estado}`}>
          {ROTULO_DO_ESTADO[entrega.estado] ?? entrega.estado}
        </span>
      </td>
      <td className="tabular">{entrega.tentativas}</td>
      <td className="entrega-motivo">
        {entrega.respostaHttp !== null ? `HTTP ${entrega.respostaHttp}` : ''}
        {entrega.erro ? ` · ${entrega.erro}` : ''}
        {entrega.respostaHttp === null && !entrega.erro ? '—' : ''}
      </td>
    </tr>
  );
}

function Endpoint({ endpoint }: { readonly endpoint: EndpointNaApi }) {
  return (
    <li className={endpoint.ativo ? 'chave' : 'chave chave--morta'}>
      <div className="chave__cabeca">
        <h3 className="chave__nome">{endpoint.nome}</h3>
        <code className="chave__prefixo">{endpoint.url}</code>
      </div>

      <p className="chave__escopos">
        {endpoint.eventos
          .map((e) => (ehEventoDeWebhook(e) ? ROTULO_DO_EVENTO[e] : e))
          .join(' · ')}
      </p>

      {endpoint.ativo ? (
        <form action={acaoDesligarWebhook} className="chave__revogar">
          <input name="endpointId" type="hidden" value={endpoint.id} />
          <button className="ui-button ui-button--ghost chave__acao" type="submit">
            Desligar
          </button>
        </form>
      ) : (
        <p className="chave__revogada">Desligado. As entregas antigas continuam no histórico.</p>
      )}
    </li>
  );
}

export default async function WebhooksPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await webhooksNaApi(token);
  const query = await searchParams;
  const desligado = first(query['desligado']) === '1';
  const novo = await lerSenhaDeUmaVez();

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
      <main className="ui-container painel__conteudo" {...secao('webhooks')}>
        {topo}
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar os webhooks. <a href="/admin/webhooks">Tentar de novo</a>
        </div>
      </main>
    );
  }

  const { endpoints, entregas } = resposta.dados;
  const ativos = endpoints.filter((e) => e.ativo);

  return (
    <main className="ui-container painel__conteudo" {...secao('webhooks')}>
      {topo}

      <h1 className="painel__titulo">Webhooks</h1>
      <p className="painel__sub">
        Avisamos outro sistema assim que algo acontece aqui. O aviso leva o tipo do evento e o
        identificador — nunca nome, telefone ou valor: quem precisa do detalhe busca pela{' '}
        <a href="/admin/chaves">chave de API</a>, que tem escopo e deixa rastro.
      </p>

      {novo ? (
        <div className="ui-alert ui-alert--success chave-nova" role="status">
          <p className="chave-nova__aviso">
            Guarde agora — <strong>esta é a única vez</strong> que o segredo aparece. É com ele
            que o outro lado confere a assinatura de cada aviso.
          </p>
          <code className="chave-nova__valor">{novo.senha}</code>
        </div>
      ) : null}

      {desligado ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Endereço desligado. Nenhum aviso novo sai para ele.
        </div>
      ) : null}

      <section className="painel__grupo">
        <h2 className="painel__secao">Cadastrar um endereço</h2>
        <p className="plano__nota">
          Só <code>https://</code>: a assinatura prova de onde o aviso veio, mas não esconde o que
          ele diz. Cada envio leva o cabeçalho <code>barber-dock-signature</code> no formato{' '}
          <code>t=…,v1=…</code> — o mesmo que a Stripe usa, então a maioria das bibliotecas já
          sabe conferir.
        </p>
        <form action={acaoCadastrarWebhook} className="formulario chave-form">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="webhook-nome">
              Nome
            </label>
            <input
              className="ui-field__input"
              id="webhook-nome"
              maxLength={80}
              minLength={2}
              name="nome"
              placeholder="ERP do contador"
              required
              type="text"
            />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="webhook-url">
              Endereço
            </label>
            <input
              className="ui-field__input"
              id="webhook-url"
              maxLength={500}
              name="url"
              placeholder="https://seusistema.com.br/barber-dock"
              required
              type="url"
            />
          </div>

          <fieldset className="chave-escopos">
            <legend className="ui-field__label">Quando avisar</legend>
            {EVENTOS_DE_WEBHOOK.map((evento) => (
              <label className="ui-field__label chave-escopo" key={evento}>
                <input name="eventos" type="checkbox" value={evento} />
                <span>
                  {ROTULO_DO_EVENTO[evento]} <code>{evento}</code>
                </span>
              </label>
            ))}
          </fieldset>

          <button className="ui-button ui-button--primary chave-form__acao" type="submit">
            Cadastrar
          </button>
        </form>
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">
          Endereços{' '}
          <span className="padrao-lista__contagem tabular">
            {ativos.length} {ativos.length === 1 ? 'ativo' : 'ativos'}
          </span>
        </h2>
        {endpoints.length === 0 ? (
          <p className="plano__vazio">
            Nenhum endereço ainda. É o estado normal: só quem tem outro sistema para avisar
            precisa de um.
          </p>
        ) : (
          <ul className="chave-lista">
            {endpoints.map((e) => (
              <Endpoint endpoint={e} key={e.id} />
            ))}
          </ul>
        )}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Últimos avisos</h2>
        <p className="plano__nota">
          Um aviso que falha é tentado de novo por até seis horas. Contra um erro definitivo do
          outro lado — endereço errado, segredo errado — ele desiste na hora: repetir seria
          insistir com uma resposta que já se sabe.
        </p>
        {entregas.length === 0 ? (
          <p className="plano__vazio">
            Nenhum aviso ainda. Eles aparecem aqui assim que o primeiro evento acontecer.
          </p>
        ) : (
          <div className="ui-scroll-x">
            <table className="plano-faturas">
              <thead>
                <tr>
                  <th scope="col">Evento</th>
                  <th scope="col">Quando</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Tentativas</th>
                  <th scope="col">Resposta</th>
                </tr>
              </thead>
              <tbody>
                {entregas.map((e) => (
                  <Entrega entrega={e} key={e.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
