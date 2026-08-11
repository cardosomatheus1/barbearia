'use server';

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
  convidarProfissional,
  salvarAvisos,
  salvarJanela,
  salvarMetaDoProfissional,
  salvarPreferenciasDoCliente,
  salvarPagamentos,
  salvarProfissionais,
  reemitirSenha,
  reverterImportacao,
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
  salvarPacoteNaApi,
  reembolsarPacoteNaApi,
  assumirRecadoNaApi,
  devolverRecadoNaApi,
  encerrarRecadoNaApi,
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
} from '@/lib/admin-api';
import { versaoDoConsentimento } from '@/lib/politica';
import { ehConversa } from '@barbearia/core';
import { DIAS, lerJornada, minutosOuNulo } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import { limiarDeFaltas } from '@/lib/sinal';
import { destinoDoBalcao } from '@/lib/destino';

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

function falhar(rota: string, code: string): never {
  const separador = rota.includes('?') ? '&' : '?';
  redirect(`${rota}${separador}erro=${encodeURIComponent(code)}`);
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

/**
 * Lista fechada das ações que o balcão pode enviar.
 *
 * O `action` chega de um campo escondido do formulário, que é entrada externa
 * como qualquer outra. A API valida de novo — esta guarda existe para a tela
 * não gastar uma ida ao servidor com lixo, e para o erro ser o da tela.
 */
const ACOES_DE_ATENDIMENTO: ReadonlySet<string> = new Set([
  'confirm', 'check_in', 'wait', 'start', 'complete', 'no_show', 'undo_no_show', 'cancel',
]);

async function exigirSessao(): Promise<string> {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');
  return token;
}

export async function acaoCriarConta(form: FormData): Promise<void> {
  const resultado = await criarConta({
    name: texto(form, 'name'),
    email: texto(form, 'email'),
    password: String(form.get('password') ?? ''),
    phone: texto(form, 'phone'),
    businessName: texto(form, 'businessName'),
  });

  if (!resultado.ok) falhar('/admin/criar-conta', resultado.code);

  // Sem sessão automática: a API responde igual para e-mail novo e já
  // cadastrado, e entregar sessão só num dos casos desfaria isso na tela.
  redirect('/admin/entrar?criada=1');
}

export async function acaoEntrar(form: FormData): Promise<void> {
  const resultado = await entrarComoGestor(texto(form, 'email'), String(form.get('password') ?? ''));
  if (!resultado.ok) falhar('/admin/entrar', resultado.code);

  await gravarSessaoGestor(resultado.dados.token, resultado.dados.expiresAt);

  // Quem entrou com a senha de primeiro acesso não opera nada até escolher a
  // sua: mandar para o painel faria a pessoa bater em 403 na primeira porta e
  // achar que o sistema quebrou.
  redirect(resultado.dados.mustChangePassword ? '/admin/trocar-senha' : '/admin/dia');
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

  const resultado = await salvarEmpresa(token, {
    name: texto(form, 'name'),
    ...(texto(form, 'street') ? { street: texto(form, 'street') } : {}),
    ...(texto(form, 'district') ? { district: texto(form, 'district') } : {}),
    ...(texto(form, 'city') ? { city: texto(form, 'city') } : {}),
    ...(texto(form, 'state') ? { state: texto(form, 'state').toUpperCase() } : {}),
    ...(texto(form, 'phone') ? { phone: texto(form, 'phone') } : {}),
    ...(texto(form, 'whatsapp') ? { whatsapp: texto(form, 'whatsapp') } : {}),
    ...(texto(form, 'instagram') ? { instagram: texto(form, 'instagram') } : {}),
    ...(texto(form, 'about') ? { about: texto(form, 'about') } : {}),
    // O fuso vem da unidade, nunca do aparelho de quem visita — é aqui, e só
    // aqui, que ele é escolhido.
    ...(texto(form, 'timezone') ? { timezone: texto(form, 'timezone') } : {}),
    amenities: form.getAll('amenities').map(String),
  });

  if (!resultado.ok) falhar('/admin/onboarding?e=2', resultado.code);
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

  if (services.length === 0) falhar('/admin/onboarding?e=3', 'nenhum_servico');

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
  if (nomes.length === 0) falhar('/admin/onboarding?e=4', 'nenhum_profissional');

  const dias = form.getAll('dia').map(Number);
  const abre = numero(form, 'abre', 540);
  const fecha = numero(form, 'fecha', 1080);

  if (dias.length === 0) falhar('/admin/onboarding?e=4', 'nenhum_dia');
  if (abre >= fecha) falhar('/admin/onboarding?e=4', 'jornada_invertida');

  // A jornada é a mesma para toda a equipe nesta etapa. Diferenciar por pessoa
  // é trabalho de cadastro, e o objetivo aqui é chegar ao link em dez minutos —
  // o ajuste por pessoa fica no CRUD da equipe (bloco 13).
  const schedule = dias.map((weekday) => ({ weekday, startMinute: abre, endMinute: fecha }));

  const resultado = await salvarProfissionais(
    token,
    nomes.map((name) => ({ name, schedule })),
  );
  if (!resultado.ok) falhar('/admin/onboarding?e=4', resultado.code);

  redirect('/admin/onboarding?e=5');
}

// -- Etapa 5 -----------------------------------------------------------------

export async function acaoPagamentos(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await salvarPagamentos(token, form.getAll('metodo').map(String));
  if (!resultado.ok) falhar('/admin/onboarding?e=5', resultado.code);
  redirect('/admin/onboarding?e=6');
}

// -- Etapa 6 -----------------------------------------------------------------

export async function acaoPublicar(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await publicarBarbearia(token);
  if (!resultado.ok) falhar('/admin/onboarding?e=6', resultado.code);
  redirect(`/admin/onboarding?e=6&publicado=1`);
}

// -- Configuração ------------------------------------------------------------

export async function acaoJanela(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await salvarJanela(token, {
    cancelMinHours: numero(form, 'cancelMinHours', 2),
    rescheduleMinHours: numero(form, 'rescheduleMinHours', 2),
    maxReschedules: numero(form, 'maxReschedules', 2),
    // Por cento na tela, pontos-base no banco. A conversão fica aqui, num lugar
    // só — espalhá-la faria dois pontos do código discordarem sobre 12,5%.
    maxDiscountBps: Math.min(100, Math.max(0, numero(form, 'maxDiscountPercent', 20))) * 100,
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

  if (!resultado.ok) falhar('/admin/configuracoes', resultado.code);
  redirect('/admin/configuracoes?salvo=1');
}

// -- Balcão ------------------------------------------------------------------

/**
 * Move um atendimento pelo balcão.
 *
 * Volta para o mesmo dia e o mesmo filtro de onde saiu — a recepção não pode
 * perder o lugar na lista a cada toque. O destino vem do formulário e é
 * conferido antes de virar redirecionamento: campo de formulário é entrada
 * externa, e um `redirect` cru com ele seria redirecionamento aberto.
 */
export async function acaoAtendimento(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const id = texto(form, 'id');
  const acao = texto(form, 'action');
  const voltar = destinoDoBalcao(texto(form, 'voltar'));

  if (!ACOES_DE_ATENDIMENTO.has(acao)) falhar(voltar, 'request_failed');

  const resultado = await moverAtendimento(token, id, acao as AcaoAtendimento);
  if (!resultado.ok) falhar(voltar, resultado.code);

  /**
   * Cancelar abre uma vaga, e quem a quer aparece agora (bloco 38).
   *
   * A contagem viaja pela URL porque a ação redireciona — e ela precisa
   * atravessar. Sem isto, a lista de espera existiria no domínio e o balcão
   * nunca saberia dela no único instante em que ela serve: o cliente liga, a
   * recepção desmarca, e o horário fica livre para quem marcar primeiro pelo
   * site.
   *
   * Só a contagem, nunca os nomes: nome de cliente em barra de endereço fica no
   * histórico do navegador do balcão e no log do servidor.
   */
  const esperando = resultado.dados.esperando.length;
  if (esperando > 0) {
    redirect(`${voltar}${voltar.includes('?') ? '&' : '?'}esperando=${esperando}`);
  }

  redirect(voltar);
}

/**
 * Marca alguém pelo balcão.
 *
 * A chave de idempotência vem do formulário, gerada uma vez quando a tela foi
 * montada. Gerá-la aqui daria uma chave nova a cada envio, e o duplo toque —
 * que é o problema que ela existe para resolver — criaria dois horários.
 */
export async function acaoMarcarNoBalcao(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const serviceIds = texto(form, 'serviceIds').split(',').filter(Boolean);
  const date = texto(form, 'date');
  const start = texto(form, 'start');
  const professionalId = texto(form, 'professionalId');

  const volta = new URLSearchParams({
    s: serviceIds.join(','),
    p: professionalId,
    d: date,
    h: start,
    e: 'd',
  });

  const resultado = await marcarNoBalcao(
    token,
    {
      // Cliente já cadastrado entra pelo id; quem não tem cadastro entra por
      // nome e celular, e o cadastro nasce agora. O telefone do cadastrado não
      // volta para a tela em momento nenhum — a busca só devolve mascarado.
      ...(texto(form, 'customerId')
        ? { customerId: texto(form, 'customerId') }
        : { name: texto(form, 'name'), phone: texto(form, 'phone') }),
      professionalId,
      serviceIds,
      date,
      start,
      ...(texto(form, 'notes') ? { notes: texto(form, 'notes') } : {}),
    },
    texto(form, 'chave'),
  );

  if (!resultado.ok) {
    volta.set('erro', resultado.code);
    redirect(`/admin/dia/marcar?${volta.toString()}`);
  }

  redirect(`/admin/dia?d=${date}&marcado=1`);
}

// -- Fotos -------------------------------------------------------------------

/**
 * Grava os endereços de foto.
 *
 * Manda o formulário inteiro, sempre: campo em branco é "tire esta foto", e
 * omitir os vazios faria a única forma de remover uma foto ser mexer no banco.
 * A API distingue ausente de vazio justamente para isto.
 */
export async function acaoFotos(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const porPrefixo = (prefixo: string) =>
    [...form.entries()]
      .filter(([chave]) => chave.startsWith(prefixo))
      .map(([chave, valor]) => ({
        id: chave.slice(prefixo.length),
        photoUrl: String(valor).trim(),
      }));

  const resultado = await salvarFotos(token, {
    coverUrl: texto(form, 'coverUrl'),
    logoUrl: texto(form, 'logoUrl'),
    professionals: porPrefixo('pro_'),
    services: porPrefixo('srv_'),
  });

  if (!resultado.ok) falhar('/admin/fotos', resultado.code);
  redirect('/admin/fotos?salvo=1');
}

// -- Equipe ------------------------------------------------------------------

/**
 * Cria a conta e leva a senha de primeiro acesso para a tela **uma vez**.
 *
 * Ela viaja num cookie `httpOnly` de vida curta, não na URL: parâmetro de
 * consulta acaba no `Location`, no `Referer`, no log do servidor e no histórico
 * do navegador do balcão — que é máquina compartilhada. Ver
 * `guardarSenhaDeUmaVez`. Quando existir WhatsApp transacional (bloco 20), a
 * entrega passa por lá e isto sai.
 */
export async function acaoCriarMembro(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await criarMembro(token, {
    name: texto(form, 'name'),
    email: texto(form, 'email'),
    role: texto(form, 'role') as Papel,
    ...(texto(form, 'phone') ? { phone: texto(form, 'phone') } : {}),
  });

  if (!resultado.ok) falhar('/admin/equipe', resultado.code);

  await guardarSenhaDeUmaVez(resultado.dados.member.name, resultado.dados.senhaInicial);
  redirect('/admin/equipe');
}

export async function acaoTrocarPapel(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await trocarPapel(token, texto(form, 'id'), texto(form, 'role') as Papel);
  if (!resultado.ok) falhar('/admin/equipe', resultado.code);
  redirect('/admin/equipe?salvo=1');
}

export async function acaoLigarMembro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarMembro(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) falhar('/admin/equipe', resultado.code);
  redirect('/admin/equipe?salvo=1');
}

export async function acaoReemitirSenha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await reemitirSenha(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/equipe', resultado.code);

  await guardarSenhaDeUmaVez(texto(form, 'nome'), resultado.dados.senhaInicial);
  redirect('/admin/equipe');
}

/**
 * Troca a própria senha.
 *
 * É a rota que destranca a conta de primeiro acesso, e a única que a guarda de
 * permissão deixa passar enquanto `mustChangePassword` for verdadeiro.
 */
export async function acaoTrocarMinhaSenha(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const nova = String(form.get('newPassword') ?? '');
  if (nova !== String(form.get('confirmPassword') ?? '')) {
    falhar('/admin/trocar-senha', 'nao_confere');
  }

  const resultado = await trocarMinhaSenha(
    token,
    String(form.get('currentPassword') ?? ''),
    nova,
  );
  if (!resultado.ok) falhar('/admin/trocar-senha', resultado.code);

  redirect('/admin/dia');
}

// -- Cadastro: catálogo, equipe, jornadas e recursos --------------------------

function entradaDeServico(form: FormData): EntradaDeServico | null {
  const priceCents = centavosDoCampo(String(form.get('preco') ?? ''));
  if (priceCents === null) return null;

  const componentIds = form
    .getAll('componentIds')
    .map((valor) => String(valor))
    .filter(Boolean);

  return {
    name: texto(form, 'name'),
    description: texto(form, 'description'),
    categoryName: texto(form, 'categoryName') || 'Serviços',
    priceCents,
    durationMinutes: numero(form, 'durationMinutes', 30),
    bufferBeforeMinutes: numero(form, 'bufferBeforeMinutes', 0),
    bufferAfterMinutes: numero(form, 'bufferAfterMinutes', 0),
    bookableOnline: form.get('bookableOnline') === 'on',
    // `getAll` porque o campo escondido acompanha a caixa: marcada, chegam "0"
    // e "1"; desmarcada, chega só "0". `get` devolveria sempre o primeiro e a
    // caixa nunca ligaria.
    alwaysRequireDeposit: form.getAll('alwaysRequireDeposit').includes('1'),
    ...(componentIds.length >= 2 ? { componentIds } : {}),
  };
}

export async function acaoSalvarServico(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const entrada = entradaDeServico(form);
  if (!entrada) falhar('/admin/catalogo', 'preco_invalido');

  const id = texto(form, 'id');
  const resultado = id
    ? await editarServico(token, id, entrada)
    : await criarServico(token, entrada);

  if (!resultado.ok) falhar('/admin/catalogo', resultado.code);
  redirect('/admin/catalogo?salvo=1');
}

/**
 * Ajusta à mão se um cliente paga sinal (bloco 37).
 *
 * A tela pergunta em decisão — "nunca pedir", "sempre pedir", "voltar ao
 * cálculo" — e não em número. O score é interno por regra da SPEC §2.13, e um
 * campo de 0 a 100 aqui obrigaria o gerente a conhecer a fórmula para escolher
 * um valor que faça o que ele quer. As duas pontas da escala são o que ele de
 * fato decide.
 */
/**
 * Registra que o sinal chegou (bloco 37).
 *
 * O valor vai no formulário e é reconferido pelo domínio contra o exigido. Não
 * é redundância inútil: o campo é escondido, e campo escondido é entrada
 * externa como qualquer outra — quem alterar o HTML mandaria "recebi R$ 2" de
 * um sinal de R$ 20, e a diferença sumiria sem segunda pessoa olhando.
 */
export async function acaoRegistrarSinal(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const voltar = destinoDoBalcao(texto(form, 'voltar'));

  const resultado = await registrarSinal(
    token,
    texto(form, 'appointmentId'),
    numero(form, 'valorCents', 0),
  );
  if (!resultado.ok) falhar(voltar, resultado.code);
  redirect(voltar);
}

/**
 * Devolve o sinal (bloco 37).
 *
 * Sem valor no formulário: o domínio lê o que está registrado e zera. Aceitar
 * um valor aqui abriria devolução parcial, que não é uma decisão que a política
 * conhece — e a soma que não bate só apareceria no fechamento do mês.
 */
export async function acaoDevolverSinal(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const voltar = destinoDoBalcao(texto(form, 'voltar'));

  const resultado = await devolverSinalDoHorario(token, texto(form, 'appointmentId'));
  if (!resultado.ok) falhar(voltar, resultado.code);
  redirect(voltar);
}

export async function acaoConfiancaDoCliente(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = texto(form, 'de') === 'meu-dia' ? 'meu-dia' : 'dia';
  const destino = `/admin/cliente/${customerId}?de=${de}`;

  const decisao = texto(form, 'decisao');
  // 100 dispensa (o piso de dispensa é 85 e não é configurável); 0 fica abaixo
  // de qualquer limiar que a barbearia consiga escolher.
  const score = decisao === 'dispensar' ? 100 : decisao === 'exigir' ? 0 : null;

  const resultado = await ajustarConfianca(token, customerId, {
    score,
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) falhar(destino, resultado.code);
  redirect(`${destino}&ajuste=1`);
}

export async function acaoLigarServico(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarServico(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) falhar('/admin/catalogo', resultado.code);
  redirect('/admin/catalogo?salvo=1');
}

export async function acaoExigenciasDoServico(form: FormData): Promise<void> {
  const token = await exigirSessao();

  // Um par de campos por recurso cadastrado; quantidade zero significa "não usa".
  const requirements = form
    .getAll('resourceType')
    .map((tipo, indice) => ({
      resourceType: String(tipo),
      quantity: Number(form.getAll('quantity')[indice] ?? 0),
    }))
    .filter((exigencia) => Number.isFinite(exigencia.quantity) && exigencia.quantity > 0);

  const resultado = await exigenciasDoServico(token, texto(form, 'id'), requirements);
  if (!resultado.ok) falhar('/admin/recursos', resultado.code);
  redirect('/admin/recursos?salvo=1');
}

function entradaDeProfissional(form: FormData): EntradaDeProfissional {
  const serviceIds = form.getAll('serviceIds').map((valor) => String(valor)).filter(Boolean);
  const limite = Number(form.get('dailyLimit'));

  return {
    name: texto(form, 'name'),
    bio: texto(form, 'bio'),
    kind: (texto(form, 'kind') || 'professional') as EntradaDeProfissional['kind'],
    bookableOnline: form.get('bookableOnline') === 'on',
    dailyLimit: Number.isFinite(limite) && limite > 0 ? limite : null,
    // Vazio é "faz tudo", e a API grava como tudo. Ver `gravarHabilidades`.
    ...(serviceIds.length > 0 ? { serviceIds } : {}),
  };
}

export async function acaoSalvarProfissional(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const entrada = entradaDeProfissional(form);

  const resultado = id
    ? await editarProfissional(token, id, entrada)
    : await criarProfissional(token, entrada);

  if (!resultado.ok) falhar('/admin/profissionais', resultado.code);
  redirect('/admin/profissionais?salvo=1');
}

export async function acaoLigarProfissional(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarProfissional(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) falhar('/admin/profissionais', resultado.code);

  // Desativar não cancela nada. Quem fica sem dono vai para a tela, e alguém
  // decide o que fazer — silenciar isso é como o cliente descobre no dia.
  const orfaos = resultado.dados.futuros.length;
  redirect(`/admin/profissionais?salvo=1${orfaos > 0 ? `&orfaos=${orfaos}` : ''}`);
}

/**
 * Grava a jornada, em dois tempos quando há conflito.
 *
 * A primeira gravação volta com a lista de quem ficaria fora e **não escreve**;
 * a tela mostra os nomes e oferece o botão que confirma. Encolher a terça é
 * legítimo — fazê-lo sem ver os clientes já marcados às 15h não é.
 */
export async function acaoSalvarJornada(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const destino = `/admin/profissionais?pessoa=${encodeURIComponent(id)}`;

  const lida = lerJornada(
    DIAS.map(({ weekday }) => ({
      weekday,
      trabalha: form.get(`dia_${weekday}`) === 'on',
      inicio: texto(form, `inicio_${weekday}`),
      fim: texto(form, `fim_${weekday}`),
      pausaInicio: texto(form, `pausa_inicio_${weekday}`),
      pausaFim: texto(form, `pausa_fim_${weekday}`),
    })),
  );

  if (!lida.ok) falhar(destino, `${lida.code}_${lida.weekday}`);

  const confirmar = form.get('confirmarConflitos') === '1';
  const resultado = await salvarJornada(token, id, lida.faixas, confirmar);
  if (!resultado.ok) falhar(destino, resultado.code);

  if (!resultado.dados.saved) {
    // A proposta e os conflitos vão num cookie de vida curta, nunca na URL: um
    // traz a semana inteira digitada, o outro traz nome de cliente — e a URL
    // fica no histórico do balcão, que é máquina compartilhada.
    await guardarConflitoDeJornada({
      professionalId: id,
      faixas: lida.faixas,
      conflitos: resultado.dados.conflitos,
    });
    redirect(destino);
  }

  redirect(`${destino}&salvo=1`);
}

export async function acaoSalvarRecursos(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const pools = form
    .getAll('resourceType')
    .map((tipo, indice) => ({
      resourceType: String(tipo).trim(),
      capacity: Number(form.getAll('capacity')[indice] ?? 0),
    }))
    .filter((pool) => pool.resourceType.length >= 2 && pool.capacity >= 1);

  const resultado = await salvarRecursos(token, pools);
  if (!resultado.ok) falhar('/admin/recursos', resultado.code);
  redirect('/admin/recursos?salvo=1');
}

// -- Fila presencial ----------------------------------------------------------

/**
 * Põe alguém na fila.
 *
 * A chave de idempotência vem do formulário, gerada quando a tela foi montada —
 * como na marcação pelo balcão, e pelo mesmo motivo: gerá-la aqui daria uma
 * chave nova a cada envio, e o duplo toque criaria duas entradas para a mesma
 * pessoa, empurrando a fila inteira.
 */
export async function acaoEntrarNaFila(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const serviceIds = form.getAll('serviceIds').map((v) => String(v)).filter(Boolean);
  if (serviceIds.length === 0) falhar('/admin/fila', 'sem_servico');

  const preferido = texto(form, 'professionalId');

  const resultado = await entrarNaFila(
    token,
    {
      name: texto(form, 'name'),
      phone: texto(form, 'phone'),
      serviceIds,
      ...(preferido ? { professionalId: preferido } : {}),
    },
    texto(form, 'idempotencyKey'),
  );

  if (!resultado.ok) falhar('/admin/fila', resultado.code);

  // O link viaja num cookie de vida curta, nunca na URL: ele é credencial ao
  // portador e a URL fica no histórico do balcão, que é máquina compartilhada.
  await guardarLinkDaFila(texto(form, 'name'), resultado.dados.token);
  redirect('/admin/fila');
}

/**
 * Ajusta o saldo de fidelidade de um cliente à mão (bloco 41).
 *
 * A rota exige `finance.loyalty_adjust`, que cai no grupo de dinheiro pelo
 * prefixo e por isso vem com segundo fator derivado: criar saldo é criar valor
 * gastável no balcão da operação seguinte.
 */
export async function acaoAjustarFidelidade(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const quantidade = Number(form.get('quantidade') ?? 0);

  if (!Number.isInteger(quantidade) || quantidade === 0) {
    falhar(`/admin/cliente/${customerId}`, 'quantidade_invalida');
  }

  const resultado = await ajustarSaldoDeFidelidade(token, customerId, {
    quantidade,
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) falhar(`/admin/cliente/${customerId}`, resultado.code);
  redirect(`/admin/cliente/${customerId}?salvo=fidelidade`);
}

/**
 * Escolhe o modelo de fidelidade da casa (bloco 41).
 *
 * Um modelo, nunca três: a tela oferece um seletor único porque "você tem 340
 * pontos, 3 visitas e R$ 12 de cashback" é uma frase que ninguém entende no
 * balcão — e a chave primária do banco garante o resto.
 */
export async function acaoSalvarFidelidade(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const modo = texto(form, 'modo');
  if (!['nenhum', 'pontos', 'visitas', 'cashback'].includes(modo)) {
    falhar('/admin/fidelidade', 'invalid_request');
  }

  const validade = Number(form.get('validadeDias') ?? 0);

  const resultado = await salvarProgramaDeFidelidade(token, {
    modo: modo as 'nenhum' | 'pontos' | 'visitas' | 'cashback',
    pontosPorReal: Number(form.get('pontosPorReal') ?? 1),
    valorDoPontoCents: Number(form.get('valorDoPontoCents') ?? 1),
    visitasParaPremio: Number(form.get('visitasParaPremio') ?? 10),
    // A tela pede porcentagem; o produto guarda pontos-base, sempre inteiros.
    cashbackBps: Math.round(Number(form.get('cashbackPercent') ?? 5) * 100),
    validadeDias: validade > 0 ? validade : null,
  });
  if (!resultado.ok) falhar('/admin/fidelidade', resultado.code);
  redirect('/admin/fidelidade?salvo=1');
}

/**
 * Assume um recado (bloco 40).
 *
 * "Assumir" é a palavra que a tela usa e a única que o domínio expõe para este
 * gesto — vocabulário de transição mora num lugar só (CLAUDE.md §6). Sem
 * responsável, devolve à triagem: é a saída de "assumi por engano".
 */
export async function acaoAssumirRecado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await assumirRecadoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/recados', resultado.code);
  redirect('/admin/recados?feito=assumido');
}

/** Devolve à triagem. Todo estado precisa de saída na tela (CLAUDE.md §6). */
export async function acaoDevolverRecado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await devolverRecadoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/recados', resultado.code);
  redirect('/admin/recados?feito=devolvido');
}

/**
 * Responde ao cliente.
 *
 * A mensagem sai pela fila de trabalho, dentro da transação que grava a
 * resposta. Recado anônimo é recusado com código próprio — a tela precisa dizer
 * *por que* não dá, e não só que não deu.
 */
export async function acaoResponderRecado(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await responderRecadoNaApi(
    token,
    texto(form, 'id'),
    String(form.get('resposta') ?? ''),
  );
  if (!resultado.ok) falhar('/admin/recados', resultado.code);
  redirect('/admin/recados?feito=respondido');
}

/**
 * Encerra o recado — que **não** é apagá-lo.
 *
 * O texto continua na base e continua contando para a leitura do trimestre. Não
 * existe caminho de código que faça o contrário: a tabela não tem `DELETE` para
 * a aplicação (SPEC §4.10).
 */
export async function acaoEncerrarRecado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await encerrarRecadoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/recados', resultado.code);
  redirect('/admin/recados?feito=encerrado');
}

export async function acaoMoverNaFila(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const para = texto(form, 'para');
  if (!['waiting', 'called', 'done', 'gave_up'].includes(para)) {
    falhar('/admin/fila', 'invalid_request');
  }

  const resultado = await moverNaFila(token, texto(form, 'id'), para as StatusNaFila);
  if (!resultado.ok) falhar('/admin/fila', resultado.code);
  redirect('/admin/fila?salvo=1');
}

/**
 * A pessoa sentou.
 *
 * O 409 daqui não é erro de tela: é a recusa de encaixar por cima de quem
 * marcou, que vem da constraint do banco. A mensagem precisa chegar inteira.
 */
export async function acaoSentarDaFila(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await sentarDaFila(token, texto(form, 'id'), texto(form, 'professionalId'));
  if (!resultado.ok) falhar('/admin/fila', resultado.code);
  redirect('/admin/dia');
}

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
    falhar(destino, 'tipo_invalido');
  }

  const comFaixa = kind === 'block' || kind === 'custom_hours';
  const inicio = minutosOuNulo(texto(form, 'inicio'));
  const fim = minutosOuNulo(texto(form, 'fim'));
  if (comFaixa && (inicio === null || fim === null)) falhar(destino, 'faixa_ausente');

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

  if (!resultado.ok) falhar(destino, resultado.code);

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
  if (!resultado.ok) falhar(destino, resultado.code);

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

  if (!resultado.ok) falhar(destino, resultado.code);

  const separador = destino.includes('?') ? '&' : '?';
  redirect(`${destino}${separador}salvo=1`);
}

