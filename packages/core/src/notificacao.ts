import { instantToLocal, localToInstant } from './zone.js';

/**
 * Quando avisar, e quando **não** avisar.
 *
 * Lógica pura: o relógio entra por parâmetro e o fuso vem da unidade, nunca do
 * processo. É o mesmo cuidado da grade — errar o fuso aqui manda lembrete às
 * quatro da manhã, e o número da barbearia é o que paga.
 *
 * O lembrete é o recurso de maior retorno do produto: a SPEC §1 abre dizendo
 * que barbearias que o implementam relatam **40% a 70% menos faltas**. Também é
 * o que mais rápido destrói a reputação de um número de WhatsApp se for feito
 * sem regra. Daí as quatro proteções deste arquivo.
 *
 * 1. **Janela de silêncio.** Nada entre 21h e 8h. Mensagem que cairia dentro
 *    dela é empurrada para as 8h — não descartada, porque o lembrete de amanhã
 *    ainda serve.
 *
 * 2. **Lembrete que chegaria depois da hora não é enviado.** Empurrar às cegas
 *    produziria "não esqueça do seu horário das 9h" às 10h. Pior que não
 *    lembrar: parece sistema quebrado, e o cliente deixa de confiar no próximo.
 *
 * 3. **Transacional ≠ promocional.** Confirmação e lembrete são o serviço que a
 *    pessoa contratou e ignoram opt-out de marketing. "Volte sempre" é
 *    promoção, respeita o opt-out e conta no teto.
 *
 * 4. **Teto por cliente.** Quatro por mês somando canais, só para promocional.
 *    Automação sem teto vira spam e queima o número (SPEC §4.11).
 */

export const TIPOS_DE_NOTIFICACAO = [
  'confirmacao',
  'lembrete_24h',
  'lembrete_2h',
  'sua_vez',
  'senha_de_acesso',
  'retorno',
  'link_atualizado',
] as const;
export type TipoDeNotificacao = (typeof TIPOS_DE_NOTIFICACAO)[number];

/**
 * O que cada `{{n}}` do template vira, por tipo de aviso — **em um lugar só**.
 *
 * A Meta preenche as variáveis por **posição**, não por nome: quem manda a
 * mensagem passa uma lista, e a primeira entra em `{{1}}`. Isso significa que a
 * ordem daqui e a ordem que o worker monta são a mesma coisa dita duas vezes, e
 * é o tipo de par que diverge sem nada ficar vermelho.
 *
 * Divergiu: a tela de cadastro do texto dizia que `{{2}}` era a hora e `{{3}}` o
 * profissional, e o worker mandava **nome do cliente e nome da barbearia**, dois
 * valores, para todo tipo. Quem escrevesse "seu corte é amanhã às {{2}}" mandava
 * ao cliente "seu corte é amanhã às Barbearia Matheus", e quem usasse `{{3}}`
 * não mandava nada — a Meta recusa quando a quantidade não bate.
 *
 * Pior: `quandoTexto` e `profissional` **já viajavam** dentro da mensagem de
 * agendamento e eram descartados na hora de montar as variáveis. O dado existia
 * e ninguém lia, que é o defeito da §6 pergunta 4.
 *
 * Por tipo e não uma lista só porque o template é por tipo: `{{2}}` no lembrete
 * e `{{2}}` na campanha são textos diferentes, aprovados em separado. O que não
 * pode variar é dentro do mesmo tipo.
 */
/**
 * O nome de cada aviso, como o produto o chama na tela.
 *
 * Mora aqui e não na tela porque **duas** telas o mostram desde o bloco 92 — a
 * de WhatsApp e a ficha do cliente —, e uma lista escrita ao lado é a que fica
 * para trás no primeiro aviso novo. É a mesma decisão dos públicos de campanha,
 * que viraram teste pelo mesmo motivo.
 */
/**
 * Os avisos que o **banco** conhece e este pacote ainda não.
 *
 * `notification_kind` tem `pedido_de_avaliacao` desde o bloco 46 e nenhum código
 * o usa — mas a semente cria a automação, e a tela mostrava "Pedido de
 * avaliacao", sem acento, porque o humanizador só troca sublinhado por espaço.
 *
 * Nomear aqui é mais honesto que acentuar por adivinhação: o humanizador
 * continua existindo para o valor que ninguém previu, e este mapa é onde se
 * escreve o nome de quem já se conhece.
 */
