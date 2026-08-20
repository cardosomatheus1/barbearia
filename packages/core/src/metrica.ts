import type { Permissao } from './permissoes.js';

/**
 * O schema semântico de métricas (bloco 63, SPEC §4.15).
 *
 * > *"Implementação: **text-to-query sobre um schema semântico restrito**, não
 * > SQL livre. Um conjunto fechado de métricas e dimensões validadas, com escopo
 * > de tenant aplicado na camada de dados — jamais confiando no prompt para
 * > isolar tenant."*
 *
 * Este arquivo é o "conjunto fechado". Ele não executa nada e não sabe o que é um
 * banco: é a lista do que se pode perguntar, e o que cada resposta significa.
 *
 * ## Por que o catálogo é dado, e não um `switch` no assistente
 *
 * O bloco 64 vai traduzir português para uma destas entradas. Se a tradução
 * pudesse produzir qualquer coisa, o modelo seria a fronteira de segurança — e
 * modelo não é fronteira. Aqui a fronteira é o tipo: o que não está nesta lista
 * não existe, e o executor recusa antes de tocar no banco.
 *
 * ## A permissão viaja com a métrica
 *
 * É a decisão mais importante do bloco. "Quanto faturei este mês" é
 * `finance.view`; "quantos clientes estão em risco" é `customers.view`. Sem isso,
 * o assistente viraria o caminho mais curto para tudo que o painel guarda — a
 * recepcionista perguntaria o faturamento no chat e receberia, porque a rota do
 * chat estaria declarada com a permissão de *conversar*.
 *
 * É a regra da rota que agrega levada ao limite: aqui uma rota só responde
 * dezenas de perguntas, então a permissão não pode morar na rota. Ela mora no
 * que foi perguntado.
 *
 * ## Toda resposta diz onde conferir
 *
 * *"Toda resposta traz o número, o período, a fonte e um link para a tela onde
 * ele pode ser conferido."* Por isso `tela` é obrigatório no tipo: um número sem
 * onde conferir é um número que o dono não pode usar para decidir nada — e a
 * primeira vez que ele discordar do que está na tela, o assistente inteiro perde
 * o crédito.
 */

/**
 * Como o número é lido. Decide a formatação, e ela não é escrita por métrica.
 *
 * Uma métrica nova que trouxesse o próprio formatador acabaria com "R$ 1290,00"
 * numa tela e "1290 reais" na outra.
 */
export type UnidadeDaMetrica = 'centavos' | 'contagem' | 'pontos_base' | 'minutos' | 'dias';

/**
 * Por onde a métrica pode ser quebrada.
 *
 * Fechada de propósito: `profissional` e `servico` são as duas que a SPEC pede
 * em letras ("qual barbeiro tem maior ticket médio", "qual serviço dá maior
 * margem"). Dimensão nova entra aqui, com o executor que a sustenta — nunca uma
 * string que o assistente inventa.
 */
export const DIMENSOES = ['nenhuma', 'profissional', 'servico', 'unidade'] as const;
export type DimensaoDaMetrica = (typeof DIMENSOES)[number];

export interface DefinicaoDeMetrica {
  readonly chave: string;
  /** Como a métrica é chamada na resposta. */
  readonly rotulo: string;
  /**
   * O que ela **é**, em uma frase, para a resposta poder explicar-se.
   *
   * Não é documentação: é o texto que vai junto do número. "Faturamento" sem
   * dizer que é o total pago no período é o que faz o dono comparar com um
   * número de outro lugar e concluir que o produto erra.
   */
  readonly significado: string;
  readonly unidade: UnidadeDaMetrica;
  /**
   * A permissão que a pergunta exige. Ver o cabeçalho — ela viaja com a métrica.
   */
  readonly exige: readonly Permissao[];
  readonly dimensoes: readonly DimensaoDaMetrica[];
  /** Onde o número pode ser conferido. Obrigatório: ver o cabeçalho. */
  readonly tela: string;
  /**
   * Se subir é bom. A resposta usa isto para não pintar de verde uma piora.
   *
   * É a lição do comparativo do DRE: uma seta verde para cima em "Faltas" é a
   * tela dizendo o contrário do número.
   */
  readonly subirEBom: boolean;
}

