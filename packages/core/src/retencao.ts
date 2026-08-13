/**
 * Retenção de dado pessoal: quando a barbearia deixa de poder guardar (bloco 32).
 *
 * ## A regra, e por que ela é desconfortável
 *
 * A SPEC §1.8 regra 6 diz: cliente sem interação há cinco anos entra em fila de
 * anonimização automática, **com aviso prévio ao tenant**. A LGPD art. 15 III
 * diz a mesma coisa por outro caminho — o tratamento termina quando a finalidade
 * se esgota, e a finalidade de "guardar como o senhor gosta do corte" se esgota
 * quando ele parou de vir há cinco anos.
 *
 * O desconforto é real e é do dono: a base dele encolhe sozinha. Por isso o
 * aviso prévio não é cortesia — é o que transforma uma perda silenciosa numa
 * decisão informada. Ele tem trinta dias para trazer a pessoa de volta, e uma
 * visita basta para zerar a contagem.
 *
 * ## Por que os dois prazos são constantes e não coluna
 *
 * Espaçamento, teto de desconto e janela de cancelamento são configuráveis
 * porque são política comercial da casa. Estes dois não são: um dono que
 * pudesse escrever "cem anos" estaria configurando o descumprimento, e um que
 * escrevesse "zero dias de aviso" estaria removendo a própria proteção que o
 * aviso existe para dar. A escolha fica escrita aqui, onde se lê e se discute.
 */

/** Cinco anos, da SPEC §1.8 regra 6. */
export const RETENCAO_ANOS = 5;

/** Trinta dias entre o aviso ao dono e a anonimização. */
export const AVISO_DE_RETENCAO_DIAS = 30;

/**
 * Quanto tempo o texto cru de uma pergunta anônima pode ficar guardado (bloco 66).
 *
 * Noventa dias, e não cinco anos: são coisas diferentes. O prazo de cinco anos
 * é sobre um **cadastro**, que existe para servir a pessoa e é alcançável por
 * `anonimizar_cliente`; este é sobre uma frase digitada por alguém sem conta,
 * que ninguém sabe de quem é e que a exportação do titular não alcança. Cópia de
 * dado pessoal fora de `customers` vive com prazo — é a regra de
 * `imports.payload`, aqui aplicada ao que o visitante escreve.
 *
 * O que **não** vence é a chave normalizada nem o contador: eles são o produto —
 * "dezoito pessoas perguntaram se você abre no domingo" — e não identificam
 * ninguém. Vence a redação original, que é onde um nome ou um telefone caberia.
 *
 * E noventa dias porque é o horizonte em que a redação ainda diz alguma coisa
 * ao dono. Uma pergunta que ninguém repete há um trimestre já não descreve o
 * público de hoje; guardá-la é risco sem contrapartida.
 */
export const RETENCAO_DO_TEXTO_DIAS = 90;

const DIA_MS = 86_400_000;

export type PassoDaRetencao = 'nada' | 'avisar' | 'anonimizar';

export interface SituacaoDeRetencao {
  /**
   * A última vez que esta pessoa **interagiu** — não a última vez que alguém
   * editou a ficha dela.
   *
   * A distinção decide o resultado: importar a base inteira mexe em
   * `updated_at` de mil e duzentos cadastros, e usar essa coluna faria a
   * migração de sistema zerar a contagem de todo mundo. Interação é
   * atendimento, comanda, lançamento no fiado, entrada na fila — ou, quando não
   * houve nenhuma, o dia em que o cadastro nasceu.
   */
  readonly ultimaInteracao: Date;
  /** Quando o dono foi avisado de que esta pessoa está para sair. */
  readonly avisadoEm: Date | null;
  readonly anonimizadoEm: Date | null;
}

/**
 * O que fazer com este cadastro hoje.
 *
 * Pura, com o relógio por parâmetro: a suíte precisa provar a virada dos cinco
 * anos e a dos trinta dias sem esperar nem um nem outro.
 *
 * A ordem das perguntas importa. "Já voltou depois do aviso?" vem **antes** de
 * "o aviso venceu?", senão uma pessoa que voltou dentro dos trinta dias seria
 * anonimizada mesmo assim — que é o pior resultado possível: o dono foi
 * avisado, agiu, trouxe o cliente de volta, e o sistema apagou o cadastro
 * porque só olhou a data do aviso.
 */
export function decidirRetencao(
  situacao: SituacaoDeRetencao,
  agora: Date,
): PassoDaRetencao {
  if (situacao.anonimizadoEm !== null) return 'nada';

  const inativoDesde = agora.getTime() - situacao.ultimaInteracao.getTime();
  const limite = RETENCAO_ANOS * 365 * DIA_MS;

  if (inativoDesde < limite) return 'nada';

  if (situacao.avisadoEm === null) return 'avisar';

  // Voltou depois do aviso: o `ultimaInteracao` acima já teria devolvido
  // 'nada'. Chegar aqui significa que continua parado — só falta o prazo.
  const desdeOAviso = agora.getTime() - situacao.avisadoEm.getTime();
  return desdeOAviso >= AVISO_DE_RETENCAO_DIAS * DIA_MS ? 'anonimizar' : 'nada';
}

/**
 * O apelido que substitui o nome, no formato que a SPEC §1.8 regra 3 escreve:
 * `cliente_anonimizado_a1b2`.
 *
 * Derivado do id e não sorteado, por duas razões práticas. A primeira é que
 * anonimizar duas vezes o mesmo cadastro — reprocessamento, retentativa da
 * fila — não pode produzir um segundo nome, senão a mesma linha aparece com
 * dois rótulos em telas abertas ao mesmo tempo. A segunda é que teste com nome
 * sorteado ou compara nada ou compara uma expressão regular, e as duas coisas
 * deixam de pegar o dia em que a função passar a devolver o nome verdadeiro.
 *
 * Não é reversível: o id **já** está em `orders.customer_id` e não deixa de
 * estar com a anonimização, porque a nota fiscal precisa apontar para alguma
 * linha. O que a anonimização remove é o vínculo com a **pessoa** — nome,
 * telefone, nascimento, anotação —, não o vínculo interno entre as linhas.
 *
 * Colisão é possível e não é problema: isto é rótulo de tela, não chave. Duas
 * pessoas anonimizadas com o mesmo sufixo continuam sendo duas linhas
 * distintas, e nenhuma consulta procura por nome.
 */
export function apelidoAnonimo(customerId: string): string {
  const limpo = customerId.replace(/-/g, '');
  return `cliente_anonimizado_${limpo.slice(0, 4)}`;
}