/**
 * Exportado para o teste poder provar que o exemplo dele **é** desconhecido.
 *
 * A guarda do caso genérico usava `pedido_de_avaliacao`, que era desconhecido
 * quando ela foi escrita e ganhou nome próprio aqui no bloco seguinte: o teste
 * ficou vermelho por ter sido corrigido o que ele cobria. Com os dois mapas à
 * mão ele afirma a ausência antes de afirmar a frase, e não volta a apodrecer.
 */
export const NOME_DO_QUE_O_BANCO_CONHECE: Readonly<Record<string, string>> = {
  pedido_de_avaliacao: 'Pedido de avaliação',
};

export const NOME_DO_AVISO: Readonly<Record<TipoDeNotificacao, string>> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
  link_atualizado: 'Novo link de agendamento',
};

/**
 * A maior posição de variável usada no corpo, que é o que a Meta conta.
 *
 * Posição e não ocorrência: um texto que usa `{{1}}` duas vezes pede **uma**
 * variável, e um que usa só `{{2}}` pede duas — a Meta preenche por índice.
 *
 * Mora no `core` porque é lógica pura sobre uma string, e porque quem precisa
 * dela agora são dois: o envio, que corta as variáveis pelo tamanho do texto
 * aprovado, e a submissão, que manda uma amostra por posição.
 */
export function variaveisDoCorpo(corpo: string): number {
  let maior = 0;
  for (const achado of corpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const posicao = Number(achado[1]);
    if (Number.isFinite(posicao) && posicao > maior) maior = posicao;
  }
  return maior;
}

/**
 * Um exemplo de cada variável, para a Meta analisar o texto (bloco 93).
 *
 * ## Por que isto existe
 *
 * A Meta **recusa** template cujas variáveis chegam sem amostra. A recusa vem
 * com o nome da política — *"Variáveis de modelo sem texto de amostra"* — e o
 * texto fica rejeitado sem nunca ter sido lido por ninguém: o produto mandava
 * `Olá {{1}}, é sua vez na fila para a {{2}}` e a Meta não tinha como saber se
 * `{{1}}` é um nome, um valor em reais ou um link.
 *
 * Aconteceu com o primeiro texto de verdade deste produto, e nada do nosso lado
 * apontava para isso: a submissão respondia sucesso, o estado virava `pendente`,
 * e a rejeição chegava depois pelo painel da Meta.
 *
 * ## Por que sai daqui, e casado com o significado
 *
 * A amostra precisa ser **plausível para aquela posição**: mandar "exemplo" nas
 * três faria a Meta analisar um texto que não se parece com o que vai sair, e é
 * pela verossimilhança que ela decide. Como o significado de cada posição já
 * mora em `VARIAVEIS_DO_AVISO`, a amostra é casada com ele — e uma variável nova
 * ali sem amostra aqui fica visível no `Record`, que o compilador cobra.
 *
 * Nomes inventados de propósito: a amostra vai para a Meta e não é cliente
 * nenhum. É o mesmo cuidado de não pôr dado pessoal em log.
 */
export const EXEMPLO_DA_VARIAVEL: Readonly<Record<string, string>> = {
  'o nome do cliente': 'Carlos',
  'o nome da barbearia': 'Barbearia Domari',
  'a hora do agendamento': 'terça-feira, 19 de agosto às 15:30',
  'o nome do profissional': 'Ruan',
};

/**
 * As amostras que acompanham um corpo, na ordem das posições que ele usa.
 *
 * Quem manda é o **corpo escrito**, não a lista do tipo: a barbearia pode
 * escrever um texto com uma variável só, e mandar três amostras para duas
 * posições é recusado pela Meta com a mesma cara de erro de conteúdo.
 */
export function exemplosDoCorpo(tipo: TipoDeNotificacao, corpo: string): readonly string[] {
  const quantas = variaveisDoCorpo(corpo);
  const significados = VARIAVEIS_DO_AVISO[tipo];
  return Array.from({ length: quantas }, (_, i) => {
    const qual = significados[i];
    return (qual ? EXEMPLO_DA_VARIAVEL[qual] : undefined) ?? 'exemplo';
  });
}

