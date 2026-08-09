import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { estadoDoSegundoFator } from '@/lib/plataforma-api';
import { lerSegredoDaPlataforma, lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import {
  acaoCadastrarSegundoFator,
  acaoConfirmarSegundoFator,
  acaoProvarSegundoFator,
} from '../acoes';

/**
 * O segundo fator da conta que enxerga todas as barbearias.
 *
 * A tela existe porque a capacidade existe: sem ela, "ative o segundo fator"
 * seria uma exigência que a API cobra e o produto não deixa cumprir — o mesmo
 * defeito de um campo que o motor aceita e ninguém preenche, do avesso.
 *
 * O segredo aparece **uma vez**, em texto, e não como imagem. Gerar o QR Code
 * exigiria uma biblioteca nova, e o aplicativo autenticador aceita o segredo
 * digitado — a alternativa custaria uma dependência para economizar uma
 * digitação de trinta e dois caracteres, uma vez na vida de cada conta.
 */

export const metadata: Metadata = {
  title: 'Segurança da plataforma',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  invalid_code: 'Código incorreto. Confira o relógio do aparelho e tente de novo.',
  mfa_already_on: 'O segundo fator já está ligado nesta conta.',
  mfa_not_started: 'Comece o cadastro antes de confirmar.',
  mfa_setup_required: 'Ative o segundo fator primeiro.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para concluir. Tente de novo.',
};

export default async function SegurancaDaPlataformaPage({ searchParams }: Props) {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const feito = typeof query['feito'] === 'string' ? query['feito'] : undefined;
  const destino = typeof query['destino'] === 'string' ? query['destino'] : '/plataforma';

  const [estado, segredo] = await Promise.all([
    estadoDoSegundoFator(token),
    lerSegredoDaPlataforma(),
  ]);

  if (!estado.ok) {
    if (estado.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Segurança</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar. Recarregue a página.
        </div>
      </main>
    );
  }

  const { ligado, provado } = estado.dados;

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Segurança</h1>
      <p className="painel__sub">
        Esta conta bloqueia contas e entra na de clientes. A senha sozinha não basta.
      </p>

      {feito === 'ligado' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Segundo fator ligado.
        </div>
      ) : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? 'Não deu para concluir. Tente de novo.'}
        </div>
      ) : null}

      {segredo ? (
        <section className="painel__grupo">
          <h2 className="painel__secao">Cadastre no aplicativo</h2>
          <p className="painel__sub">
            Abra o autenticador, escolha “inserir chave manualmente” e digite o segredo abaixo.
            Depois confirme com o código de seis dígitos que ele mostrar.
          </p>

          <p className="segredo-mfa">{segredo.segredoBase32}</p>

          <h3 className="painel__secao">Códigos de recuperação</h3>
          <p className="painel__sub">
            Guarde agora, fora deste computador. Eles aparecem uma vez só e cada um funciona
            uma única vez — é como se entra quando o celular se perde.
          </p>
          <ul className="codigos-mfa">
            {segredo.codigosDeRecuperacao.map((codigo) => (
              <li className="codigos-mfa__item" key={codigo}>
                {codigo}
              </li>
            ))}
          </ul>

          <form action={acaoConfirmarSegundoFator} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="codigo-confirmar">
                Código do aplicativo
              </label>
              <input
                autoComplete="one-time-code"
                className="ui-field__input"
                id="codigo-confirmar"
                inputMode="numeric"
                name="codigo"
                required
              />
            </div>
            <button className="ui-button ui-button--primary ui-button--lg" type="submit">
              Confirmar e ligar
            </button>
          </form>
        </section>
      ) : !ligado ? (
        <section className="painel__grupo">
          <h2 className="painel__secao">Segundo fator desligado</h2>
          <p className="painel__sub">
            Enquanto estiver assim, esta conta não consegue entrar na conta de nenhuma barbearia.
          </p>
          <form action={acaoCadastrarSegundoFator} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="email">
                Seu e-mail
              </label>
              <input
                autoComplete="email"
                className="ui-field__input"
                id="email"
                name="email"
                type="email"
                required
              />
              <p className="ui-field__ajuda">
                Aparece só como rótulo no aplicativo autenticador, para distinguir esta conta das
                outras que você tiver nele.
              </p>
            </div>
            <button className="ui-button ui-button--primary ui-button--lg" type="submit">
              Ativar segundo fator
            </button>
          </form>
        </section>
      ) : (
        <section className="painel__grupo">
          <h2 className="painel__secao">
            {provado ? 'Confirmado nesta sessão' : 'Confirme para continuar'}
          </h2>
          <p className="painel__sub">
            {provado
              ? 'A confirmação vale por trinta minutos. Depois disso, entrar na conta de uma barbearia pede o código de novo.'
              : 'A confirmação vale por trinta minutos e é pedida de novo depois — esta sessão dura oito horas, e quem digitou o código de manhã não é necessariamente quem está no teclado à tarde.'}
          </p>

          <form action={acaoProvarSegundoFator} className="formulario">
            <input name="destino" type="hidden" value={destino} />
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="codigo">
                Código do aplicativo
              </label>
              <input
                autoComplete="one-time-code"
                className="ui-field__input"
                id="codigo"
                inputMode="numeric"
                name="codigo"
                required
              />
              <p className="ui-field__ajuda">
                Um código de recuperação também vale — e some depois de usado.
              </p>
            </div>
            <button className="ui-button ui-button--primary ui-button--lg" type="submit">
              Confirmar
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
