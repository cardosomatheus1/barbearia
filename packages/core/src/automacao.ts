/**
 * O motor de automação (bloco 56, SPEC §4.11).
 *
 * *"Motor baseado em eventos, não em listas estáticas."* A lista estática
 * envelhece no dia seguinte ao de ser montada, e quem a montou precisa lembrar
 * de montá-la de novo. O motor pergunta ao banco quem cruzou a condição hoje.
 *
 * ## O que este arquivo **não** faz
 *
 * Teto de mensagens, opt-out e janela de silêncio moram em `notificacao.ts`
 * desde o bloco 20. Aqui eles são **chamados**, nunca reescritos: duas regras de
 * silêncio no mesmo produto discordariam no primeiro ajuste, e a que estivesse
 * errada seria a que ninguém lembra que existe.
 *
 * A estrutura da SPEC é `gatilho → condição → atraso → canal → conteúdo →
 * objetivo`. As três primeiras são deste arquivo; canal e conteúdo saem do
 * template aprovado (bloco 55); o objetivo é medido depois, na atribuição.
 */

import { foraDoSilencio, naturezaDe, TETO_PROMOCIONAL_MES } from './notificacao.js';
import type { TipoDeNotificacao } from './notificacao.js';

// ---------------------------------------------------------------------------
// Gatilhos
// ---------------------------------------------------------------------------

export const GATILHOS = [
  'primeiro_atendimento',
  'aniversario',
  'sem_retorno',
  'assinatura_vencendo',
  'pacote_acabando',
  'cancelamento',
  'avaliacao_positiva',
  'avaliacao_negativa',
  'servico_realizado',
  'produto_comprado',
  'vaga_na_espera',
] as const;
export type Gatilho = (typeof GATILHOS)[number];

export const ROTULO_DO_GATILHO: Readonly<Record<Gatilho, string>> = {
  primeiro_atendimento: 'Primeiro atendimento',
  aniversario: 'Aniversário',
  sem_retorno: 'Sumiu há um tempo',
  assinatura_vencendo: 'Assinatura vencendo',
  pacote_acabando: 'Pacote acabando',
  cancelamento: 'Cancelou o horário',
  avaliacao_positiva: 'Avaliou bem',
  avaliacao_negativa: 'Avaliou mal',
  servico_realizado: 'Fez um serviço',
  produto_comprado: 'Comprou um produto',
  vaga_na_espera: 'Abriu vaga na lista de espera',
};

/**
 * O rótulo do número que cada gatilho pede, ou `null` quando ele não pede.
 *
 * O que muda entre gatilhos é o **rótulo**, não a forma — daí uma coluna só no
 * schema. Um gatilho que pedisse dois números precisaria de outra decisão, e ela
 * não existe porque nenhum pede.
 */
export const LIMIAR_DO_GATILHO: Readonly<Record<Gatilho, string | null>> = {
  primeiro_atendimento: null,
  aniversario: 'Quantos dias antes',
  sem_retorno: 'Depois de quantos dias sem vir',
  assinatura_vencendo: 'Quantos dias antes de vencer',
  pacote_acabando: 'Quando faltarem quantas unidades',
  cancelamento: null,
  avaliacao_positiva: 'A partir de quantas estrelas',
  avaliacao_negativa: 'Até quantas estrelas',
  servico_realizado: null,
  produto_comprado: null,
  vaga_na_espera: null,
};

/**
 * Os gatilhos que a varredura já sabe procurar.
 *
 * Mora em `core` e não na consulta porque é afirmação sobre o **domínio**, e
 * quem precisa dela é a tela: um gatilho na lista que nunca dispara faria a
 * barbearia ligá-lo e concluir que o produto está quebrado. Escondê-lo seria
 * pior — faria a SPEC §4.11 parecer entregue inteira.
 *
 * A lista cresce quando cada consulta entra, e a lacuna declara em qual bloco.
 */
export const GATILHOS_COM_VARREDURA: readonly Gatilho[] = [...GATILHOS];

export function gatilhoDispara(gatilho: Gatilho): boolean {
  return GATILHOS_COM_VARREDURA.includes(gatilho);
}

export function gatilhoPedeLimiar(gatilho: Gatilho): boolean {
  return LIMIAR_DO_GATILHO[gatilho] !== null;
}

// ---------------------------------------------------------------------------
// Objetivos
// ---------------------------------------------------------------------------

