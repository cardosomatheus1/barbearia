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

import type { Permissao } from '@barbearia/core';

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
   * A permissão que **abre a porta** desta tela — a que, faltando, faz a
   * primeira leitura dela ser recusada.
   *
   * Lista com mais de um elemento é *qualquer uma serve*, e existe por um caso
   * só: Comissões tem duas portas — `commission.view_own` mostra os números de
   * quem entrou, `commission.view_all` mostra os da casa —, e declarar uma
   * esconderia a tela de quem tem a outra.
   *
   * Ausente é legítimo e quer dizer *não há porta*: o Assistente, Segurança e
   * Unidades abrem para qualquer conta da casa.
   *
   * ## Por que uma coluna aqui, e não a leitura do `@Exige` da rota
   *
   * A objeção estava escrita e era boa: uma coluna à mão em quarenta linhas é a
   * sexta lista paralela deste código, e **errar uma linha esconde uma tela de
   * quem deveria vê-la** — que é pior do que o defeito original.
   *
   * O que responde por isso não é a coluna, é a guarda, e ela é **empírica e
   * nos dois sentidos** (`scripts/percorrer.mjs`): entra no painel com cada
   * papel padrão, abre **todo destino que o menu ofereceu** e reprova se algum
   * recusar, e abre **todo destino que o menu escondeu** e reprova se algum
   * abrir. Escrever a permissão errada fica vermelho de um dos dois lados.
   *
   * Ler o `@Exige` da rota seria mais fraco, não mais forte: a tela chama várias
   * rotas, a união delas esconde demais, a primeira esconde de menos, e nenhuma
   * das duas enxerga a tela que engole o 403 e desenha um formulário que só vai
   * recusar no botão — que era o caso de WhatsApp, Campanhas e Automações.
   */
  readonly permissao?: readonly Permissao[];
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
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', nota: 'indicadores e visão do negócio', permissao: ['reports.operational'] },
      { href: '/admin/assistente', nome: 'Assistente', secao: 'assistente', nota: 'pergunte em português' },
    ],
    dentro: [],
  },
  {
    id: 'atendimento',
    nome: 'Atendimento',
    telas: [
      { href: '/admin/dia', nome: 'Hoje', secao: 'dia', nota: 'operação do dia em tempo real', grupo: 'O dia', permissao: ['appointments.view'] },
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', nota: 'dia, semana e próximos horários', grupo: 'O dia', permissao: ['appointments.view'] },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', nota: 'clientes que chegaram sem marcar', grupo: 'O dia', recurso: 'fila', permissao: ['appointments.view'] },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', nota: 'sugestões e reclamações de clientes', grupo: 'Voz do cliente', permissao: ['feedback.view'] },
      { href: '/admin/recepcao', nome: 'Recepção', secao: 'recepcao', nota: 'perguntas que o site não soube responder', grupo: 'Voz do cliente', permissao: ['feedback.view'] },
      { href: '/admin/avaliacoes', nome: 'Avaliações', secao: 'avaliacoes', nota: 'notas dos atendimentos e nota baixa a tratar', grupo: 'Voz do cliente', permissao: ['reviews.view'] },
    ],
    dentro: ['cliente', 'meu-dia'],
  },
  {
    id: 'financeiro',
    nome: 'Financeiro',
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', nota: 'abertura, movimentos e fechamento', grupo: 'Balcão', permissao: ['cashier.open'] },
      // "Cobrar", como o título da tela. Mesmo defeito do fiado, mais leve.
      { href: '/admin/comanda', nome: 'Cobrar', secao: 'comanda', nota: 'cobrança dos atendimentos', grupo: 'Balcão', permissao: ['cashier.open'] },
      // "Fiado" e não "Pendências": todo o resto do produto diz fiado — a rota, a
      // função `quemEstaDevendo`, "Pagamento de fiado" no extrato do caixa, o
      // resumo do dia e o próprio título da tela. Quando o dono fala "abre o
      // Fiado", a recepção procurava "Fiado" no menu e não achava (§6, pergunta 2).
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', nota: 'valores em aberto de clientes', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/financeiro', nome: 'Contas', secao: 'financeiro', nota: 'o que a casa deve e tem a receber', grupo: 'Fechamento', permissao: ['finance.view'] },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', nota: 'o que a casa precisa pagar', grupo: 'Fechamento', permissao: ['commission.view_own', 'commission.view_all'] },
      { href: '/admin/dre', nome: 'Resultado', secao: 'dre', nota: 'o que sobrou depois de tudo', grupo: 'Fechamento', permissao: ['finance.view_profit'] },
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
      { href: '/admin/whatsapp', nome: 'WhatsApp', secao: 'whatsapp', nota: 'o número por onde tudo sai — conecte antes de enviar', grupo: 'Envios', permissao: ['whatsapp.manage'] },
      { href: '/admin/campanhas', nome: 'Campanhas', secao: 'campanhas', nota: 'horários vazios e quem chamar', grupo: 'Envios', permissao: ['marketing.send'] },
      { href: '/admin/automacoes', nome: 'Automações', secao: 'automacoes', nota: 'o que a casa manda sozinha', grupo: 'Envios', permissao: ['marketing.send'] },
      // "Lembretes" no menu e "Avisos ao cliente" no título da própria tela — e
      // o botão do onboarding, a primeira coisa que um dono novo vê, também diz
      // "Avisos ao cliente". O produto mandava para um nome e escondia atrás de
      // outro (§6, pergunta 2).
      { href: '/admin/avisos', nome: 'Avisos ao cliente', secao: 'avisos', nota: 'confirmação, lembrete e retorno', grupo: 'Envios', recurso: 'avisos', permissao: ['settings.manage'] },
      { href: '/admin/retencao', nome: 'Retenção', secao: 'retencao', nota: 'quem está indo embora, e por quê', grupo: 'Retorno', permissao: ['customers.view'] },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', nota: 'pontos, visitas ou cashback', grupo: 'Retorno', permissao: ['appointments.view'] },
    ],
    dentro: [],
  },
  {
    id: 'cadastros',
    nome: 'Cadastros',
    telas: [
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', nota: 'preço, duração e regras do serviço', grupo: 'Catálogo', permissao: ['settings.manage'] },
      { href: '/admin/precos', nome: 'Preços por horário', secao: 'precos', nota: 'cobrar menos na hora vazia e mais na cheia', grupo: 'Catálogo', permissao: ['settings.manage'] },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', nota: 'combos pagos adiantado, como 5 cortes', grupo: 'Catálogo', permissao: ['appointments.view'] },
      { href: '/admin/clube', nome: 'Clube', secao: 'clube', nota: 'planos de assinatura e quem assina', grupo: 'Catálogo', permissao: ['appointments.view'] },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', nota: 'barbeiros, jornadas e metas', grupo: 'Estrutura', permissao: ['settings.manage'] },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', nota: 'cadeiras, lavatórios e salas', grupo: 'Estrutura', permissao: ['settings.manage'] },
      { href: '/admin/estoque', nome: 'Estoque', secao: 'estoque', nota: 'produtos, contagem e ficha de consumo', grupo: 'Estrutura', permissao: ['inventory.view'] },
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', nota: 'logo e imagens da página pública', grupo: 'Marca', permissao: ['settings.manage'] },
      { href: '/admin/franquia', nome: 'Franquia', secao: 'franquia', nota: 'o cardápio padrão da rede e o que esta casa adotou', grupo: 'Marca', permissao: ['settings.manage'] },
    ],
    dentro: [],
  },
  {
    id: 'integracoes',
    nome: 'Integrações',
    telas: [
      /*
        A porta **não** é `fiscal.view`, e foi a guarda de percurso que disse.
        A tela desenha a lista quando se tem `fiscal.view` **e** `finance.view`
        — trezentas notas com valor são o faturamento do mês por outro caminho —
        ou o cadastro quando se tem `fiscal.settings`. A recepção tem a primeira
        e não a segunda, então para ela a tela recusa inteira.
      */
      { href: '/admin/fiscal', nome: 'Nota fiscal', secao: 'fiscal', nota: 'CNPJ, regime e notas emitidas', recurso: 'fiscal', permissao: ['fiscal.settings', 'finance.view'] },
      { href: '/admin/chaves', nome: 'Chaves de API', secao: 'chaves', nota: 'integração do seu site ou do seu ERP', permissao: ['team.manage'] },
      { href: '/admin/webhooks', nome: 'Webhooks', secao: 'webhooks', nota: 'avisar outro sistema quando algo acontece aqui', permissao: ['team.manage'] },
    ],
    dentro: [],
  },
  {
    id: 'administracao',
    nome: 'Administração',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', nota: 'contas, papéis e permissões', grupo: 'A conta', permissao: ['team.manage'] },
      { href: '/admin/unidades', nome: 'Unidades', secao: 'unidades', nota: 'lojas da rede, quem opera cada uma e estoque entre elas', grupo: 'A conta' },
      { href: '/admin/plano', nome: 'Plano e cobrança', secao: 'plano', nota: 'assinatura, uso e limites', grupo: 'A conta', permissao: ['settings.manage'] },
      { href: '/admin/configuracoes', nome: 'Configurações', secao: 'configuracoes', nota: 'horários, políticas e preferências', grupo: 'Preferências', permissao: ['settings.manage'] },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', nota: 'senha e segundo fator', grupo: 'Preferências' },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', nota: 'trazer base de outro sistema', grupo: 'Preferências', recurso: 'importacao', permissao: ['customers.edit'] },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', nota: 'solicitações e dados de clientes', grupo: 'Obrigações', permissao: ['settings.manage'] },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', nota: 'histórico de alterações', grupo: 'Obrigações', permissao: ['settings.manage'] },
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
 * O menu, já sem o que esta pessoa não conseguiria abrir.
 *
 * Dois cortes, e eles não são o mesmo caso:
 *
 * - **recurso da plataforma**: quem decidiu foi a plataforma, e para o dono a
 *   tela *não existe* — some do menu, o endereço responde 404. É a mesma razão
 *   de a guarda responder 404 e não 403.
 * - **permissão**: quem decide é o dono, e a tela *existe* — some do menu, mas
 *   o endereço continua explicando quem libera. Quem chegar por link salvo lê
 *   a frase; quem está navegando não é oferecido um caminho que recusa.
 *
 * ## Isto reverte uma decisão escrita aqui
 *
 * A versão anterior deste comentário dizia que sem permissão o item **fica** no
 * menu, "porque quem decide é o dono e ele pode liberar". O argumento parece
 * bom e a medição o desmentiu: o barbeiro via 39 destinos e **18** recusavam ao
 * abrir; a recepção, 12. Um menu que erra em quase metade dos toques não está
 * ensinando ninguém a pedir acesso — está ensinando a não confiar no menu.
 *
 * Pior: seis daqueles destinos nem recusavam direito. Plano, Chaves de API,
 * Webhooks, Fotos, Franquia e a lista de comandas abertas devolviam *"Não deu
 * para carregar. Recarregue a página"* sobre um 403 — a recusa de permissão
 * vestida de falha passageira, que é a convenção do repositório quebrada no
 * lugar mais caro: a pessoa recarrega para sempre.
 *
 * O que fica de pé do argumento antigo é a **frase na tela**, e ela continua
 * lá para quem chega pelo endereço.
 *
 * O módulo que ficasse sem nenhuma tela sai junto — um ícone no trilho que abre
 * uma lista vazia é a pessoa tocando e nada acontecendo.
 *
 * Mora aqui e não no casco de propósito: quem sabe filtrar o registro é o
 * registro, e assim a regra é testável sem montar JSX.
 */
export function modulosVisiveis(
  recursos: readonly string[],
  permissoes: readonly string[],
): readonly ModuloDoPainel[] {
  const tem = new Set(permissoes);
  return REGISTRO.map((modulo) => ({
    ...modulo,
    telas: modulo.telas.filter(
      (tela) =>
        (!tela.recurso || recursos.includes(tela.recurso)) &&
        (!tela.permissao || tela.permissao.some((p) => tem.has(p))),
    ),
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
