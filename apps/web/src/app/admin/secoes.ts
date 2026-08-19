/**
 * Arquitetura de navegação do painel.
 *
 * A regra aqui é simples: o menu deve refletir a pergunta que o gestor está
 * tentando responder, e não a estrutura interna do código.
 *
 * ## Por que sete módulos, e não cinco
 *
 * A primeira divisão tinha cinco áreas, e uma delas — "Administração" —
 * carregava **dezesseis dos quarenta destinos**. Um módulo que junta a folha de
 * permissões, o token da API, a política de privacidade e a campanha de
 * retorno não está organizando nada: está sendo o lugar onde cai o que não
 * coube nos outros quatro. No notebook a lista passava da dobra, e a última
 * tela — plano e cobrança — só aparecia rolando.
 *
 * O corte novo é pela **pergunta que a pessoa está fazendo**:
 *
 * | Módulo | A pergunta |
 * |---|---|
 * | Visão geral | como está o negócio? |
 * | Atendimento | o que está acontecendo agora? |
 * | Financeiro | quanto entrou, quanto saiu, quanto sobrou? |
 * | Marketing | quem não está voltando, e o que a casa manda? |
 * | Cadastros | o que a casa vende e com o quê? |
 * | Integrações | o que fala com o mundo lá fora? |
 * | Administração | quem pode o quê, e as obrigações da empresa |
 *
 * Marketing e Integrações são os dois que saíram de dentro de Administração, e
 * os dois eram exatamente o que estava escondido lá: campanha e automação são a
 * ferramenta de trazer cliente de volta, e ninguém as procura no mesmo lugar
 * onde troca a senha.
 *
 * ## O terceiro nível: `grupo`
 *
 * Módulo com seis ou nove telas vira lista, e lista é o que ninguém lê até o
 * fim. O `grupo` quebra a lista em blocos curtos — *O dia*, *Voz do cliente* —
 * e ele é **dado**, não desenho: o casco emite o rótulo quando o grupo muda, e
 * a ordem do registro é a ordem da tela.
 */

