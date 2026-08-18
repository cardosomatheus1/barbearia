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
export const NOME_DO_AVISO: Readonly<Record<TipoDeNotificacao, string>> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
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
 * O nome do aviso a partir de um texto qualquer.
 *
 * A tela recebe o tipo como `string` — ele vem da API, do banco, de um campo de
 * formulário. Um `as` para calar o compilador aqui esconderia justamente o caso
 * que interessa: o tipo que chegou e que este mapa não conhece. Devolver o
 * próprio valor é o que a tela já fazia, agora com o compilador de acordo.
 */
export function nomeDoAviso(tipo: string): string {
  return (NOME_DO_AVISO as Record<string, string | undefined>)[tipo] ?? tipo;
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
export const TIPOS_DE_CAMPANHA = ['retorno'] as const;
export type TipoDeCampanha = (typeof TIPOS_DE_CAMPANHA)[number];

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
  | 'teto_do_mes';

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
