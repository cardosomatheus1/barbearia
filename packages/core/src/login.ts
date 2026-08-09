/**
 * Proteção contra força bruta no login (bloco 33, SPEC Parte 5 §5.12).
 *
 * ## Por que o limite por IP não resolve isto
 *
 * O produto já tem teto por IP desde o bloco 4, e ele continua necessário — é o
 * que segura varredura de endpoint caro. Mas para adivinhar **uma senha** ele
 * não serve: quem tenta mil senhas na conta do dono usa mil endereços, e é
 * barato. E o inverso também dói: uma barbearia inteira atrás do mesmo NAT
 * compartilha um IP, então um teto apertado por IP derruba o balcão quando a
 * recepcionista erra a senha três vezes.
 *
 * O que segura adivinhação é o teto **por conta**. O atacante não escolhe de
 * qual conta é a senha que ele quer.
 *
 * ## Escada, não porta trancada
 *
 * Bloqueio permanente ao errar N vezes transforma o ataque em negação de
 * serviço: basta errar de propósito a senha do dono para trancá-lo fora do
 * próprio negócio na véspera do Natal. A escada cresce o suficiente para tornar
 * a adivinhação inviável e cede sozinha — cinco tentativas livres, depois a
 * espera dobra.
 *
 * Aos dez erros a espera já é de meia hora, e mil tentativas levariam anos. Quem
 * sabe a senha espera trinta minutos uma vez; quem não sabe desiste.
 */

/** Erros livres antes de a escada começar. */
export const ERROS_ANTES_DA_ESPERA = 5;

/** O primeiro degrau, em segundos. Dobra a cada erro seguinte. */
export const PRIMEIRA_ESPERA_SEGUNDOS = 30;

/**
 * Teto do degrau, em segundos.
 *
 * Meia hora. Sem teto, o vigésimo erro pediria mais de um ano de espera — que é
 * o bloqueio permanente com outro nome, e traz de volta a negação de serviço
 * que a escada existe para evitar.
 */
export const MAIOR_ESPERA_SEGUNDOS = 30 * 60;

/**
 * Quanto tempo sem erro zera a contagem.
 *
 * Vinte e quatro horas. Quem errou duas vezes ontem e volta hoje começa do
 * zero — senão a contagem de uma pessoa desastrada com a senha se acumula por
 * meses até ela cair na escada sem nunca ter sido atacada.
 */
export const ESQUECER_APOS_SEGUNDOS = 24 * 60 * 60;

export interface EstadoDoLogin {
  /** Erros seguidos até agora. */
  readonly falhas: number;
  /** Quando foi o último erro. Nulo é "nunca errou". */
  readonly ultimaFalhaEm: Date | null;
}

/**
 * Quanto tempo esta conta ainda precisa esperar, em segundos.
 *
 * Zero libera. Pura e com o relógio por parâmetro: a suíte precisa provar a
 * escada inteira e o esquecimento sem dormir meia hora.
 */
export function esperaDeLogin(estado: EstadoDoLogin, agora: Date): number {
  if (estado.ultimaFalhaEm === null || estado.falhas <= ERROS_ANTES_DA_ESPERA) return 0;

  const desdeAFalha = (agora.getTime() - estado.ultimaFalhaEm.getTime()) / 1000;
  // Esquecido pelo tempo: nem precisa olhar a escada.
  if (desdeAFalha >= ESQUECER_APOS_SEGUNDOS) return 0;

  const degrau = Math.min(
    PRIMEIRA_ESPERA_SEGUNDOS * 2 ** (estado.falhas - ERROS_ANTES_DA_ESPERA - 1),
    MAIOR_ESPERA_SEGUNDOS,
  );

  const falta = Math.ceil(degrau - desdeAFalha);
  return falta > 0 ? falta : 0;
}

/**
 * A contagem depois de mais um erro.
 *
 * Reinicia quando o último erro é velho o bastante: a conta que errou duas
 * vezes há um ano não deve entrar na escada no primeiro engano de hoje.
 */
export function contarFalha(estado: EstadoDoLogin, agora: Date): number {
  if (estado.ultimaFalhaEm === null) return 1;
  const desdeAFalha = (agora.getTime() - estado.ultimaFalhaEm.getTime()) / 1000;
  return desdeAFalha >= ESQUECER_APOS_SEGUNDOS ? 1 : estado.falhas + 1;
}
