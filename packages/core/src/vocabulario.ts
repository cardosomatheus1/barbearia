import type { AppointmentStatus, AttendanceAction } from './attendance.js';
import type { Permissao } from './permissoes.js';

/**
 * Como o produto chama cada coisa — em um lugar só (correção de fluxo, depois do bloco 36).
 *
 * ## Por que isto existe
 *
 * A mesma transição tinha três nomes, em três telas do mesmo produto: o balcão
 * dizia **Iniciar**, o barbeiro dizia **Começar**, e a fila dizia **Sentou**.
 * "Concluir" e "Terminei" eram a mesma coisa. "Faltou", "Não veio" e "Não
 * apareceu" eram três botões, e o terceiro nem fazia o mesmo que os outros dois.
 *
 * Quando a recepção diz "já iniciei o Ruan" e o barbeiro procura "Começar" na
 * tela dele, o treinamento vira folclore — e ninguém consegue escrever um manual
 * para o produto porque o produto não tem um nome só para nada.
 *
 * ## Por que em `core` e não numa constante de tela
 *
 * Porque não é texto, é **decisão de negócio**: o nome de uma transição é o que
 * a barbearia inteira usa para falar dela, em voz alta, com o cliente na frente.
 * É o mesmo argumento de `fraseDoIntervalo` — e o oposto do rótulo decorativo,
 * que pode viver onde é usado.
 *
 * Há teste que reprova texto de transição escrito à mão na tela.
 *
 * ## O verbo é o que vai acontecer, não o nome do estado
 *
 * "Chegou" e não "check-in": quem opera descreve o cliente, não o sistema. E o
 * botão diz o que acontece **quando ele é apertado**, não como as coisas ficam
 * depois — a colisão entre os dois é o que fazia o operador apertar "Chegou" e
 * receber "Chegou" de volta como selo, sem saber se tinha funcionado.
 */

/** O que o botão faz. Presente do indicativo, na voz de quem opera. */
export const VERBO_DA_ACAO: Readonly<Record<AttendanceAction, string>> = {
  confirm: 'Confirmar',
  check_in: 'Marcar chegada',
  wait: 'Mandar esperar',
  start: 'Iniciar atendimento',
  complete: 'Encerrar atendimento',
  no_show: 'Marcar falta',
  undo_no_show: 'Desfazer falta',
  cancel: 'Cancelar',
};

/**
 * A versão curta, para onde não cabe a frase inteira.
 *
 * O cartão do barbeiro no celular tem uma coluna estreita, e "Encerrar
 * atendimento" quebra em duas linhas nos 360px. O verbo continua sendo o mesmo
 * — o que muda é quanto dele cabe —, e é por isso que os dois mapas vivem lado
 * a lado: separá-los é como eles voltam a divergir.
 */
export const VERBO_CURTO: Readonly<Record<AttendanceAction, string>> = {
  confirm: 'Confirmar',
  check_in: 'Chegou',
  wait: 'Esperar',
  start: 'Iniciar',
  complete: 'Encerrar',
  no_show: 'Faltou',
  undo_no_show: 'Não faltou',
  cancel: 'Cancelar',
};

/** Como o estado aparece na tela, para quem está no balcão. */
export const ROTULO_DO_ESTADO: Readonly<Record<AppointmentStatus, string>> = {
  pending: 'Marcado',
  confirmed: 'Confirmado',
  checked_in: 'Na espera',
  waiting: 'Na espera',
  in_progress: 'Na cadeira',
  completed: 'Atendido',
  cancelled_customer: 'Cancelado pelo cliente',
  cancelled_business: 'Cancelado pela casa',
  no_show: 'Faltou',
  rescheduled: 'Remarcado',
};

/**
 * V9 · significado visual dos estados.
 *
 * Cor não nomeia o estado; o rótulo continua sendo `ROTULO_DO_ESTADO`. Este
 * mapa só fecha o significado semântico para que a mesma situação não fique
 * verde numa tela, azul em outra e vermelha numa terceira.
 *
 * - success: concluído/confirmado/recebido;
 * - warning: pede atenção agora;
 * - danger: problema ou perda;
 * - neutral: estado informativo/inativo, sem urgência.
 *
 * Azul (`--color-accent`) fica reservado a ação, foco e navegação — não a
 * "estado bonito".
 */
export type TomSemantico = 'neutral' | 'success' | 'warning' | 'danger';

