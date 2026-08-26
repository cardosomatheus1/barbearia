'use server';

import {
  centavos,
  centavosOpcionais,
  exigirSessao,
  falhar,
  numero,
  texto,
} from './comum';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import {
  salvarAvisos,
  criarBloqueio,
  criarExcecao,
  moverAgendamento,
  removerExcecao,
  type TipoDeExcecao,
  criarContaDoFinanceiro as criarContaDoFinanceiroApi,
  quitarContaDoFinanceiro as quitarContaDoFinanceiroApi,
  cancelarContaDoFinanceiro as cancelarContaDoFinanceiroApi,
  criarCategoriaDoFinanceiro as criarCategoriaDoFinanceiroApi,
  criarContaBancaria as criarContaBancariaApi,
  transferirEntreContas as transferirEntreContasApi,
  definirLimiteDeFiado as definirLimiteDeFiadoApi,
  lancarSaldoInicialDeFiado as lancarSaldoInicialDeFiadoApi,
  abrirOCaixa,
  movimentarOCaixa,
  fecharOCaixa,
  abrirComandaNoBalcao,
  cancelarComandaAberta,
  retomarCampanhaNaApi,
  tirarDaListaDeEspera,
  adicionarNaComanda,
  removerDaComanda,
  ajustarAComanda,
  cancelarCobrancaDaComanda,
  cobrarComanda,
  fecharAComanda,
  receberDoFiado,
  comecarSegundoFator,
  definirPoliticaDeSegundoFator,
  confirmarSegundoFator,
  desligarSegundoFator,
  verificarSegundoFatorAgora,
  type FormaDePagamento,
  salvarRegraDeComissao,
  removerRegraDeComissao,
  salvarAliquotaDoAdquirente,
  salvarConfiguracaoDeComissao,
  fecharComissao,
  anonimizarCliente as anonimizarClienteNaApi,
  encerrarSessao as encerrarSessaoDoAparelho,
} from '@/lib/admin-api';
import { versaoDoConsentimento } from '@/lib/politica';
import {
  MOTIVOS_DA_CONTESTACAO,
  MOTIVOS_DA_CONTESTACAO_DE_COMISSAO,
  ehConversa,
  TIPO_PADRAO_DE_CAMPANHA,
  type MotivoDaContestacao,
  ehMeioAceito,
} from '@barbearia/core';
import { DIAS, lerJornada, minutosOuNulo } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import { limiarDeFaltas } from '@/lib/sinal';
import { destinoDoBalcao } from '@/lib/destino';
import { VOLTA_DA_META } from '@/lib/meta';

import {
  guardarConflitoDaAgenda,
  guardarSegredoDoMfa,
  guardarCodigosDeRecuperacao,
} from '@/lib/sessao-gestor';


/**
 * Ações do painel.
 *
 * Cada etapa do onboarding grava sozinha e volta para a etapa seguinte. Nenhum
 * "salvar tudo no fim": quem cadastra barbearia faz isso no celular, entre um
 * cliente e outro, e abandonar no passo 4 não pode custar os passos 1 a 3.
 */





const ROTA_CAMPANHAS = '/admin/campanhas';

// -- Agenda -------------------------------------------------------------------

/**
 * Para onde voltar depois de mexer na agenda.
 *
 * Mesmo motivo de `destinoDoBalcao`: valor de formulário virando `redirect` é
 * redirecionador aberto, e o cookie do painel altera catálogo, equipe e preço.
 * A volta é montada aqui a partir de campos conhecidos, nunca aceita pronta.
 */
function voltarParaAgenda(form: FormData): string {
  const busca = new URLSearchParams();
  const de = texto(form, 'de');
  const vista = texto(form, 'v');
  if (/^\d{4}-\d{2}-\d{2}$/.test(de)) busca.set('de', de);
  if (['dia', 'semana', 'lista'].includes(vista)) busca.set('v', vista);
  const query = busca.toString();
  return `/admin/agenda${query ? `?${query}` : ''}`;
}

