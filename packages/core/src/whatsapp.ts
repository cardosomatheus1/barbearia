/**
 * WhatsApp oficial — o contrato (bloco 55, SPEC §4.12).
 *
 * O motor de aviso existe desde o bloco 20 e sempre mandou por uma abstração.
 * Este arquivo é o contrato do canal de verdade, e a decisão que ele carrega
 * está na SPEC em letras: **número verificado da barbearia, não da plataforma**.
 *
 * ## Por que o número é dela
 *
 * A mensagem que chega de um número desconhecido é a que o cliente ignora ou
 * bloqueia. O número da barbearia ele já tem na agenda — é para onde ele liga
 * quando quer remarcar. O custo dessa escolha é real e não se esconde: a
 * barbearia precisa criar o portfólio na Meta, conectar a WABA e **confirmar a
 * posse do número** por código de SMS. Por isso o estado do cadastro é
 * explícito, e a barbearia opera sem ele.
 *
 * ## O que **não** é exigido para começar
 *
 * *Business Verification* — razão social, endereço, documentos da empresa — não
 * entra no caminho de quem está se cadastrando. Uma conta nova já manda para
 * clientes de verdade, com **teto de 250 destinatários únicos por dia** em
 * conversa iniciada pela casa; o teto sobe para 2.000 e além conforme o volume
 * entregue, e é só aí que a verificação documental pode ser cobrada.
 *
 * Isto é decisão de produto e não trivia: 250 por dia é folgado para uma
 * barbearia — a campanha maior que este produto monta é a base inteira, e uma
 * base de barbearia de bairro tem centenas, não milhares. A consequência é que
 * o onboarding do canal cabe numa tarde, e a tela precisa dizer isso em vez de
 * mandar esperar.
 *
 * ## Cloud API direto
 *
 * Sem BSP no meio: um intermediário a menos no caminho do dado do cliente, e a
 * conta é com a Meta. O que se paga por isso é a burocracia ficar visível — e é
 * a tela que precisa guiar, não esconder.
 *
 * ## Por que template é cadastro e não string
 *
 * A Meta aprova cada texto, leva de minutos a dias, recusa, e **pausa** o que já
 * tinha aprovado quando o índice de qualidade cai. Um texto no código estaria
 * certo hoje e errado no dia em que a Meta pedisse mudança — e não haveria onde
 * ler "por que a mensagem parou de sair".
 */

import type { TipoDeNotificacao } from './notificacao.js';

// ---------------------------------------------------------------------------
// O estado do cadastro
// ---------------------------------------------------------------------------

export const ESTADOS_DO_WHATSAPP = [
  'nao_configurado',
  'aguardando_verificacao',
  'ativo',
  'suspenso',
] as const;
export type EstadoDoWhatsApp = (typeof ESTADOS_DO_WHATSAPP)[number];

export const ROTULO_DO_WHATSAPP: Readonly<Record<EstadoDoWhatsApp, string>> = {
  nao_configurado: 'Não configurado',
  /**
   * "Falta confirmar o número", e não "Na Meta" (bloco 83).
   *
   * O rótulo antigo dizia onde a coisa estava, e isso soava como espera. O que
   * este estado significa é que **a pessoa tem um passo a dar** — digitar o
   * código do SMS —, e o título da seção é a primeira coisa que ela lê. Ele
   * contradizia a explicação logo abaixo, que já foi corrigida neste bloco.
   */
  aguardando_verificacao: 'Falta confirmar o número',
  ativo: 'Ativo',
  suspenso: 'Suspenso',
};

/**
 * O que a tela diz sobre cada estado.
 *
 * Quatro estados e não um booleano porque cada um pede uma coisa diferente de
 * quem opera: começar, esperar, nada, ou resolver com a Meta. "WhatsApp: não"
 * serviria para três deles e não diria o que fazer em nenhum.
 */
export const EXPLICACAO_DO_WHATSAPP: Readonly<Record<EstadoDoWhatsApp, string>> = {
  nao_configurado:
    'Os avisos saem pelo canal antigo. Cadastre o número para eles saírem pelo WhatsApp da casa.',
  /**
   * O que falta é **confirmar o número**, não esperar pela Meta.
   *
   * Até o bloco 82 esta frase dizia "a Meta está verificando a empresa, ela
   * avisa por e-mail" — e isso mandava a barbearia sentar e esperar. A
   * verificação de empresa (*Business Verification*) deixou de ser exigida para
   * começar a mandar mensagem: o que falta neste estado é a pessoa confirmar a
   * posse do número com o código que chega por SMS ou ligação, que ela faz
   * agora e sozinha.
   *
   * Frase que manda esperar sobre um passo que é para fazer é a pior classe de
   * texto de interface: ela não erra um número, ela para o trabalho.
   */
  aguardando_verificacao:
    'Falta confirmar o número no painel da Meta: ela manda um código por SMS ou ligação, e é você quem digita. Leva um minuto — não é preciso esperar aprovação nenhuma.',
  ativo: 'Os avisos saem pelo número da barbearia.',
  suspenso: 'A Meta suspendeu o número. O motivo está abaixo — os avisos voltaram ao canal antigo.',
};

