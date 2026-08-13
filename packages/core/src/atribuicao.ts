/**
 * A comissão do marketplace (bloco 72, SPEC §5.2).
 *
 * > *"Comissão de marketplace incide exclusivamente sobre **cliente novo
 * > trazido pela plataforma**. Cliente que a barbearia já tinha na base nunca
 * > gera comissão, mesmo que agende pelo app do marketplace."*
 * >
 * > *"Cobrar sobre base própria é a principal fonte de revolta contra Fresha
 * > (20% sobre cliente novo) e Booksy — e é exatamente a brecha a explorar no
 * > discurso de venda."*
 *
 * ## O produto é a regra negativa
 *
 * O que se vende aqui é o que **não** se cobra. Isso muda onde a regra pode
 * morar: uma promessa negativa que vive num relatório é uma promessa que se
 * perde no primeiro caminho novo. Ela está no índice único do banco (uma
 * comissão por cliente, para sempre), nas duas pontas da janela, e nas
 * condições de "cliente novo" que este arquivo escreve.
 */

/** Nome-base do cookie que carimba a passagem pelo marketplace. */
export const COOKIE_DA_ORIGEM = 'origem';

/**
 * Quanto tempo o carimbo do marketplace vale no navegador.
 *
 * Trinta dias é a ponta de cima da janela de atribuição, e as duas são o mesmo
 * número de propósito: um cookie que durasse mais criaria agendamentos com
 * `source = 'marketplace'` que a atribuição depois recusaria por prazo — origem
 * gravada que não vira nada é pior que origem ausente, porque o relatório de
 * canal passa a contar aquisições que a cobrança não reconhece.
 */
export const VALIDADE_DA_ORIGEM_DIAS = 30;

/**
 * A janela de atribuição, em dias, contada da criação do agendamento.
 *
 * Ela tem as **duas** pontas, como a janela das automações do bloco 63. Sem a
 * de baixo, um atendimento anterior à passagem pelo marketplace seria creditado
 * a ele; sem a de cima, a plataforma levaria crédito por um corte de seis meses
 * depois, que a pessoa faria de qualquer jeito. Atribuição frouxa é pior que
 * nenhuma, porque tem número.
 */
export const JANELA_DE_ATRIBUICAO_DIAS = 30;

/** Teto da alíquota, em pontos-base. Cinquenta por cento e o banco confere. */
export const TETO_DA_COMISSAO_BPS = 5000;

export interface BaseDaAtribuicao {
  /** O valor do atendimento que a comissão usa como base, em centavos. */
  readonly baseCents: number;
  /** A alíquota vigente da barbearia, em pontos-base. */
  readonly feeBps: number;
}

/**
 * Quanto a plataforma tem a receber por este cliente novo.
 *
 * Arredondamento comum, como toda comissão deste produto: o valor é derivado da
 * base e da alíquota **copiadas na linha**, nunca lido do cadastro na hora do
 * relatório. Renegociar a alíquota em maio não muda o que foi cobrado em abril.
 */
export function comissaoDoMarketplace(entrada: BaseDaAtribuicao): number {
  if (entrada.feeBps <= 0 || entrada.baseCents <= 0) return 0;
  const bps = Math.min(entrada.feeBps, TETO_DA_COMISSAO_BPS);
  return Math.round((entrada.baseCents * bps) / 10_000);
}

export interface CandidataAAtribuicao {
  /** Quando o agendamento foi **criado** — é dele que a janela conta. */
  readonly criadoEm: Date;
  /** Quando a ficha do cliente nasceu nesta barbearia. */
  readonly cadastradoEm: Date;
  /** Se o agendamento nasceu com `source = 'marketplace'`. */
  readonly veioPelaBusca: boolean;
  /** Se este é o primeiro agendamento da pessoa nesta barbearia. */
  readonly primeiroAgendamento: boolean;
  /** Se a pessoa já tinha comanda nesta barbearia antes deste atendimento. */
  readonly comandaAnterior: boolean;
}

export type RecusaDaAtribuicao =
  | 'ja_era_da_base'
  | 'cadastro_anterior'
  | 'nao_veio_pela_busca';

/**
 * Se este atendimento gera comissão, e quando não gera, **por quê**.
 *
 * O motivo não é enfeite: a barbearia vai perguntar por que aquele cliente não
 * apareceu na conta, e "não gerou" sem motivo transforma toda pergunta numa
 * investigação. É a mesma decisão de `notifications.reason` e do disparo de
 * automação que não saiu.
 */
export function decidirAtribuicao(
  candidata: CandidataAAtribuicao,
): { readonly atribui: true } | { readonly atribui: false; readonly motivo: RecusaDaAtribuicao } {
  /**
   * "Já era da base" vem **antes** de tudo, e essa ordem é a promessa.
   *
   * Uma pessoa que já cortava ali e um dia clicou no marketplace continua sendo
   * cliente da barbearia. Checar a janela primeiro daria o mesmo resultado hoje
   * e o motivo errado na tela — e o motivo é o que a casa lê para conferir se a
   * plataforma está cumprindo o que vendeu.
   */
  if (!candidata.primeiroAgendamento || candidata.comandaAnterior) {
    return { atribui: false, motivo: 'ja_era_da_base' };
  }
  if (!candidata.veioPelaBusca) {
    return { atribui: false, motivo: 'nao_veio_pela_busca' };
  }

  /**
   * A janela é entre o **cadastro** e o agendamento, e ela pega o caso que as
   * duas condições acima deixam passar.
   *
   * Uma ficha trazida na importação de base há dois anos, sem nunca ter
   * agendado nem aberto comanda, satisfaz "primeiro agendamento" e "sem comanda
   * anterior" — e mesmo assim aquela pessoa **já era da barbearia**: ela veio
   * na planilha do sistema antigo. Sem esta ponta, a plataforma cobraria por um
   * cliente que ela não trouxe, que é a frase que a SPEC §5.2 usa para
   * descrever a revolta contra o concorrente.
   *
   * A ponta de baixo é `< 0` e existe pelo mesmo motivo das automações: um
   * agendamento anterior ao próprio cadastro é dado inconsistente, e creditá-lo
   * seria inventar aquisição a partir de um defeito.
   */
  const dias = (candidata.criadoEm.getTime() - candidata.cadastradoEm.getTime()) / 86_400_000;
  if (dias < 0 || dias > JANELA_DE_ATRIBUICAO_DIAS) {
    return { atribui: false, motivo: 'cadastro_anterior' };
  }

  return { atribui: true };
}

export const MOTIVO_DA_RECUSA: Readonly<Record<RecusaDaAtribuicao, string>> = {
  ja_era_da_base: 'Já era cliente da casa',
  cadastro_anterior: 'Já estava no seu cadastro antes da busca',
  nao_veio_pela_busca: 'Não veio pela busca',
};