/**
 * Cria bloqueio, folga, feriado ou horário diferente.
 *
 * A rota é escolhida pelo tipo, não por um parâmetro: bloqueio é operação de
 * recepção, o resto muda o funcionamento da barbearia. Ver `criarBloqueio`.
 */
export async function acaoCriarExcecao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const destino = voltarParaAgenda(form);

  const kind = texto(form, 'kind') as TipoDeExcecao;
  if (!['block', 'day_off', 'holiday', 'vacation', 'custom_hours'].includes(kind)) {
    return falhar(destino, 'tipo_invalido');
  }

  const comFaixa = kind === 'block' || kind === 'custom_hours';
  const inicio = minutosOuNulo(texto(form, 'inicio'));
  const fim = minutosOuNulo(texto(form, 'fim'));
  if (comFaixa && (inicio === null || fim === null)) return falhar(destino, 'faixa_ausente');

  const profissional = texto(form, 'professionalId');

  const dados = {
    kind,
    date: texto(form, 'date'),
    // Dia inteiro manda nulo mesmo que o campo de hora tenha algo digitado: o
    // domínio recusa faixa em tipo que fecha o dia, e mandar o resíduo de um
    // campo escondido viraria erro que a pessoa não entende.
    startMinute: comFaixa ? inicio : null,
    endMinute: comFaixa ? fim : null,
    ...(profissional ? { professionalId: profissional } : {}),
    ...(texto(form, 'reason') ? { reason: texto(form, 'reason') } : {}),
    confirmarConflitos: form.get('confirmarConflitos') === '1',
  };

  const resultado =
    kind === 'block' ? await criarBloqueio(token, dados) : await criarExcecao(token, dados);

  if (!resultado.ok) return falhar(destino, resultado);

  if (!resultado.dados.saved) {
    await guardarConflitoDaAgenda({
      ...dados,
      conflitos: resultado.dados.conflitos,
    });
    redirect(destino);
  }

  const separador = destino.includes('?') ? '&' : '?';
  redirect(`${destino}${separador}salvo=1`);
}

export async function acaoRemoverExcecao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const destino = voltarParaAgenda(form);
  const resultado = await removerExcecao(token, texto(form, 'id'));
  if (!resultado.ok) return falhar(destino, resultado);

  const separador = destino.includes('?') ? '&' : '?';
  redirect(`${destino}${separador}salvo=1`);
}

/**
 * Move um agendamento.
 *
 * É o que o "arrastar" da SPEC faz por baixo, e é a versão que funciona no
 * teclado, no leitor de tela e no celular de 360px — que a WCAG 2.5.7 exige de
 * qualquer coisa que se arraste, e que aqui é o caminho principal.
 */
export async function acaoMoverAgendamento(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const destino = voltarParaAgenda(form);

  const profissional = texto(form, 'professionalId');
  const resultado = await moverAgendamento(token, texto(form, 'id'), {
    date: texto(form, 'date'),
    start: texto(form, 'start'),
    ...(profissional ? { professionalId: profissional } : {}),
  });

  if (!resultado.ok) return falhar(destino, resultado);

  const separador = destino.includes('?') ? '&' : '?';
  redirect(`${destino}${separador}salvo=1`);
}

// -- Balcão: comanda, caixa e fiado -------------------------------------------


export async function acaoAbrirCaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await abrirOCaixa(token, await centavos(form, 'openingCents', '/admin/caixa'));
  if (!resultado.ok) return falhar('/admin/caixa', resultado);
  redirect('/admin/caixa?salvo=1');
}

export async function acaoMovimentarCaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const kind = texto(form, 'kind');
  if (kind !== 'withdrawal' && kind !== 'supply') return falhar('/admin/caixa', 'invalid_request');

  const resultado = await movimentarOCaixa(
    token,
    {
      kind,
      amountCents: await centavos(form, 'amountCents', '/admin/caixa'),
      reason: texto(form, 'reason'),
    },
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) return falhar('/admin/caixa', resultado);
  redirect('/admin/caixa?salvo=1');
}

/**
 * Fecha o caixa e guarda a divergência para a tela seguinte mostrar.
 *
 * A divergência vai por query string, e é o único número deste módulo que pode:
 * é a diferença da própria pessoa que acabou de contar, não é credencial e não
 * identifica ninguém.
 */
