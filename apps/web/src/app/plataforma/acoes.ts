'use server';

import { redirect } from 'next/navigation';
import {
  bloquear,
  cadastrarSegundoFator,
  confirmarSegundoFator,
  definirRecurso,
  desbloquear,
  encerrarSuporte,
  entrarNaConta,
  entrarNaPlataforma,
  provarSegundoFator,
  sairDaPlataforma,
  trocarPlano,
  anularFatura,
  cancelarDestaqueNaApi,
  registrarPagamento,
  reverterContestacaoNaApi,
  venderDestaqueNaApi,
  criarFranquiaNaApi,
  porNaFranquiaNaApi,
  tirarDaFranquiaNaApi,
  cancelarAssinaturaNaApi,
  reativarAssinaturaNaApi,
  salvarCobrancaNaApi,
} from '@/lib/plataforma-api';
import {
  apagarSessaoDaPlataforma,
  gravarSessaoDaPlataforma,
  guardarSegredoDaPlataforma,
  lerSessaoDaPlataforma,
  guardarRecusaDaPlataforma,
} from '@/lib/sessao-plataforma';
import { gravarSessaoGestor } from '@/lib/sessao-gestor';
import { destinoDaPlataforma } from '@/lib/destino';

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? '').trim();

/**
 * Recusa: o código na URL e a frase do domínio junto, num cookie.
 *
 * Mesma decisão do painel da barbearia, e pelo mesmo motivo medido: o mapa
 * escrito à mão em cada tela cobria uma parte dos códigos e o resto virava
 * "Tente de novo". Aqui a frase costuma ser a única informação — "esta conta
 * já é operadora", "a fatura já foi paga" — e o código sozinho não a substitui.
 */
async function falhar(
  destino: string,
  erro: string | { readonly code: string; readonly message: string },
): Promise<never> {
  const code = typeof erro === 'string' ? erro : erro.code;
  if (typeof erro !== 'string') await guardarRecusaDaPlataforma(erro.message);
  redirect(`${destino}?erro=${encodeURIComponent(code)}`);
}

async function exigirSessao(): Promise<string> {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');
  return token;
}

export async function acaoEntrarNaPlataforma(form: FormData): Promise<void> {
  const resultado = await entrarNaPlataforma(texto(form, 'email'), String(form.get('senha') ?? ''));
  // O código, nunca a frase: a porta de entrada não conta quem existe.
  if (!resultado.ok) return falhar('/plataforma/entrar', resultado.code);

  await gravarSessaoDaPlataforma(resultado.dados.token, resultado.dados.expiraEm);
  redirect('/plataforma');
}

export async function acaoSairDaPlataforma(): Promise<void> {
  const token = await lerSessaoDaPlataforma();
  // Revoga no servidor antes de apagar o cookie: só apagar deixaria o token
  // aceito por quem o tivesse capturado.
  if (token) await sairDaPlataforma(token);
  await apagarSessaoDaPlataforma();
  redirect('/plataforma/entrar');
}

export async function acaoTrocarPlano(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await trocarPlano(token, texto(form, 'tenantId'), texto(form, 'planoCode'));
  if (!resultado.ok) return falhar('/plataforma', resultado);
  redirect('/plataforma?feito=plano');
}

export async function acaoBloquear(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivo');
  // Recusado aqui, no domínio e no `CHECK` do banco. A tela é a primeira das
  // três porque é a única que consegue dizer onde está o campo vazio.
  if (motivo.length < 3) return falhar('/plataforma', 'reason_required');

  const resultado = await bloquear(token, texto(form, 'tenantId'), motivo);
  if (!resultado.ok) return falhar('/plataforma', resultado);
  redirect('/plataforma?feito=bloqueio');
}

export async function acaoDesbloquear(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await desbloquear(token, texto(form, 'tenantId'));
  if (!resultado.ok) return falhar('/plataforma', resultado);
  redirect('/plataforma?feito=desbloqueio');
}

// -- segundo fator (bloco 26) -------------------------------------------------

