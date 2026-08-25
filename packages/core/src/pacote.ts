/**
 * Pacotes: venda, consumo, validade e receita diferida (bloco 42, SPEC §4.7).
 *
 * ## O que separa pacote de assinatura
 *
 * A SPEC abre a seção com isso: "compra única, sem recorrência". O cliente paga
 * R$ 250 por cinco cortes e leva anos usando, ou não usa. Assinatura é o bloco
 * 45 e cobra todo mês; aqui não há cobrança nenhuma depois da primeira.
 *
 * ## A decisão que dá nome ao bloco: receita diferida
 *
 * A venda entra R$ 250 no caixa e **não** é receita de R$ 250. Ela é receita de
 * cinco cortes que ainda não aconteceram, reconhecida conforme o uso. A SPEC
 * escreve o motivo em uma linha: *"Sem isso, o DRE mostra um mês excelente
 * seguido de meses falsamente ruins."*
 *
 * A barbearia que vende trinta pacotes em janeiro fecha o mês parecendo
 * espetacular e passa fevereiro e março atendendo de graça — e a leitura dos
 * três meses fica errada nas duas pontas.
 *
 * ## O valor da unidade é congelado na compra
 *
 * Cinco cortes por R$ 250 valem R$ 50 cada, e continuam valendo R$ 50 no dia em
 * que o corte avulso subir para R$ 70. Recalcular na leitura faria a receita
 * reconhecida mudar de valor depois de reconhecida — e é o mesmo raciocínio da
 * regra de comissão copiada no lançamento e da taxa do adquirente congelada na
 * venda.
 */

export const ESTADOS_DO_PACOTE = ['ativo', 'esgotado', 'vencido', 'reembolsado'] as const;
export type EstadoDoPacote = (typeof ESTADOS_DO_PACOTE)[number];

export const ROTULO_DO_PACOTE: Readonly<Record<EstadoDoPacote, string>> = {
  ativo: 'Ativo',
  esgotado: 'Todo usado',
  vencido: 'Vencido',
  reembolsado: 'Reembolsado',
};

/** Quando a SPEC pede "aviso quando restar 1". */
export const RESTANTE_QUE_AVISA = 1;

export interface PacoteDoCliente {
  readonly id: string;
  readonly serviceId: string;
  readonly total: number;
  readonly usados: number;
  readonly venceEm: Date | null;
  readonly valorDaUnidadeCents: number;
  /** Preço total congelado na compra; necessário para preservar o resto da divisão. */
  readonly precoCents: number;
  readonly compradoEm: Date;
  readonly transferivel: boolean;
  readonly reembolsadoEm: Date | null;
}

/**
 * O estado de um pacote, calculado e não guardado.
 *
 * `vencido` depende do relógio, e uma coluna com esse valor estaria errada todo
 * dia entre a meia-noite e a varredura passar. Mesma decisão da oferta de vaga
 * do bloco 39: a tela mostra o estado **de verdade**, não o gravado.
 */
export function estadoDoPacote(pacote: PacoteDoCliente, agora: Date): EstadoDoPacote {
  if (pacote.reembolsadoEm) return 'reembolsado';
  if (pacote.usados >= pacote.total) return 'esgotado';
  if (pacote.venceEm && pacote.venceEm <= agora) return 'vencido';
  return 'ativo';
}

/**
 * Assinatura mínima de propósito: o estorno e a transferência do bloco 52
 * perguntam quantas sobram com o que carregaram do banco, e exigir o objeto
 * inteiro obrigaria as duas a buscar campos que não usam.
 */
export function restamNoPacote(pacote: Pick<PacoteDoCliente, 'total' | 'usados'>): number {
  return Math.max(0, pacote.total - pacote.usados);
}

/**
 * Este pacote cobre este serviço agora?
 *
 * Três perguntas, e a ordem importa pouco — o que importa é que nenhuma delas
 * pode ficar de fora. Pacote vencido com saldo é o caso que mais aparece no
 * balcão, e é o que a recepção tenta usar.
 */
export function pacoteCobre(
  pacote: PacoteDoCliente,
  serviceId: string,
  agora: Date,
): boolean {
  return (
    pacote.serviceId === serviceId &&
    estadoDoPacote(pacote, agora) === 'ativo' &&
    restamNoPacote(pacote) > 0
  );
}

/**
 * Qual pacote usar quando o cliente tem mais de um do mesmo serviço.
 *
 * **O que vence primeiro.** É o que o cliente espera e o que impede o produto
 * de deixar vencer saldo que ele podia ter usado — mesma ordem do saldo de
 * fidelidade e de qualquer estoque perecível. Entre dois sem validade, o mais
 * antigo: ele é o que está parado há mais tempo no balanço.
 */
export function proximoAConsumir(
  pacotes: readonly PacoteDoCliente[],
  serviceId: string,
  agora: Date,
): PacoteDoCliente | null {
  const servem = pacotes.filter((p) => pacoteCobre(p, serviceId, agora));
  if (servem.length === 0) return null;

  return [...servem].sort((a, b) => {
    const venceA = a.venceEm?.getTime() ?? Number.POSITIVE_INFINITY;
    const venceB = b.venceEm?.getTime() ?? Number.POSITIVE_INFINITY;
    if (venceA !== venceB) return venceA - venceB;
    return a.compradoEm.getTime() - b.compradoEm.getTime();
  })[0] as PacoteDoCliente;
}