export const TOM_SEMANTICO_DO_ESTADO: Readonly<Record<AppointmentStatus, TomSemantico>> = {
  pending: 'neutral',
  confirmed: 'success',
  checked_in: 'warning',
  waiting: 'warning',
  in_progress: 'neutral',
  completed: 'success',
  cancelled_customer: 'danger',
  cancelled_business: 'danger',
  no_show: 'danger',
  rescheduled: 'neutral',
};


/**
 * `checked_in` e `waiting` compartilham o rótulo, e é decisão.
 *
 * Para quem opera são a mesma situação: a pessoa está no salão e ainda não
 * sentou. A diferença entre elas é interna — `waiting` é quem foi mandado
 * esperar porque a cadeira não estava livre — e mostrar "Chegou" e "Aguardando"
 * como coisas diferentes fazia o balcão procurar uma distinção que não muda
 * nada do que ele faz em seguida.
 *
 * Elas continuam separadas no domínio porque a fila e o tempo de espera contam
 * a partir de momentos diferentes.
 */

/**
 * Ações que tiram dinheiro da casa. Nunca em destaque, sempre distinguíveis.
 *
 * Mora aqui e não na tela porque a resposta é a mesma nas três telas que
 * mostram atendimento — e porque "qual botão é perigoso" é decisão de negócio,
 * não de layout.
 */
export const ACOES_PESADAS: ReadonlySet<AttendanceAction> = new Set(['no_show', 'cancel']);

/**
 * A permissão que **cada** ação do painel exige, além de `appointments.attend`.
 *
 * Mora aqui, e é um mapa, porque a guarda escrita à mão no controller cobria
 * uma ação só. `cancel` passou a exigir `appointments.cancel` no bloco 118 —
 * e `no_show`, que a `ACOES_PESADAS` logo acima já nomeia como igualmente
 * pesada, ficou de fora: ela abre exatamente os mesmos estados, libera a mesma
 * cadeira e ainda **pune** o cliente na confiabilidade, que o cancelamento
 * feito pela casa não faz. Uma guarda que vale num caminho e não no vizinho é
 * a porta dos fundos que a convenção do bloco 60 descreve.
 *
 * `no_show` continua sob `appointments.attend`, e isso é decisão escrita, não
 * omissão: marcar falta é **registrar o que aconteceu no balcão**, que é o que
 * `appointments.attend` significa — tirá-la da recepção seria tirar a metade
 * do painel de quem passa o dia nele. Quem quiser separá-las ganha a linha
 * neste mapa, e o controller passa a cobrar sem precisar lembrar dele.
 *
 * O mapa é total no tipo de propósito: ação nova sem entrada não compila, e o
 * compilador é quem cobra a decisão — nunca esta lista lembrada por alguém.
 */
export const PERMISSAO_DA_ACAO: Readonly<Record<AttendanceAction, Permissao>> = {
  confirm: 'appointments.attend',
  check_in: 'appointments.attend',
  wait: 'appointments.attend',
  start: 'appointments.attend',
  complete: 'appointments.attend',
  no_show: 'appointments.attend',
  undo_no_show: 'appointments.attend',
  cancel: 'appointments.cancel',
};

/**
 * De quem se cobra: quem sentou na cadeira, e quem já saiu dela.
 *
 * Mora aqui porque **duas telas respondem a mesma pergunta** — a lista de
 * "Cobrar" e o cartão do dia — e elas precisam concordar. Escrita nas duas,
 * bastava alguém acrescentar um estado num lugar para o balcão ver a mesma
 * pessoa cobrável numa tela e não na outra, sem nada ficar vermelho.
 *
 * Antes de sentar não há o que cobrar: o corte não começou, e comanda aberta em
 * quem ainda pode faltar é comanda que alguém esquece aberta.
 */
export const ESTADOS_COBRAVEIS: ReadonlySet<AppointmentStatus> = new Set([
  'in_progress',
  'completed',
]);

/**
 * A ação em destaque de cada estado — uma só, em qualquer tela.
 *
 * Sempre a que quem opera mais aperta naquele momento. `no_show` e `cancel`
 * nunca aparecem aqui: são decisões que tiram dinheiro da casa e não devem ser
 * o botão mais fácil de acertar sem querer.
 *
 * `no_show` fica sem destaque de propósito: a linha já saiu do dia, e desfazer é
 * conserto de engano, não o próximo passo de ninguém.
 */
export const ACAO_PRINCIPAL: Readonly<Partial<Record<AppointmentStatus, AttendanceAction>>> = {
  pending: 'check_in',
  confirmed: 'check_in',
  checked_in: 'start',
  waiting: 'start',
  in_progress: 'complete',
};