/**
 * O catálogo.
 *
 * A ordem é a das perguntas da SPEC §4.15, e não é decorativa: ela é a ordem em
 * que as sugestões aparecem para quem abre o assistente sem saber o que
 * perguntar.
 */
export const METRICAS = [
  {
    chave: 'faturamento',
    rotulo: 'Faturamento',
    significado: 'O total das comandas pagas no período, pelo dia da barbearia.',
    unidade: 'centavos',
    exige: ['finance.view'],
    dimensoes: ['nenhuma', 'profissional', 'unidade'],
    /**
     * O Painel, e não Contas (bloco 114).
     *
     * `/admin/financeiro` chama-se **Contas** desde o bloco 103 e mostra o que a
     * casa deve e tem a receber — não há faturamento nem ticket ali. O dono
     * clicava em "Conferir na tela", não encontrava o número e concluía que um
     * dos dois erra. A SPEC §4.15 pede o link para onde o número **pode ser
     * conferido**, que é o que impede o assistente de virar oráculo.
     */
    tela: '/admin/painel',
    subirEBom: true,
  },
  {
    chave: 'ticket_medio',
    rotulo: 'Ticket médio',
    significado: 'Quanto cada comanda paga trouxe, em média, no período.',
    unidade: 'centavos',
    exige: ['finance.view'],
    dimensoes: ['nenhuma', 'profissional', 'unidade'],
    tela: '/admin/painel',
    subirEBom: true,
  },
  {
    chave: 'atendimentos',
    rotulo: 'Atendimentos concluídos',
    significado: 'Quantos atendimentos terminaram no período.',
    unidade: 'contagem',
    exige: ['appointments.view'],
    dimensoes: ['nenhuma', 'profissional', 'servico', 'unidade'],
    tela: '/admin/agenda',
    subirEBom: true,
  },
  {
    chave: 'faltas',
    rotulo: 'Faltas',
    significado: 'Quantos não apareceram sem avisar, no período.',
    unidade: 'contagem',
    exige: ['appointments.view'],
    dimensoes: ['nenhuma', 'profissional', 'unidade'],
    tela: '/admin/agenda',
    subirEBom: false,
  },
  {
    chave: 'perda_por_falta',
    rotulo: 'Perdido com falta',
    significado: 'A soma do preço dos horários em que ninguém apareceu.',
    unidade: 'centavos',
    exige: ['finance.view', 'appointments.view'],
    dimensoes: ['nenhuma', 'profissional', 'unidade'],
    tela: '/admin/agenda',
    subirEBom: false,
  },
  {
    chave: 'clientes_em_risco',
    rotulo: 'Clientes em risco',
    significado: 'Quantos passaram do próprio ritmo de retorno e ainda não voltaram.',
    unidade: 'contagem',
    exige: ['customers.view'],
    dimensoes: ['nenhuma'],
    tela: '/admin/retencao',
    subirEBom: false,
  },
  {
    chave: 'ocupacao',
    rotulo: 'Ocupação',
    significado: 'Quanto da agenda aberta foi vendido no período.',
    unidade: 'pontos_base',
    exige: ['reports.operational'],
    dimensoes: ['nenhuma', 'profissional', 'unidade'],
    tela: '/admin/campanhas',
    subirEBom: true,
  },
  {
    chave: 'rentabilidade_do_clube',
    rotulo: 'Margem do clube',
    significado: 'Quanto sobra da mensalidade dos assinantes depois da comissão e do insumo.',
    unidade: 'pontos_base',
    /**
     * `finance.view_profit`, pela mesma razão da margem por serviço — e a
     * pergunta está na SPEC §4.15 em letras: *"minha assinatura é rentável?"*.
     *
     * Ela é a única do catálogo que responde sobre o clube, e não tem dimensão:
     * quebrar por profissional aqui seria a comissão da assinatura, que é outra
     * pergunta e tem tela própria.
     */
    exige: ['finance.view_profit'],
    dimensoes: ['nenhuma'],
    tela: '/admin/clube',
    subirEBom: true,
  },
  {
    chave: 'margem_por_servico',
    rotulo: 'Margem por serviço',
    significado: 'Quanto sobra de cada serviço depois da comissão e do insumo.',
    unidade: 'pontos_base',
    /**
     * `finance.view_profit`, e não `finance.view`.
     *
     * O gerente padrão tem a segunda e não a primeira: é assim que o dono delega
     * a operação sem entregar a estratégia. Uma pergunta em português não pode
     * ser o atalho que a tela não é.
     */
    exige: ['finance.view_profit'],
    dimensoes: ['nenhuma', 'servico'],
    /**
     * Estoque, e não o DRE: é lá que "O que sobra de cada serviço" está
     * desenhado, pela mesma `margemPorServico` que responde esta pergunta.
     */
    tela: '/admin/estoque',
    subirEBom: true,
  },
] as const satisfies readonly DefinicaoDeMetrica[];