// -- Balcão: comanda, caixa e fiado -------------------------------------------

/**
 * Valor em centavos vindo do formulário.
 *
 * `centavosDoCampo` monta o número a partir dos dígitos — nunca
 * `Number(campo) * 100`, que em ponto flutuante devolve 4899 para "48,99". Um
 * centavo por comanda é o que faz o caixa não bater no fim do dia.
 *
 * **Valor malformado vira erro, não zero.** Um `?? 0` aqui transformaria
 * "5o,00" (com a letra o) em corte de graça, e ninguém veria — nem o operador,
 * que digitou algo, nem o dono, que só veria a gaveta faltando no fechamento.
 */
function centavos(form: FormData, campo: string, rota: string): number {
  const valor = centavosDoCampo(texto(form, campo));
  if (valor === null) falhar(rota, 'valor_invalido');
  return valor;
}

/** Campo opcional: vazio é zero, mas escrito errado continua sendo erro. */
function centavosOpcionais(form: FormData, campo: string, rota: string): number {
  return texto(form, campo) === '' ? 0 : centavos(form, campo, rota);
}

export async function acaoAbrirCaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await abrirOCaixa(token, centavos(form, 'openingCents', '/admin/caixa'));
  if (!resultado.ok) falhar('/admin/caixa', resultado.code);
  redirect('/admin/caixa?salvo=1');
}

