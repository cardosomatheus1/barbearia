'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import {
  ajustarConfianca,
  devolverSinalDoHorario,
  registrarSinal,
  adicionarSlug,
  analisarImportacao,
  aplicarImportacao,
  criarConta,
  criarMembro,
  entrarComoGestor,
  ligarMembro,
  marcarNoBalcao,
  moverAtendimento,
  publicarBarbearia,
  sairDoGestor,
  salvarEmpresa,
  salvarFotos,
  enviarFotoDaBarbearia,
  removerFotoDaBarbearia,
  type AlvoDeUpload,
  convidarProfissional,
  salvarAvisos,
  salvarJanela,
  salvarMetaDoProfissional,
  salvarPreferenciasDoCliente,
  salvarPagamentos,
  salvarProfissionais,
  reemitirSenha,
  reverterImportacao,
  resolverConflitoImportacao,
  salvarServicos,
  trocarMinhaSenha,
  trocarPapel,
  criarBloqueio,
  criarExcecao,
  moverAgendamento,
  removerExcecao,
  type TipoDeExcecao,
  criarProfissional,
  entrarNaFila,
  ajustarSaldoDeFidelidade,
  adiantarNaApi,
  cancelarValeNaApi,
  estornarVendaNaApi,
  transferirPacoteNaApi,
  salvarFiscalNaApi,
  emitirNotaNaApi,
  salvarDocumentoDoTomadorNaApi,
  salvarCadastroDoWhatsAppNaApi,
  conciliarWhatsAppNaApi,
  mandarMensagemNaApi,
  submeterTemplateNaApi,
  definirAutomacaoAtivaNaApi,
  salvarAutomacaoNaApi,
  abrirUnidadeNaApi,
  criarCampanhaNaApi,
  conectarWhatsAppNaApi,
  signupDoWhatsAppNaApi,
  enviarCampanhaNaApi,
  definirUnidadeAtivaNaApi,
  definirUnidadesNaApi,
  escolherUnidadeNaApi,
  transferirEstoqueNaApi,
  cancelarNotaNaApi,
  criarContaDoFinanceiro as criarContaDoFinanceiroApi,
  quitarContaDoFinanceiro as quitarContaDoFinanceiroApi,
  cancelarContaDoFinanceiro as cancelarContaDoFinanceiroApi,
  criarCategoriaDoFinanceiro as criarCategoriaDoFinanceiroApi,
  criarContaBancaria as criarContaBancariaApi,
  transferirEntreContas as transferirEntreContasApi,
  definirLimiteDeFiado as definirLimiteDeFiadoApi,
  lancarSaldoInicialDeFiado as lancarSaldoInicialDeFiadoApi,
  salvarPacoteNaApi,
  reembolsarPacoteNaApi,
  contestarAvaliacaoNaApi,
  retirarContestacaoNaApi,
  tratarAvaliacaoNaApi,
  salvarProdutoNaApi,
  moverEstoqueNaApi,
  salvarFichaNaApi,
  salvarPlanoNaApi,
  assinarNaApi,
  agendarCancelamentoNaApi,
  cancelarAssinaturaNaApi,
  cancelarFaturaNaApi,
  desfazerCancelamentoNaApi,
  pagarFaturaNaApi,
  salvarModeloDaAssinaturaNaApi,
  cadastrarRecebedorNaApi,
  salvarSplitNaApi,
  incluirDependenteNaApi,
  removerDependenteNaApi,
  assumirRecadoNaApi,
  devolverRecadoNaApi,
  encerrarRecadoNaApi,
  resolverLacunaNaApi,
  apagarFaixaNaApi,
  criarFaixaNaApi,
  ligarPrecoPorFaixaNaApi,
  apagarFotoNaApi,
  contestarClienteDoMarketplace,
  definirPerfilPublicoNaApi,
  publicarFotoNaApi,
  registrarFotoNaApi,
  definirVitrineNaApi,
  moverNaFila,
  responderRecadoNaApi,
  sentarDaFila,
  type StatusNaFila,
  criarServico,
  trocarDePlano,
  salvarPermissoesDoPapel,
  salvarProgramaDeFidelidade,
  editarProfissional,
  editarServico,
  exigenciasDoServico,
  ligarProfissional,
  ligarServico,
  salvarJornada,
  salvarRecursos,
  type AcaoAtendimento,
  type EntradaDeProfissional,
  type EntradaDeServico,
  type Papel,
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
  registrarConsentimentoNoBalcao,
  abrirPedidoDeDados,
  encerrarPedidoDeDados,
  anonimizarCliente as anonimizarClienteNaApi,
  encerrarSessao as encerrarSessaoDoAparelho,
  expulsarSuporte,
  salvarPreferenciasDeAlerta,
  adotarDoPadrao,
  criarChaveNaApi,
  cadastrarWebhookNaApi,
  desligarWebhookNaApi,
  revogarChaveNaApi,
  salvarMetaDaRedeNaApi,
  despublicarDoPadrao,
  publicarNoPadrao,
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