/** Dá para mandar mensagem agora? */
export function whatsappDisponivel(estado: EstadoDoWhatsApp): boolean {
  return estado === 'ativo';
}

// ---------------------------------------------------------------------------
// O que o token concedido pode
// ---------------------------------------------------------------------------

/**
 * As duas permissões da Meta que este produto pede, como ela as nomeia.
 *
 * Elas fazem coisas diferentes e são concedidas em separado: a de envio manda
 * mensagem, a de gerência **nomeia a conta e cria template**. O produto se
 * contenta com a primeira para descobrir a qual conta o token pertence, e é
 * por isso que existe conexão que funciona inteira e não aprova texto nenhum.
 */
export const ESCOPO_DE_ENVIO = 'whatsapp_business_messaging';
export const ESCOPO_DE_GERENCIA = 'whatsapp_business_management';

/**
 * O token concedido cria modelo de mensagem?
 *
 * Três respostas e não duas, e a terceira é o bloco inteiro: **`null` é "não dá
 * para dizer", nunca "não pode"**.
 *
 * Cadastro pelo formulário do bloco 55 não passa pela Meta e não tem escopo
 * para gravar; cadastro anterior ao bloco 88 tampouco. Se a ausência virasse
 * `false`, a tela acusaria de falta de acesso justamente quem está com o acesso
 * funcionando — e a acusação sairia como aviso sobre um cadastro que manda
 * mensagem sem reclamar.
 *
 * É a distinção que o score do bloco 61 já precisou fazer: numa tela, "não sei"
 * e "zero" se parecem e levam a decisões opostas.
 */
export function podeGerenciarTemplates(escopos: readonly string[] | null): boolean | null {
  if (escopos === null) return null;
  return escopos.includes(ESCOPO_DE_GERENCIA);
}

/**
 * O aviso que a tela dá **antes** de a pessoa escrever o texto.
 *
 * A frase da Meta para este caso — "esta conta não pode criar um novo modelo" —
 * chega depois do trabalho todo e não nomeia permissão nenhuma. `O_QUE_FAZER_NA_META`
 * a traduz para "onde se resolve"; isto é um passo antes: o cadastro **já sabe**
 * que vai dar errado, e deixar a pessoa escrever mesmo assim é gastar o tempo
 * dela para chegar a uma recusa previsível.
 */
export const AVISO_SEM_GERENCIA =
  'Este acesso manda mensagem, mas não cria texto novo: a Meta concedeu só a ' +
  'permissão de envio. Reconecte o número e, na janela dela, deixe marcada ' +
  'também a permissão de gerenciar a conta — os textos que já estão aprovados ' +
  'continuam saindo normalmente.';

// ---------------------------------------------------------------------------
// O estado do template
// ---------------------------------------------------------------------------

export const ESTADOS_DO_TEMPLATE = [
  'rascunho',
  'pendente',
  'aprovado',
  'rejeitado',
  'pausado',
] as const;
export type EstadoDoTemplate = (typeof ESTADOS_DO_TEMPLATE)[number];

/**
 * O que fazer diante de uma recusa da Meta, por frase dela.
 *
 * A frase dela já aparece na tela desde o bloco 87, e foi o que destravou três
 * diagnósticos seguidos. Só que ela responde "o quê" e não "onde se resolve" —
 * e a resposta mora em painel de terceiro, com dezenas de telas.
 *
 * É a mesma decisão da lista de perguntas sem resposta do bloco 66: lista de
 * trabalho diz onde se resolve, senão é a lista que ninguém abre duas vezes.
 *
 * Casamento por trecho e não por código numérico: a Meta reusa o `code: 100`
 * para quase tudo, e é a frase que distingue. Trecho e não igualdade porque ela
 * traduz a mensagem para o idioma da conta e muda a redação sem avisar — o que
 * não casa continua mostrando a frase crua, que é o comportamento de antes.
 */
export const O_QUE_FAZER_NA_META: readonly {
  readonly quando: readonly string[];
  readonly faca: string;
}[] = [
  {
    // "This WhatsApp Business Account cannot create a new template"
    quando: ['não pode criar um novo modelo', 'cannot create a new template'],
    faca:
      'A recusa é da conta, não do texto — reenviar não resolve. No Gerenciador ' +
      'da Meta, confira sob qual conta do WhatsApp o número está: conta de teste ' +
      'não cria texto novo, e conta com verificação de empresa pendente também ' +
      'costuma ficar bloqueada. Conecte o número sob uma conta de verdade e ' +
      'tente de novo.',
  },
  {
    quando: ['já foi usado', 'has been used'],
    faca: 'A conexão anterior deu certo. Recarregue a tela: o número já deve estar salvo.',
  },
  {
    quando: ['domínio', "isn't included in the app's domains"],
    faca:
      'O endereço de volta não está registrado no app da Meta. É configuração da ' +
      'plataforma, não da barbearia — avise o suporte.',
  },
  {
    quando: ['expirou', 'expired', 'session has expired'],
    faca: 'O código da Meta vale segundos. Toque em conectar de novo e siga sem parar no meio.',
  },
];