export async function acaoMovimentarCaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const kind = texto(form, 'kind');
  if (kind !== 'withdrawal' && kind !== 'supply') falhar('/admin/caixa', 'invalid_request');

  const resultado = await movimentarOCaixa(token, {
    kind,
    amountCents: centavos(form, 'amountCents', '/admin/caixa'),
    reason: texto(form, 'reason'),
  });
  if (!resultado.ok) falhar('/admin/caixa', resultado.code);
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
  const resultado = await fecharOCaixa(token, centavos(form, 'countedCents', '/admin/caixa'), texto(form, 'notes'));
  if (!resultado.ok) falhar('/admin/caixa', resultado.code);
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
  if (!resultado.ok) falhar('/admin/comanda', resultado.code);
  redirect(`/admin/comanda/${resultado.dados.id}`);
}

export async function acaoAdicionarItem(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');
  const tipo = texto(form, 'tipo');
  if (tipo !== 'service' && tipo !== 'product' && tipo !== 'consumable' && tipo !== 'package') {
    falhar(`/admin/comanda/${id}`, 'invalid_request');
  }

  const serviceId = texto(form, 'serviceId');
  const professionalId = texto(form, 'professionalId');
  const packageId = texto(form, 'packageId');

  const resultado = await adicionarNaComanda(token, id, {
    tipo,
    descricao: texto(form, 'descricao'),
    quantidade: Math.max(1, numero(form, 'quantidade', 1)),
    // Num item de pacote este número é ignorado: o preço sai do catálogo, e é
    // isso que impede um item de R$ 1 congelar cinco unidades de R$ 50.
    precoUnitarioCents: centavos(form, 'precoUnitarioCents', `/admin/comanda/${id}`),
    ...(serviceId ? { serviceId } : {}),
    ...(professionalId ? { professionalId } : {}),
    ...(packageId ? { packageId } : {}),
  });
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
  redirect(`/admin/comanda/${id}`);
}