/**
 * A modalidade vinda do `select`, conferida antes de virar corpo de requisição.
 *
 * Campo de formulário é entrada externa. Um valor fora da lista subiria até a
 * borda da API e voltaria como 400 genérico — e a tela diria "não deu para
 * salvar" sobre um campo que a pessoa nem tocou.
 */
const MODALIDADES = new Set(['nenhum', 'fixo', 'percentual', 'total']);
type ModalidadeDoFormulario = 'nenhum' | 'fixo' | 'percentual' | 'total';

function modalidadeDeSinal(valor: string): ModalidadeDoFormulario {
  return MODALIDADES.has(valor) ? (valor as ModalidadeDoFormulario) : 'nenhum';
}
import {
  apagarSessaoGestor,
  guardarConflitoDaAgenda,
  guardarEstadoDaMeta,
  guardarMotivoDaMeta,
  guardarRascunho,
  guardarRecusa,
  guardarConflitoDeJornada,
  guardarLinkDaFila,
  guardarSenhaDeUmaVez,
  gravarSessaoGestor,
  lerSessaoGestor,
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

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? '').trim();
const numero = (form: FormData, campo: string, padrao: number): number => {
  const valor = Number(form.get(campo));
  return Number.isFinite(valor) ? valor : padrao;
};

/**
 * Recusa: o código na URL e **a frase do domínio** junto, num cookie.
 *
 * O código sozinho era o que a tela recebia, e cada tela traduzia o que ela
 * conhecia num `Record<string, string>` com `?? 'Não deu para salvar. Tente de
 * novo.'` no fim. Medido: os controllers mapeiam 239 códigos e os mapas das
 * telas cobrem 142 — **97 recusas** chegavam à barbearia como a frase genérica.
 *
 * O custo não é cosmético. A recepcionista digita 30% numa casa com teto de
 * 20%, e o domínio devolve *"O desconto máximo desta barbearia é R$ X"* — uma
 * frase escrita de propósito, com o número dentro, porque o comentário da rota
 * diz que *"recusado sem o número manda a recepção adivinhar"*. Ela viajava
 * pela rede inteira e era descartada na última linha: o que aparecia era "Tente
 * de novo", e a pessoa tentava de novo, para sempre.
 *
 * A frase vai por **cookie** e não pela URL, e isso é a regra do código de erro
 * que vai para o endereço: o que fica no histórico do navegador, no
 * autocompletar e no referrer não nomeia mecanismo nem carrega valor. O código
 * continua na URL porque é ele que a tela usa para decidir **onde** desenhar a
 * recusa; a frase é só o texto.
 *
 * `guardarRecusa` existe desde o bloco 98 e era escrita só por
 * `guardarOQueFoiDigitado` — o mecanismo estava pronto e ligado num caminho só.
 */
async function falhar(
  rota: string,
  erro: string | { readonly code: string; readonly message: string },
): Promise<never> {
  const code = typeof erro === 'string' ? erro : erro.code;
  if (typeof erro !== 'string') await guardarRecusa(erro.message);
  const separador = rota.includes('?') ? '&' : '?';
  redirect(`${rota}${separador}erro=${encodeURIComponent(code)}`);
}

/**
 * Guarda o que foi digitado antes de recusar (bloco 98).
 *
 * A recusa voltava com a frase certa e o formulário **vazio**: quem montou um
 * público de sete campos recomeçava do zero por um número que faltava.
 *
 * Só os campos que a tela sabe repor — `FormData` traz botão, chave de
 * idempotência e campo escondido junto, e reencher a tela com eles seria
 * devolver estado que ninguém digitou. A lista é da tela porque é ela que sabe
 * o que tem `defaultValue`.
 */
