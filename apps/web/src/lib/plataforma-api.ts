/**
 * Cliente da API da plataforma.
 *
 * Separado de `admin-api.ts` de propósito, e não por organização de arquivos:
 * são duas APIs com dois tipos de token, e um cliente único convidaria a passar
 * o token errado numa chamada nova. Aqui não existe função que aceite os dois.
 *
 * Sempre `no-store`: bloquear uma conta e ver a lista velha em seguida seria
 * pior do que não ter a tela.
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export type Resposta<T> =
  | { ok: true; dados: T }
  | { ok: false; code: string; message: string };

async function chamar<T>(
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
): Promise<Resposta<T>> {
  const resposta = await fetch(`${BASE}${path}`, {
    method: metodo,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });

  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    return {
      ok: false,
      code: corpo?.error?.code ?? 'request_failed',
      message: corpo?.error?.message ?? 'Não foi possível concluir. Tente de novo.',
    };
  }

  return { ok: true, dados: (await resposta.json()) as T };
}

export interface SessaoDaPlataforma {
  token: string;
  expiraEm: string;
  admin: { id: string; nome: string };
}

export interface Plano {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  maxChairs: number | null;
  active: boolean;
}

export interface BarbeariaNaPlataforma {
  tenantId: string;
  nome: string;
  slug: string | null;
  plano: { code: string; name: string; priceCents: number } | null;
  bloqueada: boolean;
  bloqueadaEm: string | null;
  motivoDoBloqueio: string | null;
  criadaEm: string;
}

export interface EventoDaPlataforma {
  acao: string;
  tenantId: string | null;
  detalhe: Record<string, unknown>;
  quando: string;
  adminNome: string | null;
}

export const entrarNaPlataforma = (email: string, senha: string) =>
  chamar<SessaoDaPlataforma>('POST', '/v1/plataforma/login', { email, senha });

export const sairDaPlataforma = (token: string) =>
  chamar<{ revoked: boolean }>('POST', '/v1/plataforma/logout', {}, token);

export const listarBarbearias = (token: string) =>
  chamar<{ barbearias: BarbeariaNaPlataforma[] }>('GET', '/v1/plataforma/barbearias', undefined, token);

export const listarPlanos = (token: string) =>
  chamar<{ planos: Plano[] }>('GET', '/v1/plataforma/planos', undefined, token);

export const trocarPlano = (token: string, tenantId: string, planoCode: string) =>
  chamar<{ ok: boolean }>('PUT', `/v1/plataforma/barbearias/${tenantId}/plano`, { planoCode }, token);

export const bloquear = (token: string, tenantId: string, motivo: string) =>
  chamar<{ ok: boolean }>('POST', `/v1/plataforma/barbearias/${tenantId}/bloqueio`, { motivo }, token);

export const desbloquear = (token: string, tenantId: string) =>
  chamar<{ ok: boolean }>('DELETE', `/v1/plataforma/barbearias/${tenantId}/bloqueio`, undefined, token);

export const trilhaDaPlataforma = (token: string, limite = 100) =>
  chamar<{ eventos: EventoDaPlataforma[] }>(
    'GET',
    `/v1/plataforma/trilha?limite=${limite}`,
    undefined,
    token,
  );

export interface ResumoDaPlataforma {
  mrrCents: number;
  barbeariasAtivas: number;
  barbeariasBloqueadas: number;
  semPlano: number;
  saidasNoPeriodo: number;
  entradasNoPeriodo: number;
  churnEmPontos: number;
  dias: number;
  agendamentos: number;
  adocaoOnlineEmPontos: number;
  ocupacaoEmPontos: number;
  faltasEmPontos: number;
  receitaCents: number;
  recebidoPixCents: number;
  recebidoCartaoCents: number;
  recebidoDinheiroCents: number;
  recebidoOutrosCents: number;
  barbeariasComMovimento: number;
}

export interface SaudeDaBarbearia {
  tenantId: string;
  nome: string;
  bloqueada: boolean;
  planoCode: string | null;
  agendamentos: number;
  adocaoOnlineEmPontos: number;
  ocupacaoEmPontos: number;
  faltasEmPontos: number;
  receitaCents: number;
  ultimoDia: string | null;
}

export const metricasDaPlataforma = (token: string, dias = 30) =>
  chamar<{ ate: string; resumo: ResumoDaPlataforma }>(
    'GET',
    `/v1/plataforma/metricas?dias=${dias}`,
    undefined,
    token,
  );

export const saudeDasBarbearias = (token: string, dias = 30) =>
  chamar<{ ate: string; barbearias: SaudeDaBarbearia[] }>(
    'GET',
    `/v1/plataforma/saude?dias=${dias}`,
    undefined,
    token,
  );

export interface RecursoDaBarbearia {
  code: string;
  nome: string;
  descricao: string;
  ligado: boolean;
  proprio: boolean;
}

export interface SuporteAberto {
  tenantId: string;
  barbearia: string;
  adminNome: string | null;
  motivo: string;
  abertoEm: string;
  expiraEm: string;
}

export const estadoDoSegundoFator = (token: string) =>
  chamar<{ ligado: boolean; provado: boolean }>('GET', '/v1/plataforma/mfa', undefined, token);

export const cadastrarSegundoFator = (token: string, email: string) =>
  chamar<{ segredoBase32: string; uri: string; codigosDeRecuperacao: string[] }>(
    'POST',
    '/v1/plataforma/mfa',
    { email },
    token,
  );

export const confirmarSegundoFator = (token: string, codigo: string) =>
  chamar<{ ok: boolean }>('POST', '/v1/plataforma/mfa/confirmar', { codigo }, token);

export const provarSegundoFator = (token: string, codigo: string) =>
  chamar<{ usouRecuperacao: boolean }>('POST', '/v1/plataforma/mfa/provar', { codigo }, token);

export const recursosDaBarbearia = (token: string, tenantId: string) =>
  chamar<{ recursos: RecursoDaBarbearia[] }>(
    'GET',
    `/v1/plataforma/barbearias/${tenantId}/recursos`,
    undefined,
    token,
  );

export const definirRecurso = (
  token: string,
  tenantId: string,
  code: string,
  ligado: boolean,
) =>
  chamar<{ ok: boolean }>(
    'PUT',
    `/v1/plataforma/barbearias/${tenantId}/recursos`,
    { code, ligado },
    token,
  );

export const suportesAbertos = (token: string) =>
  chamar<{ suportes: SuporteAberto[] }>('GET', '/v1/plataforma/suporte', undefined, token);

export const entrarNaConta = (token: string, tenantId: string, motivo: string) =>
  chamar<{ token: string; expiraEm: string; barbearia: string; gestor: string }>(
    'POST',
    `/v1/plataforma/barbearias/${tenantId}/suporte`,
    { motivo },
    token,
  );

export const encerrarSuporte = (token: string, tenantId: string) =>
  chamar<{ ok: boolean }>(
    'DELETE',
    `/v1/plataforma/barbearias/${tenantId}/suporte`,
    undefined,
    token,
  );

/**
 * A cobrança, do lado da plataforma (bloco 28).
 *
 * O que o painel faz aqui é o que a régua não faz sozinha: registrar o
 * pagamento que alguém conferiu no extrato e perdoar o que foi acordado. As
 * duas coisas ficam na trilha com autor, ao contrário do que a régua escreve —
 * que vai com autor nulo, porque não teve gente.
 */