/** A orientação para uma frase da Meta, ou `null` quando ela não é conhecida. */
export function oQueFazerNaMeta(frase: string): string | null {
  const alvo = frase.toLowerCase();
  return O_QUE_FAZER_NA_META.find((r) => r.quando.some((t) => alvo.includes(t)))?.faca ?? null;
}

export const ROTULO_DO_TEMPLATE: Readonly<Record<EstadoDoTemplate, string>> = {
  rascunho: 'Rascunho',
  pendente: 'Na Meta',
  aprovado: 'Aprovado',
  rejeitado: 'Rejeitado',
  pausado: 'Pausado',
};

export const EXPLICACAO_DO_TEMPLATE: Readonly<Record<EstadoDoTemplate, string>> = {
  rascunho: 'Ainda não foi enviado para aprovação.',
  pendente: 'Enviado. A Meta costuma responder em minutos, às vezes em dias.',
  aprovado: 'Aprovado. É este texto que sai.',
  rejeitado: 'A Meta recusou. O motivo está abaixo — corrija o texto e envie de novo.',
  pausado:
    'A Meta pausou este texto porque muita gente marcou como spam ou bloqueou o número. Ele volta sozinho, e mandar menos é o que faz voltar.',
};

/**
 * Os quatro estados de uma mensagem que saiu, e é `core` quem os nomeia.
 *
 * A união vivia só em `packages/crm`, e a tela não tinha como falar deles — foi
 * por isso que o produto passou a chamar tudo de "enviada". É a regra do tipo
 * com o mesmo nome nos dois lados: uma declaração só, no domínio.
 */
export const ESTADOS_DA_MENSAGEM = ['enviada', 'entregue', 'lida', 'falhou'] as const;
export type EstadoDaMensagemEnviada = (typeof ESTADOS_DA_MENSAGEM)[number];

/**
 * O que a tela escreve sobre uma mensagem — rótulo e porquê, juntos.
 *
 * ## `enviada` não quer dizer que chegou
 *
 * A Cloud API responde `accepted` e devolve um `wamid`: isso é a Meta **aceitar
 * para entregar**, não entregar. Quem conta o desfecho é o webhook, minutos ou
 * segundos depois. O produto tratava as duas coisas como uma só — o banco
 * gravava `enviada`, a tela dizia "Mensagem enviada pelo WhatsApp da casa", e
 * pronto.
 *
 * Aconteceu em produção: quatro mensagens aceitas, nenhuma entregue,
 * `delivered_at` nulo nas quatro, e a recepção sem nada para olhar. Duas horas
 * de investigação para descobrir que o app não estava publicado — e que o
 * produto não tinha vocabulário para dizer o que sabia.
 *
 * Rótulo e explicação saem juntos pela razão do bloco 133: separados, o estado
 * novo faria os dois mapas divergirem, e a tela mostraria uma coisa ao lado da
 * outra.
 */
export const ESTADO_DA_MENSAGEM: Readonly<
  Record<EstadoDaMensagemEnviada, { readonly rotulo: string; readonly explicacao: string }>
> = {
  enviada: {
    rotulo: 'A caminho',
    explicacao:
      'A Meta aceitou para entregar. Ainda não confirmou que chegou no aparelho — costuma levar segundos.',
  },
  entregue: {
    rotulo: 'Entregue',
    explicacao: 'Chegou no WhatsApp do cliente.',
  },
  lida: {
    rotulo: 'Lida',
    explicacao: 'O cliente abriu a mensagem.',
  },
  falhou: {
    /**
     * Sem "o motivo está ao lado": a tela empilha, e no celular ele fica
     * embaixo. Frase que nomeia posição erra na primeira largura em que o
     * layout reflui — e o motivo da Meta é obrigatório por `CHECK` nesta
     * linha, então repetir que ele existe não acrescenta nada. O que falta a
     * quem lê é o que fazer com ele.
     */
    rotulo: 'Não chegou',
    explicacao:
      'A Meta recusou a entrega. Mandar de novo só adianta se o que ela apontou tiver mudado.',
  },
};

export function estadoDaMensagemNaTela(estado: string): {
  readonly rotulo: string;
  readonly explicacao: string;
} {
  const conhecido = (ESTADOS_DA_MENSAGEM as readonly string[]).includes(estado);
  /**
   * Estado que este mapa não conhece é gravado por uma versão mais nova, e a
   * tela precisa dizer alguma coisa. Devolver o código cru é honesto — o
   * silêncio, não.
   */
  return conhecido
    ? ESTADO_DA_MENSAGEM[estado as EstadoDaMensagemEnviada]
    : { rotulo: estado, explicacao: 'Estado desconhecido para esta versão da tela.' };
}

