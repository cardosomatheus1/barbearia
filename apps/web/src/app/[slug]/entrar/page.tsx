import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProfile } from '@/lib/api';
import { destinoSeguro } from '@/lib/destino';
import { lerSessao } from '@/lib/sessao';
import { conferir, enviarCodigo } from './acoes';

/**
 * Entrar com o celular.
 *
 * Aqui o código no WhatsApp é obrigatório — é a fronteira do produto. Agendar
 * não pede nada; **ver, cancelar e remarcar** pedem, porque sem isso conhecer o
 * telefone de alguém daria poder sobre a agenda dessa pessoa.
 */

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: 'Entrar',
  robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Falhas traduzidas.
 *
 * Nenhuma delas revela se o número tem cadastro. `code_mismatch` e
 * `no_challenge` dizem a mesma coisa de propósito: distinguir transformaria a
 * tela em oráculo de "este telefone é cliente daqui".
 */
const FALHA: Record<string, string> = {
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  // Os dois textos abaixo aparecem no passo do código, não no do celular: o
  // código já foi enviado, e é ele que destrava a tela.
  resend_too_soon: 'O código já foi enviado. Confira o WhatsApp — dá para pedir outro em instantes.',
  too_many_sends: 'Já enviamos vários códigos. Use o último que chegou; para receber outro, aguarde.',
  code_mismatch: 'Código incorreto. Confira a mensagem e digite de novo.',
  no_challenge: 'Código incorreto. Confira a mensagem e digite de novo.',
  code_expired: 'Este código expirou. Peça um novo.',
  too_many_attempts: 'Muitas tentativas. Peça um novo código.',
  sessao_expirada: 'Demorou um pouco. Digite o celular de novo.',
  invalid_request: 'Confira os dados e tente de novo.',
};

export default async function EntrarPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  // Validado **aqui também**, não só nas server actions: esta página redireciona
  // sozinha quando já existe sessão, e é este o caminho que um link montado por
  // terceiro alcança. O valor também vai para o campo oculto e para o link
  // "Usar outro número", então sanear na entrada cobre o fluxo inteiro.
  const destino = destinoSeguro(first(query['destino']), slug);

  // Já entrou: não faz sentido pedir o código de novo.
  if (await lerSessao(slug)) redirect(destino);

  const falha = first(query['erro']);
  const noCodigo = first(query['e']) === 'codigo';

  return (
    <main className="ui-container entrar">
      <a className="entrar__voltar" href={`/${slug}`}>
        ← {profile.name}
      </a>

      <h1 className="entrar__titulo">
        {noCodigo ? 'Digite o código' : 'Seus agendamentos'}
      </h1>
      <p className="entrar__sub">
        {noCodigo
          ? 'Mandamos um código de 6 dígitos no seu WhatsApp.'
          : 'Entre com o celular que você usou para agendar.'}
      </p>

      {falha ? (
        <div className="ui-alert ui-alert--danger entrar__falha" role="alert">
          {FALHA[falha] ?? 'Não foi possível continuar. Tente de novo.'}
        </div>
      ) : null}

      {noCodigo ? (
        <form action={conferir} className="formulario">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="destino" value={destino} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="codigo">
              Código
            </label>
            <input
              className="ui-field__input codigo"
              id="codigo"
              name="code"
              required
              // `inputMode` numérico abre o teclado de números no celular sem
              // recusar colar; `pattern` valida sem depender de JavaScript.
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              placeholder="000000"
            />
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Entrar
          </button>
        </form>
      ) : (
        <form action={enviarCodigo} className="formulario">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="destino" value={destino} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="celular">
              Celular (WhatsApp)
            </label>
            <input
              className="ui-field__input"
              id="celular"
              name="phone"
              required
              inputMode="tel"
              autoComplete="tel"
              placeholder="(71) 98888-7777"
            />
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Receber código
          </button>
        </form>
      )}

      {noCodigo ? (
        <a className="entrar__trocar" href={`/${slug}/entrar?destino=${encodeURIComponent(destino)}`}>
          Usar outro número
        </a>
      ) : (
        <p className="entrar__nota">
          Para <strong>agendar</strong> não precisa de código — é só{' '}
          <a href={`/${slug}/agendar`}>escolher o horário</a>.
        </p>
      )}
    </main>
  );
}
