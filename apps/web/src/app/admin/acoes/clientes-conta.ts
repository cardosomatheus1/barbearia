'use server';

import {
  exigirSessao,
  falhar,
  numero,
  texto,
  TETO_DO_ARQUIVO,
} from './comum';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import {
  adicionarSlug,
  analisarImportacao,
  aplicarImportacao,
  convidarProfissional,
  salvarMetaDoProfissional,
  salvarPreferenciasDoCliente,
  reverterImportacao,
  resolverConflitoImportacao,
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
  trocarDePlano,
  salvarPermissoesDoPapel,
  adicionarNaComanda,
  registrarConsentimentoNoBalcao,
  abrirPedidoDeDados,
  encerrarPedidoDeDados,
  anonimizarCliente as anonimizarClienteNaApi,
  encerrarSessao as encerrarSessaoDoAparelho,
  expulsarSuporte,
  salvarPreferenciasDeAlerta,
} from '@/lib/admin-api';
import { versaoDoConsentimento } from '@/lib/politica';
import {
  ehConversa,
} from '@barbearia/core';
import { DIAS, lerJornada, minutosOuNulo } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import { limiarDeFaltas } from '@/lib/sinal';
import { destinoDoBalcao } from '@/lib/destino';
import { VOLTA_DA_META } from '@/lib/meta';

import {
  guardarSenhaDeUmaVez,
} from '@/lib/sessao-gestor';


/**
 * Ações do painel.
 *
 * Cada etapa do onboarding grava sozinha e volta para a etapa seguinte. Nenhum
 * "salvar tudo no fim": quem cadastra barbearia faz isso no celular, entre um
 * cliente e outro, e abandonar no passo 4 não pode custar os passos 1 a 3.
 */





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
  if (bruto === '/admin/meu-dia') return '/admin/meu-dia';
  if (bruto === '/admin/clientes') return '/admin/clientes';
  return '/admin/dia';
}

function origemDaFicha(destino: string): 'meu-dia' | 'clientes' | 'dia' {
  return destino === '/admin/meu-dia' ? 'meu-dia' : destino === '/admin/clientes' ? 'clientes' : 'dia';
}

export async function acaoPreferencias(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const customerId = texto(form, 'customerId');
  const de = destinoDaFicha(texto(form, 'de'));
  const rota = `/admin/cliente/${customerId}?de=${origemDaFicha(de)}`;

  const conversa = texto(form, 'conversa');
  if (!ehConversa(conversa)) return falhar(rota, 'preferencia_invalida');

  const resultado = await salvarPreferenciasDoCliente(token, customerId, {
    maquinaLaterais: texto(form, 'maquinaLaterais') || null,
    tipoDegrade: texto(form, 'tipoDegrade') || null,
    topo: texto(form, 'topo') || null,
    barbaEstilo: texto(form, 'barbaEstilo') || null,
    produtosEvitar: texto(form, 'produtosEvitar') || null,
    conversa,
    observacoes: texto(form, 'observacoes') || null,
  });

  if (!resultado.ok) return falhar(rota, resultado);
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

  if (!resultado.ok) return falhar(`/admin/profissionais?pessoa=${professionalId}`, resultado);

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
  if (bruto && metaCents === null) return falhar(rota, 'meta_invalida');

  const resultado = await salvarMetaDoProfissional(token, {
    professionalId,
    mes: texto(form, 'mes'),
    metaCents,
  });

  if (!resultado.ok) return falhar(rota, resultado);
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
  if (!(arquivo instanceof File) || arquivo.size === 0) return falhar('/admin/importar', 'sem_arquivo');

  const enviado = arquivo as File;
  if (enviado.size > TETO_DO_ARQUIVO) return falhar('/admin/importar', 'arquivo_grande');

  const conteudo = await enviado.text();
  const separador = texto(form, 'separador');

  const resultado = await analisarImportacao(token, {
    fileName: enviado.name,
    conteudo,
    ...(separador ? { separador } : {}),
  });

  if (!resultado.ok) return falhar('/admin/importar', resultado);
  redirect(`/admin/importar?i=${resultado.dados.id}`);
}