/**
 * O que a tela escreve sobre um texto — rótulo e porquê, na mesma conta.
 *
 * ## `pendente` passou a significar duas coisas (bloco 133)
 *
 * A ida à Meta virou tarefa de fila, então entre o clique e a Meta existe agora
 * um intervalo em que o texto está `pendente` e **não saiu daqui**. Com um mapa
 * só, a tela dizia "Enviado. A Meta costuma responder em minutos" sobre um
 * texto que a Meta nunca viu — e a barbearia ia procurar no painel dela um
 * texto que não estava lá. É o estado vazio que não diz o porquê, com outra
 * roupa.
 *
 * Rótulo e explicação saem **juntos** de propósito. Separados, o dia em que
 * alguém acrescentasse um estado deixaria os dois mapas divergirem — e a tela
 * mostraria "Na fila" ao lado de "a Meta costuma responder em minutos".
 *
 * `naFila` só vale sobre `pendente`: nos outros estados a Meta já respondeu, e
 * um texto aprovado não está esperando fila nenhuma.
 */
export function estadoDoTextoNaTela(
  estado: EstadoDoTemplate,
  naFila: boolean,
): { readonly rotulo: string; readonly explicacao: string } {
  if (estado === 'pendente' && naFila) {
    return {
      rotulo: 'Na fila',
      explicacao:
        'Na fila para a Meta. Sai em instantes — não precisa mandar de novo, e o estado muda sozinho aqui.',
    };
  }
  return { rotulo: ROTULO_DO_TEMPLATE[estado], explicacao: EXPLICACAO_DO_TEMPLATE[estado] };
}

/** Só o aprovado sai. Os outros quatro são etapas ou problemas. */
export function templateUtilizavel(estado: EstadoDoTemplate): boolean {
  return estado === 'aprovado';
}

// ---------------------------------------------------------------------------
// Os botões
// ---------------------------------------------------------------------------

/**
 * O que o cliente pode tocar dentro da mensagem.
 *
 * A SPEC §4.12 chama isto de requisito e explica por quê numa frase que vale
 * ser repetida: *o botão de cancelar dentro da mensagem reduz falta **e** reduz
 * cancelamento tardio ao mesmo tempo* — quem não precisa voltar ao site avisa
 * com antecedência em vez de simplesmente não aparecer.
 *
 * A lista é fechada porque cada botão é uma ação do domínio, não um texto: o
 * que volta da Meta é este identificador, e é ele que decide o que acontece.
 */
export const BOTOES_DA_MENSAGEM = [
  'confirmar',
  'remarcar',
  'cancelar',
  'agendar_novamente',
  /**
   * Sair da lista de promoções, pelo próprio botão (bloco 94).
   *
   * A Meta recomenda opt-out em texto de marketing, e o motivo é dela: quem não
   * acha como sair marca como spam, e spam derruba a qualidade do número — que
   * derruba **tudo**, lembrete de horário junto. O botão é mais barato que a
   * denúncia.
   *
   * É o único botão deste produto que age sem horário marcado, e por isso é o
   * único que um texto escrito pela barbearia pode carregar junto de
   * `agendar_novamente`. `confirmar` e `cancelar` precisam de um agendamento
   * provado, que uma campanha não tem.
   */
  'parar_de_receber',
] as const;
export type BotaoDaMensagem = (typeof BOTOES_DA_MENSAGEM)[number];

/**
 * O texto de cada botão, em `core` e não escrito na tela.
 *
 * Vocabulário de transição mora aqui (CLAUDE.md §6): o mesmo botão aparece no
 * template cadastrado, na mensagem que sai e no histórico que o balcão lê, e
 * "Cancelar" num lugar com "Desmarcar" no outro é o que faz a recepção achar
 * que são duas coisas.
 */
export const ROTULO_DO_BOTAO: Readonly<Record<BotaoDaMensagem, string>> = {
  confirmar: 'Confirmar',
  remarcar: 'Remarcar',
  cancelar: 'Cancelar',
  agendar_novamente: 'Agendar novamente',
  parar_de_receber: 'Parar de receber',
};

/**
 * O que acontece quando o cliente aperta, em português e na tela.
 *
 * Botão é a única parte da mensagem em que o cliente **age**, e quem monta o
 * texto precisa saber o que vai acontecer antes de oferecer. Sem isto a escolha
 * seria por adivinhação, e "Agendar novamente" pareceria marcar sozinho.
 */
export const EFEITO_DO_BOTAO: Readonly<Record<BotaoDaMensagem, string>> = {
  confirmar: 'a presença é confirmada na agenda, na hora',
  remarcar: 'a casa fica sabendo que a pessoa quer outro horário — quem remarca é ela, no site',
  cancelar: 'o horário é cancelado na agenda, na hora',
  agendar_novamente: 'abre a página de agendamento da barbearia',
  parar_de_receber: 'a pessoa sai da lista de promoções na hora, e fica registrado',
};

