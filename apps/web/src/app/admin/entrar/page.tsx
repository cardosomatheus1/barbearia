import { redirect } from 'next/navigation';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoEntrar } from '../acoes';
import { Marca } from '../marca';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  // Uma mensagem só para os dois casos: distinguir revelaria quais e-mails têm
  // conta na plataforma.
  invalid_credentials: 'E-mail ou senha incorretos.',
  invalid_request: 'Confira os dados e tente de novo.',
  rate_limited: 'Muitas tentativas. Aguarde um instante.',
  /**
   * O bloqueio **não** é oráculo, e por isso tem frase própria.
   *
   * O argumento acima — mensagem única para não revelar quais e-mails têm conta
   * — não se aplica aqui: `staff.guard.ts` confere o bloqueio **depois** de a
   * senha ser provada, exatamente para que dizê-lo não conte nada a quem está
   * adivinhando. Quem lê esta frase já provou ser dono da conta.
   *
   * Sem ela, o código caía na rede genérica e o dono da barbearia bloqueada
   * digitava a senha certa e lia "Não foi possível entrar. Tente de novo." — e
   * tentava de novo. O comentário do próprio guard diz o contrário sobre esta
   * mesma situação: "Esconder dele seria transformar um bloqueio administrativo
   * em 'o sistema parou'."
   */
  tenant_blocked:
    'Esta conta está bloqueada. Fale com o suporte para reativá-la — seus dados continuam aqui.',
  // A API não respondeu. Diferente de recusa: aqui repetir de fato adianta.
  api_timeout: 'A conexão demorou demais. Tente de novo.',
  api_indisponivel: 'Não conseguimos falar com o servidor agora. Tente de novo em instantes.',
};

export default async function EntrarGestorPage({ searchParams }: Props) {
  if (await lerSessaoGestor()) redirect('/admin');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const criada = query['criada'] === '1';

  return (
    <main className="ui-container painel__entrada">
      <Marca />
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
          {/* Aqui o mapa da tela é o único, e é decisão: a frase do domínio
              não entra numa porta de entrada.

              `AvisoDeRecusa` mostra o que a API escreveu, e é o certo em toda
              tela de dentro. Numa tela de login isso vira oráculo — "e-mail já
              cadastrado" e "conta bloqueada" contam a quem está tentando
              adivinhar exatamente o que a regra de não revelar existência de
              cadastro existe para não contar. É o precedente do OTP, que
              responde igual para telefone existente e inexistente. */}
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