export type ChaveDeMetrica = (typeof METRICAS)[number]['chave'];

const POR_CHAVE = new Map<string, DefinicaoDeMetrica>(METRICAS.map((m) => [m.chave, m]));

export function ehMetrica(chave: string): chave is ChaveDeMetrica {
  return POR_CHAVE.has(chave);
}

export function definicaoDaMetrica(chave: ChaveDeMetrica): DefinicaoDeMetrica {
  const achada = POR_CHAVE.get(chave);
  /**
   * O tipo já garante, e a guarda existe mesmo assim.
   *
   * `ChaveDeMetrica` só é verdade em quem compilou junto: uma chave vinda do
   * corpo de uma requisição atravessa `ehMetrica` e um `as`, e é aí que um dia
   * alguém esquece a conferência. Erro explícito é melhor que `undefined`
   * viajando para dentro do executor.
   */
  if (!achada) throw new Error(`métrica desconhecida: ${chave}`);
  return achada;
}

export type FalhaDaPergunta =
  | 'metrica_desconhecida'
  | 'dimensao_nao_suportada'
  | 'periodo_invalido'
  | 'sem_permissao';

export interface PerguntaValidada {
  readonly metrica: ChaveDeMetrica;
  readonly dimensao: DimensaoDaMetrica;
  readonly de: string;
  readonly ate: string;
}

/**
 * Quantos dias uma pergunta pode abranger.
 *
 * Teto nas duas pontas, como toda janela deste código desde o achado do bloco
 * 41: só o começo conferido deixa "de hoje até 2099" passar.
 */
export const DIAS_MAXIMOS_DA_PERGUNTA = 366;

/**
 * Valida a pergunta **antes** de qualquer ida ao banco.
 *
 * As permissões de quem pergunta entram por parâmetro e saem do banco, nunca do
 * pedido: é a mesma regra de "ninguém concede o que não tem". O modelo do bloco
 * 64 propõe uma pergunta; quem decide se ela pode ser respondida é isto aqui.
 */
export function validarPergunta(
  pedido: { readonly metrica: string; readonly dimensao: string; readonly de: string; readonly ate: string },
  permissoesDeQuemPergunta: readonly string[],
): { readonly ok: true; readonly pergunta: PerguntaValidada; readonly definicao: DefinicaoDeMetrica }
  | { readonly ok: false; readonly falha: FalhaDaPergunta } {
  if (!ehMetrica(pedido.metrica)) return { ok: false, falha: 'metrica_desconhecida' };
  const definicao = definicaoDaMetrica(pedido.metrica);

  const dimensao = pedido.dimensao as DimensaoDaMetrica;
  if (!definicao.dimensoes.includes(dimensao)) {
    return { ok: false, falha: 'dimensao_nao_suportada' };
  }

  if (!ehDia(pedido.de) || !ehDia(pedido.ate) || pedido.de > pedido.ate) {
    return { ok: false, falha: 'periodo_invalido' };
  }
  const dias =
    (Date.parse(`${pedido.ate}T00:00:00Z`) - Date.parse(`${pedido.de}T00:00:00Z`)) / 86_400_000;
  if (dias >= DIAS_MAXIMOS_DA_PERGUNTA) return { ok: false, falha: 'periodo_invalido' };

  /**
   * A permissão é conferida **aqui**, e de novo na borda.
   *
   * Aqui porque a mensagem precisa ser honesta — "você não tem acesso a este
   * número" é diferente de "não entendi a pergunta" —, e na borda porque uma
   * validação de domínio não é uma guarda de rota. Duas camadas, e a de baixo
   * não confia na de cima.
   */
  const tem = new Set(permissoesDeQuemPergunta);
  if (!definicao.exige.every((p) => tem.has(p))) return { ok: false, falha: 'sem_permissao' };

  return {
    ok: true,
    pergunta: { metrica: pedido.metrica, dimensao, de: pedido.de, ate: pedido.ate },
    definicao,
  };
}