/**
 * Os botões que um texto escrito pela barbearia pode carregar.
 *
 * Os outros dois — confirmar e cancelar — mexem num **agendamento provado**, e
 * quem recebe uma campanha não tem horário marcado. Oferecê-los produziria a
 * pior combinação: o cliente aperta, o produto responde "o horário não é de
 * quem respondeu", e nada acontece sem que ninguém saiba por quê.
 */
/**
 * Quais botões cada aviso **pode** carregar, para a barbearia escolher.
 *
 * ## Por que agora dá para escolher, e antes não dava
 *
 * A regra deste repositório era categórica: botão sai do tipo, nunca do
 * formulário, porque *"o que a Meta aprova precisa ser o que o motor manda"*.
 * Ela existia por um mecanismo — o motor montava os botões de
 * `BOTOES_DO_AVISO` na hora do envio, e a Meta casa a resposta do cliente pela
 * **posição**: um texto aprovado com dois botões recebendo três do motor faria
 * o cliente apertar "Confirmar" e o produto entender "Cancelar".
 *
 * Esse mecanismo mudou no bloco 94: o motor lê os botões **da linha do
 * template**, que é o que a Meta aprovou. A divergência deixou de ser possível,
 * e com ela caiu o motivo de a escolha não existir.
 *
 * ## O que continua fechado, e por quê
 *
 * A lista por tipo, e não uma lista só. Confirmar, remarcar e cancelar mexem
 * num **agendamento provado**: num texto de campanha o cliente apertaria, o
 * produto responderia "o horário não é de quem respondeu", e nada aconteceria
 * sem que ninguém soubesse por quê.
 *
 * `sua_vez` e `senha_de_acesso` ficam sem nenhum, e é decisão: a primeira é a
 * pessoa já dentro da barbearia esperando a vez — não há o que confirmar —, e a
 * segunda é credencial, onde qualquer botão é superfície a mais.
 *
 * `BOTOES_DO_AVISO` continua sendo o **padrão** de cada aviso, e é o que sai
 * quando a barbearia não escolhe.
 */
export const BOTOES_POSSIVEIS: Readonly<Record<TipoDeNotificacao, readonly BotaoDaMensagem[]>> = {
  confirmacao: ['confirmar', 'remarcar', 'cancelar'],
  lembrete_24h: ['confirmar', 'remarcar', 'cancelar'],
  /**
   * "Remarcar" continua disponível aqui, e a tela **avisa** em vez de proibir.
   *
   * Duas horas antes não há grade para remanejar no mesmo dia, e oferecer
   * produz a frustração de tentar e não ter — o motivo escrito em
   * `BOTOES_DO_AVISO`, que é por isso que o padrão não o traz. Mas é opinião de
   * produto sobre o negócio de outra pessoa, e a barbearia que abre a agenda no
   * mesmo dia está certa em querê-lo. Proibir seria o produto sabendo mais que
   * o dono sobre a agenda dele.
   */
  lembrete_2h: ['confirmar', 'remarcar', 'cancelar'],
  sua_vez: [],
  senha_de_acesso: [],
  retorno: ['agendar_novamente', 'parar_de_receber'],
  /**
   * Só a saída, e nunca `agendar_novamente`.
   *
   * O motivo de `agendar_novamente` estar fora é o mesmo de `BOTOES_DO_AVISO`:
   * ele abre o agendamento pela conversa, e este aviso existe justamente porque
   * o caminho antigo mudou. Oferecê-lo seria a mensagem se contradizendo.
   *
   * `parar_de_receber` fica disponível — não por padrão, como em `retorno` —
   * porque este aviso sai por campanha, e campanha aqui passa por consentimento
   * de marketing: quem recebe precisa poder sair pela própria mensagem.
   */
  link_atualizado: ['parar_de_receber'],
};

/**
 * Os botões que este aviso desaconselha, com o motivo.
 *
 * Aviso e não recusa: a tela diz o que acontece e deixa decidir. Recusar seria
 * o produto opinando sobre a agenda de quem opera.
 */
export const RESSALVA_DO_BOTAO: Readonly<
  Partial<Record<TipoDeNotificacao, Partial<Record<BotaoDaMensagem, string>>>>
> = {
  lembrete_2h: {
    remarcar:
      'Duas horas antes costuma não haver grade para remanejar no mesmo dia — quem tenta e não '
      + 'acha horário fica mais frustrado que quem não recebeu a oferta.',
  },
};

/**
 * O rótulo de um botão a partir de um texto qualquer.
 *
 * A tela recebe o botão como `string` — ele vem do `jsonb` da linha, que é
 * `unknown` do lado de cá. Um `as` esconderia justamente o caso que interessa:
 * o botão gravado por uma versão anterior e que este mapa não conhece.
 */
