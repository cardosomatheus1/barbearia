/**
 * Arquitetura de navegação do painel.
 *
 * A regra aqui é simples: o menu deve refletir a pergunta que o gestor está
 * tentando responder, e não a estrutura interna do código. Por isso o painel
 * é dividido em cinco áreas claras: visão geral, atendimento, financeiro,
 * cadastros e administração.
 */

export type Modulo = 'inicio' | 'atendimento' | 'financeiro' | 'cadastros' | 'administracao';

export interface Destino {
  readonly href: string;
  readonly nome: string;
  readonly secao: string;
  readonly nota: string;
}

export interface ModuloDoPainel {
  readonly id: Modulo;
  readonly nome: string;
  readonly telas: readonly Destino[];
  /** Seções que pertencem ao módulo, mas são abertas a partir de outra tela. */
  readonly dentro: readonly string[];
}

export const MODULOS = [
  {
    id: 'inicio',
    nome: 'Visão geral',
    telas: [
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', nota: 'indicadores e visão do negócio' },
    ],
    dentro: [],
  },
  {
    id: 'atendimento',
    nome: 'Atendimento',
    telas: [
      { href: '/admin/dia', nome: 'Hoje', secao: 'dia', nota: 'operação do dia em tempo real' },
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', nota: 'dia, semana e próximos horários' },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'clientes que chegaram sem marcar' },
      { href: '/admin/avisos', nome: 'Lembretes', secao: 'avisos', nota: 'retornos e pendências de clientes' },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', nota: 'sugestões e reclamações de clientes' },
    ],
    dentro: ['cliente', 'meu-dia'],
  },
  {
    id: 'financeiro',
    nome: 'Financeiro',
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', nota: 'abertura, movimentos e fechamento' },
      { href: '/admin/comanda', nome: 'Comandas', secao: 'comanda', nota: 'cobrança dos atendimentos' },
      { href: '/admin/fiado', nome: 'Pendências', secao: 'fiado', nota: 'valores em aberto de clientes' },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', nota: 'o que a casa precisa pagar' },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', nota: 'pontos, visitas ou cashback' },
    ],
    dentro: ['meus-numeros'],
  },
  {
    id: 'cadastros',
    nome: 'Cadastros',
    telas: [
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', nota: 'preço, duração e regras do serviço' },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', nota: 'combos pagos adiantado, como 5 cortes' },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', nota: 'barbeiros, jornadas e metas' },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', nota: 'cadeiras, lavatórios e salas' },
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', nota: 'logo e imagens da página pública' },
    ],
    dentro: [],
  },
  {
    id: 'administracao',
    nome: 'Administração',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', nota: 'contas, papéis e permissões' },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'horários, políticas e preferências' },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'senha e segundo fator' },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', nota: 'histórico de alterações' },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', nota: 'trazer base de outro sistema' },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', nota: 'solicitações e dados de clientes' },
      { href: '/admin/plano', nome: 'Plano e cobrança', secao: 'plano', nota: 'assinatura, uso e limites' },
    ],
    dentro: ['onboarding'],
  },
] as const satisfies readonly ModuloDoPainel[];

export type Secao =
  | (typeof MODULOS)[number]['telas'][number]['secao']
  | (typeof MODULOS)[number]['dentro'][number];

const MODULO_DA_SECAO = new Map<string, Modulo>(
  MODULOS.flatMap((m) => [
    ...m.telas.map((t) => [t.secao, m.id] as const),
    ...m.dentro.map((s) => [s, m.id] as const),
  ]),
);

export function moduloDaSecao(nome: Secao): Modulo | undefined {
  return MODULO_DA_SECAO.get(nome);
}

export function secao(nome: Secao): {
  readonly 'data-secao': string;
  readonly 'data-modulo-atual': Modulo;
} {
  const modulo = MODULO_DA_SECAO.get(nome);
  if (!modulo) throw new Error(`seção fora do casco: ${nome}`);
  return { 'data-secao': nome, 'data-modulo-atual': modulo };
}

/**
 * As seções de cada módulo, **derivadas** do registro.
 *
 * A versão anterior escrevia `MODULOS[0]`, `MODULOS[1]`, `MODULOS[2]` à mão: um
 * módulo novo entrava em `MODULOS` e ficava de fora daqui em silêncio — e como
 * a guarda do CSS varre justamente os valores deste mapa, as telas dele
 * escapariam da conferência sem nada ficar vermelho. É o mesmo defeito que
 * `lgpd` e `plano` já tiveram, um nível acima.
 *
 * `Object.fromEntries` devolve assinatura de índice, e o TypeScript não prova
 * que todas as chaves de `Modulo` estão lá — daí a asserção. Ela não fica sem
 * rede: há teste que confere que as chaves são exatamente os ids de `MODULOS`.
 */
const PORTA_ABERTA: Record<string, readonly string[]> = Object.fromEntries(
  MODULOS.map((m) => [m.id, [...m.telas.map((t) => t.secao), ...m.dentro]]),
);

export const SECOES_POR_MODULO = PORTA_ABERTA as Readonly<Record<Modulo, readonly string[]>>;