export const OBJETIVOS = ['agendamento', 'venda', 'avaliacao'] as const;
export type Objetivo = (typeof OBJETIVOS)[number];

export const ROTULO_DO_OBJETIVO: Readonly<Record<Objetivo, string>> = {
  agendamento: 'Gerar agendamento',
  venda: 'Gerar venda',
  avaliacao: 'Gerar avaliação',
};

export const JANELA_MAXIMA_DIAS = 90;
export const JANELA_PADRAO_DIAS = 7;

export type FalhaDaAutomacao =
  | 'nome_obrigatorio'
  | 'limiar_obrigatorio'
  | 'limiar_invalido'
  | 'janela_invalida'
  | 'atraso_invalido';

/**
 * A automação é montável?
 *
 * O limiar é **obrigatório quando o gatilho pede** — e é a validação que
 * importa: `sem_retorno` sem número não é uma automação incompleta, é uma que
 * dispara para a base inteira no primeiro dia. Ela passaria pela borda, pelo
 * banco e só apareceria na conta da Meta.
 */
export function validarAutomacao(params: {
  readonly nome: string;
  readonly gatilho: Gatilho;
  readonly limiar: number | null;
  readonly atrasoMinutos: number;
  readonly janelaDias: number;
}): FalhaDaAutomacao | null {
  if (params.nome.trim().length === 0) return 'nome_obrigatorio';
  if (gatilhoPedeLimiar(params.gatilho)) {
    if (params.limiar === null) return 'limiar_obrigatorio';
    if (params.limiar <= 0) return 'limiar_invalido';
  }
  if (params.atrasoMinutos < 0) return 'atraso_invalido';
  if (params.janelaDias < 1 || params.janelaDias > JANELA_MAXIMA_DIAS) return 'janela_invalida';
  return null;
}

export const EXPLICACAO_DA_FALHA: Readonly<Record<FalhaDaAutomacao, string>> = {
  nome_obrigatorio: 'Dê um nome para você reconhecer esta automação depois.',
  limiar_obrigatorio: 'Este gatilho precisa de um número — sem ele, ele dispara para todo mundo.',
  limiar_invalido: 'O número precisa ser maior que zero.',
  janela_invalida: `A janela do objetivo vai de 1 a ${JANELA_MAXIMA_DIAS} dias.`,
  atraso_invalido: 'O atraso não pode ser negativo.',
};

// ---------------------------------------------------------------------------
// A decisão de disparo
// ---------------------------------------------------------------------------

export type MotivoDeNaoDisparar =
  | 'automacao_desligada'
  | 'ja_disparou_por_este_fato'
  | 'ja_recebeu_hoje'
  | 'sem_telefone'
  | 'optou_por_nao_receber'
  | 'teto_do_mes';

export const EXPLICACAO_DE_NAO_DISPARAR: Readonly<Record<MotivoDeNaoDisparar, string>> = {
  automacao_desligada: 'A automação está desligada.',
  ja_disparou_por_este_fato: 'Esta pessoa já recebeu esta automação por este mesmo motivo.',
  ja_recebeu_hoje: 'Esta pessoa já recebeu uma automação hoje.',
  sem_telefone: 'Não há telefone no cadastro.',
  optou_por_nao_receber: 'A pessoa pediu para não receber promoção.',
  teto_do_mes: `Já foram ${TETO_PROMOCIONAL_MES} mensagens promocionais neste mês.`,
};

/**
 * Por que uma mensagem não saiu — **todos** os motivos que o produto escreve.
 *
 * Três colunas guardam motivo: `campaign_targets.skipped_reason`,
 * `automation_sends.skipped_reason` e `notifications.reason`. As duas primeiras
 * saem de `MotivoDeNaoDisparar`; a terceira, de `MotivoDeNaoEnviar` — e as duas
 * uniões existem no código, então este mapa é **derivado delas**, nunca uma
 * lista escrita ao lado.
 *
 * ## O que este mapa não tem, e por quê
 *
 * A primeira versão trazia `sem_consentimento`, `janela_de_silencio`,
 * `ainda_no_prazo` e `provedor_indisponivel`. **Nenhum dos quatro é escrito por
 * código nenhum**: dois vinham da semente de demonstração, que inventou valores
 * próprios, e dois de um mapa velho na tela de avisos que ninguém tinha
 * removido.
 *
 * Acomodá-los aqui foi o erro que a segunda volta deste bloco desfaz: ampliar o
 * vocabulário do domínio para caber dado fabricado faz o produto parecer capaz
 * de coisas que ele não faz — que é exatamente o que a semente já fazia. Quem
 * conserta a semente é a semente, e há guarda que a cobra.
 *
 * `fora_da_janela` fica: ele é escrito por `despacharCampanha`, e não é recusa —
 * é adiamento, por isso não está em `MotivoDeNaoDisparar`.
 */