export function rotuloDoBotao(botao: string): string {
  /**
   * Os dois mapas, porque a linha do template guarda os dois tipos juntos.
   *
   * `whatsapp_templates.buttons` é um arranjo de nomes, e desde o bloco 95 ele
   * mistura resposta rápida com os que levam a algum lugar. A tela não precisa
   * saber a diferença para escrever o nome; quem precisa é o envio, e lá o
   * filtro é por `botaoConhecido`.
   */
  const dos = ROTULO_DO_BOTAO as Record<string, string | undefined>;
  const levam = ROTULO_DO_BOTAO_QUE_LEVA as Record<string, string | undefined>;
  return dos[botao] ?? levam[botao] ?? botao;
}

/**
 * Os botões que **levam a algum lugar**, e não voltam como resposta (bloco 95).
 *
 * ## Os três tipos da Meta, e por que só um era usado
 *
 * Ela aceita `QUICK_REPLY` — que volta para nós como mensagem —, `URL` e
 * `PHONE_NUMBER`, que não voltam: o aparelho abre o navegador ou o discador e
 * pronto. O produto só usava o primeiro, e isso deixava de fora as duas coisas
 * que uma barbearia mais quer oferecer.
 *
 * ## O que isso conserta em `agendar_novamente`
 *
 * Aquele botão é resposta rápida, e o cliente que o aperta **não vai a lugar
 * nenhum**: o produto registra "quer agendar de novo" e a pessoa continua na
 * conversa, esperando algo acontecer. O comentário do executor já dizia por quê
 * — escolher horário exige ver a grade, e a mensagem não tem grade — e a
 * conclusão certa não era registrar a intenção: era **levar à grade**.
 *
 * `abrir_agenda` faz isso. `agendar_novamente` continua existindo para os
 * textos já aprovados com ele, e a tela recomenda o novo.
 *
 * ## Por que o endereço não é digitado
 *
 * Sai do slug da barbearia e do telefone da unidade, que o produto já tem. Um
 * campo livre seria um link que a barbearia digita errado uma vez e manda para
 * mil pessoas — e, pior, um lugar onde alguém cola um endereço que não é dela.
 */
export const BOTOES_QUE_LEVAM = ['abrir_agenda', 'ligar'] as const;
export type BotaoQueLeva = (typeof BOTOES_QUE_LEVAM)[number];

export const ROTULO_DO_BOTAO_QUE_LEVA: Readonly<Record<BotaoQueLeva, string>> = {
  abrir_agenda: 'Agendar',
  ligar: 'Ligar para a barbearia',
};

export const EFEITO_DO_BOTAO_QUE_LEVA: Readonly<Record<BotaoQueLeva, string>> = {
  abrir_agenda: 'abre a página de agendamento da barbearia no navegador do cliente',
  ligar: 'abre o discador do celular já com o número da barbearia',
};

export function botaoQueLevaConhecido(valor: string): valor is BotaoQueLeva {
  return (BOTOES_QUE_LEVAM as readonly string[]).includes(valor);
}

/**
 * O teto da Meta, e ele é por tipo.
 *
 * Três de resposta rápida, e no máximo um de link e um de ligação. Mandar mais
 * é recusa dela, e a recusa chega horas depois pelo painel — o formato de falha
 * que este produto já pagou caro duas vezes.
 */
export const TETO_DE_RESPOSTA_RAPIDA = 3;
export const TETO_DE_LINK = 1;
export const TETO_DE_LIGACAO = 1;

export function botaoConhecido(valor: string): valor is BotaoDaMensagem {
  return (BOTOES_DA_MENSAGEM as readonly string[]).includes(valor);
}

/**
 * Quais botões cada aviso leva.
 *
 * Derivado do tipo e não escolhido na tela: um lembrete com "Agendar novamente"
 * ofereceria marcar de novo a quem já tem hora marcada, e um retorno com
 * "Cancelar" ofereceria cancelar o que não existe. O template cadastrado na Meta
 * nasce com estes botões, e o que volta é conferido contra eles.
 */
export const BOTOES_DO_AVISO: Readonly<Record<TipoDeNotificacao, readonly BotaoDaMensagem[]>> = {
  confirmacao: ['confirmar', 'remarcar', 'cancelar'],
  lembrete_24h: ['confirmar', 'remarcar', 'cancelar'],
  // Duas horas antes, remarcar já não é oferta honesta: não há grade para
  // remanejar no mesmo dia, e oferecer produz a frustração de tentar e não ter.
  lembrete_2h: ['confirmar', 'cancelar'],
  sua_vez: [],
  senha_de_acesso: [],
  retorno: ['agendar_novamente'],
  /**
   * Nenhum, e o link vai no corpo.
   *
   * Os botões desta lista são **respostas rápidas**: o cliente aperta, a Meta
   * devolve o texto, e o motor casa com uma ação. Não existe botão de URL aqui,
   * e é o que este aviso pediria — então o endereço vai escrito no corpo, onde
   * o WhatsApp o transforma em link tocável de qualquer forma.
   *
   * `agendar_novamente` seria o candidato óbvio e está errado: ele abre o fluxo
   * de agendamento pela conversa, que passa pelo endereço **antigo** guardado no
   * histórico da pessoa — exatamente o que este aviso existe para substituir.
   */
  link_atualizado: [],
};