export async function acaoRemoverItem(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');
  const resultado = await removerDaComanda(token, id, texto(form, 'itemId'));
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
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
          valor: centavosOpcionais(form, 'descontoValor', `/admin/comanda/${id}`),
          motivo: texto(form, 'motivo'),
        };

  const resultado = await ajustarAComanda(token, id, {
    desconto: desconto.valor > 0 ? desconto : null,
    gorjetaCents: centavosOpcionais(form, 'gorjetaCents', `/admin/comanda/${id}`),
  });
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
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

  const pagamentos = [0, 1, 2]
    .map((i) => ({
      forma: texto(form, `forma${i}`) as FormaDePagamento,
      valorCents: centavosOpcionais(form, `valor${i}`, `/admin/comanda/${id}`),
    }))
    .filter((p) => p.valorCents > 0 && p.forma);

  if (pagamentos.length === 0) falhar(`/admin/comanda/${id}`, 'sem_pagamento');

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

  const resultado = await fecharAComanda(
    token,
    id,
    pagamentos,
    texto(form, 'idempotencyKey'),
    Number.isInteger(resgate) && resgate > 0 ? resgate : undefined,
    servicoDoPacote.length > 0 ? servicoDoPacote : undefined,
  );
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
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
    falhar(`/admin/comanda/${id}`, 'invalid_request');
  }

  const resultado = await cobrarComanda(
    token,
    id,
    meio as 'pix' | 'cartao' | 'link',
    texto(form, 'idempotencyKey'),
  );
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
  redirect(`/admin/comanda/${id}?cobrando=1`);
}