export type Modulo =
  | 'inicio'
  | 'atendimento'
  | 'financeiro'
  | 'marketing'
  | 'cadastros'
  | 'integracoes'
  | 'administracao';

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
  /**
   * O subgrupo dentro do módulo, quando ele tem telas o bastante para pedir um.
   *
   * Ausente é legítimo: módulo curto não precisa de divisão, e inventar um
   * rótulo para quatro itens é hierarquia que não ajuda ninguém. Telas do mesmo
   * grupo ficam **juntas na ordem do registro** — o casco não reordena nada, e
   * um grupo que aparecesse duas vezes seria erro de escrita visível na tela.
   */
  readonly grupo?: string;
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
      { href: '/admin/assistente', nome: 'Assistente', secao: 'assistente', nota: 'pergunte em português' },
    ],
    dentro: [],
  },
  {
    id: 'atendimento',
    nome: 'Atendimento',
    telas: [
      { href: '/admin/dia', nome: 'Hoje', secao: 'dia', nota: 'operação do dia em tempo real', grupo: 'O dia' },
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', nota: 'dia, semana e próximos horários', grupo: 'O dia' },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'clientes que chegaram sem marcar', grupo: 'O dia', recurso: 'fila' },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', nota: 'sugestões e reclamações de clientes', grupo: 'Voz do cliente' },
      { href: '/admin/recepcao', nome: 'Recepção', secao: 'recepcao', nota: 'perguntas que o site não soube responder', grupo: 'Voz do cliente' },
      { href: '/admin/avaliacoes', nome: 'Avaliações', secao: 'avaliacoes', nota: 'notas dos atendimentos e nota baixa a tratar', grupo: 'Voz do cliente' },
    ],
    dentro: ['cliente', 'meu-dia'],
  },
  {
    id: 'financeiro',
    nome: 'Financeiro',
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', nota: 'abertura, movimentos e fechamento', grupo: 'Balcão' },
      // "Cobrar", como o título da tela. Mesmo defeito do fiado, mais leve.
      { href: '/admin/comanda', nome: 'Cobrar', secao: 'comanda', nota: 'cobrança dos atendimentos', grupo: 'Balcão' },
      // "Fiado" e não "Pendências": todo o resto do produto diz fiado — a rota, a
      // função `quemEstaDevendo`, "Pagamento de fiado" no extrato do caixa, o
      // resumo do dia e o próprio título da tela. Quando o dono fala "abre o
      // Fiado", a recepção procurava "Fiado" no menu e não achava (§6, pergunta 2).
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', nota: 'valores em aberto de clientes', grupo: 'Balcão' },
      { href: '/admin/financeiro', nome: 'Contas', secao: 'financeiro', nota: 'o que a casa deve e tem a receber', grupo: 'Fechamento' },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', nota: 'o que a casa precisa pagar', grupo: 'Fechamento' },
      { href: '/admin/dre', nome: 'Resultado', secao: 'dre', nota: 'o que sobrou depois de tudo', grupo: 'Fechamento' },
    ],
    dentro: ['meus-numeros'],
  },
  {
    id: 'marketing',
    nome: 'Marketing',
    telas: [
      /**
       * O WhatsApp abre o grupo, e é onde ele passou a morar (bloco 83).
       *
       * Ele estava em "Integrações", ao lado de nota fiscal, chave de API e
       * webhook — que são coisas de quem liga sistema em sistema. Mas quem abre
       * a tela do WhatsApp é quem vai mandar campanha, e ela é **pré-requisito
       * das duas telas abaixo**: sem número conectado e texto aprovado, nem
       * automação nem campanha chegam a ninguém.
       *
       * Primeiro do grupo por causa disso: a ordem do menu passa a ser a ordem
       * em que se faz o trabalho.
       */
      { href: '/admin/whatsapp', nome: 'WhatsApp', secao: 'whatsapp', nota: 'o número por onde tudo sai — conecte antes de enviar', grupo: 'Envios' },
      { href: '/admin/campanhas', nome: 'Campanhas', secao: 'campanhas', nota: 'horários vazios e quem chamar', grupo: 'Envios' },
      { href: '/admin/automacoes', nome: 'Automações', secao: 'automacoes', nota: 'o que a casa manda sozinha', grupo: 'Envios' },
      // "Lembretes" no menu e "Avisos ao cliente" no título da própria tela — e
      // o botão do onboarding, a primeira coisa que um dono novo vê, também diz
      // "Avisos ao cliente". O produto mandava para um nome e escondia atrás de
      // outro (§6, pergunta 2).
      { href: '/admin/avisos', nome: 'Avisos ao cliente', secao: 'avisos', nota: 'confirmação, lembrete e retorno', grupo: 'Envios', recurso: 'avisos' },
      { href: '/admin/retencao', nome: 'Retenção', secao: 'retencao', nota: 'quem está indo embora, e por quê', grupo: 'Retorno' },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', nota: 'pontos, visitas ou cashback', grupo: 'Retorno' },
    ],
    dentro: [],
  },
  {
    id: 'cadastros',
    nome: 'Cadastros',
    telas: [
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', nota: 'preço, duração e regras do serviço', grupo: 'Catálogo' },
      { href: '/admin/precos', nome: 'Preços por horário', secao: 'precos', nota: 'cobrar menos na hora vazia e mais na cheia', grupo: 'Catálogo' },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', nota: 'combos pagos adiantado, como 5 cortes', grupo: 'Catálogo' },
      { href: '/admin/clube', nome: 'Clube', secao: 'clube', nota: 'planos de assinatura e quem assina', grupo: 'Catálogo' },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', nota: 'barbeiros, jornadas e metas', grupo: 'Estrutura' },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', nota: 'cadeiras, lavatórios e salas', grupo: 'Estrutura' },
      { href: '/admin/estoque', nome: 'Estoque', secao: 'estoque', nota: 'produtos, contagem e ficha de consumo', grupo: 'Estrutura' },
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', nota: 'logo e imagens da página pública', grupo: 'Marca' },
      { href: '/admin/franquia', nome: 'Franquia', secao: 'franquia', nota: 'o cardápio padrão da rede e o que esta casa adotou', grupo: 'Marca' },
    ],
    dentro: [],
  },
  {
    id: 'integracoes',
    nome: 'Integrações',
    telas: [
      { href: '/admin/fiscal', nome: 'Nota fiscal', secao: 'fiscal', nota: 'CNPJ, regime e notas emitidas', recurso: 'fiscal' },
      { href: '/admin/chaves', nome: 'Chaves de API', secao: 'chaves', nota: 'integração do seu site ou do seu ERP' },
      { href: '/admin/webhooks', nome: 'Webhooks', secao: 'webhooks', nota: 'avisar outro sistema quando algo acontece aqui' },
    ],
    dentro: [],
  },
  {
    id: 'administracao',
    nome: 'Administração',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', nota: 'contas, papéis e permissões', grupo: 'A conta' },
      { href: '/admin/unidades', nome: 'Unidades', secao: 'unidades', nota: 'lojas da rede, quem opera cada uma e estoque entre elas', grupo: 'A conta' },
      { href: '/admin/plano', nome: 'Plano e cobrança', secao: 'plano', nota: 'assinatura, uso e limites', grupo: 'A conta' },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'horários, políticas e preferências', grupo: 'Preferências' },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'senha e segundo fator', grupo: 'Preferências' },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', nota: 'trazer base de outro sistema', grupo: 'Preferências', recurso: 'importacao' },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', nota: 'solicitações e dados de clientes', grupo: 'Obrigações' },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', nota: 'histórico de alterações', grupo: 'Obrigações' },
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