// ---------------------------------------------------------------------------
// O contrato do provedor
// ---------------------------------------------------------------------------

export interface TemplateParaAprovar {
  readonly nome: string;
  readonly idioma: string;
  readonly corpo: string;
  readonly botoes: readonly BotaoDaMensagem[];
  /**
   * Os botões que levam a algum lugar, com o destino já resolvido (bloco 95).
   *
   * O endereço e o telefone saem do cadastro da barbearia e chegam aqui
   * prontos: o provedor não sabe consultar banco, e um destino montado lá
   * dentro seria a segunda noção de "qual é a página desta casa".
   */
  readonly acoes?: readonly { readonly botao: BotaoQueLeva; readonly destino: string }[];
  /**
   * Qual aviso é, e existe para a **amostra** fazer sentido (bloco 93).
   *
   * A Meta recusa variável sem exemplo, e o exemplo precisa ser plausível para
   * aquela posição — `{{2}}` é a hora num lembrete e o nome da casa numa
   * campanha. Sem o tipo, a amostra seria genérica e o texto seria analisado
   * como algo que não se parece com o que vai sair.
   */
  readonly tipo: TipoDeNotificacao;
}

export interface RespostaDoTemplate {
  readonly metaId: string | null;
  readonly estado: EstadoDoTemplate;
  readonly motivoDaRecusa: string | null;
}

export interface MensagemParaEnviar {
  /** O telefone do destinatário, E.164. */
  readonly para: string;
  readonly template: string;
  readonly idioma: string;
  /** As variáveis posicionais do template, na ordem (`{{1}}`, `{{2}}`...). */
  readonly variaveis: readonly string[];
  /**
   * O que volta quando a pessoa toca cada botão.
   *
   * Carrega o id do agendamento junto do botão — a Meta devolve exatamente esta
   * string, e sem o id não haveria como saber **qual** horário cancelar. É o
   * mesmo desenho do token da vaga no bloco 39.
   */
  readonly respostas: readonly { readonly botao: BotaoDaMensagem; readonly payload: string }[];
}

export interface MensagemEnviada {
  /** O id da Meta (`wamid...`). É a chave da conciliação por webhook. */
  readonly wamid: string;
}

/**
 * A chamada de envio terminou sem prova de desfecho.
 *
 * Não significa que a mensagem falhou: timeout, reset de conexão ou uma
 * resposta 2xx sem `wamid` podem acontecer **depois** de a Meta já ter aceitado
 * o envio. Quem recebe este erro não deve disparar outra mensagem; deve manter
 * a intenção em estado incerto até reconciliação/decisão explícita.
 */
export class WhatsAppDeliveryUnknownError extends Error {
  constructor(mensagem = 'não foi possível confirmar se a mensagem saiu') {
    super(mensagem);
    this.name = 'WhatsAppDeliveryUnknownError';
  }
}

/**
 * O que a Meta responde sobre o número em si (bloco 90).
 *
 * `verificado` é a posse do número provada — a pessoa digitou no painel da Meta
 * o código que chegou por SMS. É o **único** fato que promove o cadastro a
 * `ativo`, e é por isso que ele é perguntado a ela em vez de deduzido daqui:
 * registrar o número e provar a posse dele são passos diferentes, e o segundo
 * acontece fora do produto, minutos ou horas depois.
 */
export interface EstadoDoNumero {
  readonly verificado: boolean;
  /** Como a Meta escreve o número. Nulo quando ela não devolve. */
  readonly numeroVisivel: string | null;
}

export interface WhatsAppProvider {
  /** Manda um template aprovado. É o único jeito de iniciar conversa. */
  enviar(mensagem: MensagemParaEnviar): Promise<MensagemEnviada>;
  /** Submete um texto para aprovação da Meta. */
  submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate>;
  /**
   * Reescreve um texto que a Meta **já conhece** (bloco 92).
   *
   * Criar e editar são endpoints diferentes do lado dela, e usar o de criar
   * sobre um nome que já existe é recusado — o que fazia corrigir uma vírgula
   * num texto aprovado ser impossível pela tela. O nome e o idioma não mudam na
   * edição: o que se reescreve é o corpo e os botões.
   */
  editarTemplate(metaId: string, template: TemplateParaAprovar): Promise<RespostaDoTemplate>;
  /** Pergunta em que pé está. A rede de segurança da conciliação. */
  consultarTemplate(nome: string, idioma: string): Promise<RespostaDoTemplate>;
  /** Pergunta se a posse do número já foi provada. */
  consultarNumero(): Promise<EstadoDoNumero>;
}