/** "Desisti do Pix, vou pagar em dinheiro" — rotina do balcão. */
export async function acaoCancelarCobranca(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');

  const resultado = await cancelarCobrancaDaComanda(token, id, texto(form, 'chargeId'));
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
  redirect(`/admin/comanda/${id}?salvo=1`);
}

export async function acaoReceberFiado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const forma = texto(form, 'forma');
  if (!['cash', 'debit', 'credit', 'pix'].includes(forma)) {
    falhar('/admin/fiado', 'invalid_request');
  }

  const resultado = await receberDoFiado(token, {
    customerId: texto(form, 'customerId'),
    amountCents: centavos(form, 'amountCents', '/admin/fiado'),
    forma: forma as 'cash' | 'debit' | 'credit' | 'pix',
  });
  if (!resultado.ok) falhar('/admin/fiado', resultado.code);
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
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);
  redirect(`/admin/seguranca?politica=${exigir ? 'ligada' : 'desligada'}`);
}

export async function acaoComecarSegundoFator(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await comecarSegundoFator(token);
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);

  // Segredo em cookie de vida curta, nunca na URL: ele gera todos os códigos
  // futuros e a URL fica no histórico da máquina do balcão.
  await guardarSegredoDoMfa(resultado.dados);
  redirect('/admin/seguranca');
}

