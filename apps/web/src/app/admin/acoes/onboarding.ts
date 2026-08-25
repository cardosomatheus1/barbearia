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

export async function acaoCriarConta(form: FormData): Promise<void> {
  const resultado = await criarConta({
    name: texto(form, 'name'),
    email: texto(form, 'email'),
    password: String(form.get('password') ?? ''),
    phone: texto(form, 'phone'),
    businessName: texto(form, 'businessName'),
    ...(texto(form, 'cf-turnstile-response')
      ? { turnstileToken: texto(form, 'cf-turnstile-response') }
      : {}),
  });

  /**
   * O **código**, nunca a frase — as duas portas de entrada são a exceção.
   *
   * `falhar` com o objeto guarda a mensagem do domínio num cookie para a tela
   * mostrar, e isso é o certo em toda tela de dentro. Aqui não: a frase da API
   * sobre login e cadastro é justamente o que a regra de não revelar existência
   * de cadastro existe para não dizer. É o precedente do OTP.
   */
  if (!resultado.ok) return falhar('/admin/criar-conta', resultado.code);

  // Sem sessão automática: a API responde igual para e-mail novo e já
  // cadastrado, e entregar sessão só num dos casos desfaria isso na tela.
  redirect('/admin/entrar?criada=1');
}

export async function acaoEntrar(form: FormData): Promise<void> {
  const resultado = await entrarComoGestor(texto(form, 'email'), String(form.get('password') ?? ''));
  // O código, nunca a frase: a porta de entrada não conta quem existe.
  if (!resultado.ok) return falhar('/admin/entrar', resultado.code);

  await gravarSessaoGestor(resultado.dados.token, resultado.dados.expiresAt);

  // Quem entrou com a senha de primeiro acesso não opera nada até escolher a
  // sua: mandar para o painel faria a pessoa bater em 403 na primeira porta e
  // achar que o sistema quebrou.
  redirect(resultado.dados.mustChangePassword ? '/admin/trocar-senha' : '/admin');
}

export async function acaoSair(): Promise<void> {
  const token = await lerSessaoGestor();
  // Revoga no servidor antes de apagar o cookie: só apagar deixaria o token
  // aceito por quem o tivesse capturado.
  if (token) await sairDoGestor(token);
  await apagarSessaoGestor();
  redirect('/admin/entrar');
}

// -- Etapa 2 -----------------------------------------------------------------

export async function acaoEmpresa(form: FormData): Promise<void> {
  const token = await exigirSessao();

  /**
   * Todos os campos, sempre — inclusive vazios (bloco 111).
   *
   * A tela omitia o que estava em branco, e do outro lado o domínio tratava
   * ausente como "apague". Agora o formulário **vem preenchido**, então o que
   * chega vazio é a pessoa tendo apagado: é isso que tira da página pública o
   * celular que alguém cadastrou por engano. Omitir continuaria a impedir a
   * limpeza — e não há segunda tela para esse cadastro.
   */
  const resultado = await salvarEmpresa(token, {
    name: texto(form, 'name'),
    street: texto(form, 'street'),
    district: texto(form, 'district'),
    city: texto(form, 'city'),
    state: texto(form, 'state').toUpperCase(),
    phone: texto(form, 'phone'),
    whatsapp: texto(form, 'whatsapp'),
    instagram: texto(form, 'instagram'),
    linkDoMapa: texto(form, 'linkDoMapa'),
    about: texto(form, 'about'),
    // O fuso vem da unidade, nunca do aparelho de quem visita — é aqui, e só
    // aqui, que ele é escolhido. Vazio nunca: é um `select` com padrão.
    ...(texto(form, 'timezone') ? { timezone: texto(form, 'timezone') } : {}),
    amenities: form.getAll('amenities').map(String),
  });

  if (!resultado.ok) return falhar('/admin/onboarding?e=2', resultado);
  redirect('/admin/onboarding?e=3');
}

// -- Etapa 3 -----------------------------------------------------------------