export async function acaoFecharCaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await fecharOCaixa(token, await centavos(form, 'countedCents', '/admin/caixa'), texto(form, 'notes'));
  if (!resultado.ok) return falhar('/admin/caixa', resultado);
  redirect(`/admin/caixa?divergencia=${resultado.dados.divergenciaCents}`);
}

export async function acaoAbrirComanda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const appointmentId = texto(form, 'appointmentId');
  const customerId = texto(form, 'customerId');

  const resultado = await abrirComandaNoBalcao(
    token,
    {
      ...(appointmentId ? { appointmentId } : {}),
      ...(customerId ? { customerId } : {}),
    },
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) return falhar('/admin/comanda', resultado);
  redirect(`/admin/comanda/${resultado.dados.id}`);
}

/**
 * Cancelar uma comanda aberta.
 *
 * A saída que faltava: aberta por engano, ela não tinha como sair de `open` —
 * fechar exige pagamento, e uma comanda vazia não fecha.
 */
export async function acaoCancelarComanda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cancelarComandaAberta(token, texto(form, 'orderId'));
  if (!resultado.ok) return falhar('/admin/comanda', resultado);
  redirect('/admin/comanda?feito=cancelada');
}

/**
 * Retoma uma campanha que ficou parada em `enviando`.
 *
 * O despacho é idempotente por alvo — quem já recebeu não recebe de novo —, e o
 * domínio só aceita quando nada se mexe há uma hora.
 */
export async function acaoRetomarCampanha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await retomarCampanhaNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar(ROTA_CAMPANHAS, resultado);
  redirect(`${ROTA_CAMPANHAS}?feito=enviando`);
}

/**
 * Tira alguém da lista de espera, pelo balcão.
 *
 * A lista era desenhada no painel com nome, telefone e convite vivo, e sem
 * nenhum controle: quem ligava dizendo "já resolvi" continuava recebendo
 * convite, com o horário segurado fora da grade a cada um deles.
 */
export async function acaoTirarDaEspera(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await tirarDaListaDeEspera(token, texto(form, 'entryId'));
  if (!resultado.ok) return falhar('/admin/agenda', resultado);
  redirect('/admin/agenda?feito=espera_removida');
}

/**
 * O que o seletor do balcão manda: `s:<id>`, `p:<id>` ou `livre`.
 *
 * Um seletor só, com serviços e produtos, e o prefixo diz qual é qual. Dois
 * seletores exigiriam a tela saber qual esconder, e não há componente de
 * cliente neste produto — o `<select>` decide sozinho e o servidor lê a escolha.
 */
function itemEscolhido(valor: string): { tipo: string; serviceId?: string; productId?: string } {
  if (valor.startsWith('s:')) return { tipo: 'service', serviceId: valor.slice(2) };
  if (valor.startsWith('p:')) return { tipo: 'product', productId: valor.slice(2) };
  return { tipo: 'service' };
}

export async function acaoAdicionarItem(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');

  /**
   * O item vem do **catálogo**, e o id viaja junto.
   *
   * O campo era texto livre com um `datalist` de nomes: digitar exatamente
   * "Corte masculino" gravava a linha com `service_id` **nulo**, e a partir dali
   * a ficha técnica não baixava insumo, o pacote não cobria, o plano do clube
   * não cobria e a margem por serviço perdia a linha — tudo sem erro. É a
   * convenção de casar por id e não por nome, invertida: o nome era gravado e
   * descartado.
   *
   * `livre` continua existindo porque o balcão vende o que não está no catálogo
   * — e aí a linha nasce sem id de propósito, o que é diferente de nascer sem
   * id por acidente.
   */
  const escolha = itemEscolhido(texto(form, 'item'));
  const tipo = escolha.tipo;
  if (tipo !== 'service' && tipo !== 'product' && tipo !== 'consumable' && tipo !== 'package') {
    return falhar(`/admin/comanda/${id}`, 'invalid_request');
  }

  const professionalId = texto(form, 'professionalId');
  const packageId = texto(form, 'packageId');

  const resultado = await adicionarNaComanda(token, id, {
    tipo,
    descricao: texto(form, 'descricao'),
    quantidade: Math.max(1, numero(form, 'quantidade', 1)),
    // Num item de pacote ou de produto este número é ignorado: o preço sai do
    // catálogo, e é isso que impede um item de R$ 1 congelar cinco unidades de
    // R$ 50.
    precoUnitarioCents: await centavos(form, 'precoUnitarioCents', `/admin/comanda/${id}`),
    ...(escolha.serviceId ? { serviceId: escolha.serviceId } : {}),
    ...(escolha.productId ? { productId: escolha.productId } : {}),
    ...(professionalId ? { professionalId } : {}),
    ...(packageId ? { packageId } : {}),
  }, texto(form, 'idempotencyKey'));
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}`);
}

export async function acaoRemoverItem(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');
  const resultado = await removerDaComanda(token, id, texto(form, 'itemId'));
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}`);
}

