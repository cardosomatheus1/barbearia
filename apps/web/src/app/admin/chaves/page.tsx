import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  ESCOPOS_COM_ROTA,
  PREFIXO_DA_CHAVE,
  TETO_POR_MINUTO,
  type ApiKeyFailure,
  type Permissao,
} from '@barbearia/core';
import { chavesNaApi, type ChaveNaApi } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSenhaDeUmaVez, lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoCriarChave, acaoRevogarChave, acaoSair } from '../acoes';
import { secao } from '../secoes';
import { FalhaDaLeitura } from '../falha-da-leitura';

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

/**
 * O que cada recusa quer dizer, na língua de quem opera (bloco 112).
 *
 * A tela nunca leu `?erro=`: emitir uma chave com o servidor sem
 * `API_KEY_PEPPER` recarregava a página vazia, e o dono clicava de novo. Chave
 * estreita de propósito — com `Record<string, …>` o código novo cairia em
 * `undefined` e a caixa nasceria em branco.
 */
const FALHA_DA_CHAVE: Record<ApiKeyFailure | 'invalid_request' | 'erro_inesperado', string> = {
  pepper_ausente:
    'A chave que protege as credenciais da API não está configurada no servidor ' +
    '(API_KEY_PEPPER). Sem ela nenhuma chave pode ser emitida — fale com quem instalou.',
  escopo_vazio: 'Marque ao menos uma permissão: uma chave sem escopo não faz nada.',
  escopo_desconhecido: 'Uma das permissões enviadas não existe.',
  escopo_de_dinheiro:
    'Chave de API não move dinheiro. Essas operações exigem o segundo fator, que se prova por ' +
    'sessão — e máquina não digita código de seis dígitos.',
  escopo_irreversivel:
    'Exportar e anonimizar cadastro não saem por chave: são atos de LGPD, e uma pessoa responde ' +
    'por eles.',
  escopo_alem_do_ator: 'Você só concede o que você mesmo tem. Peça ao dono primeiro.',
  chave_nao_encontrada: 'Essa chave não existe mais.',
  motivo_obrigatorio: 'Escreva o motivo da revogação — é o que explica a decisão depois.',
  invalid_request: 'Confira os campos: algo veio fora do formato esperado.',
  erro_inesperado: 'Não deu para emitir a chave. Tente de novo.',
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
  const erro = first(query['erro']);
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
        <FalhaDaLeitura code={resposta.code} href="/admin/chaves" oque="as chaves" />
      </main>
    );
  }

  const { chaves, disponiveis } = resposta.dados;
  // A separação vem do domínio, não de uma lista escrita ao lado: `core` é quem
  // sabe qual escopo tem rota, e uma varredura do portão cobra a verdade dele.
  const comRota = disponiveis.filter((escopo) => ESCOPOS_COM_ROTA.includes(escopo as Permissao));
  const semRota = disponiveis.filter((escopo) => !ESCOPOS_COM_ROTA.includes(escopo as Permissao));
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

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA_DA_CHAVE[erro as ApiKeyFailure] ?? FALHA_DA_CHAVE['erro_inesperado']}
        </div>
      ) : null}

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

            {/*
              O que a API honra **hoje**, separado do resto (bloco 112).

              A lista inteira sob "O que ela pode fazer" prometia trinta e uma
              coisas e duas respondiam: o dono marcava `fiscal.issue` porque o
              integrador pediu, e nada acontecia — não havia nem o que recusar.

              Os demais continuam concedíveis e aparecem **marcados**, que é a
              regra deste repositório para gatilho que ainda não funciona:
              escondê-los faria a lista parecer completa, e a chave que os tem
              passa a valer no dia em que a rota existir — o que é decisão de
              quem emite, e por isso precisa estar escrito na hora de emitir.
            */}
            <fieldset className="chave-escopos">
              <legend className="ui-field__label">O que a API responde hoje</legend>
              {comRota.map((escopo) => (
                <label className="ui-field__label chave-escopo" key={escopo}>
                  <input name="escopos" type="checkbox" value={escopo} />
                  <code>{escopo}</code>
                </label>
              ))}
            </fieldset>

            {semRota.length > 0 ? (
              <details className="dobra chave-futuros">
                <summary className="dobra__titulo">
                  Ainda sem rota na API ({semRota.length})
                </summary>
                <p className="dobra__ajuda">
                  Estes existem no painel e a API pública ainda não os atende. Conceder agora é
                  legítimo — a chave passa a valer quando a rota existir —, e nada responde até lá.
                </p>
                <div className="chave-escopos">
                  {semRota.map((escopo) => (
                    <label className="ui-field__label chave-escopo" key={escopo}>
                      <input name="escopos" type="checkbox" value={escopo} />
                      <code>{escopo}</code>
                    </label>
                  ))}
                </div>
              </details>
            ) : null}

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
