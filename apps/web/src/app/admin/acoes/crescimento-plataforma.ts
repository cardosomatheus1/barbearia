'use server';

import {
  centavos,
  exigirSessao,
  falhar,
  guardarOQueFoiDigitado,
  texto,
} from './comum';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import {
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
  anonimizarCliente as anonimizarClienteNaApi,
  encerrarSessao as encerrarSessaoDoAparelho,
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
  TIPO_PADRAO_DE_CAMPANHA,
} from '@barbearia/core';
import { DIAS, lerJornada, minutosOuNulo } from '@/lib/jornada';
import { centavosDoCampo } from '@/lib/dinheiro';
import { limiarDeFaltas } from '@/lib/sinal';
import { destinoDoBalcao } from '@/lib/destino';
import { VOLTA_DA_META } from '@/lib/meta';

import {
  guardarEstadoDaMeta,
  guardarMotivoDaMeta,
  guardarSenhaDeUmaVez,
} from '@/lib/sessao-gestor';


/**
 * Ações do painel.
 *
 * Cada etapa do onboarding grava sozinha e volta para a etapa seguinte. Nenhum
 * "salvar tudo no fim": quem cadastra barbearia faz isso no celular, entre um
 * cliente e outro, e abandonar no passo 4 não pode custar os passos 1 a 3.
 */





// -- Fiscal (bloco 53) --------------------------------------------------------

const ROTA_FISCAL = '/admin/fiscal';

export async function acaoSalvarFiscal(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const regime = texto(form, 'regime');
  if (regime !== 'simples' && regime !== 'mei' && regime !== 'salao_parceiro') {
    return falhar(ROTA_FISCAL, 'invalid_request');
  }

  /**
   * O ISS chega como "2,5" e vai em pontos-base.
   *
   * Reaproveitar `centavos` seria acidente esperando acontecer: ele existe para
   * dinheiro, e a coincidência de as duas escalas serem centésimos é o tipo de
   * coisa que deixa de valer no dia em que uma delas muda.
   */
  const iss = texto(form, 'issPercent').replace(',', '.');
  const issBps = Math.round(Number(iss || '0') * 100);
  if (!Number.isFinite(issBps)) return falhar(ROTA_FISCAL, 'aliquota_invalida');

  const resultado = await salvarFiscalNaApi(token, {
    cnpj: texto(form, 'cnpj'),
    regime,
    codigoDeServico: texto(form, 'codigoDeServico'),
    issBps,
    municipioIbge: texto(form, 'municipioIbge'),
    inscricaoMunicipal: texto(form, 'inscricaoMunicipal') || null,
    emitirAutomaticamente: texto(form, 'emitirAutomaticamente') === '1',
  });
  if (!resultado.ok) return falhar(ROTA_FISCAL, resultado);
  redirect(`${ROTA_FISCAL}?salvo=1`);
}

