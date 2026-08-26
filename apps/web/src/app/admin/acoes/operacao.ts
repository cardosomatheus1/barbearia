'use server';

import {
  exigirSessao,
  falhar,
  numero,
  texto,
} from './comum';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import {
  ajustarConfianca,
  devolverSinalDoHorario,
  registrarSinal,
  criarMembro,
  ligarMembro,
  marcarNoBalcao,
  salvarFotos,
  enviarFotoDaBarbearia,
  removerFotoDaBarbearia,
  type AlvoDeUpload,
  reemitirSenha,
  trocarMinhaSenha,
  trocarPapel,
  criarProfissional,
  entrarNaFila,
  ajustarSaldoDeFidelidade,
  criarContaDoFinanceiro as criarContaDoFinanceiroApi,
  quitarContaDoFinanceiro as quitarContaDoFinanceiroApi,
  cancelarContaDoFinanceiro as cancelarContaDoFinanceiroApi,
  criarCategoriaDoFinanceiro as criarCategoriaDoFinanceiroApi,
  criarContaBancaria as criarContaBancariaApi,
  transferirEntreContas as transferirEntreContasApi,
  definirLimiteDeFiado as definirLimiteDeFiadoApi,
  lancarSaldoInicialDeFiado as lancarSaldoInicialDeFiadoApi,
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
  salvarProgramaDeFidelidade,
  editarProfissional,
  editarServico,
  exigenciasDoServico,
  ligarProfissional,
  ligarServico,
  salvarJornada,
  salvarRecursos,
  type EntradaDeProfissional,
  type EntradaDeServico,
  type Papel,
  anonimizarCliente as anonimizarClienteNaApi,
  encerrarSessao as encerrarSessaoDoAparelho,
} from '@/lib/admin-api';
import { versaoDoConsentimento } from '@/lib/politica';
import {
  MOTIVOS_DA_CONTESTACAO_DE_COMISSAO,
} from '@barbearia/core';
import { DIAS, lerJornada, minutosOuNulo } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import { limiarDeFaltas } from '@/lib/sinal';
import { destinoDoBalcao } from '@/lib/destino';
import { VOLTA_DA_META } from '@/lib/meta';

import {
  guardarConflitoDeJornada,
  guardarLinkDaFila,
  guardarSenhaDeUmaVez,
} from '@/lib/sessao-gestor';


/**
 * Ações do painel.
 *
 * Cada etapa do onboarding grava sozinha e volta para a etapa seguinte. Nenhum
 * "salvar tudo no fim": quem cadastra barbearia faz isso no celular, entre um
 * cliente e outro, e abandonar no passo 4 não pode custar os passos 1 a 3.
 */





// -- Balcão ------------------------------------------------------------------

/**
 * Mover um atendimento **não é ação de servidor** — é `dia/atender/route.ts`.
 *
 * Ela morava aqui e não conseguia levar adiante o que o domínio devolve: quem
 * espera pela vaga que o cancelamento acabou de abrir, com nome e telefone.
 * Nome de cliente não vai para a URL, e cookie gravado dentro de uma server
 * action não emite `Set-Cookie` neste app — então só a contagem atravessava, e
 * o aviso mandava para a lista de espera inteira da unidade.
 *
 * O handler devolve uma resposta HTTP de verdade, e ali o cookie é cookie.
 *
 * A lista fechada das ações foi junto, para `packages/core` — ela era uma cópia
 * à mão de `ACOES`, e morava num arquivo `'use server'`, que **só exporta função
 * assíncrona**. O handler não conseguia importá-la, e o build foi quem disse.
 */

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
  // Compatibilidade para formulários antigos: depois do R9 a API só aceita
  // caminhos gerados pelo próprio armazenamento. A tela nova usa upload.
  const resultado = await salvarFotos(token, {
    coverUrl: texto(form, 'coverUrl'),
    logoUrl: texto(form, 'logoUrl'),
  });
  if (!resultado.ok) return falhar('/admin/fotos', resultado);
  redirect('/admin/fotos?salvo=1');
}

const ALVOS_DE_UPLOAD = new Set<AlvoDeUpload>(['cover', 'logo', 'professional', 'service']);

