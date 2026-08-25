/**
 * Validação server-side do Cloudflare Turnstile para portas anônimas.
 *
 * O widget sozinho não protege nada: quem automatiza pode chamar a API direto.
 * Por isso a API recebe o token e valida no Siteverify antes de criar a conta.
 * Em produção, configuração ausente falha fechada; em desenvolvimento sem
 * configuração a proteção é omitida para não tornar o ambiente local dependente
 * de um provedor externo.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TETO_TOKEN = 2048;
const TIMEOUT_MS = 10_000;

interface RespostaTurnstile {
  readonly success?: boolean;
  readonly hostname?: string;
  readonly action?: string;
}

export type FalhaTurnstile = 'token_invalido' | 'provedor_indisponivel' | 'configuracao_ausente';
export type ResultadoTurnstile =
  | { readonly ok: true; readonly ignorado: boolean }
  | { readonly ok: false; readonly code: FalhaTurnstile };

export interface VerificarTurnstileParams {
  readonly token?: string;
  readonly ip?: string;
  readonly action: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
}

const hostnamesEsperados = (env: NodeJS.ProcessEnv): ReadonlySet<string> =>
  new Set(
    (env['TURNSTILE_HOSTNAMES'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );

export async function verificarTurnstile(params: VerificarTurnstileParams): Promise<ResultadoTurnstile> {
  const env = params.env ?? process.env;
  const segredo = env['TURNSTILE_SECRET_KEY']?.trim();
  const producao = env['NODE_ENV'] === 'production';

  if (!segredo) {
    return producao
      ? { ok: false, code: 'configuracao_ausente' }
      : { ok: true, ignorado: true };
  }

  const token = params.token?.trim() ?? '';
  if (!token || token.length > TETO_TOKEN) return { ok: false, code: 'token_invalido' };

  const hostnames = hostnamesEsperados(env);
  if (producao && hostnames.size === 0) return { ok: false, code: 'configuracao_ausente' };

  const body = new URLSearchParams({ secret: segredo, response: token });
  if (params.ip) body.set('remoteip', params.ip);

  let resposta: Response;
  try {
    resposta = await (params.fetcher ?? fetch)(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'provedor_indisponivel' };
  }

  if (!resposta.ok) return { ok: false, code: 'provedor_indisponivel' };

  let dados: RespostaTurnstile;
  try {
    dados = (await resposta.json()) as RespostaTurnstile;
  } catch {
    return { ok: false, code: 'provedor_indisponivel' };
  }

  if (!dados.success || dados.action !== params.action) {
    return { ok: false, code: 'token_invalido' };
  }

  if (hostnames.size > 0 && (!dados.hostname || !hostnames.has(dados.hostname.toLowerCase()))) {
    return { ok: false, code: 'token_invalido' };
  }

  return { ok: true, ignorado: false };
}