export async function acaoCadastrarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cadastrarSegundoFator(token, texto(form, 'email'));
  if (!resultado.ok) return falhar('/plataforma/seguranca', resultado);

  // Segredo e códigos de recuperação viajam em cookie de vida curta, nunca na
  // URL: o segredo TOTP gera todos os códigos futuros, e a URL fica no
  // histórico do navegador e no `Referer` de toda requisição seguinte. Mesma
  // decisão do bloco 19, pelo mesmo motivo.
  await guardarSegredoDaPlataforma(resultado.dados);
  redirect('/plataforma/seguranca');
}

export async function acaoConfirmarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await confirmarSegundoFator(token, texto(form, 'codigo'));
  if (!resultado.ok) return falhar('/plataforma/seguranca', resultado);
  redirect('/plataforma/seguranca?feito=ligado');
}

export async function acaoProvarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  // Validado aqui, e não só ao desenhar o campo: o campo é do navegador, então
  // conferir na renderização não confere nada. É a mesma lição de
  // `destinoSeguro`, que nasceu validando só na ação e deixando a página aberta
  // — o erro simétrico deste.
  const destino = destinoDaPlataforma(texto(form, 'destino'));
  const resultado = await provarSegundoFator(token, texto(form, 'codigo'));
  if (!resultado.ok) return falhar('/plataforma/seguranca', resultado);
  redirect(destino);
}

// -- recursos (bloco 26) ------------------------------------------------------

export async function acaoDefinirRecurso(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await definirRecurso(
    token,
    texto(form, 'tenantId'),
    texto(form, 'code'),
    texto(form, 'ligado') === '1',
  );
  if (!resultado.ok) return falhar('/plataforma', resultado);
  redirect('/plataforma?feito=recurso');
}

// -- suporte assistido (bloco 26) ---------------------------------------------

export async function acaoEntrarNaConta(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivo');
  if (motivo.length < 3) return falhar('/plataforma', 'reason_required');

  const resultado = await entrarNaConta(token, texto(form, 'tenantId'), motivo);
  if (!resultado.ok) return falhar('/plataforma', resultado);

  // O token de suporte é um token de gestor, então ele vai para o cookie de
  // gestor — o painel inteiro já sabe lê-lo, e nada precisa de um segundo
  // caminho de sessão. O que muda é a marca na sessão, que a API resolve.
  await gravarSessaoGestor(resultado.dados.token, resultado.dados.expiraEm);
  redirect('/admin/dia');
}

export async function acaoEncerrarSuporte(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await encerrarSuporte(token, texto(form, 'tenantId'));
  if (!resultado.ok) return falhar('/plataforma', resultado);
  redirect('/plataforma?feito=suporte_encerrado');
}

// -- Cobrança (bloco 28) ------------------------------------------------------

export async function acaoRegistrarPagamento(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await registrarPagamento(token, texto(form, 'faturaId'), texto(form, 'metodo'));
  if (!resultado.ok) return falhar('/plataforma/faturas', resultado);
  redirect('/plataforma/faturas?pago=1');
}

export async function acaoAnularFatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await anularFatura(token, texto(form, 'faturaId'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar('/plataforma/faturas', resultado);
  redirect('/plataforma/faturas?anulada=1');
}

// -- Destaque e contestações (bloco 75) ---------------------------------------

/**
 * Vende um destaque.
 *
 * Sem `locationId`: a unidade é a primária, a mais antiga — a mesma que a
 * página pública mostra. A rede que quiser destacar outra loja usa a rota
 * direta; obrigar a escolher aqui faria a barbearia de uma loja só, que é a
 * esmagadora maioria, procurar um id que ela não tem por que conhecer.
 */
export async function acaoVenderDestaque(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await venderDestaqueNaApi(token, texto(form, 'tenantId'), {
    lugar: Number(texto(form, 'lugar')),
    de: texto(form, 'de'),
    ate: texto(form, 'ate'),
  });
  if (!resultado.ok) return falhar('/plataforma/destaques', resultado);
  redirect('/plataforma/destaques?vendido=1');
}

export async function acaoCancelarDestaque(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cancelarDestaqueNaApi(
    token,
    texto(form, 'anuncioId'),
    texto(form, 'motivo'),
  );
  if (!resultado.ok) return falhar('/plataforma/destaques', resultado);
  redirect('/plataforma/destaques?feito=1');
}

/**
 * A plataforma reverte uma contestação indevida.
 *
 * Fecha a lacuna do bloco 72: a renúncia era definitiva do lado da barbearia,
 * porque o índice único faz aquele cliente nunca mais gerar comissão. O motivo
 * é exigido dos dois lados — quem contesta explica, quem reverte também.
 */
export async function acaoReverterContestacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await reverterContestacaoNaApi(
    token,
    texto(form, 'atribuicaoId'),
    texto(form, 'motivo'),
  );
  if (!resultado.ok) return falhar('/plataforma/destaques', resultado);
  redirect('/plataforma/destaques?revertida=1');
}