export async function acaoUploadFoto(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const bruto = texto(form, 'target') as AlvoDeUpload;
  if (!ALVOS_DE_UPLOAD.has(bruto)) redirect('/admin/fotos?erro=invalid_photo_target');
  const id = texto(form, 'targetId') || undefined;
  const valor = form.get('arquivo');
  if (!(valor instanceof File) || valor.size === 0) redirect('/admin/fotos?erro=arquivo_vazio');
  if (valor.size > 3 * 1024 * 1024) redirect('/admin/fotos?erro=photo_too_large');
  const resultado = await enviarFotoDaBarbearia(token, bruto, valor, id);
  if (!resultado.ok) return falhar('/admin/fotos', resultado);
  redirect('/admin/fotos?salvo=1');
}

export async function acaoRemoverFotoDaBarbearia(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const bruto = texto(form, 'target') as AlvoDeUpload;
  if (!ALVOS_DE_UPLOAD.has(bruto)) redirect('/admin/fotos?erro=invalid_photo_target');
  const id = texto(form, 'targetId') || undefined;
  const resultado = await removerFotoDaBarbearia(token, bruto, id);
  if (!resultado.ok) return falhar('/admin/fotos', resultado);
  redirect('/admin/fotos?removido=1');
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

  if (!resultado.ok) return falhar('/admin/equipe', resultado);

  await guardarSenhaDeUmaVez(resultado.dados.member.name, resultado.dados.senhaInicial);
  redirect('/admin/equipe');
}

export async function acaoTrocarPapel(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await trocarPapel(token, texto(form, 'id'), texto(form, 'role') as Papel);
  if (!resultado.ok) return falhar('/admin/equipe', resultado);
  redirect('/admin/equipe?salvo=1');
}

export async function acaoLigarMembro(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarMembro(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) return falhar('/admin/equipe', resultado);
  redirect('/admin/equipe?salvo=1');
}

export async function acaoReemitirSenha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await reemitirSenha(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/equipe', resultado);

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
    return falhar('/admin/trocar-senha', 'nao_confere');
  }

  const resultado = await trocarMinhaSenha(
    token,
    String(form.get('currentPassword') ?? ''),
    nova,
  );
  if (!resultado.ok) return falhar('/admin/trocar-senha', resultado);

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
    ...(componentIds.length >= 2
      ? {
          componentIds,
          // Só junto do combo: fora dele o campo não é desenhado, e mandar zero
          // seria a tela decidindo por um serviço avulso que ela nem mostrou.
          comboToleranceMinutes: numero(form, 'comboToleranceMinutes', 0),
        }
      : {}),
  };
}

export async function acaoSalvarServico(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const entrada = entradaDeServico(form);
  if (!entrada) return falhar('/admin/catalogo', 'preco_invalido');

  const id = texto(form, 'id');
  const resultado = id
    ? await editarServico(token, id, entrada)
    : await criarServico(token, entrada);

  if (!resultado.ok) return falhar('/admin/catalogo', resultado);
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
  if (!resultado.ok) return falhar(voltar, resultado);
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
  if (!resultado.ok) return falhar(voltar, resultado);
  redirect(voltar);
}