const EXPLICACAO_DO_MOTIVO: Readonly<Record<string, string>> = {
  ...EXPLICACAO_DE_NAO_DISPARAR,
  fora_da_janela: 'Ficou para depois: entre 21h e 8h nada sai.',
  // Os de `MotivoDeNaoEnviar` que a decisão de disparo não tem.
  ja_enviada: 'Esta pessoa já tinha sido avisada.',
  passou_da_hora: 'A hora do aviso já tinha passado.',
  cancelado: 'O horário foi desmarcado.',
};

/**
 * A frase inteira, para uma linha por pessoa.
 *
 * `string` na entrada pelo motivo de `nomeDoAviso`: quem chama é a tela, e o
 * valor vem do banco. Motivo desconhecido é **humanizado**, nunca devolvido
 * cru e nunca descartado: a primeira versão jogava fora a informação que o
 * resumo ao lado mostrava, e a lista de "quem não recebeu" ficava mais vaga que
 * o número que levava até ela.
 */
export function explicacaoDoPulo(motivo: string): string {
  const conhecido = EXPLICACAO_DO_MOTIVO[motivo];
  if (conhecido) return conhecido;
  const frase = motivo.replace(/_/g, ' ').trim();
  return frase ? `${frase.charAt(0).toUpperCase()}${frase.slice(1)}.` : 'Não deu para mandar.';
}

/**
 * O mesmo motivo em duas palavras, para a contagem ao lado do número.
 *
 * A frase inteira serve para uma linha por pessoa; num resumo de quatro motivos
 * ela vira parágrafo, e parágrafo num cartão é o que ninguém lê.
 */
export const RESUMO_DO_PULO: Readonly<Record<string, string>> = {
  automacao_desligada: 'automação desligada',
  ja_disparou_por_este_fato: 'já recebeu por este motivo',
  ja_recebeu_hoje: 'já recebeu hoje',
  sem_telefone: 'sem telefone',
  optou_por_nao_receber: 'pediu para não receber',
  teto_do_mes: 'teto do mês',
  fora_da_janela: 'fora do horário',
  ja_enviada: 'já tinha sido avisado',
  passou_da_hora: 'a hora já tinha passado',
  cancelado: 'horário desmarcado',
};

export function resumoDoPulo(motivo: string): string {
  return RESUMO_DO_PULO[motivo] ?? motivo.replace(/_/g, ' ');
}

export interface DecisaoDeDisparo {
  readonly disparar: boolean;
  /** Quando mandar. Já sai fora da janela de silêncio, no fuso da unidade. */
  readonly quando: Date | null;
  readonly motivo: MotivoDeNaoDisparar | null;
}

/**
 * Esta automação dispara para esta pessoa agora?
 *
 * A ordem das perguntas é deliberada e vai do **fato** para a **pessoa**:
 * automação desligada e fato repetido não dizem nada sobre o cliente, e
 * respondê-las antes evita ler cadastro para concluir que nem havia disparo.
 *
 * `jaRecebeuHoje` vem antes do opt-out e do teto porque é a regra que a SPEC
 * escreve por último e que mais protege o número: cinco automações razoáveis
 * mandariam cinco mensagens na terça, cada uma correta sozinha, e o conjunto
 * sendo spam.
 *
 * O que **não** está aqui: o teto e o opt-out são lidos de `notificacao.ts`, com
 * os mesmos números do bloco 20. Uma segunda constante de teto neste arquivo
 * seria a forma mais rápida de o produto ter dois tetos discordando.
 */
