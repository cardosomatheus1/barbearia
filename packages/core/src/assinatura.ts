/**
 * Assinaturas: planos, regras e cooldown (bloco 45, SPEC §4.6).
 *
 * A SPEC abre a seção chamando isto de **a maior oportunidade estratégica**, e o
 * argumento é do setor: corte tem ciclo natural de 3–4 semanas, o que faz dele o
 * serviço mais assinável que existe. Transforma receita variável em receita
 * mínima previsível.
 *
 * ## O cooldown é o que torna "ilimitado" viável
 *
 * *"Corte ilimitado, com mínimo de 7 dias entre cortes."* Sem o intervalo,
 * "ilimitado" é prejuízo garantido no primeiro assinante entusiasmado — e a
 * barbearia descobre isso no fim do mês, com a agenda cheia e o caixa igual.
 *
 * Por isso ele não é um detalhe do plano: é o mecanismo. Um plano ilimitado sem
 * cooldown é aceito pelo produto, mas a tela diz em letras o que isso significa.
 *
 * ## A cota é por período, e o período é da assinatura
 *
 * "2 cortes por mês" conta os cortes **deste ciclo**, que começa no dia da
 * adesão — não no dia 1º. Quem assinou no dia 20 tem o ciclo do dia 20 ao dia
 * 20, e é assim que a cobrança recorrente vai funcionar no bloco 47.
 */

export const ESTADOS_DA_ASSINATURA = [
  'ativa',
  'pendente',
  'inadimplente',
  'suspensa',
  'cancelada',
] as const;
export type EstadoDaAssinatura = (typeof ESTADOS_DA_ASSINATURA)[number];

export const ROTULO_DA_ASSINATURA: Readonly<Record<EstadoDaAssinatura, string>> = {
  ativa: 'Ativa',
  pendente: 'Aguardando o primeiro pagamento',
  inadimplente: 'Pagamento atrasado',
  suspensa: 'Suspensa',
  cancelada: 'Cancelada',
};

/**
 * Quais estados ainda dão direito a usar o plano.
 *
 * `inadimplente` **usa**, e é a decisão que a SPEC pede em letras: *"Suspensão
 * de benefício é gradual e avisada — cortar o acesso no primeiro erro de cartão
 * gera cancelamento por raiva, não por preço."* Um cartão que falhou na terça
 * costuma passar na quinta, e o assinante que foi barrado no balcão no meio
 * disso não volta.
 *
 * `suspensa` é o degrau seguinte, e aí sim o benefício para. A régua que leva de
 * um ao outro é do bloco 47.
 */
export const ESTADOS_QUE_USAM: readonly EstadoDaAssinatura[] = ['ativa', 'inadimplente'];

export function assinaturaVale(estado: EstadoDaAssinatura): boolean {
  return ESTADOS_QUE_USAM.includes(estado);
}

/** Ilimitado é `null`, e não um número grande. Um `9999` é uma cota disfarçada. */
export interface BeneficioDoPlano {
  readonly serviceId: string;
  readonly quantidade: number | null;
  /** Dias mínimos entre dois usos. Zero é sem intervalo. */
  readonly cooldownDias: number;
}

/**
 * O que o domínio precisa saber sobre o uso, e é só isto.
 *
 * `usados` é a contagem **do ciclo**; `ultimoUso` é o mais recente de todos, sem
 * corte de ciclo. Os dois separados de propósito: a cota é do ciclo e o
 * cooldown não é, e a primeira versão os confundiu — ela recebia uma lista de
 * usos do ciclo e derivava o cooldown dela, o que perdia o intervalo sempre que
 * o último corte tinha caído no ciclo anterior. Quem cortou no dia 28 e viu o
 * ciclo virar no dia 30 cortava de novo no dia 30.
 */
export interface UsoDoBeneficio {
  readonly usados: number;
  readonly ultimoUso: Date | null;
}

export type RecusaDoUso =
  | 'assinatura_inativa'
  | 'servico_fora_do_plano'
  | 'cota_esgotada'
  | 'dentro_do_cooldown';