export async function acaoConfiancaDoCliente(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const brutoDe = texto(form, 'de');
  const de = brutoDe === '/admin/meu-dia' ? 'meu-dia' : brutoDe === '/admin/clientes' ? 'clientes' : 'dia';
  const destino = `/admin/cliente/${customerId}?aba=financeiro&de=${de}`;

  const decisao = texto(form, 'decisao');
  // 100 dispensa (o piso de dispensa é 85 e não é configurável); 0 fica abaixo
  // de qualquer limiar que a barbearia consiga escolher.
  const score = decisao === 'dispensar' ? 100 : decisao === 'exigir' ? 0 : null;

  const resultado = await ajustarConfianca(token, customerId, {
    score,
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) return falhar(destino, resultado);
  redirect(`${destino}&ajuste=1`);
}

export async function acaoLigarServico(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarServico(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) return falhar('/admin/catalogo', resultado);
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
  if (!resultado.ok) return falhar('/admin/recursos', resultado);
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

  if (!resultado.ok) return falhar('/admin/profissionais', resultado);
  redirect('/admin/profissionais?salvo=1');
}

export async function acaoLigarProfissional(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarProfissional(token, texto(form, 'id'), texto(form, 'active') === '1');
  if (!resultado.ok) return falhar('/admin/profissionais', resultado);

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

  if (!lida.ok) return falhar(destino, `${lida.code}_${lida.weekday}`);

  const confirmar = form.get('confirmarConflitos') === '1';
  const resultado = await salvarJornada(token, id, lida.faixas, confirmar);
  if (!resultado.ok) return falhar(destino, resultado);

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
  if (!resultado.ok) return falhar('/admin/recursos', resultado);
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
  if (serviceIds.length === 0) return falhar('/admin/fila', 'sem_servico');

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

  if (!resultado.ok) return falhar('/admin/fila', resultado);

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
    return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, 'quantidade_invalida');
  }

  const resultado = await ajustarSaldoDeFidelidade(token, customerId, {
    quantidade,
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&salvo=fidelidade`);
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
    return falhar('/admin/fidelidade', 'invalid_request');
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
    // O seletor sempre traz um dos dois; "empresa" é o padrão e o comportamento
    // anterior (bloco 59).
    escopo: texto(form, 'escopo') === 'unidade' ? 'unidade' : 'empresa',
  });
  if (!resultado.ok) return falhar('/admin/fidelidade', resultado);
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
  if (!resultado.ok) return falhar('/admin/recados', resultado);
  redirect('/admin/recados?feito=assumido');
}

/** Devolve à triagem. Todo estado precisa de saída na tela (CLAUDE.md §6). */
export async function acaoDevolverRecado(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await devolverRecadoNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/recados', resultado);
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
  if (!resultado.ok) return falhar('/admin/recados', resultado);
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
  if (!resultado.ok) return falhar('/admin/recados', resultado);
  redirect('/admin/recados?feito=encerrado');
}

/**
 * Marca como resolvida a pergunta que a recepção não soube responder (bloco 66).
 *
 * Resolver é **estado**: a linha continua no banco, com o contador, e perguntar
 * de novo reabre. A tela não tem botão de apagar porque a aplicação não tem o
 * direito — e apagar a pergunta sem resposta seria apagar exatamente o dado que
 * esta lista existe para produzir.
 */
/**
 * Entra ou sai da vitrine do marketplace (bloco 70).
 *
 * Aparecer na busca nasce ligado — é o benefício que a plataforma vende, e o
 * dado exibido já é o da própria página pública. Sair é decisão, e é esta ação.
 */
export async function acaoDefinirVitrine(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await definirVitrineNaApi(token, texto(form, 'ligado') === '1');
  if (!resultado.ok) return falhar('/admin/configuracoes', resultado);
  redirect('/admin/configuracoes?salvo=1');
}

/**
 * Registra uma foto antes/depois (bloco 74, SPEC §4.2).
 *
 * O consentimento é conferido pela API e pelo banco; aqui a falha volta para a
 * ficha com o código, e a tela escreve a frase — "este cliente não autorizou" é
 * o que a recepção precisa ler para saber o que fazer, não um erro genérico.
 */
export async function acaoRegistrarFoto(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'customerId');
  const resultado = await registrarFotoNaApi(token, id, {
    tipo: texto(form, 'tipo') === 'depois' ? 'depois' : 'antes',
    url: texto(form, 'url'),
    ...(texto(form, 'legenda') ? { legenda: texto(form, 'legenda') } : {}),
    ...(texto(form, 'professionalId') ? { professionalId: texto(form, 'professionalId') } : {}),
    noPortfolio: texto(form, 'noPortfolio') === '1',
  });
  if (!resultado.ok) return falhar(`/admin/cliente/${id}`, resultado);
  redirect(`/admin/cliente/${id}?foto=1`);
}

export async function acaoPublicarFoto(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'customerId');
  const resultado = await publicarFotoNaApi(
    token,
    texto(form, 'fotoId'),
    texto(form, 'publicar') === '1',
  );
  if (!resultado.ok) return falhar(`/admin/cliente/${id}`, resultado);
  redirect(`/admin/cliente/${id}?foto=1`);
}

/**
 * Apaga uma foto — `DELETE` de verdade.
 *
 * O titular que pede para tirar uma foto não pediu para escondê-la, e é a
 * exceção deliberada num schema em que quase tudo é append-only.
 */
export async function acaoApagarFoto(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'customerId');
  const resultado = await apagarFotoNaApi(token, texto(form, 'fotoId'));
  if (!resultado.ok) return falhar(`/admin/cliente/${id}`, resultado);
  redirect(`/admin/cliente/${id}?foto=1`);
}

/**
 * Liga ou desliga a página pública do barbeiro (bloco 73, SPEC §5.2).
 *
 * As especialidades vão juntas porque é a mesma decisão: uma página pública sem
 * elas é um nome e uma foto, e a SPEC as põe no card justamente porque é por
 * elas que o cliente escolhe quem corta o cabelo dele.
 */
export async function acaoPerfilPublico(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await definirPerfilPublicoNaApi(token, texto(form, 'id'), {
    ligado: texto(form, 'ligado') === '1',
    especialidades: form.getAll('especialidades').map(String).filter(Boolean),
  });
  if (!resultado.ok) return falhar('/admin/profissionais', resultado);
  redirect('/admin/profissionais?feito=1');
}

/**
 * A barbearia contesta uma cobrança de cliente novo (bloco 72).
 *
 * Contestar é **estado**, não apagar: a linha continua existindo para a
 * conversa ter documento, e aquele cliente não volta a gerar comissão numa
 * varredura seguinte.
 */
export async function acaoContestarMarketplace(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const categoria = texto(form, 'categoria');
  if (!MOTIVOS_DA_CONTESTACAO_DE_COMISSAO.includes(categoria as never)) {
    return falhar('/admin/plano', 'invalid_request');
  }

  const resultado = await contestarClienteDoMarketplace(token, texto(form, 'id'), {
    categoria,
    motivo: texto(form, 'motivo'),
  });
  if (!resultado.ok) return falhar('/admin/plano', resultado);
  redirect('/admin/plano?contestado=1');
}

/**
 * Liga ou desliga o preço por faixa (bloco 68).
 *
 * É o que a SPEC §4.20 chama de "autorização configurada explicitamente": sem
 * este interruptor, faixa cadastrada não muda preço nenhum.
 */
export async function acaoLigarPrecoPorFaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await ligarPrecoPorFaixaNaApi(token, texto(form, 'ligado') === '1');
  if (!resultado.ok) return falhar('/admin/precos', resultado);
  redirect('/admin/precos?feito=1');
}

/**
 * Cadastra a faixa — e é isto que "o administrador aprova" quer dizer.
 *
 * O botão da recomendação chama esta mesma ação com os valores sugeridos
 * preenchidos: não existe caminho em que uma sugestão vire regra sozinha.
 */
export async function acaoCriarFaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await criarFaixaNaApi(token, {
    diaDaSemana: Number(texto(form, 'diaDaSemana')),
    inicioMinuto: Number(texto(form, 'inicioMinuto')),
    fimMinuto: Number(texto(form, 'fimMinuto')),
    deltaBps: Number(texto(form, 'deltaBps')),
  });
  if (!resultado.ok) return falhar('/admin/precos', resultado);
  redirect('/admin/precos?feito=1');
}

export async function acaoApagarFaixa(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await apagarFaixaNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/precos', resultado);
  redirect('/admin/precos?feito=1');
}

export async function acaoResolverLacuna(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await resolverLacunaNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/recepcao', resultado);
  redirect('/admin/recepcao?feito=resolvida');
}

export async function acaoMoverNaFila(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const para = texto(form, 'para');
  if (!['waiting', 'called', 'done', 'gave_up'].includes(para)) {
    return falhar('/admin/fila', 'invalid_request');
  }

  const resultado = await moverNaFila(token, texto(form, 'id'), para as StatusNaFila);
  if (!resultado.ok) return falhar('/admin/fila', resultado);
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
  if (!resultado.ok) return falhar('/admin/fila', resultado);
  redirect('/admin/dia');
}