export async function acaoAjustarComanda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');
  const tipo = texto(form, 'descontoTipo');

  // Percentual é inteiro; valor é centavos. Mandar os dois pelo mesmo campo
  // sem separar aqui faria "10" virar dez centavos de desconto.
  const desconto =
    tipo === 'percent'
      ? { tipo: 'percent' as const, valor: numero(form, 'descontoValor', 0), motivo: texto(form, 'motivo') }
      : {
          tipo: 'amount' as const,
          valor: await centavosOpcionais(form, 'descontoValor', `/admin/comanda/${id}`),
          motivo: texto(form, 'motivo'),
        };

  // String vazia é a opção "rateada entre quem atendeu", que é `null` no banco
  // — e não "não mexa". O formulário sempre manda o campo, então o `undefined`
  // aqui não acontece; ele existe para quem chamar a função sem a tela.
  const gorjetaProfessionalId = texto(form, 'gorjetaProfessionalId');

  const resultado = await ajustarAComanda(token, id, {
    desconto: desconto.valor > 0 ? desconto : null,
    gorjetaCents: await centavosOpcionais(form, 'gorjetaCents', `/admin/comanda/${id}`),
    gorjetaProfessionalId: gorjetaProfessionalId === '' ? null : gorjetaProfessionalId,
  });
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}?salvo=1`);
}

/**
 * Fecha a comanda.
 *
 * Aceita até três formas na mesma conta — pagamento dividido é rotina em
 * barbearia ("cem no pix e o resto em dinheiro"). Os campos vazios são
 * descartados aqui para não mandar zero, que a borda recusaria.
 */
export async function acaoFecharComanda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');

  const pagamentos = (
    await Promise.all(
      [0, 1, 2].map(async (i) => ({
        forma: texto(form, `forma${i}`) as FormaDePagamento,
        valorCents: await centavosOpcionais(form, `valor${i}`, `/admin/comanda/${id}`),
      })),
    )
  ).filter((p) => p.valorCents > 0 && p.forma);

  // Lista vazia é válida somente para comanda de total zero. O domínio é quem
  // conhece o total e recusa `falta_pagar` se alguém tentar usar este atalho
  // numa venda positiva.

  /**
   * O resgate de fidelidade viaja separado do valor (bloco 41).
   *
   * A unidade é outra: o pagamento diz quantos centavos abateram da conta, isto
   * diz quanto sai do saldo. Em `visitas` os dois nem se parecem — dez visitas
   * viram a conta inteira. O domínio reconfere o par sob a trava e recusa se
   * não bater; o número desta tela nunca é a verdade sobre o saldo.
   */
  const resgate = Number(form.get('resgateQuantidade') ?? 0);

  /**
   * O pacote viaja separado do valor pela mesma razão do resgate (bloco 42).
   *
   * A forma diz "quitou pelo pacote"; `servicoDoPacote` diz **qual** serviço ele
   * está cobrindo, que é o que decide qual unidade some. O domínio confere que o
   * serviço está nesta comanda e que o valor bate com a unidade congelada.
   *
   * Quem foi **vendido** não viaja: sai dos itens de pacote da comanda, que são
   * os que carregam o preço cobrado.
   */
  const servicoDoPacote = texto(form, 'servicoDoPacote');
  const servicoDaAssinatura = texto(form, 'servicoDaAssinatura');

  const resultado = await fecharAComanda(
    token,
    id,
    pagamentos,
    texto(form, 'idempotencyKey'),
    Number.isInteger(resgate) && resgate > 0 ? resgate : undefined,
    servicoDoPacote.length > 0 ? servicoDoPacote : undefined,
    servicoDaAssinatura.length > 0 ? servicoDaAssinatura : undefined,
  );
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}?pago=1`);
}