/**
 * Grava o cardápio a partir do que o dono marcou e editou.
 *
 * O formulário manda todos os templates; os desmarcados são descartados aqui.
 * A duração vai como o dono deixou — e se ele encurtar um combo abaixo da soma
 * das partes, a API recusa e devolve **qual** combo está errado. É o defeito D4
 * barrado na origem, e não descoberto com o barbeiro atrasado.
 */
export async function acaoServicos(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const marcados = new Set(form.getAll('escolhidos').map(String));
  const chaves = form.getAll('chave').map(String);

  const services = chaves
    .filter((chave) => marcados.has(chave))
    .map((chave) => {
      const componentes = texto(form, `componentes_${chave}`)
        .split(',')
        .filter((c) => c && marcados.has(c));

      return {
        key: chave,
        name: texto(form, `nome_${chave}`),
        description: texto(form, `descricao_${chave}`) || undefined,
        category: texto(form, `categoria_${chave}`),
        durationMinutes: numero(form, `duracao_${chave}`, 30),
        bufferAfterMinutes: numero(form, `buffer_${chave}`, 5),
        priceCents: Math.round(numero(form, `preco_${chave}`, 0) * 100),
        ...(componentes.length >= 2 ? { componentKeys: componentes } : {}),
      };
    });

  if (services.length === 0) return falhar('/admin/onboarding?e=3', 'nenhum_servico');

  const resultado = await salvarServicos(token, services);
  if (!resultado.ok) {
    const busca = new URLSearchParams({ e: '3', erro: resultado.code });
    // O detalhe diz qual combo está incoerente; sem ele a tela só saberia dizer
    // "dados inválidos".
    if (Array.isArray(resultado.detail)) {
      busca.set('quais', resultado.detail.map((p) => String((p as { key: string }).key)).join(','));
    }
    redirect(`/admin/onboarding?${busca.toString()}`);
  }

  redirect('/admin/onboarding?e=4');
}

// -- Etapa 4 -----------------------------------------------------------------

export async function acaoProfissionais(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const nomes = form.getAll('profissional').map(String).filter(Boolean);
  if (nomes.length === 0) return falhar('/admin/onboarding?e=4', 'nenhum_profissional');

  const dias = form.getAll('dia').map(Number);
  const abre = numero(form, 'abre', 540);
  const fecha = numero(form, 'fecha', 1080);

  if (dias.length === 0) return falhar('/admin/onboarding?e=4', 'nenhum_dia');
  if (abre >= fecha) return falhar('/admin/onboarding?e=4', 'jornada_invertida');

  // A jornada é a mesma para toda a equipe nesta etapa. Diferenciar por pessoa
  // é trabalho de cadastro, e o objetivo aqui é chegar ao link em dez minutos —
  // o ajuste por pessoa fica no CRUD da equipe (bloco 13).
  const schedule = dias.map((weekday) => ({ weekday, startMinute: abre, endMinute: fecha }));

  const resultado = await salvarProfissionais(
    token,
    nomes.map((name) => ({ name, schedule })),
  );
  if (!resultado.ok) return falhar('/admin/onboarding?e=4', resultado);

  redirect('/admin/onboarding?e=5');
}

// -- Etapa 5 -----------------------------------------------------------------

export async function acaoPagamentos(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await salvarPagamentos(token, form.getAll('metodo').map(String));
  if (!resultado.ok) return falhar('/admin/onboarding?e=5', resultado);
  redirect('/admin/onboarding?e=6');
}

// -- Etapa 6 -----------------------------------------------------------------

export async function acaoPublicar(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await publicarBarbearia(token);
  if (!resultado.ok) return falhar('/admin/onboarding?e=6', resultado);
  redirect(`/admin/onboarding?e=6&publicado=1`);
}

// -- Configuração ------------------------------------------------------------

/**
 * Os meios que a casa aceita (bloco 127).
 *
 * Ação própria e não um campo dentro de `acaoJanela` porque a rota é outra
 * (`PUT /v1/admin/payments`, do onboarding) e porque a semântica de ausência é
 * diferente: aqui o formulário **sempre** manda a decisão inteira, e nenhuma
 * caixa marcada quer dizer "não anuncio nenhum meio", não "não mexa". É a
 * mesma decisão de `amenities`, que já é absoluta pelo mesmo motivo — uma lista
 * de caixas não tem como dizer "deixe como estava".
 */