export async function acaoResolverConflitoImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const linha = numero(form, 'linha', 0);
  const escolha = texto(form, 'escolha');

  if (!id || linha < 2 || (escolha !== 'anterior' && escolha !== 'linha')) {
    return falhar(`/admin/importar?i=${encodeURIComponent(id)}`, 'conflito_invalido');
  }

  const resultado = await resolverConflitoImportacao(token, id, { linha, escolha });
  if (!resultado.ok) return falhar(`/admin/importar?i=${encodeURIComponent(id)}`, resultado);

  redirect(`/admin/importar?i=${encodeURIComponent(id)}&conflito=1`);
}

export async function acaoAplicarImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');

  const resultado = await aplicarImportacao(token, id);
  if (!resultado.ok) return falhar(`/admin/importar?i=${id}`, resultado);

  redirect(`/admin/importar?feito=${resultado.dados.criados}&atualizados=${resultado.dados.atualizados}`);
}

export async function acaoReverterImportacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');

  const resultado = await reverterImportacao(token, id);
  if (!resultado.ok) return falhar('/admin/importar', resultado);

  redirect(`/admin/importar?desfeito=${resultado.dados.apagados}`);
}

/** O endereço do sistema antigo, para o link da bio não quebrar. */
export async function acaoAdicionarSlug(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await adicionarSlug(token, texto(form, 'slug'));
  if (!resultado.ok) return falhar('/admin/importar', resultado);

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

  if (!resultado.ok) return falhar('/admin/plano', resultado);
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
  if (!resultado.ok) return falhar('/admin/equipe/permissoes', resultado);
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
  const rota = `/admin/cliente/${customerId}?de=${origemDaFicha(de)}`;

  const finalidade = texto(form, 'finalidade');
  const versao = versaoDoConsentimento(finalidade);
  if (versao === null) return falhar(rota, 'finalidade_invalida');

  const resultado = await registrarConsentimentoNoBalcao(token, customerId, {
    finalidade,
    concedido: texto(form, 'concedido') === '1',
    versaoDoTexto: versao,
  });

  if (!resultado.ok) return falhar(rota, resultado);
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
  const rota = `/admin/cliente/${customerId}?de=${origemDaFicha(de)}`;

  const tipo = texto(form, 'tipo');
  if (tipo !== 'export' && tipo !== 'deletion') return falhar(rota, 'pedido_invalido');

  const resultado = await abrirPedidoDeDados(token, customerId, tipo);
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}&pedido=1`);
}

export async function acaoEncerrarPedidoDeDados(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const nota = texto(form, 'nota');
  const resultado = await encerrarPedidoDeDados(token, texto(form, 'pedidoId'), {
    atendido: texto(form, 'atendido') === '1',
    ...(nota ? { nota } : {}),
  });

  if (!resultado.ok) return falhar('/admin/lgpd', resultado);
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
  const rota = `/admin/cliente/${customerId}?de=${origemDaFicha(de)}`;

  /**
   * A confirmação digitada, conferida aqui e não só no navegador.
   *
   * Sem JavaScript no cliente não existe `confirm()`, e é bom que não exista:
   * digitar a palavra é uma barreira mais forte que um diálogo que se fecha no
   * reflexo. A conferência mora no servidor porque a do navegador é sugestão.
   */
  if (texto(form, 'confirmacao').toUpperCase() !== 'APAGAR') {
    return falhar(rota, 'confirmacao_invalida');
  }

  const resultado = await anonimizarClienteNaApi(token, customerId, texto(form, 'motivo'));
  if (!resultado.ok) return falhar(rota, resultado);

  // Volta para a lista, não para a ficha: a ficha que ele estava vendo não
  // existe mais como cadastro de pessoa, e mostrá-la vazia parece defeito.
  redirect(`${de}?apagado=1`);
}

// -- Segurança da conta (bloco 33) --------------------------------------------

export async function acaoEncerrarSessao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await encerrarSessaoDoAparelho(token, texto(form, 'id'));
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);
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
  if (!resultado.ok) return falhar('/admin/seguranca', resultado);
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

  if (!resultado.ok) return falhar('/admin/seguranca', resultado);
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
  if (!resultado.ok) return falhar('/admin/pacotes', resultado);
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
  if (!resultado.ok) return falhar(`/admin/cliente/${customerId}?aba=fidelidade`, resultado);
  redirect(`/admin/cliente/${customerId}?aba=fidelidade&feito=reembolsado`);
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
  }, texto(form, 'idempotencyKey'));
  if (!resultado.ok) return falhar(`/admin/comanda/${id}`, resultado);
  redirect(`/admin/comanda/${id}`);
}

