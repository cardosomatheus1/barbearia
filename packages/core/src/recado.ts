/**
 * Recados do cliente: sugestão, reclamação e elogio (bloco 40).
 *
 * ## Por que isto não é avaliação
 *
 * A avaliação da SPEC §4.10 é uma nota de 1 a 5 presa a um atendimento
 * concluído — e é confiável exatamente por isso. O recado é o outro lado: o
 * cliente que quer dizer alguma coisa **sem ter uma nota para dar**. "A cadeira
 * do fundo está bamba", "vocês deviam abrir no domingo", "esperei quarenta
 * minutos". Nada disso cabe numa estrela, e nada disso exige atendimento
 * nenhum — quem desistiu da fila e foi embora é justamente quem mais tem o que
 * contar.
 *
 * Três diferenças que fazem dele um bloco próprio:
 *
 * - **A entrada.** Avaliação nasce de um atendimento; recado nasce de uma
 *   vontade. Amarrá-lo a um agendamento perderia quem nunca foi atendido.
 * - **O destino.** Nota baixa vira alerta com prazo de 48h. Recado vira fila de
 *   triagem sem prazo, que alguém lê quando dá.
 * - **A publicação.** Avaliação vai para o perfil público. Recado **não vai** —
 *   é conversa entre o cliente e a casa, e publicá-lo transformaria um canal de
 *   melhoria em vitrine de problema.
 *
 * ## O limite ético é o mesmo da avaliação
 *
 * O produto não oferece apagar reclamação. Aqui isso não é promessa de tela: a
 * tabela do bloco 40 nasce sem `DELETE` para a aplicação. Encerrar um recado é
 * um estado, e o texto continua lá.
 */

export const TIPOS_DE_RECADO = ['sugestao', 'reclamacao', 'elogio'] as const;
export type TipoDeRecado = (typeof TIPOS_DE_RECADO)[number];

export const ESTADOS_DO_RECADO = [
  'aberto',
  'em_analise',
  'respondido',
  'encerrado',
] as const;
export type EstadoDoRecado = (typeof ESTADOS_DO_RECADO)[number];

/**
 * O vocabulário, num lugar só.
 *
 * Mesma decisão do vocabulário de atendimento (CLAUDE.md §6): a recepção diz
 * "já respondi o Ruan" e o dono procura o mesmo botão. Escrever o rótulo em
 * cada tela é como o produto acaba com três nomes para a mesma coisa.
 */
export const ROTULO_DO_TIPO: Readonly<Record<TipoDeRecado, string>> = {
  sugestao: 'Sugestão',
  reclamacao: 'Reclamação',
  elogio: 'Elogio',
};

export const ROTULO_DO_RECADO: Readonly<Record<EstadoDoRecado, string>> = {
  aberto: 'Aberto',
  em_analise: 'Em análise',
  respondido: 'Respondido',
  encerrado: 'Encerrado',
};

/** O que o botão diz, para a transição sair com o mesmo nome em toda tela. */
export const VERBO_DO_RECADO: Readonly<Record<EstadoDoRecado, string>> = {
  aberto: 'Reabrir',
  em_analise: 'Assumir',
  respondido: 'Responder',
  encerrado: 'Encerrar',
};

/**
 * Piso e teto do texto.
 *
 * O piso não é burocracia: um recado de três caracteres não diz nada e ainda
 * ocupa a fila de quem lê. O teto é a borda — texto livre sem limite é como uma
 * caixa de entrada vira depósito.
 */
export const MINIMO_DO_RECADO = 10;
export const MAXIMO_DO_RECADO = 2000;
export const MAXIMO_DA_RESPOSTA = 1000;

export type RecusaDoRecado = 'texto_curto' | 'texto_longo' | 'tipo_invalido';

export function podeRegistrarRecado(pedido: {
  readonly tipo: string;
  readonly texto: string;
}): { readonly aceito: true } | { readonly aceito: false; readonly recusa: RecusaDoRecado } {
  if (!(TIPOS_DE_RECADO as readonly string[]).includes(pedido.tipo)) {
    return { aceito: false, recusa: 'tipo_invalido' };
  }
  const texto = pedido.texto.trim();
  if (texto.length < MINIMO_DO_RECADO) return { aceito: false, recusa: 'texto_curto' };
  if (texto.length > MAXIMO_DO_RECADO) return { aceito: false, recusa: 'texto_longo' };
  return { aceito: true };
}

/**
 * As transições que existem.
 *
 * `encerrado` é terminal de propósito, e `respondido` **não** é: o cliente pode
 * responder de volta, e o recado precisa poder voltar à análise sem virar um
 * recado novo — senão a mesma conversa aparece três vezes na fila.
 *
 * Todo estado não-terminal tem pelo menos uma saída, e é o que a tela precisa
 * desenhar (CLAUDE.md §6).
 */
const SAIDAS: Readonly<Record<EstadoDoRecado, readonly EstadoDoRecado[]>> = {
  aberto: ['em_analise', 'respondido', 'encerrado'],
  em_analise: ['respondido', 'encerrado', 'aberto'],
  respondido: ['encerrado', 'em_analise'],
  encerrado: [],
};

export function transicaoDoRecado(de: EstadoDoRecado, para: EstadoDoRecado): boolean {
  return SAIDAS[de].includes(para);
}

export function saidasDoRecado(de: EstadoDoRecado): readonly EstadoDoRecado[] {
  return SAIDAS[de];
}

/**
 * A ordem da fila de triagem.
 *
 * **Reclamação primeiro, e não a mais antiga primeiro.** É a única decisão de
 * produto desta ordenação: quem reclamou está insatisfeito agora, e um elogio
 * de ontem esperando na frente dele é a fila trabalhando contra si mesma. Entre
 * dois do mesmo tipo, o mais antigo vem antes — senão o recado de segunda-feira
 * nunca é lido.
 *
 * Recado que já tem dono cai para o fim: ele não está esperando triagem, está
 * esperando alguém que já sabe que ele existe.
 */
const PESO_DO_TIPO: Readonly<Record<TipoDeRecado, number>> = {
  reclamacao: 0,
  sugestao: 1,
  elogio: 2,
};

export interface RecadoNaFila {
  readonly id: string;
  readonly tipo: TipoDeRecado;
  readonly estado: EstadoDoRecado;
  readonly criadoEm: Date;
  readonly responsavelId: string | null;
}

export function ordenarTriagem<T extends RecadoNaFila>(recados: readonly T[]): readonly T[] {
  return [...recados].sort((a, b) => {
    const donoA = a.responsavelId ? 1 : 0;
    const donoB = b.responsavelId ? 1 : 0;
    if (donoA !== donoB) return donoA - donoB;
    const tipo = PESO_DO_TIPO[a.tipo] - PESO_DO_TIPO[b.tipo];
    if (tipo !== 0) return tipo;
    return a.criadoEm.getTime() - b.criadoEm.getTime();
  });
}

/**
 * Há quantos dias este recado está esperando.
 *
 * A fila não tem prazo — é decisão do bloco, e está escrita no ROADMAP: recado
 * não é alerta de recuperação de nota, que tem 48h. Mas "aberto há 9 dias"
 * precisa aparecer, senão a fila envelhece em silêncio e o canal morre sem
 * ninguém notar.
 */
export function diasEsperando(criadoEm: Date, agora: Date): number {
  return Math.max(0, Math.floor((agora.getTime() - criadoEm.getTime()) / 86_400_000));
}