export async function acaoEmitirNota(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const orderId = texto(form, 'orderId');
  const rota = texto(form, 'de') === 'fiscal' ? ROTA_FISCAL : `/admin/comanda/${orderId}`;
  const resultado = await emitirNotaNaApi(token, orderId);
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}?feito=nota`);
}

/**
 * O CPF do tomador, digitado no balcão.
 *
 * Volta para a comanda e não para a tela de nota fiscal: é ali que a recepção
 * está quando o cliente pede, com a maquininha na mão.
 */
export async function acaoSalvarDocumentoDoTomador(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const orderId = texto(form, 'orderId');
  const rota = `/admin/comanda/${orderId}`;
  const resultado = await salvarDocumentoDoTomadorNaApi(
    token,
    texto(form, 'customerId'),
    texto(form, 'documento') || null,
  );
  if (!resultado.ok) return falhar(rota, resultado);
  redirect(`${rota}?feito=documento`);
}

const ROTA_WHATSAPP = '/admin/whatsapp';
const ROTA_AUTOMACOES = '/admin/automacoes';
const ROTA_CAMPANHAS = '/admin/campanhas';

/**
 * Os campos que a tela de campanha sabe repor depois de uma recusa (bloco 98).
 *
 * Escrita aqui e não derivada do `FormData`: ele traz também o botão, a chave
 * de idempotência e os campos escondidos, e reencher a tela com eles devolveria
 * estado que ninguém digitou. Há teste que cobra que todo `name` com
 * `defaultValue` na tela esteja nesta lista.
 */
const CAMPOS_DA_CAMPANHA = [
  'nome',
  'filtro',
  'valorDoFiltro',
  'diaDaSemana',
  'templateId',
  'janelaDias',
] as const;

export async function acaoCriarCampanha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const valor = texto(form, 'valorDoFiltro');
  const dia = texto(form, 'diaDaSemana');
  /**
   * O texto escolhido, e é **ele** quem diz o tipo (bloco 96).
   *
   * A tela mandava um `tipo` fixo e o motor pegava o primeiro texto aprovado
   * daquele tipo com `LIMIT 1`. Com três convites de retorno cadastrados, a
   * campanha da célula fria saía com "seu pacote está acabando" para quem nunca
   * comprou pacote — e a prévia na tela mostrava outro texto.
   *
   * Um campo só, e não os dois: o `tipo` continua existindo na borda para quem
   * cria campanha sem nenhum texto cadastrado, e mandar os dois daqui seria o
   * par que diverge.
   */
  const templateId = texto(form, 'templateId');
  const resultado = await criarCampanhaNaApi(token, {
    nome: texto(form, 'nome'),
    filtro: texto(form, 'filtro'),
    valorDoFiltro: valor ? Number(valor) : null,
    diaDaSemana: dia ? Number(dia) : null,
    /**
     * O tipo cai no padrão quando a tela não desenhou o campo (bloco 108).
     *
     * Sem texto aprovado — que é o estado do **dia 1 de toda barbearia**, antes
     * de o WhatsApp estar ligado — o formulário não renderiza nem o rádio de
     * `templateId` nem o campo de `tipo`. A ação mandava `tipo: ''`, o `z.enum`
     * recusava, e o botão primário da tela devolvia "Parâmetro inválido: tipo"
     * sobre um campo que não existe na tela.
     *
     * A automação, na linha 2992, sempre teve esta queda. A assimetria é o que
     * mostra que era descuido e não regra: as duas telas dizem a mesma frase
     * vermelha ("Nenhum texto aprovado — nada vai sair"), e só uma delas
     * deixava salvar.
     *
     * E montar o público antes de ter texto é caso legítimo: o público é
     * congelado na criação, o envio é outro botão, e `campanhaEnviavel` já
     * guarda o **Enviar**.
     */
    ...(templateId
      ? { templateId }
      : { tipo: texto(form, 'tipo') || TIPO_PADRAO_DE_CAMPANHA }),
    janelaDias: Number(texto(form, 'janelaDias') || '7'),
  });
  if (!resultado.ok) {
    await guardarOQueFoiDigitado(form, CAMPOS_DA_CAMPANHA, resultado.message);
    return falhar(ROTA_CAMPANHAS, resultado);
  }
  redirect(`${ROTA_CAMPANHAS}?feito=criada&publico=${resultado.dados.publico}`);
}

/**
 * O botão "Enviar" (bloco 82).
 *
 * A rota não manda mensagem: ela põe a campanha em `enviando` e enfileira o
 * despacho. Por isso a volta diz "entrou na fila" e não "enviada" — prometer o
 * segundo faria a pessoa recarregar a tela procurando um número que ainda vai
 * demorar, e concluir que quebrou.
 */
export async function acaoEnviarCampanha(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await enviarCampanhaNaApi(token, texto(form, 'id'));
  if (!resultado.ok) return falhar(ROTA_CAMPANHAS, resultado);
  redirect(`${ROTA_CAMPANHAS}?feito=enviando`);
}


/** Os campos que a tela de automação sabe repor. Mesma razão da campanha. */
const CAMPOS_DA_AUTOMACAO = [
  'nome',
  'gatilho',
  'limiar',
  'atrasoMinutos',
  'templateId',
  'publico',
  'objetivo',
  'janelaDias',
  'ativa',
] as const;

export async function acaoSalvarAutomacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const limiarBruto = texto(form, 'limiar');
  const id = texto(form, 'id');
  const resultado = await salvarAutomacaoNaApi(token, {
    ...(id ? { id } : {}),
    nome: texto(form, 'nome'),
    gatilho: texto(form, 'gatilho'),
    // Vazio é "este gatilho não pede número", e não zero: zero é recusado pelo
    // domínio de propósito, porque um limiar de zero dispara para todo mundo.
    limiar: limiarBruto ? Number(limiarBruto) : null,
    atrasoMinutos: Number(texto(form, 'atrasoMinutos') || '0'),
    /**
     * O tipo é o do **texto escolhido**, e quem o resolve é o domínio.
     *
     * Ele decide o que importa — natureza da mensagem, opt-out, teto do mês,
     * categoria na Meta —, e deixou de ser o endereço do texto. O que vai daqui
     * é só o padrão para a automação sem texto escolhido; com texto, o domínio
     * lê o tipo dele e ignora este campo, senão os dois divergiriam.
     */
    tipo: texto(form, 'tipo') || TIPO_PADRAO_DE_CAMPANHA,
    templateId: texto(form, 'templateId') || null,
    /**
     * Para quem ela manda (bloco 100).
     *
     * Vazio é "todo mundo", que é o valor da primeira opção do seletor — e não
     * "não mexa": este formulário é o único caminho de edição, e um `undefined`
     * daqui faria voltar de "só para VIP" para "todo mundo" ser impossível.
     */
    publico: texto(form, 'publico') || null,
    objetivo: texto(form, 'objetivo'),
    janelaDias: Number(texto(form, 'janelaDias') || '7'),
    ativa: form.get('ativa') === 'on',
  });
  if (!resultado.ok) {
    await guardarOQueFoiDigitado(form, CAMPOS_DA_AUTOMACAO, resultado.message);
    /**
     * A recusa volta **para a edição**, e não para o formulário de criar.
     *
     * `falhar(ROTA_AUTOMACOES, ...)` perdia o `editar=`, e `id` não está em
     * `CAMPOS_DA_AUTOMACAO` — é campo escondido, sem `defaultValue`, então o
     * rascunho não o repunha. O formulário voltava com tudo digitado, o título
     * trocado de "Editando X" para "Nova automação" e sem o `id`: quem corrigia
     * o campo e salvava ficava com **duas** automações de mesmo nome, a
     * original ainda ligada e mandando.
     *
     * O par "enviadas / alcançadas", que a SPEC §4.11 exige para poder matar o
     * que não funciona, passava a ficar repartido entre as duas — e a decisão
     * de desligar deixava de ser possível de tomar.
     */
    return falhar(id ? `${ROTA_AUTOMACOES}?editar=${encodeURIComponent(id)}` : ROTA_AUTOMACOES, resultado);
  }
  redirect(`${ROTA_AUTOMACOES}?feito=salva`);
}


/**
 * Liga e desliga uma automação, sem reenviar o resto.
 *
 * A versão anterior reenviava o objeto inteiro com `ativa` virado, e isso
 * amarrou o freio à validação de tudo o mais: automação criada antes de o tipo
 * ser fechado respondia "Parâmetro inválido: tipo" e **continuava ligada**,
 * sem saída pela tela.
 *
 * `ativa` vem do formulário como o estado **desejado**, escrito no campo
 * escondido, e não da ausência do campo: "não veio" e "veio falso" são a mesma
 * coisa para um `FormData`, e derivar disso já custou um defeito neste arquivo.
 */
export async function acaoLigarAutomacao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await definirAutomacaoAtivaNaApi(
    token,
    texto(form, 'id'),
    texto(form, 'ativa') === 'sim',
  );
  if (!resultado.ok) return falhar(ROTA_AUTOMACOES, resultado);
  redirect(`${ROTA_AUTOMACOES}?feito=${resultado.dados.ativa ? 'ligada' : 'desligada'}`);
}

export async function acaoSalvarCadastroDoWhatsApp(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const novo = texto(form, 'token');
  const resultado = await salvarCadastroDoWhatsAppNaApi(token, {
    phoneNumberId: texto(form, 'phoneNumberId'),
    wabaId: texto(form, 'wabaId'),
    numeroVisivel: texto(form, 'numeroVisivel') || null,
    // Campo vazio é "não mexa": mandar string vazia apagaria o token salvo.
    ...(novo ? { token: novo } : {}),
  });
  if (!resultado.ok) return falhar(ROTA_WHATSAPP, resultado);
  redirect(`${ROTA_WHATSAPP}?feito=cadastro`);
}

/**
 * A volta do Embedded Signup (bloco 83).
 *
 * O formulário é preenchido pelo script da janela da Meta e submetido por ele:
 * o navegador nunca vê o `META_APP_SECRET`, então a troca do código pelo token
 * só pode acontecer do lado do servidor — que é aqui, e depois na API.
 */
/**
 * O botão "Conectar WhatsApp": sorteia o `state`, guarda, e leva para a Meta.
 *
 * ## Por que ação, e não link montado na renderização
 *
 * O `state` precisa ir para um cookie, e o Next só permite gravar cookie em
 * ação de formulário ou rota — nunca durante a renderização de uma página.
 * Montar o endereço no `page.tsx` derrubava a tela inteira com "server-side
 * exception", que foi como este caminho chegou ao ar quebrado.
 *
 * Continua sem JavaScript: é um `<form>` com um botão de submeter, como todo o
 * resto do painel.
 */
export async function acaoIrParaMeta(): Promise<void> {
  const token = await exigirSessao();
  const state = randomBytes(16).toString('hex');
  await guardarEstadoDaMeta(state);

  const resposta = await signupDoWhatsAppNaApi(token, {
    redirectUri: VOLTA_DA_META,
    state,
  });
  if (!resposta.ok || !resposta.dados.signup?.endereco) {
    return falhar(ROTA_WHATSAPP, resposta.ok ? 'sem_app' : resposta.code);
  }

  // `redirect` para fora do domínio é o próprio fluxo: a Meta traz de volta.
  redirect(resposta.dados.signup.endereco);
}

export async function acaoConectarWhatsApp(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await conectarWhatsAppNaApi(token, {
    code: texto(form, 'code'),
    wabaId: texto(form, 'wabaId'),
    phoneNumberId: texto(form, 'phoneNumberId'),
    numeroVisivel: texto(form, 'numeroVisivel') || null,
  });
  if (!resultado.ok) {
    await guardarMotivoDaMeta(resultado.message);
    return falhar(ROTA_WHATSAPP, resultado);
  }
  redirect(`${ROTA_WHATSAPP}?feito=conectado`);
}

/**
 * Pergunta à Meta o que ela ainda não respondeu, agora.
 *
 * Sem isto, o número aprovado e o texto aprovado só apareciam na tela na volta
 * seguinte do relógio — até uma hora depois. Quem acabou de digitar o código do
 * SMS no painel da Meta volta para cá em segundos e conclui que a tela travou.
 */
/**
 * Manda uma mensagem para um cliente, da ficha dele.
 *
 * O desfecho volta em letras porque "não saiu" tem quatro motivos legítimos —
 * revogou o marketing, já recebeu hoje, estourou o teto do mês, ou está na
 * janela de silêncio — e nenhum deles é erro. Sem a frase, o balcão apertaria
 * de novo achando que falhou.
 */
export async function acaoMandarMensagem(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const customerId = texto(form, 'customerId');
  // O texto escolhido, e não o tipo: os três convites de retorno da ficha
  // apareciam com um botão cada e os três mandavam o primeiro.
  const templateId = texto(form, 'templateId');
  const resultado = await mandarMensagemNaApi(
    token,
    customerId,
    templateId ? { templateId } : { tipo: texto(form, 'tipo') },
    texto(form, 'idempotencyKey'),
  );
  const brutoDe = texto(form, 'de');
  const de = brutoDe === '/admin/meu-dia' || brutoDe === 'meu-dia'
    ? 'meu-dia'
    : brutoDe === '/admin/dia' || brutoDe === 'dia'
      ? 'dia'
      : 'clientes';
  const rota = `/admin/cliente/${customerId}?aba=visao&de=${de}`;
  if (!resultado.ok) {
    await guardarMotivoDaMeta(resultado.message);
    return falhar(rota, resultado);
  }
  if (!resultado.dados.enviado) {
    await guardarMotivoDaMeta(resultado.dados.motivo ?? 'Não deu para mandar.');
    return falhar(rota, 'nao_saiu');
  }
  redirect(`${rota}&feito=mensagem`);
}

export async function acaoConciliarWhatsApp(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await conciliarWhatsAppNaApi(token);
  if (!resultado.ok) return falhar(ROTA_WHATSAPP, resultado);
  redirect(`${ROTA_WHATSAPP}?feito=conciliado`);
}

export async function acaoSubmeterTemplate(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const titulo = texto(form, 'titulo');
  /**
   * Os botões vêm como vários campos de mesmo nome, e `getAll` é o que os lê.
   *
   * `texto(form, 'botoes')` devolveria só o primeiro — e a pessoa que marcasse
   * os dois receberia um texto com um botão só, aprovado assim pela Meta e sem
   * nada para explicar a diferença.
   */
  const botoes = form.getAll('botoes').filter((b): b is string => typeof b === 'string');
  const acoes = form.getAll('acoes').filter((b): b is string => typeof b === 'string');

  const resultado = await submeterTemplateNaApi(token, {
    tipo: texto(form, 'tipo'),
    ...(titulo ? { titulo } : {}),
    ...(botoes.length > 0 ? { botoes } : {}),
    ...(acoes.length > 0 ? { acoes } : {}),
    corpo: texto(form, 'corpo'),
  });
  if (!resultado.ok) {
    // A frase de quem recusou vai junto. "Tente de novo" sobre um texto que a
    // Meta reprovou é a tela pedindo que se repita o que já não funcionou.
    await guardarMotivoDaMeta(resultado.message);
    return falhar(ROTA_WHATSAPP, resultado);
  }
  redirect(`${ROTA_WHATSAPP}?feito=template`);
}

export async function acaoCancelarNota(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await cancelarNotaNaApi(token, texto(form, 'notaId'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar(ROTA_FISCAL, resultado);
  redirect(`${ROTA_FISCAL}?feito=nota-cancelada`);
}

// -- Multiunidade (bloco 58) --------------------------------------------------

const ROTA_UNIDADES = '/admin/unidades';

/**
 * Troca a loja em que o balcão está.
 *
 * O `de` diz de onde a pessoa clicou, porque o seletor mora no casco e aparece
 * em toda tela: mandar sempre para a lista de unidades faria trocar de loja
 * custar dois cliques de volta ao lugar onde se estava trabalhando.
 */
export async function acaoEscolherUnidade(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const volta = texto(form, 'de') || ROTA_UNIDADES;
  const resultado = await escolherUnidadeNaApi(token, texto(form, 'unidadeId'));
  if (!resultado.ok) return falhar(volta, resultado);
  redirect(`${volta}?feito=unidade`);
}

export async function acaoDefinirUnidadesDaConta(form: FormData): Promise<void> {
  const token = await exigirSessao();
  /**
   * Nenhuma caixa marcada significa **todas**, e é o que a tela diz em letras.
   *
   * O contrário — nenhuma marcada trancar a pessoa fora de tudo — seria a
   * interpretação óbvia e está errada: é o padrão de toda barbearia de uma loja
   * só, e negá-lo por omissão trancaria a equipe inteira.
   */
  const unidades = form.getAll('unidade').map(String).filter(Boolean);
  const resultado = await definirUnidadesNaApi(token, texto(form, 'staffUserId'), unidades);
  if (!resultado.ok) return falhar(ROTA_UNIDADES, resultado);
  redirect(`${ROTA_UNIDADES}?feito=equipe`);
}

export async function acaoTransferirEstoque(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const nota = texto(form, 'nota');
  const resultado = await transferirEstoqueNaApi(token, {
    produtoId: texto(form, 'produtoId'),
    origemId: texto(form, 'origemId'),
    destinoId: texto(form, 'destinoId'),
    quantidade: Number(form.get('quantidade') ?? 0),
    ...(nota ? { nota } : {}),
  });
  if (!resultado.ok) return falhar(ROTA_UNIDADES, resultado);
  redirect(`${ROTA_UNIDADES}?feito=transferencia`);
}

export async function acaoAbrirUnidade(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const cidade = texto(form, 'cidade');
  const estado = texto(form, 'estado');
  const linkDoMapa = texto(form, 'linkDoMapa');
  const resultado = await abrirUnidadeNaApi(token, {
    nome: texto(form, 'nome'),
    timezone: texto(form, 'timezone'),
    ...(cidade ? { cidade } : {}),
    ...(estado ? { estado } : {}),
    ...(linkDoMapa ? { linkDoMapa } : {}),
  });
  if (!resultado.ok) return falhar(ROTA_UNIDADES, resultado);
  redirect(`${ROTA_UNIDADES}?feito=aberta`);
}

/**
 * Fecha ou reabre uma loja.
 *
 * Um botão só, e não dois: o estado da unidade decide o que ele diz e o que ele
 * manda. Dois botões lado a lado — um sempre inútil — é o que faz a recepção
 * clicar no errado com pressa.
 */
export async function acaoDefinirUnidadeAtiva(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await definirUnidadeAtivaNaApi(
    token,
    texto(form, 'unidadeId'),
    texto(form, 'ativa') === 'sim',
  );
  if (!resultado.ok) return falhar(ROTA_UNIDADES, resultado);
  redirect(`${ROTA_UNIDADES}?feito=${texto(form, 'ativa') === 'sim' ? 'reaberta' : 'fechada'}`);
}

/**
 * A pergunta do assistente (bloco 64).
 *
 * Ela volta pela URL de propósito: assim a resposta é compartilhável, o botão de
 * voltar funciona e a tela continua sem uma linha de JavaScript. O que **não**
 * vai para a URL é o resultado — só o texto que a pessoa escreveu.
 */
export async function acaoPerguntarAoAssistente(form: FormData): Promise<void> {
  const texto = String(form.get('p') ?? '').slice(0, 200);
  redirect(`/admin/assistente?p=${encodeURIComponent(texto)}`);
}

/**
 * Franquia: publicar no padrão, tirar do padrão e adotar (bloco 76).
 *
 * O preço vai em **centavos**, pela mesma função que o resto do produto usa:
 * `Number(v) * 100` daria 4499,999… para "44,99".
 */
export async function acaoPublicarNoPadrao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const id = texto(form, 'id');
  const resultado = await publicarNoPadrao(token, {
    ...(id ? { id } : {}),
    nome: texto(form, 'nome'),
    descricao: texto(form, 'descricao') || null,
    referenciaCents: await centavos(form, 'referencia', '/admin/franquia'),
    duracaoMinutos: Number(texto(form, 'duracao')) || 0,
    categoria: texto(form, 'categoria') || null,
    posicao: Number(texto(form, 'posicao')) || 0,
  });
  if (!resultado.ok) return falhar('/admin/franquia', resultado);
  redirect('/admin/franquia?publicado=1');
}

export async function acaoDespublicarDoPadrao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await despublicarDoPadrao(token, texto(form, 'itemId'));
  if (!resultado.ok) return falhar('/admin/franquia', resultado);
  redirect('/admin/franquia?despublicado=1');
}

export async function acaoAdotarDoPadrao(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await adotarDoPadrao(token, texto(form, 'itemId'));
  if (!resultado.ok) return falhar('/admin/franquia', resultado);
  redirect(`/admin/franquia?adotado=${resultado.dados.novo ? 'novo' : 'atualizado'}`);
}

/**
 * A meta combinada com uma franqueada (bloco 77).
 *
 * Meta não é preço: combinar alvo de vendas é o contrato de franquia; dizer por
 * quanto vender é que não.
 */
export async function acaoSalvarMetaDaRede(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await salvarMetaDaRedeNaApi(token, {
    franqueadaId: texto(form, 'franqueadaId'),
    mes: texto(form, 'mes'),
    metaCents: await centavos(form, 'meta', '/admin/rede'),
  });
  if (!resultado.ok) return falhar('/admin/rede', resultado);
  redirect('/admin/rede?meta=1');
}

/**
 * Emitir e revogar chave de API (bloco 78).
 *
 * O segredo volta **uma vez**, e vai para a tela num cookie `httpOnly` de dois
 * minutos com caminho restrito — nunca por parâmetro de consulta. É o mesmo
 * mecanismo da senha de primeiro acesso do bloco 29, e pela mesma razão: a URL
 * fica no histórico do navegador, no autocompletar e em qualquer referrer.
 */
export async function acaoCriarChave(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const escopos = form.getAll('escopos').map((v) => String(v));
  const resultado = await criarChaveNaApi(token, { nome: texto(form, 'nome'), escopos });
  if (!resultado.ok) return falhar('/admin/chaves', resultado);
  await guardarSenhaDeUmaVez(texto(form, 'nome'), resultado.dados.chave, 'chaves');
  redirect('/admin/chaves?criada=1');
}

export async function acaoRevogarChave(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await revogarChaveNaApi(token, texto(form, 'chaveId'), texto(form, 'motivo'));
  if (!resultado.ok) return falhar('/admin/chaves', resultado);
  redirect('/admin/chaves?revogada=1');
}

/** Webhooks para terceiros (bloco 79). O segredo sai uma vez, como a chave. */
export async function acaoCadastrarWebhook(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const eventos = form.getAll('eventos').map((v) => String(v));
  const resultado = await cadastrarWebhookNaApi(token, {
    nome: texto(form, 'nome'),
    url: texto(form, 'url'),
    eventos,
  });
  if (!resultado.ok) return falhar('/admin/webhooks', resultado);
  await guardarSenhaDeUmaVez(texto(form, 'nome'), resultado.dados.segredo, 'webhooks');
  redirect('/admin/webhooks?criado=1');
}

export async function acaoDesligarWebhook(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await desligarWebhookNaApi(token, texto(form, 'endpointId'));
  if (!resultado.ok) return falhar('/admin/webhooks', resultado);
  redirect('/admin/webhooks?desligado=1');
}