export async function acaoMeiosAceitos(form: FormData): Promise<void> {
  const token = await exigirSessao();
  // O mesmo `metodo` do onboarding, que grava na mesma coluna pela mesma rota.
  // Dois nomes de campo para o mesmo dado é a divergência do bloco seguinte.
  const escolhidos = form.getAll('metodo').map(String).filter(ehMeioAceito);

  const resultado = await salvarPagamentos(token, [...escolhidos]);
  if (!resultado.ok) return falhar('/admin/configuracoes', resultado);
  redirect('/admin/configuracoes?salvo=1');
}

export async function acaoJanela(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await salvarJanela(token, {
    cancelMinHours: numero(form, 'cancelMinHours', 2),
    rescheduleMinHours: numero(form, 'rescheduleMinHours', 2),
    maxReschedules: numero(form, 'maxReschedules', 2),
    // Por cento na tela, pontos-base no banco. A conversão fica aqui, num lugar
    // só — espalhá-la faria dois pontos do código discordarem sobre 12,5%.
    maxDiscountBps: Math.min(100, Math.max(0, numero(form, 'maxDiscountPercent', 20))) * 100,
    // O escopo do fiado (bloco 59). Vai sempre que o formulário o traz, e o
    // formulário sempre traz: é um seletor com as duas opções, não uma caixa —
    // "não marcado" aqui significaria uma terceira coisa que não existe.
    ...(texto(form, 'creditScope') === 'unidade'
      ? { creditScope: 'unidade' as const }
      : { creditScope: 'empresa' as const }),
    /**
     * O limiar de recusa (bloco 60). Campo vazio é **desligar**, não "não
     * mexa": o seletor está sempre na tela, então o que ele traz é sempre uma
     * decisão de quem salvou.
     */
    onlineBlockScore: (() => {
      const bruto = texto(form, 'onlineBlockFaltas');
      if (!bruto) return null;
      // Faltas em dez → limiar de score, pela mesma tradução do sinal. A tela
      // nunca fala em score, e a conversão fica num lugar só.
      return limiarDeFaltas(Number(bruto));
    })(),
    ...(texto(form, 'cancellationPolicy')
      ? { cancellationPolicy: texto(form, 'cancellationPolicy') }
      : {}),
    // O encarregado vai sempre que o formulário o traz, inclusive vazio: apagar
    // o campo é uma decisão legítima — a barbearia trocou de encarregado e
    // ainda não tem outro — e ignorá-la deixaria na página pública o contato de
    // quem não responde mais por isso.
    ...(form.has('dpoName') ? { dpoName: texto(form, 'dpoName') } : {}),
    ...(form.has('dpoEmail') ? { dpoEmail: texto(form, 'dpoEmail') } : {}),
    /**
     * O sinal (bloco 37).
     *
     * A tela pergunta em reais e em "faltas em dez"; o banco guarda centavos,
     * pontos-base e um limiar de score. As duas conversões ficam aqui, num
     * lugar só — espalhá-las faria a tela mostrar um número e a API aplicar
     * outro, que é como o teto de desconto quase entrou.
     */
    ...(form.has('depositMode')
      ? {
          deposit: {
            mode: modalidadeDeSinal(texto(form, 'depositMode')),
            fixedCents: numero(form, 'depositFixed', 20) * 100,
            percentBps: numero(form, 'depositPercent', 30) * 100,
            scoreThreshold: limiarDeFaltas(numero(form, 'depositThreshold', 5)),
            ticketOverCents: numero(form, 'depositTicketOver', 0) * 100,
            refundHours: numero(form, 'depositRefundHours', 24),
          },
        }
      : {}),
  });

  if (!resultado.ok) return falhar('/admin/configuracoes', resultado);
  redirect('/admin/configuracoes?salvo=1');
}