/**
 * O provedor de mentira, com estado controlável pelo teste.
 *
 * **`pendente` por padrão** ao submeter template, e não `aprovado`: é o estado
 * real de um template recém-enviado, e a aprovação leva de minutos a dias. Um
 * fake otimista faria a cadeia de conciliação — a fila perguntando, a tela
 * saindo de "na Meta" — nunca ser percorrida pelo caminho da vida real. É a
 * mesma decisão do `FakeFiscalProvider` e do `FakePaymentProvider`.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly enviadas: MensagemParaEnviar[] = [];
  readonly submetidos: TemplateParaAprovar[] = [];
  proximoEstadoDoTemplate: EstadoDoTemplate = 'pendente';
  proximaRecusa: string | null = null;
  /** Para provar o caminho de falha sem depender de rede fora do ar. */
  falharProxima = false;
  private contador = 0;

  async enviar(mensagem: MensagemParaEnviar): Promise<MensagemEnviada> {
    if (this.falharProxima) {
      this.falharProxima = false;
      throw new Error('WhatsApp indisponível');
    }
    this.enviadas.push(mensagem);
    this.contador += 1;
    return { wamid: `wamid.fake.${this.contador}` };
  }

  async submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    this.submetidos.push(template);
    return this.resposta(template.nome);
  }

  /** Editado vira submetido também: o que o teste confere é o texto que saiu. */
  async editarTemplate(_metaId: string, template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    this.editados.push(template);
    this.submetidos.push(template);
    return this.resposta(template.nome);
  }

  readonly editados: TemplateParaAprovar[] = [];

  async consultarTemplate(nome: string, _idioma: string): Promise<RespostaDoTemplate> {
    return this.resposta(nome);
  }

  /**
   * **Não verificado por padrão**, pela mesma razão do template `pendente`.
   *
   * É o estado real de um número recém-conectado: quem prova a posse é a pessoa
   * digitando no painel da Meta o código que chega por SMS, e isso acontece
   * depois. Um fake otimista faria a conciliação — a varredura perguntando, a
   * tela saindo de "falta confirmar" — nunca ser percorrida em teste nenhum.
   */
  numeroVerificado = false;

  async consultarNumero(): Promise<EstadoDoNumero> {
    return { verificado: this.numeroVerificado, numeroVisivel: null };
  }

  private resposta(nome: string): RespostaDoTemplate {
    return {
      metaId: `meta.${nome}`,
      estado: this.proximoEstadoDoTemplate,
      motivoDaRecusa: this.proximoEstadoDoTemplate === 'rejeitado' ? this.proximaRecusa : null,
    };
  }
}

// ---------------------------------------------------------------------------
// A resposta do cliente
// ---------------------------------------------------------------------------

/**
 * O que vem dentro do `payload` de um botão: a ação e o agendamento.
 *
 * Duas partes separadas por `:`, e o id é UUID — não sequencial, pelo mesmo
 * motivo de todo id público deste produto. A Meta devolve a string exatamente
 * como foi mandada, e ela viaja pelo aparelho do cliente: assumir que ela chega
 * intacta é o erro que este par de funções existe para não cometer.
 */
/**
 * `agendamentoId` é opcional desde o bloco 94, e é o que faz botão de campanha
 * existir.
 *
 * Enquanto ele era obrigatório, `enviarPeloWhatsApp` mandava **zero botões**
 * quando não havia agendamento — que é o caso de toda campanha, toda automação
 * e toda mensagem avulsa. O texto era aprovado com botão, a Meta o desenhava, e
 * o produto não mandava nenhum: a barbearia via o botão no cadastro e o cliente
 * não via botão nenhum.
 *
 * O separador continua sendo o primeiro `:`, então a metade vazia é lida como
 * ausência sem formato novo.
 */
export function montarPayload(
  botao: BotaoDaMensagem,
  agendamentoId: string | null = null,
): string {
  return `${botao}:${agendamentoId ?? ''}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lerPayload(
  payload: string | null | undefined,
): { readonly botao: BotaoDaMensagem; readonly agendamentoId: string | null } | null {
  if (!payload) return null;
  const corte = payload.indexOf(':');
  if (corte < 0) return null;
  const botao = payload.slice(0, corte);
  const agendamentoId = payload.slice(corte + 1);
  if (!botaoConhecido(botao)) return null;
  /**
   * Metade vazia é botão **sem** agendamento, e é legítimo desde o bloco 94:
   * "Parar de receber" e "Agendar novamente" numa campanha não falam de horário
   * nenhum.
   *
   * O que continua recusado é um id malformado — e quem manda mesmo é a RLS: um
   * UUID bem formado de outra barbearia passa por aqui e não passa pela
   * consulta.
   */
  if (agendamentoId === '') return { botao, agendamentoId: null };
  if (!UUID.test(agendamentoId)) return null;
  return { botao, agendamentoId };
}