export interface DecisaoDoUso {
  readonly pode: boolean;
  readonly recusa?: RecusaDoUso;
  /** Quantos ainda cabem no ciclo. `null` em plano ilimitado. */
  readonly restam: number | null;
  /** Quando o próximo uso libera, quando o cooldown está segurando. */
  readonly liberaEm: Date | null;
}

/**
 * Este assinante pode usar este serviço agora?
 *
 * Três perguntas em ordem, e a ordem importa para a **mensagem**: "seu plano não
 * cobre barba" é diferente de "você já usou os dois cortes do mês" e de "faltam
 * três dias". A recepção diz uma dessas em voz alta, com o cliente na frente, e
 * as três levam a conversas diferentes.
 */
export function podeUsarBeneficio(params: {
  readonly estado: EstadoDaAssinatura;
  readonly beneficios: readonly BeneficioDoPlano[];
  readonly serviceId: string;
  readonly uso: UsoDoBeneficio;
  readonly agora: Date;
}): DecisaoDoUso {
  if (!assinaturaVale(params.estado)) {
    return { pode: false, recusa: 'assinatura_inativa', restam: null, liberaEm: null };
  }

  const beneficio = params.beneficios.find((b) => b.serviceId === params.serviceId);
  if (!beneficio) {
    return { pode: false, recusa: 'servico_fora_do_plano', restam: null, liberaEm: null };
  }

  const restam =
    beneficio.quantidade === null ? null : beneficio.quantidade - params.uso.usados;

  if (restam !== null && restam <= 0) {
    return { pode: false, recusa: 'cota_esgotada', restam: 0, liberaEm: null };
  }

  /**
   * O cooldown conta do **último uso**, não do começo do ciclo — e não é
   * recortado pelo ciclo.
   *
   * Contar do ciclo faria o intervalo de sete dias virar "um por semana do
   * calendário", e quem cortasse no dia 6 e no dia 8 estaria dentro da regra por
   * acidente do mês. Recortar pelo ciclo é pior: o intervalo sumiria toda vez
   * que o mês virasse entre dois cortes.
   */
  const liberaEm = proximoUsoLiberado(params.uso.ultimoUso, beneficio.cooldownDias);
  if (liberaEm && liberaEm > params.agora) {
    return { pode: false, recusa: 'dentro_do_cooldown', restam, liberaEm };
  }

  return { pode: true, restam, liberaEm: null };
}

/**
 * Quando o próximo uso libera.
 *
 * Do **último uso de todos**, e não do último do ciclo: o intervalo é sobre o
 * cabelo da pessoa, não sobre o calendário da cobrança. Um corte no dia 28
 * segura o do dia 30 mesmo que o ciclo tenha virado no dia 29.
 */
export function proximoUsoLiberado(ultimoUso: Date | null, cooldownDias: number): Date | null {
  if (cooldownDias <= 0 || !ultimoUso) return null;
  return new Date(ultimoUso.getTime() + cooldownDias * 86_400_000);
}

/**
 * O ciclo de uma assinatura que começou em `aderiuEm`, contendo `agora`.
 *
 * Mensal e ancorado no dia da adesão: quem assinou no dia 20 tem o ciclo do 20
 * ao 20. Ancorar no dia 1º daria meio mês de graça para quem assina no dia 28, e
 * a barbearia veria o plano render metade no primeiro mês sem entender por quê.
 *
 * O dia 31 vira o último dia do mês curto — e volta a ser 31 no mês seguinte:
 * quem assinou em 31 de janeiro cobra em 28 de fevereiro e em 31 de março, que é
 * o que qualquer assinatura do mundo faz.
 */