/**
 * Montar uma franquia (bloco 76).
 *
 * Ligar duas barbearias é operação **entre tenants**, e não existe lugar dentro
 * de uma delas de onde ela possa ser feita: a RLS separa barbearias, e é para
 * isso que ela existe.
 */
export async function acaoCriarFranquia(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await criarFranquiaNaApi(token, {
    nome: texto(form, 'nome'),
    tenantId: texto(form, 'tenantId'),
  });
  if (!resultado.ok) return falhar('/plataforma/franquias', resultado);
  redirect('/plataforma/franquias?criada=1');
}

export async function acaoPorNaFranquia(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await porNaFranquiaNaApi(
    token,
    texto(form, 'franquiaId'),
    texto(form, 'tenantId'),
  );
  if (!resultado.ok) return falhar('/plataforma/franquias', resultado);
  redirect('/plataforma/franquias?entrou=1');
}

export async function acaoTirarDaFranquia(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await tirarDaFranquiaNaApi(token, texto(form, 'tenantId'));
  if (!resultado.ok) return falhar('/plataforma/franquias', resultado);
  redirect('/plataforma/franquias?saiu=1');
}

// -- assinatura da barbearia (bloco 128) --------------------------------------

/**
 * Cancelar a assinatura de uma barbearia.
 *
 * Motivo escrito obrigatório, como no bloqueio: a tela é a primeira das três
 * conferências — borda, domínio e `CHECK` — porque é a única que consegue dizer
 * **onde** está o campo vazio.
 */
export async function acaoCancelarAssinatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivoDoCancelamento');
  if (motivo.length < 3) return falhar('/plataforma/assinaturas', 'reason_required');

  const resultado = await cancelarAssinaturaNaApi(token, texto(form, 'tenantId'), motivo);
  if (!resultado.ok) return falhar('/plataforma/assinaturas', resultado);
  redirect('/plataforma/assinaturas?feito=cancelamento');
}

/**
 * Reativar, e ela é a saída que faltava.
 *
 * Sem ela, cancelar por engano deixava a barbearia sem plano para sempre — o
 * estado sem saída que a §6 pergunta 3 descreve, com o mecanismo pronto desde o
 * bloco 27 e nenhum botão.
 */
export async function acaoReativarAssinatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await reativarAssinaturaNaApi(token, texto(form, 'tenantId'));
  if (!resultado.ok) return falhar('/plataforma/assinaturas', resultado);
  redirect('/plataforma/assinaturas?feito=reativacao');
}

/**
 * Trocar o cartão da barbearia.
 *
 * O que entra é o **token do adquirente** e os quatro últimos — nunca o número
 * do cartão, que não tem coluna neste schema e tem invariante que reprova quem
 * criar uma. É o suporte digitando o que o adquirente devolveu, que é
 * exatamente o que `/admin/plano` manda o dono pedir: *"para trocar o cartão,
 * fale com o suporte"*.
 */
export async function acaoSalvarCobranca(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const final = texto(form, 'final');
  if (!/^[0-9]{4}$/.test(final)) return falhar('/plataforma/assinaturas', 'invalid_request');

  const resultado = await salvarCobrancaNaApi(token, texto(form, 'tenantId'), {
    pspCustomerId: texto(form, 'pspCustomerId'),
    pspMethodId: texto(form, 'pspMethodId'),
    bandeira: texto(form, 'bandeira'),
    final,
    validadeMes: Number(texto(form, 'validadeMes')),
    validadeAno: Number(texto(form, 'validadeAno')),
  });
  if (!resultado.ok) return falhar('/plataforma/assinaturas', resultado);
  redirect('/plataforma/assinaturas?feito=cobranca');
}
