import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { Marca } from '../../admin/marca';
import { acaoEntrarNaPlataforma } from '../acoes';

export const metadata: Metadata = {
  title: 'Entrar na plataforma',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  // Uma mensagem só, como na porta do gestor: distinguir "e-mail não existe" de
  // "senha errada" entregaria a lista de quem administra a plataforma.
  invalid_credentials: 'E-mail ou senha incorretos.',
  invalid_request: 'Confira os dados e tente de novo.',
  rate_limited: 'Muitas tentativas. Aguarde um instante.',
};

export default async function EntrarNaPlataformaPage({ searchParams }: Props) {
  if (await lerSessaoDaPlataforma()) redirect('/plataforma');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;

  return (
    <main className="ui-container painel__entrada">
      <Marca />
      <h1 className="painel__titulo">Plataforma</h1>
      <p className="painel__sub">
        Esta conta administra todas as barbearias. Não é a conta de nenhuma delas.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {/* Aqui o mapa da tela é o único, e é decisão: a frase da API sobre
              login vira oráculo numa porta de entrada. É o precedente do OTP,
              que responde igual para telefone existente e inexistente — e a
              conta desta porta enxerga todas as barbearias. */}
          {FALHA[erro] ?? 'Não foi possível entrar. Tente de novo.'}
        </div>
      ) : null}

      <form action={acaoEntrarNaPlataforma} className="formulario">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="email">
            E-mail
          </label>
          <input
            className="ui-field__input"
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="senha">
            Senha
          </label>
          <input
            className="ui-field__input"
            id="senha"
            name="senha"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <button
          className="ui-button ui-button--primary ui-button--lg ui-button--block"
          type="submit"
        >
          Entrar
        </button>
      </form>
    </main>
  );
}