async function guardarOQueFoiDigitado(
  form: FormData,
  campos: readonly string[],
  mensagem?: string,
): Promise<void> {
  // A frase do domínio junto: ela diz **qual** campo está errado, e a tela
  // mostrava uma genérica sobre um formulário de sete campos.
  if (mensagem) await guardarRecusa(mensagem);
  const rascunho: Record<string, string> = {};
  for (const campo of campos) {
    const valor = form.get(campo);
    /**
     * Campo ausente vira string vazia, e não some.
     *
     * Some, ele volta ao **padrão** na próxima renderização — e o padrão da
     * caixa "Começar ligada" é marcada. Quem desmarcou de propósito e levou uma
     * recusa por outro campo encontrava a caixa marcada de novo: a tela
     * desfazendo em silêncio uma decisão que alguém tomou.
     */
    rascunho[campo] = typeof valor === 'string' ? valor : '';
  }
  await guardarRascunho(rascunho);
}

/**
 * Teto do arquivo de importação, em bytes — o mesmo que a API recusa.
 *
 * Conferido aqui também para que o arquivo grande demais nem seja lido na
 * memória do servidor de tela antes de a API dizer não. Repetido em vez de
 * importado do pacote da API porque `apps/web` não depende dela: os dois falam
 * HTTP, e um número é barato de duplicar com o motivo escrito.
 */
const TETO_DO_ARQUIVO = 8 * 1024 * 1024;

async function exigirSessao(): Promise<string> {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');
  return token;
}


/** Valor em centavos vindo do formulário, compartilhado entre domínios. */
async function centavos(form: FormData, campo: string, rota: string): Promise<number> {
  const valor = centavosDoCampo(texto(form, campo));
  if (valor === null) return falhar(rota, 'valor_invalido');
  return valor;
}

/** Campo opcional: vazio é zero, mas escrito errado continua sendo erro. */
async function centavosOpcionais(form: FormData, campo: string, rota: string): Promise<number> {
  return texto(form, campo) === '' ? 0 : centavos(form, campo, rota);
}

// -- Avaliações (bloco 43) ----------------------------------------------------

/**
 * Registra o que a casa fez a respeito de uma nota baixa.
 *
 * "Tratar", e não "resolver": a avaliação publica de qualquer forma passadas as
 * 48 horas, e a segunda palavra sugeriria que o registro faz a nota sumir. O
 * vocabulário é o mesmo na tela, na trilha e no domínio.
 */
export async function acaoTratarAvaliacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const desfecho = texto(form, 'desfecho');
  if (!['contato', 'retrabalho', 'credito', 'sem_retorno'].includes(desfecho)) {
    return falhar('/admin/avaliacoes', 'invalid_request');
  }

  const resultado = await tratarAvaliacaoNaApi(token, texto(form, 'id'), {
    desfecho: desfecho as 'contato' | 'retrabalho' | 'credito' | 'sem_retorno',
    nota: texto(form, 'nota'),
  });
  if (!resultado.ok) return falhar('/admin/avaliacoes', resultado);
  redirect('/admin/avaliacoes?tratada=1');
}

/**
 * Contestar não é apagar, e a mensagem de volta diz isso.
 *
 * O redirecionamento leva `contestada=1`, e o aviso da tela repete que a nota
 * continua na média do gestor. Um "pronto!" genérico ensinaria a equipe que o
 * botão faz a avaliação sumir — que é o oposto do que ele faz.
 */
export async function acaoContestarAvaliacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivo');
  if (!MOTIVOS_DA_CONTESTACAO.includes(motivo as MotivoDaContestacao)) {
    return falhar('/admin/avaliacoes', 'invalid_request');
  }

  const resultado = await contestarAvaliacaoNaApi(token, texto(form, 'id'), {
    motivo: motivo as MotivoDaContestacao,
    nota: texto(form, 'nota'),
  });
  if (!resultado.ok) return falhar('/admin/avaliacoes', resultado);
  redirect('/admin/avaliacoes?contestada=1');
}

/**
 * A saída do estado. Sem ela, contestar por engano seria definitivo.
 */
