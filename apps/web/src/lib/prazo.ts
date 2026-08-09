/**
 * Quanto falta para um prazo, em palavras.
 *
 * Vive fora da tela porque é regra e não desenho: o número que aparece ao lado
 * de um pedido de titular é o que faz o dono decidir se responde hoje ou na
 * semana que vem, e a LGPD dá quinze dias contados. Errar para mais é entregar
 * um dia que não existe.
 */

/** O dia do calendário, sem a hora. É a unidade em que prazo se conta. */
const meiaNoite = (d: Date): number =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export interface Prazo {
  readonly texto: string;
  /** Merece destaque: vencido, vence hoje, ou está na reta final. */
  readonly urgente: boolean;
}

/**
 * Conta em **dias de calendário**, não em instantes.
 *
 * Subtrair os instantes daria 14 no dia em que o pedido nasceu — porque de
 * "agora + 15 dias" até "agora" faltam catorze dias e vinte e três horas, e
 * qualquer arredondamento honesto para baixo diz catorze. O dono abriria o
 * pedido de manhã, leria "vence em 14 dias" e concluiria que a tela erra.
 *
 * Contar caixas do calendário responde a pergunta que ele faz de verdade — "de
 * hoje até o dia do vencimento" — e decrementa na virada do dia, que é quando a
 * percepção dele também vira.
 *
 * UTC dos dois lados de propósito: a comparação é entre duas datas na mesma
 * régua, e usar o fuso do processo faria o mesmo pedido mostrar números
 * diferentes conforme o servidor que renderizou.
 */
export function faltamDias(venceEm: Date, agora: Date): Prazo {
  const dias = Math.round((meiaNoite(venceEm) - meiaNoite(agora)) / 86_400_000);

  if (dias < 0) {
    return { texto: `venceu há ${-dias} ${-dias === 1 ? 'dia' : 'dias'}`, urgente: true };
  }
  if (dias === 0) return { texto: 'vence hoje', urgente: true };
  return { texto: `vence em ${dias} ${dias === 1 ? 'dia' : 'dias'}`, urgente: dias <= 3 };
}
