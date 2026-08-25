/**
 * Preço digitado em reais, gravado em centavos inteiros.
 *
 * "49,90" e "49.90" chegam do mesmo campo — o teclado numérico do celular
 * brasileiro dá vírgula, e o do notebook dá ponto. Converter com
 * `Number(valor) * 100` produz 4989.999999999999 para "49.90", e
 * `Math.round` esconde isso até o dia em que não esconde. Por isso os centavos
 * saem dos dígitos, nunca de multiplicação em ponto flutuante — dinheiro é
 * inteiro em todo o sistema (CLAUDE.md).
 */
export function centavosDoCampo(bruto: string): number | null {
  /**
   * O separador de milhar entra, porque é o que o produto **mostra**.
   *
   * Desde que o dinheiro passou a ser exibido com milhar (`R$ 1.848,00`), o
   * fechamento cego do caixa ficou impossível de completar: a tela diz quanto a
   * gaveta tem, o operador digita exatamente o que lê, e a resposta era "valor
   * inválido". O ponto só é milhar quando vem seguido de três dígitos e há mais
   * coisa depois — `49.90` continua sendo quarenta e nove e noventa, que é o
   * que o teclado do notebook produz.
   */
  const semEspaco = bruto.trim().replace(/\s/g, '');
  const semMilhar = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(semEspaco)
    ? semEspaco.replace(/\./g, '')
    : semEspaco;
  const limpo = semMilhar.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;

  const [reais = '0', centavos = ''] = limpo.split('.');
  return Number(reais) * 100 + Number(centavos.padEnd(2, '0'));
}

/** 4990 vira "49,90" — o formato que volta para o campo de edição. */
export function reaisDoCampo(centavos: number): string {
  return (centavos / 100).toFixed(2).replace('.', ',');
}

/**
 * O dinheiro como ele se **lê**, com separador de milhar (bloco 101).
 *
 * `reaisDoCampo` é o formato que volta para o **campo de edição** — é o que a
 * própria documentação dele diz —, e vinte e três telas o usavam para exibir.
 * O resultado aparecia lado a lado na mesma tela: `R$ 32432,00` num indicador e
 * `R$ 1.848,00` no gráfico logo abaixo. O primeiro obriga a contar dígitos, e
 * número que se conta com o dedo é número em que não se confia de relance.
 *
 * Uma função, num lugar, para as vinte e três: cada tela declarava o próprio
 * `const reais`, e é assim que dois formatos convivem sem nada ficar vermelho.
 *
 * `pt-BR` fixo e não o do navegador: o produto é de uma barbearia brasileira, e
 * o formato do dinheiro não muda com a configuração de quem abre a tela.
 */
const FORMATO = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function reais(centavos: number): string {
  /**
   * O sinal antes do `R$`, e o sinal de menos tipográfico.
   *
   * `R$ -500,00` põe o sinal no meio do valor e some na leitura de uma coluna;
   * `−R$ 500,00` é como o DRE e o financeiro já escreviam, e é o que se lê num
   * extrato. O `Intl` põe o hífen depois do símbolo, então o sinal sai daqui.
   */
  const sinal = centavos < 0 ? '−' : '';
  return `${sinal}R$ ${FORMATO.format(Math.abs(centavos) / 100)}`;
}