/** Quando o pacote comprado hoje vence. Nulo quando não vence. */
export function vencimentoDoPacote(validadeDias: number | null, agora: Date): Date | null {
  if (validadeDias === null) return null;
  return new Date(agora.getTime() + validadeDias * 86_400_000);
}

/**
 * Quanto vale cada unidade, em centavos.
 *
 * Divisão inteira com o resto na **primeira** unidade, e não distribuído: cinco
 * cortes por R$ 250,01 dão 5001 centavos, e 5001/5 = 1000,2. Somar 1000 cinco
 * vezes perde um centavo, e um centavo perdido por pacote é o tipo de erro que
 * só aparece na conciliação de um ano.
 *
 * A primeira unidade recebe o resto porque ela é a mais provável de ser usada —
 * e assim a receita reconhecida nunca fica maior que a diferida.
 */
export function valorDaUnidade(precoCents: number, quantidade: number): number {
  if (quantidade <= 0) return 0;
  return Math.floor(precoCents / quantidade);
}

export function restoDaPrimeiraUnidade(precoCents: number, quantidade: number): number {
  if (quantidade <= 0) return 0;
  return precoCents - valorDaUnidade(precoCents, quantidade) * quantidade;
}

/** Quanto já foi reconhecido pelos usos, preservando o centavo de resto na primeira unidade. */
export function reconhecidoDoPacote(
  pacote: Pick<PacoteDoCliente, 'precoCents' | 'total' | 'usados' | 'valorDaUnidadeCents'>,
): number {
  const usados = Math.min(Math.max(0, pacote.usados), Math.max(0, pacote.total));
  if (usados === 0 || pacote.total <= 0) return 0;
  const resto = restoDaPrimeiraUnidade(pacote.precoCents, pacote.total);
  return usados * pacote.valorDaUnidadeCents + resto;
}

/** Valor da próxima unidade a ser reconhecida. A primeira carrega o resto da divisão inteira. */
export function valorDoProximoConsumo(
  pacote: Pick<PacoteDoCliente, 'precoCents' | 'total' | 'usados' | 'valorDaUnidadeCents'>,
): number {
  if (pacote.total <= 0 || pacote.usados >= pacote.total) return 0;
  return pacote.valorDaUnidadeCents
    + (pacote.usados === 0 ? restoDaPrimeiraUnidade(pacote.precoCents, pacote.total) : 0);
}

/**
 * Quanto ainda está diferido neste pacote.
 *
 * É o passivo: dinheiro recebido por serviço que a barbearia ainda deve. Some
 * quando o pacote vence — e aí vira receita de uma vez, porque a obrigação
 * acabou sem a barbearia precisar entregar nada.
 */
export function diferidoDoPacote(pacote: PacoteDoCliente, agora: Date): number {
  const estado = estadoDoPacote(pacote, agora);
  if (estado !== 'ativo') return 0;
  return Math.max(0, pacote.precoCents - reconhecidoDoPacote(pacote));
}

export type RecusaDoReembolso =
  | 'pacote_nao_encontrado'
  | 'ja_reembolsado'
  | 'nada_a_devolver';

/**
 * Reembolso **proporcional**, que é o que a SPEC pede.
 *
 * Devolve o que não foi usado, ao valor congelado da unidade. Devolver o preço
 * cheio pagaria de volta cortes que a barbearia já entregou; devolver nada
 * transformaria uma compra antecipada em armadilha.
 *
 * Pacote vencido não devolve: a validade é a regra que o cliente aceitou, e o
 * valor já virou receita quando ela passou.
 */
export function reembolsoProporcional(
  pacote: PacoteDoCliente,
  agora: Date,
): { readonly valorCents: number } | { readonly recusa: RecusaDoReembolso } {
  if (pacote.reembolsadoEm) return { recusa: 'ja_reembolsado' };

  const restam = restamNoPacote(pacote);
  if (restam === 0) return { recusa: 'nada_a_devolver' };
  if (pacote.venceEm && pacote.venceEm <= agora) return { recusa: 'nada_a_devolver' };

  return { valorCents: Math.max(0, pacote.precoCents - reconhecidoDoPacote(pacote)) };
}

/**
 * O que a tela diz sobre um pacote, numa frase.
 *
 * "Comprado: 5 · Usado: 3 · Restante: 2" é o formato da SPEC, e o aviso de que
 * resta um entra aqui porque é onde a recepção olha — não numa mensagem que sai
 * três dias depois.
 */
export function fraseDoPacote(pacote: PacoteDoCliente, agora: Date): string {
  const estado = estadoDoPacote(pacote, agora);
  if (estado === 'reembolsado') return 'Reembolsado.';
  if (estado === 'esgotado') return `Todos os ${pacote.total} já foram usados.`;
  if (estado === 'vencido') return `Venceu com ${restamNoPacote(pacote)} sem usar.`;

  const restam = restamNoPacote(pacote);
  const base = `${pacote.usados} de ${pacote.total} usados — ${restam} restante${restam === 1 ? '' : 's'}`;
  return restam === RESTANTE_QUE_AVISA ? `${base}. É o último.` : `${base}.`;
}
