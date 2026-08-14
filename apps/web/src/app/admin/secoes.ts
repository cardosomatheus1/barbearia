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
  /**
   * O recurso da plataforma que liga esta tela, quando ela depende de um
   * (bloco 26). Ausente é o caso normal: a tela é do produto e existe sempre.
   *
   * O código é `string` e não uma união escrita aqui de propósito — o catálogo
   * mora em `packages/platform`, e copiá-lo para cá seria a lista paralela que
   * `secoes.ts` já custou uma vez. Quem impede o erro de digitação é
   * `scripts/recursos-da-navegacao.test.mjs`, que compara os dois arquivos: um
   * código inexistente esconderia a tela para sempre, e em silêncio.
   */
  readonly recurso?: string;
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
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'clientes que chegaram sem marcar', recurso: 'fila' },
      { href: '/admin/avisos', nome: 'Lembretes', secao: 'avisos', nota: 'retornos e pendências de clientes', recurso: 'avisos' },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', nota: 'sugestões e reclamações de clientes' },
      { href: '/admin/recepcao', nome: 'Recepção', secao: 'recepcao', nota: 'perguntas que o site não soube responder' },
      { href: '/admin/avaliacoes', nome: 'Avaliações', secao: 'avaliacoes', nota: 'notas dos atendimentos e nota baixa a tratar' },
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
      { href: '/admin/financeiro', nome: 'Contas', secao: 'financeiro', nota: 'o que a casa deve e tem a receber' },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', nota: 'o que a casa precisa pagar' },
      { href: '/admin/dre', nome: 'Resultado', secao: 'dre', nota: 'o que sobrou depois de tudo' },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', nota: 'pontos, visitas ou cashback' },
    ],
    dentro: ['meus-numeros'],
  },
  {
    id: 'cadastros',
    nome: 'Cadastros',
    telas: [
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', nota: 'preço, duração e regras do serviço' },
      { href: '/admin/precos', nome: 'Preços por horário', secao: 'precos', nota: 'cobrar menos na hora vazia e mais na cheia' },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', nota: 'combos pagos adiantado, como 5 cortes' },
      { href: '/admin/estoque', nome: 'Estoque', secao: 'estoque', nota: 'produtos, contagem e ficha de consumo' },
      { href: '/admin/clube', nome: 'Clube', secao: 'clube', nota: 'planos de assinatura e quem assina' },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', nota: 'barbeiros, jornadas e metas' },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', nota: 'cadeiras, lavatórios e salas' },
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', nota: 'logo e imagens da página pública' },
      { href: '/admin/franquia', nome: 'Franquia', secao: 'franquia', nota: 'o cardápio padrão da rede e o que esta casa adotou' },
    ],
    dentro: [],
  },
  {
    id: 'administracao',
    nome: 'Administração',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', nota: 'contas, papéis e permissões' },
      { href: '/admin/unidades', nome: 'Unidades', secao: 'unidades', nota: 'lojas da rede, quem opera cada uma e estoque entre elas' },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'horários, políticas e preferências' },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'senha e segundo fator' },
      { href: '/admin/chaves', nome: 'Chaves de API', secao: 'chaves', nota: 'integração do seu site ou do seu ERP' },
      { href: '/admin/webhooks', nome: 'Webhooks', secao: 'webhooks', nota: 'avisar outro sistema quando algo acontece aqui' },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', nota: 'histórico de alterações' },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', nota: 'trazer base de outro sistema', recurso: 'importacao' },
      { href: '/admin/fiscal', nome: 'Nota fiscal', secao: 'fiscal', nota: 'CNPJ, regime e notas emitidas', recurso: 'fiscal' },
      { href: '/admin/whatsapp', nome: 'WhatsApp', secao: 'whatsapp', nota: 'número da casa e textos aprovados' },
      { href: '/admin/automacoes', nome: 'Automações', secao: 'automacoes', nota: 'o que a casa manda sozinha' },
      { href: '/admin/campanhas', nome: 'Campanhas', secao: 'campanhas', nota: 'horários vazios e quem chamar' },
      { href: '/admin/retencao', nome: 'Retenção', secao: 'retencao', nota: 'quem está indo embora, e por quê' },
      { href: '/admin/assistente', nome: 'Assistente', secao: 'assistente', nota: 'pergunte em português' },
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

/**
 * O menu, já sem o que a plataforma não ligou para esta barbearia.
 *
 * Um destino com `recurso` só aparece quando aquele recurso está ligado — e
 * quem responde é o servidor, pela mesma função que a `PermissaoGuard`
 * consulta.
 *
 * **Não é o mesmo caso da permissão.** Sem permissão o item continua no menu e
 * a tela explica, porque quem decide é o dono e ele pode liberar. Sem o
 * recurso, quem decidiu foi a plataforma: o dono não tem o que fazer com um
 * link que responde 404, e mandá-lo procurar quem libera é o pior recado
 * possível. É a mesma razão de a guarda responder 404 e não 403.
 *
 * O módulo que ficasse sem nenhuma tela sai junto — um ícone no trilho que abre
 * uma lista vazia é a pessoa tocando e nada acontecendo.
 *
 * Mora aqui e não no casco de propósito: quem sabe filtrar o registro é o
 * registro, e assim a regra é testável sem montar JSX.
 */
export function modulosVisiveis(recursos: readonly string[]): readonly ModuloDoPainel[] {
  return REGISTRO.map((modulo) => ({
    ...modulo,
    telas: modulo.telas.filter((tela) => !tela.recurso || recursos.includes(tela.recurso)),
  })).filter((modulo) => modulo.telas.length > 0);
}

/**
 * O mesmo registro, pelo tipo largo.
 *
 * `MODULOS` é `as const` porque `Secao` sai dos literais dele — e o preço é que
 * cada destino tem um tipo próprio, sem `recurso` naqueles que não o declaram.
 * Perguntar `tela.recurso` ali não compila. O `satisfies` na declaração é quem
 * garante que esta visão não mente.
 */
const REGISTRO: readonly ModuloDoPainel[] = MODULOS;

/** Os destinos que só existem quando a plataforma liga o recurso. */
export const DESTINOS_GATEADOS: readonly (Destino & { readonly recurso: string })[] = REGISTRO
  .flatMap((modulo) => modulo.telas)
  .filter((tela): tela is Destino & { readonly recurso: string } => tela.recurso !== undefined);

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