export async function acaoConfirmarSegundoFator(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await confirmarSegundoFator(token, texto(form, 'codigo'));
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);

  await guardarCodigosDeRecuperacao(resultado.dados.codigosDeRecuperacao);
  redirect('/admin/seguranca?ativado=1');
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
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);

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
    falhar('/admin/comissao/regras', 'invalid_request');
  }

  let valor = 0;
  const faixas: { ateCents: number | null; pontosBase: number }[] = [];

  if (modo === 'percent') {
    const pontos = pontosBaseDoCampo(texto(form, 'aliquota'));
    if (pontos === null) falhar('/admin/comissao/regras', 'aliquota_invalida');
    valor = pontos;
  } else if (modo === 'fixed') {
    valor = centavos(form, 'valorFixo', '/admin/comissao/regras');
  } else {
    // Três faixas no formulário: duas com teto e a última aberta, que é o que
    // impede faturamento acima do último degrau ficar sem alíquota.
    for (const i of [0, 1, 2]) {
      const aliquota = texto(form, `faixaPontos${i}`);
      if (!aliquota) continue;
      const pontos = pontosBaseDoCampo(aliquota);
      if (pontos === null) falhar('/admin/comissao/regras', 'aliquota_invalida');

      const ate = texto(form, `faixaAte${i}`);
      faixas.push({
        ateCents: ate ? centavos(form, `faixaAte${i}`, '/admin/comissao/regras') : null,
        pontosBase: pontos,
      });
    }
    if (faixas.length === 0) falhar('/admin/comissao/regras', 'faixas_ausentes');
    // A última é sempre aberta: o formulário não oferece outra forma.
    const ultima = faixas[faixas.length - 1];
    if (ultima) faixas[faixas.length - 1] = { ...ultima, ateCents: null };
  }

  const professionalId = texto(form, 'professionalId');
  const serviceId = texto(form, 'serviceId');

  const resultado = await salvarRegraDeComissao(token, {
    modo,
    valor,
    ...(faixas.length ? { faixas } : {}),
    ...(professionalId ? { professionalId } : {}),
    ...(serviceId ? { serviceId } : {}),
  });
  if (!resultado.ok) falhar('/admin/comissao/regras', resultado.code);
  redirect('/admin/comissao/regras?salvo=1');
}

export async function acaoRemoverRegraDeComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await removerRegraDeComissao(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/comissao/regras', resultado.code);
  redirect('/admin/comissao/regras?salvo=1');
}

export async function acaoConfiguracaoDeComissao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const base = texto(form, 'base');
  const tratamento = texto(form, 'tratamentoDoDesconto');
  if (base !== 'liquido' && base !== 'bruto') falhar('/admin/comissao/regras', 'invalid_request');
  if (tratamento !== 'reduz_base' && tratamento !== 'custo_da_casa') {
    falhar('/admin/comissao/regras', 'invalid_request');
  }

  const taxa = texto(form, 'tratamentoDaTaxa');
  if (taxa !== 'absorvida' && taxa !== 'rateada') {
    falhar('/admin/comissao/regras', 'invalid_request');
  }

  const resultado = await salvarConfiguracaoDeComissao(token, {
    base,
    tratamentoDoDesconto: tratamento,
    tratamentoDaTaxa: taxa,
  });
  if (!resultado.ok) falhar('/admin/comissao/regras', resultado.code);
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
    falhar('/admin/comissao/regras', 'aliquota_invalida');
  }

  const resultado = await salvarAliquotaDoAdquirente(token, {
    forma,
    bps: Math.round(porcento * 100),
  });
  if (!resultado.ok) falhar('/admin/comissao/regras', resultado.code);
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
  if (!resultado.ok) falhar('/admin/comissao', resultado.code);
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

  if (!resultado.ok) falhar('/admin/avisos', resultado.code);
  redirect('/admin/avisos?salvo=1');
}

// -- A ficha do cliente ------------------------------------------------------

/**
 * Só dois destinos de volta, e conferidos.
 *
 * O campo vem do formulário, que é entrada externa como qualquer outra — e um
 * `redirect` cru com ele é redirecionamento aberto. Mesmo motivo de
 * `destinoDoBalcao`, com o agravante de que o cookie do painel altera preço,
 * catálogo e equipe.
 */
function destinoDaFicha(bruto: string): string {
  return bruto === '/admin/meu-dia' ? '/admin/meu-dia' : '/admin/dia';
}

export async function acaoPreferencias(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = destinoDaFicha(texto(form, 'de'));
  const rota = `/admin/cliente/${customerId}?de=${de === '/admin/meu-dia' ? 'meu-dia' : 'dia'}`;

  const conversa = texto(form, 'conversa');
  if (!ehConversa(conversa)) falhar(rota, 'preferencia_invalida');

  const resultado = await salvarPreferenciasDoCliente(token, customerId, {
    maquinaLaterais: texto(form, 'maquinaLaterais') || null,
    tipoDegrade: texto(form, 'tipoDegrade') || null,
    topo: texto(form, 'topo') || null,
    barbaEstilo: texto(form, 'barbaEstilo') || null,
    produtosEvitar: texto(form, 'produtosEvitar') || null,
    conversa,
    observacoes: texto(form, 'observacoes') || null,
  });

  if (!resultado.ok) falhar(rota, resultado.code);
  redirect(`${rota}&salvo=1`);
}

/**
 * Convida o barbeiro para o aplicativo dele.
 *
 * A senha volta na resposta **e** sai por mensagem: o provedor pode estar fora
 * do ar, e o dono precisa poder ler em voz alta para quem está do lado.
 *
 * Ela vai para a tela seguinte por **cookie de vida curta, nunca pela URL** —
 * mesma decisão de `acaoCriarMembro`, e pelo mesmo motivo, que a primeira
 * versão deste convite esqueceu: senha em parâmetro de consulta fica no
 * histórico e no autocompletar do balcão, que é máquina compartilhada, e viaja
 * no `Referer` de toda requisição da página. E "morre no primeiro uso" é mais
 * fraco do que parece: `must_change_password` bloqueia o painel, não o login —
 * quem lê a URL primeiro fica com a conta.
 */
