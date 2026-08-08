'use server';

import { redirect } from 'next/navigation';
import {
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
  salvarJanela,
  salvarPagamentos,
  salvarProfissionais,
  reemitirSenha,
  salvarServicos,
  trocarMinhaSenha,
  trocarPapel,
  criarProfissional,
  criarServico,
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
} from '@/lib/admin-api';
import { DIAS, lerJornada } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import {
  apagarSessaoGestor,
  guardarConflitoDeJornada,
  guardarSenhaDeUmaVez,
  gravarSessaoGestor,
  lerSessaoGestor,
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
 * Lista fechada das ações que o balcão pode enviar.
 *
 * O `action` chega de um campo escondido do formulário, que é entrada externa
 * como qualquer outra. A API valida de novo — esta guarda existe para a tela
 * não gastar uma ida ao servidor com lixo, e para o erro ser o da tela.
 */
const ACOES_DE_ATENDIMENTO: ReadonlySet<string> = new Set([
  'confirm', 'check_in', 'wait', 'start', 'complete', 'no_show', 'undo_no_show', 'cancel',
]);

/**
 * Para onde voltar depois de mover um atendimento.
 *
 * Mesmo motivo de `destinoSeguro` no fluxo do cliente: valor de formulário
 * virando `redirect` é redirecionador aberto. Aqui o alvo é ainda mais
 * sensível — o cookie do painel altera catálogo, equipe e preço.
 */
function destinoDoBalcao(bruto: string): string {
  if (bruto.startsWith('//')) return '/admin/dia';
  return bruto === '/admin/dia' || bruto.startsWith('/admin/dia?') ? bruto : '/admin/dia';
}

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
    ...(texto(form, 'cancellationPolicy')
      ? { cancellationPolicy: texto(form, 'cancellationPolicy') }
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