export async function acaoRetirarContestacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await retirarContestacaoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/avaliacoes', resultado);
  redirect('/admin/avaliacoes?retirada=1');
}

// -- Estoque (bloco 44) -------------------------------------------------------

export async function acaoSalvarProduto(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const tipo = texto(form, 'tipo');
  if (tipo !== 'resale' && tipo !== 'internal') return falhar('/admin/estoque', 'invalid_request');

  const preco = Number(form.get('precoReais') ?? 0);
  const custo = Number(form.get('custoReais') ?? 0);
  const vence = texto(form, 'venceEm');

  const resultado = await salvarProdutoNaApi(
    token,
    {
      nome: texto(form, 'nome'),
      tipo: tipo as 'resale' | 'internal',
      sku: texto(form, 'sku') || null,
      barcode: texto(form, 'barcode') || null,
      categoria: texto(form, 'categoria') || null,
      fornecedor: texto(form, 'fornecedor') || null,
      custoCents: Math.round(custo * 100),
      // O preço só existe na revenda; no uso interno vira nulo, e o domínio
      // ignora o que vier.
      precoCents: tipo === 'resale' ? Math.round(preco * 100) : null,
      minimo: Number(form.get('minimo') ?? 0),
      unidade: texto(form, 'unidade') || 'un',
      venceEm: vence.length > 0 ? vence : null,
      ativo: form.get('ativo') === 'on',
    },
    id.length > 0 ? id : undefined,
  );
  if (!resultado.ok) return falhar('/admin/estoque', resultado);
  redirect('/admin/estoque?salvo=1');
}

/**
 * Lança um movimento à mão: entrada, perda, ajuste.
 *
 * `venda` e `consumo` não têm botão em lugar nenhum — eles nascem do fechamento
 * da comanda. Um botão de "vender" aqui seria a segunda fonte do mesmo fato: o
 * estoque baixando sem dinheiro entrando no caixa.
 */
export async function acaoMoverEstoque(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivo');

  const resultado = await moverEstoqueNaApi(token, {
    produtoId: texto(form, 'produtoId'),
    tipo: texto(form, 'tipo'),
    quantidade: Number(form.get('quantidade') ?? 0),
    ...(motivo.length > 0 ? { motivo } : {}),
  });
  if (!resultado.ok) return falhar('/admin/estoque', resultado);
  redirect('/admin/estoque?movido=1');
}

/**
 * Salva a ficha de consumo de um serviço (bloco 44).
 *
 * A ficha é substituída inteira: é uma lista curta que a barbearia refaz de uma
 * vez ("agora a barba usa outro pós-barba"), e um formulário com adicionar e
 * remover por linha seria mais tela do que o dado merece.
 *
 * Quantidade zero significa "não usa": a tela lista todos os produtos internos
 * e quem estiver em zero simplesmente não entra.
 */
export async function acaoSalvarFicha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const serviceId = texto(form, 'serviceId');

  const itens = form
    .getAll('produtoId')
    .map(String)
    .map((produtoId) => ({
      produtoId,
      quantidade: Number(form.get(`qtd-${produtoId}`) ?? 0),
    }))
    .filter((i) => Number.isInteger(i.quantidade) && i.quantidade > 0);

  const resultado = await salvarFichaNaApi(token, serviceId, itens);
  if (!resultado.ok) return falhar('/admin/catalogo', resultado);
  redirect('/admin/catalogo?ficha=1');
}

// -- Clube de assinatura (bloco 45) -------------------------------------------

/**
 * Salva um plano do clube.
 *
 * Os benefícios são substituídos inteiros, como a ficha de consumo: é uma lista
 * curta que a barbearia refaz de uma vez. O preço já vendido não muda por isso —
 * a assinatura congela o valor na adesão.
 *
 * Quantidade vazia significa **ilimitado**, e é por isso que o campo aceita
 * vazio em vez de exigir um número grande: `9999` é uma cota disfarçada.
 */