// -- Cobrança online (bloco 35) ----------------------------------------------

/**
 * Emite o Pix da comanda.
 *
 * A chave de idempotência vem do formulário, gerada quando a **tela** foi
 * montada. Gerá-la aqui daria chave nova a cada envio, e o duplo toque no
 * celular do balcão produziria dois QR Codes para a mesma conta — com o cliente
 * na frente, escolhendo um deles ao acaso.
 */
export async function acaoCobrarComanda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');
  const meio = texto(form, 'meio');
  if (meio !== 'pix' && meio !== 'cartao' && meio !== 'link') {
    return falhar(`/admin/comanda/${id}`, 'invalid_request');
  }

  const resultado = await cobrarComanda(
    token,
    id,
    meio as 'pix' | 'cartao' | 'link',
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}?cobrando=1`);
}

/** "Desisti do Pix, vou pagar em dinheiro" — rotina do balcão. */
export async function acaoCancelarCobranca(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');

  const resultado = await cancelarCobrancaDaComanda(token, id, texto(form, 'chargeId'));
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}?salvo=1`);
}

export async function acaoReceberFiado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const forma = texto(form, 'forma');
  if (!['cash', 'debit', 'credit', 'pix'].includes(forma)) {
    return falhar('/admin/fiado', 'invalid_request');
  }

  const resultado = await receberDoFiado(
    token,
    {
      customerId: texto(form, 'customerId'),
      amountCents: await centavos(form, 'amountCents', '/admin/fiado'),
      forma: forma as 'cash' | 'debit' | 'credit' | 'pix',
    },
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) return falhar('/admin/fiado', resultado);
  redirect('/admin/fiado?salvo=1');
}

// -- Segundo fator ------------------------------------------------------------

/**
 * A barbearia liga ou desliga a exigência de segundo fator no financeiro.
 *
 * O formulário manda o **estado desejado**, nunca "alterne": alternar depende
 * de saber o estado atual, e com duas abas abertas as duas mandariam a mesma
 * alternância sobre leituras diferentes.
 */
export async function acaoPoliticaDeSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const exigir = texto(form, 'exigir') === '1';

  // O código só vai quando desliga, e só quando a pessoa o digitou: mandar
  // string vazia faria a API tentar verificar "" e recusar por código inválido,
  // escondendo o motivo verdadeiro de quem só queria ligar a exigência.
  const codigo = texto(form, 'codigo');
  const resultado = await definirPoliticaDeSegundoFator(
    token,
    exigir,
    codigo.length > 0 ? codigo : undefined,
  );
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);
  redirect(`/admin/seguranca?politica=${exigir ? 'ligada' : 'desligada'}`);
}

export async function acaoComecarSegundoFator(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await comecarSegundoFator(token);
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);

  // Segredo em cookie de vida curta, nunca na URL: ele gera todos os códigos
  // futuros e a URL fica no histórico da máquina do balcão.
  await guardarSegredoDoMfa(resultado.dados);
  redirect('/admin/seguranca');
}

export async function acaoConfirmarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await confirmarSegundoFator(token, texto(form, 'codigo'));
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);

  await guardarCodigosDeRecuperacao(resultado.dados.codigosDeRecuperacao);
  redirect('/admin/seguranca?ativado=1');
}

/**
 * Desliga o segundo fator da própria conta.
 *
 * A saída que a rota tinha e a tela não. Pede o código pelo mesmo motivo que
 * ligar pede: sem ele, quem pegasse a sessão aberta tiraria a proteção antes de
 * mexer no dinheiro. A frase da tela já dizia que "desligar o segundo fator de
 * uma conta pede o código" — sobre um botão que não existia.
 */
