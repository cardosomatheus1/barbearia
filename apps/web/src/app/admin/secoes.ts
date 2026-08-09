/**
 * Onde cada tela do painel mora.
 *
 * Separado de `casco.tsx` porque isto é **dado**, e o casco é desenho. A
 * separação tem uma consequência prática que motivou a mudança: o registro
 * pode ser lido por um teste sem arrastar o runtime de JSX junto — os ícones do
 * trilho são SVG em TSX, e importar o casco inteiro só para conferir uma lista
 * de strings fazia a guarda quebrar por um motivo que não tem nada a ver com o
 * que ela guarda.
 *
 * Uma tela nova entra **aqui**, e só aqui. O CSS não precisa saber dela; o
 * `data-modulo-atual` que `secao()` devolve é o que acende o módulo.
 */

export type Modulo = 'operacao' | 'dinheiro' | 'casa';

export interface Destino {
  readonly href: string;
  readonly nome: string;
  readonly secao: string;
  /** Uma frase do que a tela faz. É o que o mock põe embaixo de cada item. */
  readonly nota: string;
}

export interface ModuloDoPainel {
  readonly id: Modulo;
  readonly nome: string;
  readonly telas: readonly Destino[];
  /**
   * Seções que **pertencem** ao módulo sem serem destino de navegação: a ficha
   * do cliente, a comanda aberta, o onboarding. O gestor chega nelas por dentro
   * de outra tela, e o módulo precisa continuar aceso enquanto ele está lá.
   */
  readonly dentro: readonly string[];
}

export const MODULOS = [
  {
    id: 'operacao',
    nome: 'Operação',
    telas: [
      { href: '/admin/dia', nome: 'O dia', secao: 'dia', nota: 'quem chegou e quem falta' },
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', nota: 'dia, semana e lista' },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'quem veio sem marcar' },
      { href: '/admin/avisos', nome: 'Avisos', secao: 'avisos', nota: 'lembretes e retorno' },
    ],
    dentro: ['cliente', 'meu-dia'],
  },
  {
    id: 'dinheiro',
    nome: 'Dinheiro',
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', nota: 'abertura e fechamento' },
      { href: '/admin/comanda', nome: 'Comanda', secao: 'comanda', nota: 'cobrar o atendimento' },
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', nota: 'quem ficou devendo' },
      { href: '/admin/comissao', nome: 'Comissão', secao: 'comissao', nota: 'período e fechamento' },
    ],
    // Os números do barbeiro são faturamento e comissão dele: é dinheiro, e não
    // operação. Quem liga as duas telas dele é a `ProNav`, não o trilho.
    dentro: ['meus-numeros'],
  },
  {
    id: 'casa',
    nome: 'A casa',
    telas: [
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', nota: 'os números do dia' },
      { href: '/admin/catalogo', nome: 'Cadastro', secao: 'cadastro', nota: 'serviços e equipe' },
      { href: '/admin/equipe', nome: 'Equipe', secao: 'equipe', nota: 'contas e permissões' },
      { href: '/admin/importar', nome: 'Trazer base', secao: 'importar', nota: 'migrar de outro sistema' },
      { href: '/admin/trilha', nome: 'Trilha', secao: 'trilha', nota: 'quem mexeu em quê' },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'segundo fator' },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'janela e políticas' },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', nota: 'pedidos dos clientes' },
      { href: '/admin/plano', nome: 'Plano', secao: 'plano', nota: 'assinatura e limites' },
    ],
    dentro: ['onboarding'],
  },
] as const satisfies readonly ModuloDoPainel[];

/**
 * Toda seção que o casco conhece.
 *
 * Derivado do array acima, então `secao('inventada')` não compila.
 */
export type Secao =
  | (typeof MODULOS)[number]['telas'][number]['secao']
  | (typeof MODULOS)[number]['dentro'][number];

const MODULO_DA_SECAO = new Map<string, Modulo>(
  MODULOS.flatMap((m) => [
    ...m.telas.map((t) => [t.secao, m.id] as const),
    ...m.dentro.map((s) => [s, m.id] as const),
  ]),
);

/**
 * Os atributos que toda tela de dentro do casco põe no próprio `<main>`.
 *
 * ```tsx
 * <main className="ui-container painel__conteudo" {...secao('dia')}>
 * ```
 *
 * São dois, e cada um serve a uma coisa: `data-secao` acende o link da tela na
 * lista de contexto; `data-modulo-atual` acende o módulo no trilho e revela a
 * lista dele.
 *
 * O segundo existe para o CSS **não** precisar enumerar as seções. Antes ele
 * listava as quinze, em quatro blocos — sessenta seletores escritos à mão que
 * ninguém ia lembrar de editar. E o preço de esquecer não era uma tela feia:
 * havia um `casco:not(:has([data-secao]))` que caía em "Operação", então
 * `/admin/meu-dia` mostrava a lista errada com nenhum módulo aceso. Cinco telas
 * estavam assim, por dois blocos, sem ninguém notar.
 */
export function secao(nome: Secao): {
  readonly 'data-secao': string;
  readonly 'data-modulo-atual': Modulo;
} {
  const modulo = MODULO_DA_SECAO.get(nome);
  // Inalcançável pelo tipo; existe para quem alargar `Secao` à mão.
  if (!modulo) throw new Error(`seção fora do casco: ${nome}`);
  return { 'data-secao': nome, 'data-modulo-atual': modulo };
}

/** As seções de cada módulo. A guarda do casco confere que nada ficou de fora. */
export const SECOES_POR_MODULO: Readonly<Record<Modulo, readonly string[]>> = {
  operacao: [...MODULOS[0].telas.map((t) => t.secao), ...MODULOS[0].dentro],
  dinheiro: [...MODULOS[1].telas.map((t) => t.secao), ...MODULOS[1].dentro],
  casa: [...MODULOS[2].telas.map((t) => t.secao), ...MODULOS[2].dentro],
};
