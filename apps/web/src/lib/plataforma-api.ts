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

import type { EstadoDaAssinaturaDaPlataforma } from '@barbearia/core';

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

/**
 * As barbearias **e o papel de quem está lendo**.
 *
 * O papel vem junto porque as cinco telas da plataforma já chamam esta rota: um
 * segundo pedido só para saber quem é seria uma ida a mais em toda navegação, e
 * um cookie gravado no login continuaria dizendo o que era verdade ontem.
 */
export const listarBarbearias = (token: string) =>
  chamar<{ papel: 'viewer' | 'operator'; barbearias: BarbeariaNaPlataforma[] }>(
    'GET',
    '/v1/plataforma/barbearias',
    undefined,
    token,
  );

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

// -- Destaque e contestações (bloco 75) ---------------------------------------

export interface DestaqueNaTela {
  readonly id: string;
  readonly barbearia: string;
  readonly cidade: string;
  readonly estado: string;
  readonly lugar: number;
  readonly de: string;
  readonly ate: string;
  readonly valorCents: number;
  readonly estado_: 'ativo' | 'cancelado';
}

export const destaquesNaApi = (token: string) =>
  chamar<{ destaques: DestaqueNaTela[] }>('GET', '/v1/plataforma/destaques', undefined, token);

export const venderDestaqueNaApi = (
  token: string,
  tenantId: string,
  corpo: { locationId?: string; lugar: number; de: string; ate: string },
) =>
  chamar<{ id: string; valorCents: number }>(
    'POST',
    `/v1/plataforma/barbearias/${tenantId}/destaques`,
    corpo,
    token,
  );

export const cancelarDestaqueNaApi = (token: string, anuncioId: string, motivo: string) =>
  chamar<{ ok: true }>(
    'POST',
    `/v1/plataforma/destaques/${anuncioId}/cancelamento`,
    { motivo },
    token,
  );

export interface ContestacaoNaTela {
  readonly id: string;
  readonly barbearia: string;
  readonly motivo: string | null;
  readonly baseCents: number;
  readonly feeCents: number;
  readonly quando: string;
}

export const contestacoesNaApi = (token: string) =>
  chamar<{ contestacoes: ContestacaoNaTela[] }>(
    'GET',
    '/v1/plataforma/contestacoes',
    undefined,
    token,
  );

export const reverterContestacaoNaApi = (token: string, atribuicaoId: string, motivo: string) =>
  chamar<{ ok: true }>(
    'POST',
    `/v1/plataforma/contestacoes/${atribuicaoId}/reversao`,
    { motivo },
    token,
  );

/** Franquias montadas (bloco 76). */
export interface FranquiaNaTela {
  readonly id: string;
  readonly nome: string;
  readonly criadaEm: string;
  readonly franqueadora: string | null;
  readonly franqueadas: number;
  readonly itensNoPadrao: number;
}

export interface CasaDaFranquiaNaTela {
  readonly tenantId: string;
  readonly nome: string;
  readonly papel: 'franqueadora' | 'franqueada';
  readonly entrouEm: string;
}

export const franquiasNaApi = (token: string) =>
  chamar<{ franquias: FranquiaNaTela[] }>('GET', '/v1/plataforma/franquias', undefined, token);

export const casasDaFranquiaNaApi = (token: string, franquiaId: string) =>
  chamar<{ casas: CasaDaFranquiaNaTela[] }>(
    'GET',
    `/v1/plataforma/franquias/${franquiaId}/casas`,
    undefined,
    token,
  );

export const criarFranquiaNaApi = (token: string, corpo: { nome: string; tenantId: string }) =>
  chamar<{ id: string }>('POST', '/v1/plataforma/franquias', corpo, token);

export const porNaFranquiaNaApi = (token: string, franquiaId: string, tenantId: string) =>
  chamar<{ ok: true }>(
    'POST',
    `/v1/plataforma/franquias/${franquiaId}/casas`,
    { tenantId },
    token,
  );

export const tirarDaFranquiaNaApi = (token: string, tenantId: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/plataforma/franquias/casas/${tenantId}`, undefined, token);

// -- assinatura da barbearia (bloco 128) --------------------------------------

/**
 * O contrato entre a plataforma e a barbearia, na tela.
 *
 * As rotas existiam inteiras desde o bloco 27 — cancelar, reativar, trocar o
 * cartão, estornar crédito — com guarda, `@AgeNaConta` e trilha, e **nenhuma
 * tinha cliente aqui**. Do outro lado, `/admin/plano` dizia ao dono em letras
 * *"para trocar o cartão, fale com o suporte"*, e o suporte não tinha essa
 * tela: era `curl` ou `UPDATE` à mão. A metade irmã funciona (a fatura tem
 * "Registrar pagamento" e "Anular"), o que tornava a ausência fácil de não
 * notar.
 */
export interface AssinaturaNaPlataforma {
  tenantId: string;
  planoCode: string;
  planoNome: string;
  /** O público-alvo **do plano** (`plans.audience`), nunca o nome da barbearia. */
  publico: string;
  estado: EstadoDaAssinaturaDaPlataforma;
  precoCents: number;
  tetoDeCadeiras: number | null;
  cadeirasEmUso: number;
  testeAte: string | null;
  periodoAte: string;
  canceladaEm: string | null;
}

export interface MeioDeCobrancaNaTela {
  meio: {
    bandeira: string | null;
    final: string | null;
    validadeMes: number | null;
    validadeAno: number | null;
    cadastrado: boolean;
  } | null;
  estornos: {
    id: string;
    valorCents: number;
    motivo: string;
    estado: string;
    criadoEm: string;
  }[];
}

export const assinaturasNaApi = (token: string) =>
  chamar<{ assinaturas: AssinaturaNaPlataforma[] }>(
    'GET',
    '/v1/plataforma/assinaturas',
    undefined,
    token,
  );

export const cobrancaNaApi = (token: string, tenantId: string) =>
  chamar<MeioDeCobrancaNaTela>(
    'GET',
    `/v1/plataforma/barbearias/${tenantId}/cobranca`,
    undefined,
    token,
  );

export const cancelarAssinaturaNaApi = (token: string, tenantId: string, motivo: string) =>
  chamar<{ ok: boolean }>(
    'POST',
    `/v1/plataforma/barbearias/${tenantId}/cancelamento`,
    { motivo },
    token,
  );

export const reativarAssinaturaNaApi = (token: string, tenantId: string) =>
  chamar<{ ok: boolean }>(
    'DELETE',
    `/v1/plataforma/barbearias/${tenantId}/cancelamento`,
    undefined,
    token,
  );

export const salvarCobrancaNaApi = (
  token: string,
  tenantId: string,
  /**
   * O que a tela manda, e o que ela **não** manda.
   *
   * `pspCustomerId` é obrigatório na borda e é o identificador da conta no
   * adquirente — quem o tem é quem falou com ele. `pspMethodId` é o token do
   * cartão, e é a única coisa deste lado que representa o cartão: não existe
   * coluna para PAN nem para CVV, e há invariante que reprova quem criar uma.
   * Bandeira, final e validade são o que o balcão lê para conferir com o dono
   * ao telefone.
   */
  corpo: {
    pspCustomerId: string;
    pspMethodId: string;
    bandeira: string;
    final: string;
    validadeMes: number;
    validadeAno: number;
  },
) =>
  chamar<{ ok: boolean }>(
    'PUT',
    `/v1/plataforma/barbearias/${tenantId}/cobranca`,
    corpo,
    token,
  );
