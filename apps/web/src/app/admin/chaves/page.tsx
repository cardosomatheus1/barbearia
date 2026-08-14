import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { PREFIXO_DA_CHAVE, TETO_POR_MINUTO } from '@barbearia/core';
import { chavesNaApi, type ChaveNaApi } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSenhaDeUmaVez, lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoCriarChave, acaoRevogarChave, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * Chaves da API pública (bloco 78).
 *
 * ## O segredo aparece uma vez, e a tela diz isso antes
 *
 * A chave inteira volta num cookie `httpOnly` de dois minutos com caminho
 * restrito — o mesmo mecanismo da senha de primeiro acesso do bloco 29, e pela
 * mesma razão: parâmetro de consulta fica no histórico do navegador, no
 * autocompletar e em qualquer referrer. Depois disso o banco só tem o HMAC, e
 * não existe rota que releia o segredo porque não existe segredo para reler.
 *
 * ## O que a tela não oferece
 *
 * Escopo de dinheiro. Ele nem aparece na lista, e a razão está escrita ao lado:
 * o segundo fator deste produto é provado por sessão, com TOTP, e máquina não
 * digita TOTP. Esconder sem dizer faria a barbearia concluir que o produto está
 * quebrado; oferecer e recusar depois seria pior.
 */

export const metadata: Metadata = {
  title: 'Chaves de API',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const dia = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

function Chave({ chave }: { readonly chave: ChaveNaApi }) {
  const viva = chave.revogadaEm === null;

  return (
    <li className={viva ? 'chave' : 'chave chave--morta'}>
      <div className="chave__cabeca">
        <h3 className="chave__nome">{chave.nome}</h3>
        <code className="chave__prefixo">
          {PREFIXO_DA_CHAVE}
          {chave.prefixo}…
        </code>
      </div>

      <p className="chave__escopos">{chave.escopos.join(' · ')}</p>

      <p className="chave__datas">
        Criada em {dia(chave.criadaEm)} ·{' '}
        {chave.usadaEm ? `usada por último em ${dia(chave.usadaEm)}` : 'nunca usada'}
      </p>

      {viva ? (
        <form action={acaoRevogarChave} className="chave__revogar">
          <input name="chaveId" type="hidden" value={chave.id} />
          <label className="ui-field__label" htmlFor={`motivo-${chave.id}`}>
            Motivo
          </label>
          <input
            className="ui-field__input"
            id={`motivo-${chave.id}`}
            maxLength={500}
            minLength={5}
            name="motivo"
            placeholder="Ex.: integração desligada"
            required
            type="text"
          />
          <button className="ui-button ui-button--ghost chave__acao" type="submit">
            Revogar
          </button>
        </form>
      ) : (
        <p className="chave__revogada">
          Revogada em {dia(chave.revogadaEm ?? '')} — {chave.motivoDaRevogacao}
        </p>
      )}
    </li>
  );
}

export default async function ChavesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await chavesNaApi(token);
  const query = await searchParams;
  const revogada = first(query['revogada']) === '1';
  const nova = await lerSenhaDeUmaVez();

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
      <main className="ui-container painel__conteudo" {...secao('chaves')}>
        {topo}
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as chaves. <a href="/admin/chaves">Tentar de novo</a>
        </div>
      </main>
    );
  }

  const { chaves, disponiveis } = resposta.dados;
  const vivas = chaves.filter((c) => c.revogadaEm === null);

  return (
    <main className="ui-container painel__conteudo" {...secao('chaves')}>
      {topo}

      <h1 className="painel__titulo">Chaves de API</h1>
      <p className="painel__sub">
        Para o seu site, o seu ERP ou quem mais precise ler a agenda e marcar horário. Cada chave
        faz até {TETO_POR_MINUTO} chamadas por minuto — o teto é da chave, não do computador que a
        usa.
      </p>

      {nova ? (
        /**
         * O segredo, uma vez. O cookie vale dois minutos e some ao ser lido.
         */
        <div className="ui-alert ui-alert--success chave-nova" role="status">
          <p className="chave-nova__aviso">
            Copie agora — <strong>esta é a única vez</strong> que a chave aparece. Depois daqui só
            existe o resumo dela no nosso banco, e nem nós conseguimos lê-la de volta.
          </p>
          <code className="chave-nova__valor">{nova.senha}</code>
        </div>
      ) : null}

      {revogada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Chave revogada. Ela para de funcionar na próxima chamada.
        </div>
      ) : null}

      <section className="painel__grupo">
        <h2 className="painel__secao">Emitir uma chave</h2>
        <p className="plano__nota">
          Marque só o que a integração precisa. Escopos de dinheiro — caixa, faturamento e
          comissão — não aparecem aqui de propósito: eles exigem segundo fator a cada 30 minutos,
          e um programa não digita o código do aplicativo autenticador.
        </p>

        {disponiveis.length === 0 ? (
          <p className="plano__vazio">
            Você não tem nenhuma permissão que possa virar escopo. Ninguém dá a uma chave o que
            não tem — peça ao dono da conta.
          </p>
        ) : (
          <form action={acaoCriarChave} className="formulario chave-form">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="chave-nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                id="chave-nome"
                maxLength={80}
                minLength={2}
                name="nome"
                placeholder="Integração do site"
                required
                type="text"
              />
            </div>

            <fieldset className="chave-escopos">
              <legend className="ui-field__label">O que ela pode fazer</legend>
              {disponiveis.map((escopo) => (
                <label className="ui-field__label chave-escopo" key={escopo}>
                  <input name="escopos" type="checkbox" value={escopo} />
                  <code>{escopo}</code>
                </label>
              ))}
            </fieldset>

            <button className="ui-button ui-button--primary chave-form__acao" type="submit">
              Emitir
            </button>
          </form>
        )}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">
          Chaves{' '}
          <span className="padrao-lista__contagem tabular">
            {vivas.length} {vivas.length === 1 ? 'ativa' : 'ativas'}
          </span>
        </h2>
        {chaves.length === 0 ? (
          <p className="plano__vazio">
            Nenhuma chave ainda. É o estado normal: só quem integra outro sistema precisa de uma.
          </p>
        ) : (
          <ul className="chave-lista">
            {chaves.map((c) => (
              <Chave chave={c} key={c.id} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