/**
 * Uma data de calendário que existe.
 *
 * Só a forma não basta: `2026-02-31` passa pela expressão regular, chega ao
 * Postgres e estoura como 500 — e entrada malformada que devolve 500 é defeito
 * de borda, sempre. É o achado da revisão do bloco 62, aplicado desde o começo
 * aqui.
 */
function ehDia(texto: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const instante = Date.parse(`${texto}T00:00:00Z`);
  return !Number.isNaN(instante) && new Date(instante).toISOString().slice(0, 10) === texto;
}

/**
 * O que uma métrica só pode responder quando a pergunta cabe nela.
 *
 * As perguntas que a SPEC lista viram sugestões na tela, e cada uma já nasce
 * apontando para uma entrada do catálogo. Escrever a sugestão à mão na tela
 * seria a lista paralela que este repositório já achou duas vezes.
 */
export const PERGUNTAS_SUGERIDAS: readonly {
  readonly texto: string;
  readonly metrica: ChaveDeMetrica;
  readonly dimensao: DimensaoDaMetrica;
}[] = [
  { texto: 'Quanto faturei neste período?', metrica: 'faturamento', dimensao: 'nenhuma' },
  { texto: 'Qual barbeiro tem o maior ticket médio?', metrica: 'ticket_medio', dimensao: 'profissional' },
  { texto: 'Quantos clientes estão em risco?', metrica: 'clientes_em_risco', dimensao: 'nenhuma' },
  { texto: 'Quanto perdi com falta?', metrica: 'perda_por_falta', dimensao: 'nenhuma' },
  { texto: 'Qual serviço dá a maior margem?', metrica: 'margem_por_servico', dimensao: 'servico' },
  { texto: 'Como está a ocupação por barbeiro?', metrica: 'ocupacao', dimensao: 'profissional' },
];

/**
 * O nome da fatia que não tem nome.
 *
 * Uma venda avulsa de produto não tem barbeiro; uma comanda sem atendimento não
 * tem serviço. Agrupadas, elas viram uma linha com o rótulo nulo — e a tela
 * desenhava uma célula em branco ao lado de um valor, que é o número mentindo
 * por omissão.
 *
 * Dizer "sem barbeiro" é a mesma regra do relatório que ignora parte do dado: o
 * número sai completo, com cara de completo, e quem lê decide em cima dele.
 */
export const SEM_ROTULO: Readonly<Record<DimensaoDaMetrica, string>> = {
  nenhuma: 'Total',
  profissional: 'Sem barbeiro (venda avulsa)',
  servico: 'Sem serviço',
  unidade: 'Sem unidade',
};

/** O número já formatado, para a tela e a resposta dizerem a mesma coisa. */
export function formatarMetrica(valor: number | null, unidade: UnidadeDaMetrica): string {
  if (valor === null) return '—';
  switch (unidade) {
    case 'centavos':
      return (valor / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    case 'pontos_base':
      return `${(valor / 100).toFixed(1).replace('.', ',')}%`;
    case 'minutos':
      return `${Math.round(valor)} min`;
    case 'dias':
      return `${Math.round(valor)} ${Math.round(valor) === 1 ? 'dia' : 'dias'}`;
    case 'contagem':
      return String(Math.round(valor));
  }
}