export function cicloDaAssinatura(
  aderiuEm: Date,
  agora: Date,
): { readonly de: Date; readonly ate: Date } {
  const diaDaAdesao = aderiuEm.getUTCDate();

  const inicioNoMes = (ano: number, mes: number): Date => {
    const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        ano,
        mes,
        Math.min(diaDaAdesao, ultimoDia),
        aderiuEm.getUTCHours(),
        aderiuEm.getUTCMinutes(),
        aderiuEm.getUTCSeconds(),
        aderiuEm.getUTCMilliseconds(),
      ),
    );
  };

  let ano = agora.getUTCFullYear();
  let mes = agora.getUTCMonth();
  if (agora < inicioNoMes(ano, mes)) {
    mes -= 1;
    if (mes < 0) {
      mes = 11;
      ano -= 1;
    }
  }

  const de = inicioNoMes(ano, mes);
  const proximo = mes === 11 ? inicioNoMes(ano + 1, 0) : inicioNoMes(ano, mes + 1);
  return { de, ate: proximo };
}

/**
 * A receita recorrente mensal das assinaturas — o MRR **da barbearia**.
 *
 * É o outro MRR da SPEC §8, e não se confunde com o da plataforma: aquele é o
 * que as barbearias pagam a nós, este é o que os clientes pagam a elas. Foi
 * declarado como lacuna no bloco em que o primeiro entrou, e é entregue aqui.
 *
 * Conta `ativa` e `inadimplente`, pelo mesmo motivo de o benefício continuar:
 * o cartão que falhou na terça costuma passar na quinta, e tirar a receita do
 * número no primeiro erro faria o painel oscilar por um problema que se resolve
 * sozinho. `suspensa` e `cancelada` saem — dessas a casa não espera mais nada.
 */
export function mrrDasAssinaturas(
  assinaturas: readonly { readonly estado: EstadoDaAssinatura; readonly precoCents: number }[],
): { readonly mrrCents: number; readonly ativas: number } {
  const contam = assinaturas.filter((a) => assinaturaVale(a.estado));
  return {
    mrrCents: contam.reduce((soma, a) => soma + a.precoCents, 0),
    ativas: contam.length,
  };
}

/**
 * O ponto de equilíbrio de um assinante: quantos usos o plano paga.
 *
 * Acima disso ele dá prejuízo, e a SPEC §4.6 pede a tela que mostra isso —
 * *"sem essa tela, o dono descobre que o clube dá prejuízo seis meses depois"*.
 * A conta completa, com comissão e insumo, é do bloco 48; aqui está a parte que
 * não depende de nada: quanto custa à casa entregar mais um uso.
 */