/**
 * O corpo como o **cliente vai ler**, com cada `{{n}}` já preenchido (bloco 96).
 *
 * A tela mostrava o texto cru — "Oi {{1}}, sentimos sua falta na {{2}}" — e
 * pedia que o balcão decidisse, em cima daquilo, se a mensagem estava boa. As
 * chaves duplas são vocabulário da Meta, não do produto: quem lê "{{1}}"
 * entende que falta alguma coisa, e a decisão que a tela pede é justamente
 * sobre o que **não** está faltando.
 *
 * Preenchido com as mesmas amostras que vão para a Meta, e não com um segundo
 * conjunto: se o exemplo da tela e o exemplo aprovado divergissem, o texto
 * conferido aqui não seria o texto submetido lá.
 *
 * Posição sem significado declarado vira `exemplo`, como em `exemplosDoCorpo` —
 * deixar `{{4}}` na frase seria a tela dizendo que sabe menos do que sabe.
 *
 * `tipo` como `string` pelo motivo de `nomeDoAviso`: quem chama é a tela, e o
 * tipo dela vem da API. Um `as` para calar o compilador esconderia justamente o
 * caso em que o banco tem um valor que este pacote ainda não conhece.
 */
export function corpoComExemplos(tipo: string, corpo: string): string {
  const significados =
    (VARIAVEIS_DO_AVISO as Record<string, readonly string[] | undefined>)[tipo] ?? [];
  return corpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (inteiro, digitos: string) => {
    const posicao = Number(digitos);
    if (!Number.isInteger(posicao) || posicao < 1) return inteiro;
    const qual = significados[posicao - 1];
    return (qual ? EXEMPLO_DA_VARIAVEL[qual] : undefined) ?? 'exemplo';
  });
}

/**
 * O nome do aviso a partir de um texto qualquer.
 *
 * A tela recebe o tipo como `string` — ele vem da API, do banco, de um campo de
 * formulário. Um `as` para calar o compilador aqui esconderia justamente o caso
 * que interessa: o tipo que chegou e que este mapa não conhece. Devolver o
 * próprio valor é o que a tela já fazia, agora com o compilador de acordo.
 */