export async function acaoConvidar(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const professionalId = texto(form, 'professionalId');
  const telefone = texto(form, 'phone');
  const resultado = await convidarProfissional(token, {
    professionalId,
    email: texto(form, 'email'),
    ...(telefone ? { phone: telefone } : {}),
  });

  if (!resultado.ok) falhar(`/admin/profissionais?pessoa=${professionalId}`, resultado.code);

  await guardarSenhaDeUmaVez(
    resultado.dados.member.name,
    resultado.dados.senhaInicial,
    'profissionais',
  );

  const busca = new URLSearchParams({
    pessoa: professionalId,
    // Só isto na URL: qual cadeira abrir e o que dizer sobre a entrega. Nenhum
    // dos dois é segredo.
    entrega: resultado.dados.entrega,
  });
  redirect(`/admin/profissionais?${busca.toString()}`);
}

// -- A meta do profissional --------------------------------------------------

/**
 * Define ou apaga a meta do mês.
 *
 * Campo vazio apaga, e é o único jeito de dizer "sem meta" — zero seria uma
 * segunda forma de dizer o mesmo, e a CHECK do banco a recusa de propósito.
 */
export async function acaoMeta(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const professionalId = texto(form, 'professionalId');
  const bruto = texto(form, 'metaReais');
  const rota = `/admin/profissionais?pessoa=${professionalId}`;

  const metaCents = bruto ? centavosDoCampo(bruto) : null;
  if (bruto && metaCents === null) falhar(rota, 'meta_invalida');

  const resultado = await salvarMetaDoProfissional(token, {
    professionalId,
    mes: texto(form, 'mes'),
    metaCents,
  });

  if (!resultado.ok) falhar(rota, resultado.code);
  redirect(`${rota}&salvo=1`);
}

// -- Importação de base ------------------------------------------------------

/**
 * Lê o arquivo e mostra o preview — SPEC §5.8.
 *
 * O arquivo é lido **aqui**, na ação de servidor, e vai para a API como texto.
 * A alternativa seria `multipart` até o final, e ela custaria um segundo
 * formato de corpo numa API que hoje só fala JSON — por um arquivo que é texto
 * por definição.
 *
 * Nada é gravado neste passo. O que ele cria é a importação em preview, que a
 * tela seguinte aplica ou descarta.
 */
export async function acaoAnalisarImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const arquivo = form.get('arquivo');
  if (!(arquivo instanceof File) || arquivo.size === 0) falhar('/admin/importar', 'sem_arquivo');

  const enviado = arquivo as File;
  if (enviado.size > TETO_DO_ARQUIVO) falhar('/admin/importar', 'arquivo_grande');

  const conteudo = await enviado.text();
  const separador = texto(form, 'separador');

  const resultado = await analisarImportacao(token, {
    fileName: enviado.name,
    conteudo,
    ...(separador ? { separador } : {}),
  });

  if (!resultado.ok) falhar('/admin/importar', resultado.code);
  redirect(`/admin/importar?i=${resultado.dados.id}`);
}

export async function acaoAplicarImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');

  const resultado = await aplicarImportacao(token, id);
  if (!resultado.ok) falhar(`/admin/importar?i=${id}`, resultado.code);

  redirect(`/admin/importar?feito=${resultado.dados.criados}&atualizados=${resultado.dados.atualizados}`);
}

export async function acaoReverterImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');

  const resultado = await reverterImportacao(token, id);
  if (!resultado.ok) falhar('/admin/importar', resultado.code);

  redirect(`/admin/importar?desfeito=${resultado.dados.apagados}`);
}

/** O endereço do sistema antigo, para o link da bio não quebrar. */
export async function acaoAdicionarSlug(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await adicionarSlug(token, texto(form, 'slug'));
  if (!resultado.ok) falhar('/admin/importar', resultado.code);

  redirect('/admin/importar?slug=1');
}

// -- Plano --------------------------------------------------------------------

/**
 * Troca o plano pelo autoatendimento (bloco 28).
 *
 * A chave de idempotência vem do formulário, gerada quando a tela foi montada —
 * mesmo motivo da comanda e da fila: gerá-la aqui daria uma chave nova a cada
 * envio, e o duplo toque emitiria a segunda cobrança do mesmo acerto.
 */
export async function acaoTrocarDePlano(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await trocarDePlano(
    token,
    texto(form, 'planoCode'),
    texto(form, 'idempotencyKey'),
  );

  if (!resultado.ok) falhar('/admin/plano', resultado.code);
  redirect('/admin/plano?trocado=1');
}

// -- Permissões ---------------------------------------------------------------

/**
 * Redefine o que um papel pode (bloco 30).
 *
 * A tela é um formulário de caixas de seleção por papel, e o navegador só manda
 * as marcadas — o que é exatamente o conjunto inteiro. Nada de diff: com duas
 * abas abertas, um diff produziria uma concessão que ninguém pediu.
 */
export async function acaoPermissoesDoPapel(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const papel = texto(form, 'papel');
  const permissoes = form.getAll('permissoes').map((v) => String(v)).filter(Boolean);

  const resultado = await salvarPermissoesDoPapel(token, papel, permissoes);
  if (!resultado.ok) falhar('/admin/equipe/permissoes', resultado.code);
  redirect('/admin/equipe/permissoes?salvo=1');
}

// -- LGPD ---------------------------------------------------------------------

/**
 * O consentimento registrado pelo balcão (bloco 31).
 *
 * A versão do texto vem de `politica.ts` e **não** do formulário, igual ao lado
 * do cliente: o que fica gravado é o que a pessoa leu, e um campo escondido
 * editável transformaria a prova no que o navegador digitou.
 *
 * Quem registra fica gravado em `recorded_by` — a diferença entre "ele clicou"
 * e "alguém da casa marcou por ele" é o que responde a uma contestação.
 */
export async function acaoConsentimentoNoBalcao(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = destinoDaFicha(texto(form, 'de'));
  const rota = `/admin/cliente/${customerId}?de=${de === '/admin/meu-dia' ? 'meu-dia' : 'dia'}`;

  const finalidade = texto(form, 'finalidade');
  const versao = versaoDoConsentimento(finalidade);
  if (versao === null) falhar(rota, 'finalidade_invalida');

  const resultado = await registrarConsentimentoNoBalcao(token, customerId, {
    finalidade,
    concedido: texto(form, 'concedido') === '1',
    versaoDoTexto: versao,
  });

  if (!resultado.ok) falhar(rota, resultado.code);
  redirect(`${rota}&salvo=1`);
}

