import type { QuemEspera } from './admin-api';

/**
 * Quem queria a vaga que o cancelamento acabou de abrir.
 *
 * Atravessa do handler que moveu o atendimento (`/admin/dia/atender`) para a
 * tela que o balcão volta a ver. O tipo mora aqui, e não em cada ponta, porque
 * quem grava e quem lê precisam concordar sobre a forma — e nada casa um JSON
 * de cookie com uma interface a não ser a mesma declaração.
 */
export interface QueriaAVaga {
  readonly id: string;
  readonly nome: string;
  /** Só os quatro últimos, como o domínio devolve: a tela fica virada para o salão. */
  readonly fim4: string | null;
  /** `HH:mm` da janela que a pessoa pediu, para a recepção saber o que oferecer. */
  readonly de: string;
  readonly ate: string;
}

export const COOKIE_DA_VAGA = 'vaga';

/**
 * Quantos nomes atravessam.
 *
 * Regra de produto, não de layout, e a tela diz o número. Cinco é o que a
 * recepção consegue ligar antes de o horário ser marcado pelo site — quem
 * precisa falar com todos abre a lista de espera, que é o link ao lado.
 *
 * E é também o que mantém o cookie pequeno: o navegador descarta em silêncio o
 * que passa de 4 KB, e sem teto o aviso sumiria justamente no cancelamento com
 * mais gente esperando.
 */
export const NOMES_QUE_ATRAVESSAM = 5;

export function daEspera(esperando: readonly QuemEspera[]): VagaNaTela {
  /**
   * Sem nome não é lista vazia — é contagem.
   *
   * Quem não tem `customers.view` recebe do domínio a mesma linha com o nome em
   * branco e o telefone nulo (bloco 38): a lista vazia seria mentira, e a lista
   * inteira entregaria a base a quem a barbearia decidiu não dar. A tela precisa
   * fazer a mesma distinção — um `<strong>` vazio ao lado de uma janela é pior
   * que os dois casos, porque parece defeito de carregamento.
   */
  const nomeados = esperando.filter((quem) => quem.customerNome !== '');

  return {
    nomes: nomeados.slice(0, NOMES_QUE_ATRAVESSAM).map((quem) => ({
      id: quem.id,
      nome: quem.customerNome,
      fim4: quem.customerTelefoneFinal,
      de: quem.inicio,
      ate: quem.fim,
    })),
    total: esperando.length,
  };
}

export interface VagaNaTela {
  readonly nomes: readonly QueriaAVaga[];
  readonly total: number;
}

/**
 * O que veio no cookie, conferido antes de virar tela.
 *
 * Nós mesmos gravamos, `httpOnly` — não é entrada externa. A conferência de
 * forma existe para o outro caso: o cookie de dois minutos gravado pela versão
 * anterior desta tela sobrevive a um deploy e chegaria aqui com outro formato.
 * Cookie malformado é aviso que não aparece, nunca tela que quebra.
 *
 * Puro de propósito — sem `next/headers` — porque é a parte que tem regra, e
 * regra sem teste é o que este repositório não aceita. Quem lê o cookie é o
 * componente.
 */
export function lerVaga(bruto: string | undefined): VagaNaTela | null {
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (typeof lido !== 'object' || lido === null) return null;
    const { nomes, total } = lido as { nomes?: unknown; total?: unknown };
    if (!Array.isArray(nomes) || typeof total !== 'number' || total < 1) return null;

    const limpos = nomes.filter(
      (quem): quem is QueriaAVaga =>
        typeof quem === 'object' &&
        quem !== null &&
        typeof (quem as QueriaAVaga).id === 'string' &&
        typeof (quem as QueriaAVaga).nome === 'string' &&
        typeof (quem as QueriaAVaga).de === 'string' &&
        typeof (quem as QueriaAVaga).ate === 'string',
    );
    /**
     * Lista **que veio** vazia é o caso da permissão: a contagem existe e os
     * nomes não atravessam. É por isso que `total` viaja separado, e não como o
     * comprimento da lista.
     *
     * Lista que veio cheia e não sobrou nada é outra coisa — formato de outra
     * versão desta tela, sobrevivendo a um deploy dentro do cookie de dois
     * minutos. Ali o aviso não aparece, em vez de virar uma contagem sem nomes
     * que se pareceria com falta de permissão.
     */
    if (nomes.length > 0 && limpos.length === 0) return null;

    // O total manda na frase ("3 pessoas esperavam"), e ele vem do domínio —
    // pode ser maior que a lista, que tem teto. Menor, nunca: seria a contagem
    // contradizendo os nomes logo abaixo dela.
    return { nomes: limpos, total: Math.max(total, limpos.length) };
  } catch {
    return null;
  }
}