export function nomeDoAviso(tipo: string): string {
  const conhecido =
    (NOME_DO_AVISO as Record<string, string | undefined>)[tipo] ??
    NOME_DO_QUE_O_BANCO_CONHECE[tipo];
  if (conhecido) return conhecido;
  /**
   * O que o produto não conhece vira frase, nunca identificador (bloco 96).
   *
   * `notification_kind` é enum do **banco** e é mais largo que a união deste
   * pacote — `pedido_de_avaliacao` está lá desde o bloco 46 e nenhum código o
   * usa. O painel mostrava a linha "manda pedido_de_avaliacao" para quem opera
   * o balcão: nome de coluna vazando para a tela, e a única pista que a pessoa
   * tinha de que aquela automação não manda nada.
   *
   * Humanizar não conserta a falta — quem responde por isso é a lacuna
   * declarada —, mas devolve o identificador ao lugar dele, que é o banco.
   */
  const frase = tipo.replace(/_/g, ' ').trim();
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

export const VARIAVEIS_DO_AVISO: Readonly<Record<TipoDeNotificacao, readonly string[]>> = {
  // Os três que falam de um horário marcado: é o que o cliente precisa ler.
  confirmacao: ['o nome do cliente', 'a hora do agendamento', 'o nome do profissional'],
  lembrete_24h: ['o nome do cliente', 'a hora do agendamento', 'o nome do profissional'],
  lembrete_2h: ['o nome do cliente', 'a hora do agendamento', 'o nome do profissional'],
  // A fila não tem hora nem profissional decidido: a pessoa está na barbearia
  // esperando, e o que importa é quem chama.
  sua_vez: ['o nome do cliente', 'o nome da barbearia'],
  senha_de_acesso: ['o nome do cliente', 'o nome da barbearia'],
  // Campanha e automação falam com quem não tem horário marcado.
  retorno: ['o nome do cliente', 'o nome da barbearia'],
  /**
   * O link **não** é variável, e é decisão.
   *
   * Ele é o mesmo para todo mundo — é o endereço da barbearia, não algo por
   * pessoa —, então entra literal no corpo do template. Como variável ele
   * custaria uma posição a mais em toda mensagem para carregar sempre o mesmo
   * valor, e a Meta recusa quando a quantidade não bate.
   *
   * O custo é que trocar o endereço de novo exige um texto novo aprovado. É o
   * certo: este aviso existe para um endereço que mudou uma vez, e um template
   * cujo conteúdo muda sozinho é o que a Meta pausa.
   */
  link_atualizado: ['o nome do cliente', 'o nome da barbearia'],
};

export type NaturezaDaMensagem = 'transacional' | 'promocional';

/**
 * O que é serviço e o que é marketing.
 *
 * A separação decide quem pode recusar: ninguém "opta por não receber" a
 * confirmação do próprio agendamento — ela é parte do que foi contratado.
 * Tratar as duas coisas igual leva a um de dois erros, e os dois são caros:
 * mandar promoção para quem pediu para parar, ou deixar de avisar quem tem
 * hora marcada porque recusou promoção meses atrás.
 */
export function naturezaDe(tipo: TipoDeNotificacao): NaturezaDaMensagem {
  return tipo === 'retorno' ? 'promocional' : 'transacional';
}

/**
 * Os tipos que contam no teto do mês e na regra de uma por dia — **derivados**.
 *
 * Quem precisa deles é SQL: a consulta que conta quantas promocionais a pessoa
 * já recebeu. Escritos à mão lá dentro (`kind = 'retorno'`), eles seriam a
 * sétima lista paralela deste código, e a primeira a divergir seria a do dia em
 * que um tipo promocional novo entrasse — o teto deixaria de contá-lo sem nada
 * ficar vermelho.
 *
 * Derivar de `naturezaDe` também documenta o inverso: a consulta **não** pode
 * contar confirmação e lembrete. Antes do bloco 108 ela contava tudo, e em
 * produção — onde o lembrete de fato grava — quem tinha quatro agendamentos no
 * mês ficava barrado de receber qualquer promoção, por um teto que a tela
 * descreve como sendo de promoções.
 */
export const TIPOS_PROMOCIONAIS: readonly TipoDeNotificacao[] = TIPOS_DE_NOTIFICACAO.filter(
  (t) => naturezaDe(t) === 'promocional',
);

/**
 * A categoria que a Meta cobra, aprova e limita — derivada do **tipo**.
 *
 * ## Por que não sai mais dos botões
 *
 * A primeira versão respondia `UTILITY` quando havia botão e `MARKETING` quando
 * não havia. Botão é um bom palpite — o lembrete tem três, a campanha tem um —,
 * e é só um palpite: `sua_vez` não tem botão nenhum e é a mensagem mais
 * transacional que existe neste produto. Ela ia para a Meta declarada como
 * marketing.
 *
 * Não é detalhe de etiqueta. Marketing tem regra de aprovação mais dura, custa
 * diferente por mensagem, e é a categoria que a Meta limita quando o número é
 * novo — então declarar utilidade como promoção é reprovar mais, pagar mais e
 * mandar menos, tudo ao mesmo tempo.
 *
 * ## Por que da natureza, e não de um campo no formulário
 *
 * `naturezaDe` já decide quem respeita opt-out e quem conta no teto do mês, e a
 * Meta separa as duas coisas pelo mesmo critério. Duas fontes para a mesma
 * pergunta divergiriam no primeiro aviso novo — e a divergência apareceria como
 * texto reprovado sem explicação, que é o defeito que este bloco veio consertar.
 *
 * Um seletor na tela seria pior ainda: a Meta **recategoriza** o que ela discorda,
 * e a barbearia estaria escolhendo um campo que não decide nada e que a faz
 * pagar mais quando escolhe errado.
 *
 * ## Sobre `AUTHENTICATION`
 *
 * A Meta tem uma terceira categoria, e `senha_de_acesso` seria dela. Não é usada
 * de propósito: template de autenticação tem formato fechado — corpo fixo, botão
 * de copiar código, nada de texto livre —, e o nosso é escrito pela barbearia.
 * Declará-lo assim seria recusa garantida. `UTILITY` é o que ele de fato é do
 * ponto de vista de quem recebe, e fica escrito aqui para ninguém "consertar"
 * isto depois sem saber o que custa.
 */
export type CategoriaDoTemplate = 'UTILITY' | 'MARKETING';

export function categoriaDoAviso(tipo: TipoDeNotificacao): CategoriaDoTemplate {
  return naturezaDe(tipo) === 'promocional' ? 'MARKETING' : 'UTILITY';
}

/**
 * Os tipos que uma **campanha** pode usar (bloco 82).
 *
 * Uma campanha é marketing por construção: é o dono escolhendo um público e
 * mandando mensagem para ele hoje. Deixar o formulário oferecer os seis tipos
 * fazia duas coisas erradas ao mesmo tempo, e a revisão de segurança achou as
 * duas na mesma linha:
 *
 * - **Furava o opt-out.** `naturezaDe` chama de transacional tudo que não é
 *   `retorno`, e a checagem de consentimento e o teto do mês só rodam sobre
 *   promocional. Uma campanha com `lembrete_24h` mandava para a base inteira,
 *   incluindo quem revogou o consentimento — o `customer_consents` inteiro
 *   contornado por um seletor. E nenhum teste podia pegar isso: todos fixavam
 *   `retorno`, que é justamente o único gated.
 * - **Mentia no texto.** "Seu horário é amanhã" para quem não tem horário
 *   marcado, "sua vez chegou" para quem não está na fila, e a senha de
 *   primeiro acesso — que é credencial — como peça de marketing.
 *
 * A lista tem um item só hoje, e isso é a verdade do produto, não uma
 * limitação escondida: existe um template de campanha. Quando houver um
 * segundo, ele entra aqui **e** em `naturezaDe`, junto.
 */
/**
 * `link_atualizado` entra aqui, e **não** entra em `naturezaDe`.
 *
 * A distinção decide duas coisas diferentes, e é o que torna este aviso barato
 * sem afrouxar nada:
 *
 * - **Categoria na Meta** sai de `naturezaDe`. Transacional vira `UTILITY`, que
 *   custa cerca de um oitavo de `MARKETING` — mandar "seu link mudou" como
 *   convite de retorno seria pagar preço de promoção por um recado operacional.
 * - **Quem pode recusar** também sai de `naturezaDe`, e por isso o disparo de
 *   campanha **não** o consulta: ele fixa `natureza: 'promocional'`, de propósito
 *   e por achado de revisão de segurança. Este aviso continua passando por
 *   consentimento de marketing e pelo teto do mês.
 *
 * É deliberadamente conservador. Um recado sobre o endereço de agendamento tem
 * argumento para ser operacional — mas quem revogou marketing e não tem horário
 * marcado não pediu para receber nada, e afrouxar a trava que a revisão instalou
 * para ganhar alcance numa campanha é a troca errada. Se a barbearia precisar
 * alcançar quem optou por não receber, o caminho é o aviso transacional que ela
 * já manda para quem tem horário — não a campanha.
 *
 * A ordem importa: `TIPO_PADRAO_DE_CAMPANHA` é `[0]`, e `retorno` continua sendo
 * o padrão de quem não escolhe.
 */
export const TIPOS_DE_CAMPANHA = ['retorno', 'link_atualizado'] as const;
export type TipoDeCampanha = (typeof TIPOS_DE_CAMPANHA)[number];

/**
 * O tipo que vale quando a tela não perguntou.
 *
 * Hoje a lista tem um item só, e o seletor de uma opção só nem é desenhado —
 * então a ação precisa de um valor. Escrito `'retorno'` à mão em dois lugares
 * (era assim), ele fica para trás no dia em que a lista tiver o segundo: a tela
 * ofereceria dois e a ação continuaria mandando o primeiro. Derivado da lista,
 * o padrão acompanha.
 */
export const TIPO_PADRAO_DE_CAMPANHA: TipoDeCampanha = TIPOS_DE_CAMPANHA[0];

/**
 * Por que uma tela não tem texto para oferecer (bloco 132).
 *
 * São **dois zeros diferentes**, e as três telas que ofereciam texto escreviam
 * a mesma frase para os dois: *"Nenhum texto aprovado"*. A barbearia tinha dois
 * textos aprovados pela Meta — `sua_vez` e o lembrete de 2h —, leu isso, foi ao
 * painel da Meta conferir, viu os dois lá e concluiu que o produto estava
 * quebrado. Nada estava: nenhum dos dois é de campanha, e campanha é o único
 * tipo que faz sentido mandar a quem **não tem horário marcado**.
 *
 * É um estado vazio que não diz o porquê — o indicador sempre `—` com outra
 * roupa —, e é a §6 pergunta 6 entre esta tela e a da Meta.
 *
 * A união é quem cobra a frase: `Record<FaltaDeTexto, …>` na tela faz o
 * compilador pedir o texto do caso novo, e um `??` genérico é justamente o que
 * deixou as três dizendo a mesma coisa. Devolve `null` quando não falta nada —
 * quem tem texto não tem estado vazio para escrever.
 */
export type FaltaDeTexto = 'nada_aprovado' | 'nenhum_do_tipo';

export function faltaDeTexto(aprovados: number, doTipo: number): FaltaDeTexto | null {
  if (doTipo > 0) return null;
  return aprovados > 0 ? 'nenhum_do_tipo' : 'nada_aprovado';
}

/**
 * Os tipos que uma tela de campanha aceita, por extenso.
 *
 * A frase do vazio precisa nomeá-los, e nomeá-los à mão faria o tipo novo em
 * `TIPOS_DE_CAMPANHA` ficar fora dela sem nada ficar vermelho. `separador` é
 * "e" numa lista do que sai e "ou" numa lista do que faltou.
 */
export function tiposDeCampanhaPorExtenso(separador: 'e' | 'ou'): string {
  return TIPOS_DE_CAMPANHA.map((tipo) => nomeDoAviso(tipo)).join(` ${separador} `);
}

export function tipoDeCampanhaValido(tipo: string): tipo is TipoDeCampanha {
  return (TIPOS_DE_CAMPANHA as readonly string[]).includes(tipo);
}

/** Antecedência de cada lembrete, em minutos. */
export const ANTECEDENCIA: Readonly<Partial<Record<TipoDeNotificacao, number>>> = {
  lembrete_24h: 24 * 60,
  lembrete_2h: 2 * 60,
};

export const SILENCIO_COMECA_MINUTO = 21 * 60;
export const SILENCIO_TERMINA_MINUTO = 8 * 60;

/** Teto mensal de mensagens promocionais por cliente (SPEC §4.11). */
export const TETO_PROMOCIONAL_MES = 4;

/**
 * Empurra para fora da janela de silêncio, se preciso.
 *
 * Antes das 8h: mesma manhã. Depois das 21h: manhã seguinte. O horário local
 * sai do fuso **da unidade** — o cliente pode estar viajando, e o que importa é
 * a hora civil de onde a barbearia está, que é a hora que ele associa ao corte.
 */
export function foraDoSilencio(instante: Date, timeZone: string): Date {
  const local = instantToLocal(timeZone, instante);

  if (local.minutes >= SILENCIO_TERMINA_MINUTO && local.minutes < SILENCIO_COMECA_MINUTO) {
    return instante;
  }

  if (local.minutes < SILENCIO_TERMINA_MINUTO) {
    return localToInstant(timeZone, local.date, SILENCIO_TERMINA_MINUTO);
  }

  // Depois das 21h: as 8h do dia seguinte.
  const [ano = 0, mes = 0, dia = 0] = local.date.split('-').map(Number);
  const amanha = new Date(Date.UTC(ano, mes - 1, dia + 1));
  return localToInstant(timeZone, amanha.toISOString().slice(0, 10), SILENCIO_TERMINA_MINUTO);
}

export type MotivoDeNaoEnviar =
  | 'ja_enviada'
  | 'passou_da_hora'
  | 'sem_telefone'
  | 'cancelado'
  | 'optou_por_nao_receber'
  | 'teto_do_mes'
  | 'entrega_incerta';

export interface DecisaoDeEnvio {
  readonly enviar: boolean;
  readonly quando: Date | null;
  readonly motivo: MotivoDeNaoEnviar | null;
}

const NAO = (motivo: MotivoDeNaoEnviar): DecisaoDeEnvio => ({
  enviar: false,
  quando: null,
  motivo,
});

/**
 * Quando (ou se) uma notificação de agendamento deve sair.
 *
 * Uma função só para as três decisões que costumam ficar espalhadas: se ainda
 * faz sentido, se o cliente aceita, e a que horas. Espalhadas, cada nova
 * mensagem reimplementa duas delas e esquece a terceira.
 */
export function decidirEnvioDeAgendamento(params: {
  readonly tipo: TipoDeNotificacao;
  /** Início do atendimento, em instante. */
  readonly comecaEm: Date;
  readonly timeZone: string;
  readonly agora: Date;
  readonly temTelefone: boolean;
  /** Status terminal (cancelado, falta) desliga o lembrete. */
  readonly aindaVale: boolean;
  readonly jaEnviada: boolean;
  readonly aceitaPromocional?: boolean;
  readonly promocionaisNoMes?: number;
}): DecisaoDeEnvio {
  if (params.jaEnviada) return NAO('ja_enviada');
  if (!params.temTelefone) return NAO('sem_telefone');
  if (!params.aindaVale) return NAO('cancelado');

  if (naturezaDe(params.tipo) === 'promocional') {
    if (params.aceitaPromocional === false) return NAO('optou_por_nao_receber');
    if ((params.promocionaisNoMes ?? 0) >= TETO_PROMOCIONAL_MES) return NAO('teto_do_mes');
  }

  const antecedencia = ANTECEDENCIA[params.tipo] ?? 0;
  /**
   * Sem antecedência, o alvo é **agora**, não a hora do corte.
   *
   * A confirmação é resposta a um fato que acabou de acontecer — a pessoa
   * marcou. Derivá-la de `comecaEm` a agendaria para o horário do próprio
   * atendimento, e o cliente receberia "seu horário está marcado" sentado na
   * cadeira. Foi o que a primeira versão fazia; o teste da madrugada pegou.
   */
  const alvo =
    antecedencia > 0
      ? new Date(params.comecaEm.getTime() - antecedencia * 60_000)
      : params.agora;

  /**
   * Lembrete cujo momento já passou não sai — não é remarcado para agora.
   *
   * Quem marcou às 22h para as 9h da manhã seguinte não recebe "faltam 24
   * horas": faltam onze. Empurrar a mensagem para o primeiro horário livre
   * entregaria o texto errado, e texto errado sobre horário é o que faz o
   * cliente parar de ler os próximos.
   *
   * A confirmação escapa porque ela **não** promete tempo: diz que está
   * marcado, e isso continua verdadeiro a qualquer distância do corte.
   */
  if (antecedencia > 0 && alvo < params.agora) return NAO('passou_da_hora');

  const quando = foraDoSilencio(alvo < params.agora ? params.agora : alvo, params.timeZone);

  // E o que a janela de silêncio empurrou para depois da hora também não sai:
  // "não esqueça das 8h" às 8h em ponto é constrangedor, não útil.
  if (antecedencia > 0 && quando >= params.comecaEm) return NAO('passou_da_hora');

  return { enviar: true, quando, motivo: null };
}

/**
 * A mensagem de retorno: o cliente sumiu.
 *
 * O intervalo sai do ciclo da própria pessoa quando ele é conhecido, e do
 * padrão da barbearia quando não é — mandar "sentimos sua falta" com trinta
 * dias para quem corta de dois em dois meses é a forma mais rápida de virar
 * ruído. O ciclo individual por histórico é do bloco 61; aqui entra o número
 * que a barbearia configurou.
 */
export function decidirRetorno(params: {
  readonly ultimaVisita: Date | null;
  readonly diasParaRetorno: number;
  readonly agora: Date;
  readonly timeZone: string;
  readonly temTelefone: boolean;
  readonly aceitaPromocional: boolean;
  readonly promocionaisNoMes: number;
  readonly jaEnviada: boolean;
}): DecisaoDeEnvio {
  if (params.jaEnviada) return NAO('ja_enviada');
  if (!params.temTelefone) return NAO('sem_telefone');
  if (!params.aceitaPromocional) return NAO('optou_por_nao_receber');
  if (params.promocionaisNoMes >= TETO_PROMOCIONAL_MES) return NAO('teto_do_mes');
  // Nunca veio: não é retorno, é aquisição — e aquisição é outra conversa.
  if (!params.ultimaVisita) return NAO('cancelado');

  const vence = new Date(
    params.ultimaVisita.getTime() + params.diasParaRetorno * 24 * 60 * 60_000,
  );
  if (vence > params.agora) return NAO('passou_da_hora');

  return { enviar: true, quando: foraDoSilencio(params.agora, params.timeZone), motivo: null };
}

/**
 * A chave que impede mandar duas vezes.
 *
 * Entrega duplicada de um evento não pode virar duas mensagens (CLAUDE.md §2).
 * A chave é determinística e é o índice único do banco que a faz valer — não
 * uma consulta antes de inserir, que tem janela de corrida.
 */
export const chaveDaNotificacao = (
  tipo: TipoDeNotificacao,
  alvoId: string,
): string => `${tipo}:${alvoId}`;
