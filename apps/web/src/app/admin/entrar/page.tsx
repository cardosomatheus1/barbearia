import { redirect } from 'next/navigation';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoEntrar } from '../acoes';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  // Uma mensagem só para os dois casos: distinguir revelaria quais e-mails têm
  // conta na plataforma.
  invalid_credentials: 'E-mail ou senha incorretos.',
  invalid_request: 'Confira os dados e tente de novo.',
  rate_limited: 'Muitas tentativas. Aguarde um instante.',
};

export default async function EntrarGestorPage({ searchParams }: Props) {
  if (await lerSessaoGestor()) redirect('/admin/onboarding');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const criada = query['criada'] === '1';

  return (
    <main className="ui-container painel__entrada">
      <h1 className="painel__titulo">Entrar no painel</h1>
      <p className="painel__sub">A conta é da barbearia, não do cliente.</p>

      {criada ? (
        // Mesma mensagem para quem acabou de criar e para quem já tinha conta:
        // é verdadeira nos dois casos e não conta nada sobre o outro.
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Tudo certo. Entre com o e-mail e a senha para continuar.
        </div>
      ) : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? 'Não foi possível entrar. Tente de novo.'}
        </div>
      ) : null}

      <form action={acaoEntrar} className="formulario">
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
          <label className="ui-field__label" htmlFor="password">
            Senha
          </label>
          <input
            className="ui-field__input"
            id="password"
            name="password"
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

      <p className="painel__nota">
        Ainda não tem conta? <a href="/admin/criar-conta">Cadastre a barbearia</a>.
      </p>
    </main>
  );
}