export function decidirDisparo(params: {
  readonly ativa: boolean;
  readonly tipo: TipoDeNotificacao;
  readonly jaDisparouPorEsteFato: boolean;
  readonly jaRecebeuHoje: boolean;
  readonly temTelefone: boolean;
  readonly aceitaPromocional: boolean;
  readonly promocionaisNoMes: number;
  readonly atrasoMinutos: number;
  readonly fatoEm: Date;
  readonly agora: Date;
  readonly timeZone: string;
  /**
   * Força a natureza, em vez de derivá-la do tipo (bloco 82).
   *
   * A campanha passa `'promocional'` **sempre**, e é a camada que não depende
   * de a lista de tipos permitidos continuar certa: `naturezaDe` chama de
   * transacional tudo que não é `retorno`, então um tipo novo que alguém
   * acrescentasse a `TIPOS_DE_CAMPANHA` sem mexer em `naturezaDe` voltaria a
   * furar o opt-out em silêncio.
   *
   * Só aperta, nunca afrouxa: não existe caminho para declarar transacional o
   * que o tipo diz ser promoção — isso seria o interruptor que desliga o
   * consentimento, com outro nome.
   */
  readonly natureza?: 'promocional';
}): DecisaoDeDisparo {
  const nao = (motivo: MotivoDeNaoDisparar): DecisaoDeDisparo => ({
    disparar: false,
    quando: null,
    motivo,
  });

  if (!params.ativa) return nao('automacao_desligada');
  if (params.jaDisparouPorEsteFato) return nao('ja_disparou_por_este_fato');
  if (params.jaRecebeuHoje) return nao('ja_recebeu_hoje');
  if (!params.temTelefone) return nao('sem_telefone');

  /**
   * Transacional ignora opt-out e teto; promocional respeita os dois.
   *
   * A separação é do bloco 20 e vale igual aqui: ninguém "opta por não receber"
   * a confirmação do próprio agendamento. Uma automação de `servico_realizado`
   * que pergunta como foi o atendimento é transacional; "sentimos sua falta" é
   * promoção.
   */
  if (params.natureza === 'promocional' || naturezaDe(params.tipo) === 'promocional') {
    if (!params.aceitaPromocional) return nao('optou_por_nao_receber');
    if (params.promocionaisNoMes >= TETO_PROMOCIONAL_MES) return nao('teto_do_mes');
  }

  /**
   * O atraso conta do **fato**, não de agora.
   *
   * A varredura roda de hora em hora e pode achar um fato de trinta minutos
   * atrás. Contar de agora empurraria a mensagem de "duas horas depois do
   * corte" para duas horas depois da varredura — e o texto prometeria uma coisa
   * que já não é verdade.
   */
  const alvo = new Date(params.fatoEm.getTime() + params.atrasoMinutos * 60_000);
  const base = alvo < params.agora ? params.agora : alvo;

  return { disparar: true, quando: foraDoSilencio(base, params.timeZone), motivo: null };
}

/**
 * O fato, do jeito que ele é único.
 *
 * É o que impede a mesma automação de disparar de novo sobre o mesmo fato
 * quando a varredura roda outra vez — e ela roda de hora em hora. Aniversário é
 * por ano, porque ele volta; os outros são pelo id do que aconteceu.
 *
 * Mora em `core` e não na consulta porque a forma da chave **é** a regra: um
 * aniversário com chave de data faria a pessoa receber parabéns todo ano, e um
 * com chave de id faria receber uma vez na vida.
 */
export function chaveDoFato(params: {
  readonly gatilho: Gatilho;
  readonly referencia: string;
  readonly ano: number;
}): string {
  return params.gatilho === 'aniversario'
    ? `aniversario:${params.ano}`
    : `${params.gatilho}:${params.referencia}`;
}

/**
 * O objetivo foi alcançado por esta mensagem?
 *
 * Atribuição por janela: o fato conta se aconteceu **depois** do envio e
 * **dentro** da janela declarada. As duas pontas importam — sem a primeira, um
 * agendamento feito antes da mensagem seria creditado a ela; sem a segunda, a
 * automação levaria crédito por um corte de dois meses depois, que a pessoa
 * faria de qualquer jeito.
 *
 * É a mesma decisão da comparação de relatório: janela frouxa produz número que
 * parece resposta e não é.
 */
export function objetivoAlcancado(params: {
  readonly enviadaEm: Date;
  readonly fatoEm: Date;
  readonly janelaDias: number;
}): boolean {
  if (params.fatoEm < params.enviadaEm) return false;
  const limite = new Date(params.enviadaEm.getTime() + params.janelaDias * 86_400_000);
  return params.fatoEm <= limite;
}
