import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoCriarConta } from '../acoes';
import { Marca } from '../marca';

/**
 * Etapa 1 — conta.
 *
 * Cinco campos e nada mais. A meta da SPEC é da conta ao link publicado em
 * menos de dez minutos, e todo campo aqui é tempo antes de o produto mostrar
 * qualquer valor.
 */

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  // Sem entrada para "e-mail já existe": a API não distingue, e a tela também
  // não pode — seria o mesmo oráculo, um passo depois.
  weak_password: 'A senha precisa de pelo menos 10 caracteres.',
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  invalid_request: 'Confira os dados. A senha precisa de pelo menos 10 caracteres.',
  rate_limited: 'Muitas tentativas. Aguarde um instante.',
  bot_verification_failed: 'Não foi possível confirmar que esta tentativa é legítima. Tente novamente.',
  bot_verification_unavailable: 'A proteção anti-bot está temporariamente indisponível. Tente novamente em instantes.',
};

export default async function CriarContaPage({ searchParams }: Props) {
  if (await lerSessaoGestor()) redirect('/admin/onboarding');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const cabecalhos = await headers();
  const nonce = cabecalhos.get('x-nonce') ?? undefined;
  const turnstileSiteKey = process.env['TURNSTILE_SITE_KEY']?.trim();

  return (
    <main className="ui-container painel__entrada">
      <p className="painel__etapa">Etapa 1 de 6</p>
      <Marca />
      <h1 className="painel__titulo">Sua barbearia no ar</h1>
      <p className="painel__sub">Em seis passos você tem um link para colocar na bio.</p>

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
          {FALHA[erro] ?? 'Não foi possível criar a conta. Tente de novo.'}
        </div>
      ) : null}

      <form action={acaoCriarConta} className="formulario">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="businessName">Nome da barbearia</label>
          <input className="ui-field__input" id="businessName" name="businessName"
                 required minLength={2} maxLength={80} placeholder="Domari Barber Club" />
          <p className="ui-field__hint">Vira o endereço do seu link. Dá para mudar depois.</p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="name">Seu nome</label>
          <input className="ui-field__input" id="name" name="name" autoComplete="name"
                 required minLength={3} maxLength={80} />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="phone">Celular (WhatsApp)</label>
          <input className="ui-field__input" id="phone" name="phone" inputMode="tel"
                 autoComplete="tel" required placeholder="(71) 98888-7777" />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="email">E-mail</label>
          <input className="ui-field__input" id="email" name="email" type="email"
                 autoComplete="email" required maxLength={160} />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="password">Senha</label>
          <input className="ui-field__input" id="password" name="password" type="password"
                 autoComplete="new-password" required minLength={10} maxLength={200} />
          <p className="ui-field__hint">Pelo menos 10 caracteres.</p>
        </div>

        {turnstileSiteKey ? (
          <>
            <script
              async
              defer
              nonce={nonce}
              src="https://challenges.cloudflare.com/turnstile/v0/api.js"
            />
            <div
              className="cf-turnstile"
              data-action="signup"
              data-sitekey={turnstileSiteKey}
            />
          </>
        ) : null}

        <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
          Criar conta
        </button>
      </form>

      <p className="painel__nota">
        Já tem conta? <a href="/admin/entrar">Entrar</a>.
      </p>
    </main>
  );
}