export function usosQueOPlanoPaga(precoCents: number, custoPorUsoCents: number): number {
  if (custoPorUsoCents <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(precoCents / custoPorUsoCents);
}

/** "2 de 2 cortes usados neste ciclo" — a frase que o balcão lê. */
export function fraseDoBeneficio(
  beneficio: BeneficioDoPlano,
  usados: number,
  nomeDoServico: string,
): string {
  if (beneficio.quantidade === null) {
    return beneficio.cooldownDias > 0
      ? `${nomeDoServico} ilimitado, a cada ${beneficio.cooldownDias} dias`
      : `${nomeDoServico} ilimitado`;
  }
  const restam = Math.max(0, beneficio.quantidade - usados);
  return `${usados} de ${beneficio.quantidade} ${nomeDoServico} — ${restam} ${
    restam === 1 ? 'restante' : 'restantes'
  } neste ciclo`;
}

/**
 * O peso da assinatura no score da fila de espera (SPEC §2.9).
 *
 * Era lacuna declarada desde o bloco 38: o termo `assinante` entrava **constante
 * e falso** para todo mundo, porque não existia assinatura no produto. Constante,
 * ele não alterava a ordem de ninguém — o efeito era o score inteiro caber em
 * 0,8 em vez de 1,0.
 *
 * Agora ele responde de verdade, e é o benefício concreto que a SPEC §4.6 chama
 * de vendável: *"assinante entra com peso maior na priority queue"*.
 */
export function eAssinante(estado: EstadoDaAssinatura | null): boolean {
  return estado !== null && assinaturaVale(estado);
}

// ---------------------------------------------------------------------------
// Restrição de horário, dependentes e antecedência (bloco 46, SPEC §4.6)
// ---------------------------------------------------------------------------

/**
 * A janela em que o plano **não** vale.
 *
 * Guarda o proibido e não o permitido: a barbearia abre setenta horas por semana
 * e bloqueia quatro. Guardar o permitido faria toda mudança de horário de
 * funcionamento exigir reescrever o plano — e um plano que esqueceu de liberar a
 * terça nova é um plano que some da grade sem ninguém saber.
 */
export interface JanelaBloqueada {
  /** 0 = domingo. Nulo é todo dia. */
  readonly diaDaSemana: number | null;
  /** Minutos locais desde a meia-noite, semiaberto `[início, fim)`. */
  readonly inicio: number;
  readonly fim: number;
}

/**
 * O plano vale neste horário?
 *
 * *"Assinante do plano Essencial pode não ter acesso a sábado 09:00–13:00, o
 * horário mais disputado."* Sem a restrição, o plano barato ocupa a hora que a
 * casa vende cheia — e o clube passa a **substituir** receita em vez de somar.
 *
 * Intervalo semiaberto, como todo intervalo deste produto: um bloqueio até as
 * 13:00 libera o horário das 13:00. Encostar não é sobrepor.
 */
export function planoValeNoHorario(
  bloqueios: readonly JanelaBloqueada[],
  diaDaSemana: number,
  minutoDoDia: number,
): boolean {
  return !bloqueios.some(
    (b) =>
      (b.diaDaSemana === null || b.diaDaSemana === diaDaSemana) &&
      minutoDoDia >= b.inicio &&
      minutoDoDia < b.fim,
  );
}

/** "Sábado das 09:00 às 13:00" — a frase que a tela mostra. */
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;

export function fraseDoBloqueio(bloqueio: JanelaBloqueada): string {
  const hora = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const quando = bloqueio.diaDaSemana === null ? 'todo dia' : DIAS[bloqueio.diaDaSemana];
  return `${quando}, das ${hora(bloqueio.inicio)} às ${hora(bloqueio.fim)}`;
}

/**
 * Até quando o assinante enxerga a grade.
 *
 * É o outro lado da prioridade na fila: quem assina vê o sábado antes e por isso
 * o pega antes. Zero significa "a mesma janela de todo mundo" — e é o padrão,
 * porque um benefício que ninguém escolheu não é benefício.
 */
export function antecedenciaDoAssinante(
  janelaDaCasaDias: number,
  janelaDoPlanoDias: number,
): number {
  return Math.max(janelaDaCasaDias, janelaDoPlanoDias);
}

export type RecusaDoDependente = 'ja_e_dependente' | 'e_o_titular' | 'assinatura_inativa';

/**
 * Esta pessoa pode entrar como dependente desta assinatura?
 *
 * O titular não é dependente de si mesmo: ele apareceria duas vezes na lista de
 * quem usa a cota, e a tela mostraria "Carlos (titular)" e "Carlos (dependente)"
 * lado a lado.
 *
 * E ninguém é dependente de duas: a mesma cota seria descontada de dois lugares,
 * e no balcão ninguém saberia de qual plano o corte saiu.
 */
export function podeSerDependente(params: {
  readonly estado: EstadoDaAssinatura;
  readonly titularId: string;
  readonly candidatoId: string;
  readonly jaEDependenteDeOutra: boolean;
}): RecusaDoDependente | null {
  if (!assinaturaVale(params.estado)) return 'assinatura_inativa';
  if (params.titularId === params.candidatoId) return 'e_o_titular';
  if (params.jaEDependenteDeOutra) return 'ja_e_dependente';
  return null;
}

/**
 * Quantas pessoas consomem esta assinatura, e quem são.
 *
 * A cota é **da assinatura**, não da pessoa: o plano família de dois cortes dá
 * dois cortes para a família inteira, não dois para cada. É o desenho que a SPEC
 * descreve — *"consumindo da mesma cota"* — e é o que faz o plano ter preço.
 */
export function quemConsome(
  titularId: string,
  dependentes: readonly string[],
): readonly string[] {
  return [titularId, ...dependentes];
}
