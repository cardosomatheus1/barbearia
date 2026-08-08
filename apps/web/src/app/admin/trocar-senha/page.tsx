import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { quemSouEu } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoTrocarMinhaSenha } from '../acoes';

/**
 * Trocar a própria senha.
 *
 * É o que destranca uma conta recém-criada: a senha de primeiro acesso foi
 * gerada pelo sistema e entregue por outra pessoa, então enquanto ela valer,
 * quem a sabe não é necessariamente quem deveria estar ali. Até a troca, a
 * guarda de permissão recusa todo o resto do painel.
 *
 * Serve também para quem já entrou e quer trocar por vontade própria — daí o
 * texto mudar conforme o caso, em vez de existirem duas telas.
 */

export const metadata: Metadata = {
  title: 'Trocar senha',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  nao_confere: 'As duas senhas novas não são iguais.',
  invalid_credentials: 'A senha atual não confere.',
  weak_password: 'A nova senha precisa de pelo menos 10 caracteres e ser diferente da atual.',
  invalid_request: 'A nova senha precisa de pelo menos 10 caracteres.',
  request_failed: 'Não deu para trocar. Tente de novo.',
};

export default async function TrocarSenhaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const eu = await quemSouEu(token);
  if (!eu.ok) redirect('/admin/entrar');

  const query = await searchParams;
  const erro = first(query['erro']);
  const primeiroAcesso = eu.dados.mustChangePassword;

  return (
    <main className="ui-container painel__entrada">
      <h1 className="painel__titulo">
        {primeiroAcesso ? 'Escolha a sua senha' : 'Trocar senha'}
      </h1>
      <p className="painel__sub">
        {primeiroAcesso
          ? `Olá, ${eu.dados.name}. A senha que você recebeu foi criada por outra pessoa — escolha a sua para continuar.`
          : 'Trocar a senha desconecta os outros aparelhos onde você entrou.'}
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      <form action={acaoTrocarMinhaSenha} className="formulario">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="currentPassword">
            {primeiroAcesso ? 'Senha que você recebeu' : 'Senha atual'}
          </label>
          <input className="ui-field__input" id="currentPassword" name="currentPassword"
                 type="password" required autoComplete="current-password" />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="newPassword">Nova senha</label>
          <input className="ui-field__input" id="newPassword" name="newPassword"
                 type="password" required minLength={10} autoComplete="new-password" />
          <p className="ui-field__hint">Pelo menos 10 caracteres.</p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="confirmPassword">Repita a nova senha</label>
          <input className="ui-field__input" id="confirmPassword" name="confirmPassword"
                 type="password" required minLength={10} autoComplete="new-password" />
        </div>

        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Salvar senha
        </button>
      </form>

      {primeiroAcesso ? null : (
        // Link de navegação sozinho respeita o alvo mínimo: a isenção da WCAG
        // 2.5.8 é para link **dentro de frase**, e este não é.
        <p className="painel__nota">
          <a className="ui-button ui-button--ghost" href="/admin/dia">Voltar ao dia</a>
        </p>
      )}
    </main>
  );
}