export async function acaoSalvarPlano(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const preco = Number(form.get('precoReais') ?? 0);
  const desconto = Number(form.get('descontoPercent') ?? 0);

  /**
   * As faixas em que o plano não vale (bloco 46).
   *
   * Uma linha por dia da semana, com começo e fim vazios significando "não
   * bloqueia". Guardar o proibido e não o permitido é a decisão do bloco: a
   * barbearia abre setenta horas e bloqueia quatro.
   */
  const bloqueios = [0, 1, 2, 3, 4, 5, 6]
    .map((dia) => ({
      diaDaSemana: dia,
      inicio: horaEmMinutos(String(form.get(`blk-ini-${dia}`) ?? '')),
      fim: horaEmMinutos(String(form.get(`blk-fim-${dia}`) ?? '')),
    }))
    .filter((b): b is { diaDaSemana: number; inicio: number; fim: number } =>
      b.inicio !== null && b.fim !== null && b.inicio < b.fim,
    );

  const beneficios = form
    .getAll('servicoId')
    .map(String)
    .map((serviceId) => {
      const bruto = String(form.get(`qtd-${serviceId}`) ?? '').trim();
      const marcado = form.get(`inclui-${serviceId}`) === 'on';
      return {
        serviceId,
        marcado,
        // Vazio é ilimitado; um número é a cota.
        quantidade: bruto.length > 0 ? Number(bruto) : null,
        cooldownDias: Number(form.get(`cd-${serviceId}`) ?? 0),
      };
    })
    .filter((b) => b.marcado)
    .map(({ serviceId, quantidade, cooldownDias }) => ({ serviceId, quantidade, cooldownDias }));

  const resultado = await salvarPlanoNaApi(
    token,
    {
      nome: texto(form, 'nome'),
      descricao: texto(form, 'descricao') || null,
      precoCents: Math.round(preco * 100),
      descontoEmProdutoBps: Math.round(desconto * 100),
      ativo: form.get('ativo') === 'on',
      janelaDeAgendamentoDias: Number(form.get('janelaDias') ?? 0),
      // O seletor sempre traz um dos dois; "empresa" é o padrão e o
      // comportamento anterior (bloco 59).
      escopo: texto(form, 'escopo') === 'unidade' ? ('unidade' as const) : ('empresa' as const),
      beneficios,
      bloqueios,
    },
    id.length > 0 ? id : undefined,
  );
  if (!resultado.ok) return falhar('/admin/clube', resultado);
  redirect('/admin/clube?salvo=1');
}

export async function acaoAssinar(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await assinarNaApi(token, customerId, texto(form, 'planId'));
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=assinou`);
}

export async function acaoCancelarAssinatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await cancelarAssinaturaNaApi(token, texto(form, 'id'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=cancelou`);
}

/**
 * Cadastra a conta de recebimento de um profissional no adquirente (bloco 50).
 *
 * Documento, banco, agência e conta **atravessam** para o adquirente e não são
 * gravados no produto — quem tem obrigação regulatória de guardá-los é ele.
 * Deste lado fica a referência opaca, pela mesma razão do token do cartão.
 */
export async function acaoCadastrarRecebedor(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cadastrarRecebedorNaApi(
    token,
    texto(form, 'professionalId'),
    {
      documento: texto(form, 'documento').replace(/\D/g, ''),
      banco: texto(form, 'banco'),
      agencia: texto(form, 'agencia'),
      conta: texto(form, 'conta'),
    },
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) return falhar('/admin/comissao', resultado);
  redirect('/admin/comissao?feito=recebedor');
}

/**
 * Liga o repasse direto ao barbeiro (bloco 49).
 *
 * Muda **para onde o dinheiro vai**: ligado, o adquirente manda a comissão
 * direto para a conta do profissional, e a casa deixa de receber o valor cheio.
 * `finance.split_manage` cai no grupo de dinheiro pelo prefixo e traz o segundo
 * fator derivado junto.
 */
export async function acaoSalvarSplit(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await salvarSplitNaApi(token, form.get('ligado') === 'on');
  if (!resultado.ok) return falhar('/admin/comissao', resultado);
  redirect('/admin/comissao?feito=split');
}

/**
 * O dono escolhe como a comissão sobre assinatura é paga (bloco 48).
 *
 * Muda **quanto a equipe inteira recebe** a partir do próximo fechamento, e por
 * isso passa por `finance.subscription_manage` — que cai no grupo de dinheiro
 * pelo prefixo e traz o segundo fator derivado junto.
 */
export async function acaoSalvarModeloDaAssinatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const teto = Number(form.get('tetoPercent') ?? 60);
  const resultado = await salvarModeloDaAssinaturaNaApi(
    token,
    texto(form, 'modo'),
    Math.round(teto * 100),
  );
  if (!resultado.ok) return falhar('/admin/clube', resultado);
  redirect('/admin/clube?feito=modelo');
}

// -- as mensalidades do clube (bloco 47) --------------------------------------

/**
 * O balcão dá baixa numa mensalidade.
 *
 * É o caminho que de fato acontece numa casa pequena: o assinante paga o plano
 * no Pix e alguém registra. Auditado, porque quem digita "recebi R$ 149" é a
 * única testemunha de dinheiro que entrou por fora da gaveta.
 */
export async function acaoPagarFatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await pagarFaturaNaApi(token, texto(form, 'id'), texto(form, 'metodo'));
  if (!resultado.ok) return falhar('/admin/clube', resultado);
  redirect('/admin/clube?feito=pagou');
}

/** Cancelar uma fatura é perdoar uma dívida — e por isso tem motivo escrito. */
export async function acaoCancelarFatura(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cancelarFaturaNaApi(token, texto(form, 'id'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar('/admin/clube', resultado);
  redirect('/admin/clube?feito=cancelou_fatura');
}

/**
 * O balcão agenda a saída para o fim do ciclo pago.
 *
 * Diferente de cancelar na hora: o cliente pagou o mês e corta até o fim dele.
 * Cortar no dia do pedido seria ficar com o dinheiro e não entregar o serviço.
 */
export async function acaoAgendarCancelamento(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await agendarCancelamentoNaApi(token, texto(form, 'id'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=agendou_saida`);
}

/** O cliente mudou de ideia antes de o ciclo acabar. */
export async function acaoDesfazerCancelamento(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await desfazerCancelamentoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=manteve`);
}

/** `HH:mm` para minutos desde a meia-noite. Vazio devolve nulo. */
function horaEmMinutos(valor: string): number | null {
  const casou = /^(\d{1,2}):(\d{2})$/.exec(valor.trim());
  if (!casou) return null;
  const h = Number(casou[1]);
  const m = Number(casou[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export async function acaoIncluirDependente(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await incluirDependenteNaApi(
    token,
    texto(form, 'subscriptionId'),
    texto(form, 'dependenteId'),
  );
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=dependente`);
}

export async function acaoRemoverDependente(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await removerDependenteNaApi(
    token,
    texto(form, 'subscriptionId'),
    texto(form, 'dependenteId'),
  );
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=dependente`);
}

// -- Financeiro (bloco 51) ----------------------------------------------------

const ROTA_FINANCEIRO = '/admin/financeiro';

/**
 * A direção chega de um campo escondido, que é entrada externa como qualquer
 * outra. A API valida de novo — esta guarda existe para o erro ser o da tela.
 */
async function direcaoDaConta(form: FormData, rota: string): Promise<'pagar' | 'receber'> {
  const valor = texto(form, 'direcao');
  if (valor !== 'pagar' && valor !== 'receber') return falhar(rota, 'invalid_request');
  return valor;
}

export async function acaoCriarContaDoFinanceiro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const direcao = await direcaoDaConta(form, ROTA_FINANCEIRO);
  const categoriaId = texto(form, 'categoriaId');
  const contaId = texto(form, 'contaId');

  const resultado = await criarContaDoFinanceiroApi(token, {
    direcao,
    descricao: texto(form, 'descricao'),
    valorCents: await centavos(form, 'valorCents', ROTA_FINANCEIRO),
    vencimentoEm: texto(form, 'vencimentoEm'),
    categoriaId: categoriaId || null,
    contaId: contaId || null,
    observacao: texto(form, 'observacao') || null,
  });
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=criada`);
}

export async function acaoQuitarContaDoFinanceiro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await quitarContaDoFinanceiroApi(token, texto(form, 'contaId'), {
    valorPagoCents: await centavos(form, 'valorPagoCents', ROTA_FINANCEIRO),
    pagaEm: texto(form, 'pagaEm'),
    pelaGaveta: texto(form, 'pelaGaveta') === '1',
  });
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=quitada`);
}

export async function acaoCancelarContaDoFinanceiro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cancelarContaDoFinanceiroApi(
    token,
    texto(form, 'contaId'),
    texto(form, 'motivo'),
  );
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=cancelada`);
}

export async function acaoCriarCategoriaDoFinanceiro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await criarCategoriaDoFinanceiroApi(token, {
    nome: texto(form, 'nome'),
    direcao: await direcaoDaConta(form, ROTA_FINANCEIRO),
  });
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=categoria`);
}

export async function acaoCriarContaBancaria(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await criarContaBancariaApi(token, { nome: texto(form, 'nome') });
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=conta`);
}

export async function acaoTransferirEntreContas(form: FormData): Promise<void> {
  const token = await exigirSessao();
  /**
   * A chave é do **formulário**, não do envio.
   *
   * Ela nasce no servidor quando a tela é montada e viaja num campo escondido:
   * o segundo toque no botão manda a mesma, e a API devolve a transferência já
   * feita em vez de fazer a segunda. Gerá-la aqui daria uma chave nova por
   * envio, que é exatamente o que não protege nada.
   */
  const resultado = await transferirEntreContasApi(
    token,
    {
      deContaId: texto(form, 'deContaId'),
      paraContaId: texto(form, 'paraContaId'),
      valorCents: await centavos(form, 'valorCents', ROTA_FINANCEIRO),
      quandoEm: texto(form, 'quandoEm'),
      observacao: texto(form, 'observacao') || null,
    },
    texto(form, 'chave') || undefined,
  );
  if (!resultado.ok) return falhar(ROTA_FINANCEIRO, resultado);
  redirect(`${ROTA_FINANCEIRO}?salvo=transferida`);
}

/**
 * O limite de fiado mora na ficha do cliente, e é lá que ele volta.
 *
 * Zero é valor legítimo e significa "não vende fiado para esta pessoa" — por
 * isso `centavosOpcionais`, que aceita o campo vazio, e não `centavos`.
 */
export async function acaoDefinirLimiteDeFiado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const rota = `/admin/cliente/${customerId}?aba=financeiro`;
  const resultado = await definirLimiteDeFiadoApi(
    token,
    customerId,
    await centavosOpcionais(form, 'limiteCents', rota),
  );
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}&salvo=limite`);
}