export interface FaturaNaPlataforma {
  id: string;
  tenantId: string;
  tipo: 'subscription' | 'proration';
  estado: 'open' | 'paid' | 'void';
  planoCode: string;
  valorCents: number;
  vencimento: string;
  periodoDe: string;
  periodoAte: string;
  tentativas: number;
  vencidaEm: string | null;
  pagaEm: string | null;
  metodo: string | null;
  canceladaEm: string | null;
  motivoDoCancelamento: string | null;
}

export const faturasEmCobranca = (token: string) =>
  chamar<{ faturas: FaturaNaPlataforma[] }>('GET', '/v1/plataforma/faturas', undefined, token);

export const registrarPagamento = (token: string, faturaId: string, metodo: string) =>
  chamar<{ ok: true }>('POST', `/v1/plataforma/faturas/${faturaId}/pagamento`, { metodo }, token);

export const anularFatura = (token: string, faturaId: string, motivo: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/plataforma/faturas/${faturaId}`, { motivo }, token);

// -- A linha do tempo (bloco 62) ----------------------------------------------

export interface MesDoMrrNaTela {
  readonly mes: string;
  readonly mrrCents: number;
  readonly barbeariasPagantes: number;
}

export interface SafraNaTela {
  readonly safra: string;
  readonly entraram: number;
  readonly retidas: readonly number[];
}

export const linhaDoTempoDaPlataforma = (token: string) =>
  chamar<{
    linha: {
      mrr: readonly MesDoMrrNaTela[];
      safras: readonly SafraNaTela[];
      maiorMrrCents: number;
    };
  }>('GET', '/v1/plataforma/linha-do-tempo', undefined, token);