/**
 * Abre o pedido do titular a partir da ficha.
 *
 * O pedido nasce **antes** de ser atendido, e é de propósito: o prazo de 15
 * dias conta da chegada, e um registro criado só no fim serviria para dizer que
 * tudo sempre foi respondido no mesmo dia.
 */
export async function acaoAbrirPedidoDeDados(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = destinoDaFicha(texto(form, 'de'));
  const rota = `/admin/cliente/${customerId}?de=${de === '/admin/meu-dia' ? 'meu-dia' : 'dia'}`;

  const tipo = texto(form, 'tipo');
  if (tipo !== 'export' && tipo !== 'deletion') falhar(rota, 'pedido_invalido');

  const resultado = await abrirPedidoDeDados(token, customerId, tipo);
  if (!resultado.ok) falhar(rota, resultado.code);
  redirect(`${rota}&pedido=1`);
}

export async function acaoEncerrarPedidoDeDados(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const nota = texto(form, 'nota');
  const resultado = await encerrarPedidoDeDados(token, texto(form, 'pedidoId'), {
    atendido: texto(form, 'atendido') === '1',
    ...(nota ? { nota } : {}),
  });

  if (!resultado.ok) falhar('/admin/lgpd', resultado.code);
  redirect('/admin/lgpd?salvo=1');
}

/**
 * Apaga os dados de um cliente (bloco 32).
 *
 * É a única ação sem volta do painel, e a tela cobra confirmação escrita antes
 * de chegar aqui. O motivo é obrigatório em três camadas — borda, domínio e a
 * função do banco — porque daqui a seis meses "por que este cadastro sumiu?" só
 * tem resposta se alguém tiver escrito.
 */
export async function acaoAnonimizarCliente(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = destinoDaFicha(texto(form, 'de'));
  const rota = `/admin/cliente/${customerId}?de=${de === '/admin/meu-dia' ? 'meu-dia' : 'dia'}`;

  /**
   * A confirmação digitada, conferida aqui e não só no navegador.
   *
   * Sem JavaScript no cliente não existe `confirm()`, e é bom que não exista:
   * digitar a palavra é uma barreira mais forte que um diálogo que se fecha no
   * reflexo. A conferência mora no servidor porque a do navegador é sugestão.
   */
  if (texto(form, 'confirmacao').toUpperCase() !== 'APAGAR') {
    falhar(rota, 'confirmacao_invalida');
  }

  const resultado = await anonimizarClienteNaApi(token, customerId, texto(form, 'motivo'));
  if (!resultado.ok) falhar(rota, resultado.code);

  // Volta para a lista, não para a ficha: a ficha que ele estava vendo não
  // existe mais como cadastro de pessoa, e mostrá-la vazia parece defeito.
  redirect(`${de}?apagado=1`);
}

// -- Segurança da conta (bloco 33) --------------------------------------------

export async function acaoEncerrarSessao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await encerrarSessaoDoAparelho(token, texto(form, 'id'));
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);
  redirect('/admin/seguranca?encerrada=1');
}

/**
 * Expulsa o suporte da plataforma da conta.
 *
 * Sem confirmação digitada, ao contrário de apagar cliente: aqui o pior caso é
 * o suporte ter que pedir de novo, e travar a saída de alguém que está dentro
 * da sua conta seria proteger a coisa errada.
 */
export async function acaoExpulsarSuporte(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await expulsarSuporte(token);
  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);
  redirect('/admin/seguranca?suporte=fora');
}

export async function acaoPreferenciasDeAlerta(form: FormData): Promise<void> {
  const token = await exigirSessao();

  // A caixa desmarcada simplesmente não é enviada pelo navegador — então a
  // ausência é "desligado", e não "não mexa nisso".
  const resultado = await salvarPreferenciasDeAlerta(token, {
    enviarCritico: form.get('enviarCritico') !== null,
    enviarAviso: form.get('enviarAviso') !== null,
    enviarRetencao: form.get('enviarRetencao') !== null,
  });

  if (!resultado.ok) falhar('/admin/seguranca', resultado.code);
  redirect('/admin/seguranca?salvo=1');
}

// -- Pacotes (bloco 42) -------------------------------------------------------

/**
 * Cadastra ou edita um pacote do catálogo.
 *
 * O `id` vazio significa "novo": o mesmo formulário serve para os dois, como no
 * catálogo de serviços. A tela manda porcentagem em lugar nenhum aqui — preço é
 * em reais e vira centavos inteiros na borda, nunca `float` adiante.
 */
export async function acaoSalvarPacote(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const validade = Number(form.get('validadeDias') ?? 0);
  const preco = Number(form.get('precoReais') ?? 0);

  const resultado = await salvarPacoteNaApi(
    token,
    {
      nome: texto(form, 'nome'),
      serviceId: texto(form, 'serviceId'),
      quantidade: Number(form.get('quantidade') ?? 2),
      precoCents: Math.round(preco * 100),
      validadeDias: validade > 0 ? validade : null,
      transferivel: form.get('transferivel') === 'on',
      ativo: form.get('ativo') !== 'off',
    },
    id.length > 0 ? id : undefined,
  );
  if (!resultado.ok) falhar('/admin/pacotes', resultado.code);
  redirect('/admin/pacotes?salvo=1');
}

/**
 * Reembolsa a parte não usada de um pacote.
 *
 * Volta para a ficha do cliente, que é de onde a recepção saiu: o pacote é dele,
 * e "quanto foi devolvido a quem" é a pergunta seguinte.
 */
export async function acaoReembolsarPacote(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  const resultado = await reembolsarPacoteNaApi(token, texto(form, 'id'));
  if (!resultado.ok) falhar(`/admin/cliente/${customerId}`, resultado.code);
  redirect(`/admin/cliente/${customerId}?feito=reembolsado`);
}

/**
 * Vende um pacote na comanda (bloco 42).
 *
 * Ação própria e não o formulário de item genérico: o preço sai do catálogo, e
 * pedir para a recepção digitá-lo abriria a porta que a revisão de segurança
 * fechou — item de R$ 1 congelando cinco unidades de R$ 50.
 */
export async function acaoVenderPacote(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'orderId');

  const resultado = await adicionarNaComanda(token, id, {
    tipo: 'package',
    descricao: texto(form, 'descricao'),
    quantidade: 1,
    // O servidor ignora este valor no item de pacote; ele vai por exigência do
    // schema, e o preço de verdade é lido do catálogo dentro da transação.
    precoUnitarioCents: 0,
    packageId: texto(form, 'packageId'),
  });
  if (!resultado.ok) falhar(`/admin/comanda/${id}`, resultado.code);
  redirect(`/admin/comanda/${id}`);
}