export async function acaoLancarSaldoInicialDeFiado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const rota = `/admin/cliente/${customerId}?aba=financeiro`;
  const resultado = await lancarSaldoInicialDeFiadoApi(token, customerId, {
    deveCents: await centavos(form, 'deveCents', rota),
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}&salvo=saldo-inicial`);
}

// -- Vale, estorno e transferência de pacote (bloco 52) -----------------------

export async function acaoAdiantarVale(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const rota = '/admin/comissao';
  const resultado = await adiantarNaApi(
    token,
    {
      professionalId: texto(form, 'professionalId'),
      valorCents: await centavos(form, 'valorCents', rota),
      de: texto(form, 'de'),
      ate: texto(form, 'ate'),
      motivo: texto(form, 'motivo') || null,
      pelaGaveta: texto(form, 'pelaGaveta') === '1',
    },
    // A chave nasce com a página e viaja no formulário: o segundo toque manda a
    // mesma, e a API devolve o vale já lançado em vez de lançar o segundo.
    texto(form, 'chave') || undefined,
  );
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}?feito=vale`);
}

export async function acaoCancelarVale(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const rota = '/admin/comissao';
  const resultado = await cancelarValeNaApi(token, texto(form, 'valeId'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}?feito=vale-cancelado`);
}

/**
 * O estorno volta para a comanda, e não para a lista.
 *
 * É onde a pessoa estava, e é onde ela confere o que aconteceu: a tela da
 * comanda estornada mostra o que foi desfeito. Mandá-la para a lista deixaria a
 * operação com mais consequências do produto sem nenhuma confirmação visível.
 */
export async function acaoEstornarVenda(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const orderId = texto(form, 'orderId');
  const rota = `/admin/comanda/${orderId}`;
  const resultado = await estornarVendaNaApi(token, orderId, texto(form, 'motivo'));
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}?feito=estornada`);
}

export async function acaoTransferirPacote(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const rota = `/admin/cliente/${customerId}?aba=fidelidade`;
  const resultado = await transferirPacoteNaApi(token, texto(form, 'customerPackageId'), {
    paraCustomerId: texto(form, 'paraCustomerId'),
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}&salvo=pacote-transferido`);
}