export async function acaoDesligarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await desligarSegundoFator(token, texto(form, 'codigo'));
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);
  redirect('/admin/seguranca?feito=desligado');
}

/**
 * Prova o segundo fator para esta sessão.
 *
 * O destino é montado a partir de uma lista fechada, nunca aceito pronto do
 * formulário: é o mesmo cuidado de `destinoDoBalcao`, e aqui o alvo é a tela
 * que a pessoa acabou de ser impedida de abrir — dinheiro.
 */
export async function acaoVerificarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await verificarSegundoFatorAgora(token, texto(form, 'codigo'));
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);

  const destinos: Record<string, string> = {
    caixa: '/admin/caixa',
    fiado: '/admin/fiado',
    comanda: '/admin/comanda',
  };
  redirect(destinos[texto(form, 'voltarPara')] ?? '/admin/caixa');
}

// -- Comissão -----------------------------------------------------------------

/**
 * Alíquota digitada em porcentagem, gravada em pontos-base.
 *
 * "40" e "40,5" vêm do mesmo campo. `Number(v) * 100` daria 4049.999… para
 * 40,5 — o mesmo defeito de ponto flutuante do preço, na única porta que
 * faltava. Os pontos-base saem dos dígitos, como os centavos.
 */
function pontosBaseDoCampo(bruto: string): number | null {
  const limpo = bruto.trim().replace('%', '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;
  const [inteiro = '0', decimais = ''] = limpo.split('.');
  const pontos = Number(inteiro) * 100 + Number(decimais.padEnd(2, '0'));
  return pontos > 10_000 ? null : pontos;
}

export async function acaoSalvarRegraDeComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const modo = texto(form, 'modo');
  if (modo !== 'percent' && modo !== 'fixed' && modo !== 'tiers') {
    return falhar('/admin/comissao/regras', 'invalid_request');
  }

  let valor = 0;
  const faixas: { ateCents: number | null; pontosBase: number }[] = [];

  if (modo === 'percent') {
    const pontos = pontosBaseDoCampo(texto(form, 'aliquota'));
    if (pontos === null) return falhar('/admin/comissao/regras', 'aliquota_invalida');
    valor = pontos;
  } else if (modo === 'fixed') {
    valor = await centavos(form, 'valorFixo', '/admin/comissao/regras');
  } else {
    // Três faixas no formulário: duas com teto e a última aberta, que é o que
    // impede faturamento acima do último degrau ficar sem alíquota.
    for (const i of [0, 1, 2]) {
      const aliquota = texto(form, `faixaPontos${i}`);
      if (!aliquota) continue;
      const pontos = pontosBaseDoCampo(aliquota);
      if (pontos === null) return falhar('/admin/comissao/regras', 'aliquota_invalida');

      const ate = texto(form, `faixaAte${i}`);
      faixas.push({
        ateCents: ate ? await centavos(form, `faixaAte${i}`, '/admin/comissao/regras') : null,
        pontosBase: pontos,
      });
    }
    if (faixas.length === 0) return falhar('/admin/comissao/regras', 'faixas_ausentes');
    // A última é sempre aberta: o formulário não oferece outra forma.
    const ultima = faixas[faixas.length - 1];
    if (ultima) faixas[faixas.length - 1] = { ...ultima, ateCents: null };
  }

  const professionalId = texto(form, 'professionalId');

  /**
   * `srv:<id>` ou `cat:<id>` — o único lugar que lê o prefixo.
   *
   * Serviço e categoria são espaços de id diferentes na mesma pergunta ("em
   * quê?"), e o campo único é o que impede marcar os dois: uma regra com
   * serviço **e** categoria só casa quando aquele serviço está naquela
   * categoria, então na prática ela nunca dispara — e nada ficaria vermelho.
   */
  const alvo = texto(form, 'alvo');
  const serviceId = alvo.startsWith('srv:') ? alvo.slice(4) : '';
  const categoryId = alvo.startsWith('cat:') ? alvo.slice(4) : '';

  const resultado = await salvarRegraDeComissao(token, {
    modo,
    valor,
    ...(faixas.length ? { faixas } : {}),
    ...(professionalId ? { professionalId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(categoryId ? { categoryId } : {}),
  });
  if (!resultado.ok) return falhar('/admin/comissao/regras', resultado);
  redirect('/admin/comissao/regras?salvo=1');
}

export async function acaoRemoverRegraDeComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await removerRegraDeComissao(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/comissao/regras', resultado);
  redirect('/admin/comissao/regras?salvo=1');
}

export async function acaoConfiguracaoDeComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const base = texto(form, 'base');
  const tratamento = texto(form, 'tratamentoDoDesconto');
  if (base !== 'liquido' && base !== 'bruto') return falhar('/admin/comissao/regras', 'invalid_request');
  if (tratamento !== 'reduz_base' && tratamento !== 'custo_da_casa') {
    return falhar('/admin/comissao/regras', 'invalid_request');
  }

  const taxa = texto(form, 'tratamentoDaTaxa');
  if (taxa !== 'absorvida' && taxa !== 'rateada') {
    return falhar('/admin/comissao/regras', 'invalid_request');
  }

  const resultado = await salvarConfiguracaoDeComissao(token, {
    base,
    tratamentoDoDesconto: tratamento,
    tratamentoDaTaxa: taxa,
  });
  if (!resultado.ok) return falhar('/admin/comissao/regras', resultado);
  redirect('/admin/comissao/regras?salvo=1');
}

/**
 * A alíquota do adquirente, digitada em porcento e guardada em pontos-base.
 *
 * `3,19` na tela vira `319` no banco. A conversão é aqui e não no domínio pelo
 * mesmo motivo do preço: quem digita pensa em porcento, e dinheiro e alíquota
 * são inteiros em todo o resto do sistema.
 */
export async function acaoAliquotaDoAdquirente(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const forma = texto(form, 'forma');
  const bruto = texto(form, 'bps').trim().replace(',', '.');

  const porcento = bruto === '' ? 0 : Number(bruto);
  if (!Number.isFinite(porcento) || porcento < 0 || porcento > 30) {
    return falhar('/admin/comissao/regras', 'aliquota_invalida');
  }

  const resultado = await salvarAliquotaDoAdquirente(token, {
    forma,
    bps: Math.round(porcento * 100),
  });
  if (!resultado.ok) return falhar('/admin/comissao/regras', resultado);
  redirect('/admin/comissao/regras?salvo=1');
}

/**
 * Fecha o período.
 *
 * Depois disto o valor é imutável e o ajuste vira lançamento novo — por isso o
 * formulário confirma antes, e por isso o período vai por campo escondido, do
 * que a tela mostrou, e não digitado de novo.
 */
export async function acaoFecharComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await fecharComissao(token, {
    de: texto(form, 'de'),
    ate: texto(form, 'ate'),
    ...(texto(form, 'notas') ? { notas: texto(form, 'notas') } : {}),
  });
  if (!resultado.ok) return falhar('/admin/comissao', resultado);
  redirect('/admin/comissao?fechado=1');
}

// -- Avisos ------------------------------------------------------------------

/**
 * Salva o que a barbearia manda ao cliente.
 *
 * Caixa não marcada não chega no `FormData` — daí `form.has`, e não `texto`. A
 * diferença importa: com `texto(...) === 'on'` desligar um aviso funcionaria,
 * mas ligar de volta também dependeria de o navegador mandar o valor, e o
 * padrão do HTML é justamente não mandar.
 */
export async function acaoAvisos(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await salvarAvisos(token, {
    confirmacao: form.has('confirmacao'),
    lembrete24h: form.has('lembrete24h'),
    lembrete2h: form.has('lembrete2h'),
    retorno: form.has('retorno'),
    diasParaRetorno: numero(form, 'diasParaRetorno', 45),
  });

  if (!resultado.ok) return falhar('/admin/avisos', resultado);
  redirect('/admin/avisos?salvo=1');
}

