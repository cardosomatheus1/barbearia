/**
 * Arquitetura de navegação do painel.
 *
 * V0 troca o vocabulário da arquitetura pelo vocabulário do trabalho. A pessoa
 * não deveria aprender onde um engenheiro colocaria "Cadastros" ou
 * "Integrações" para achar o que usa no balcão. O índice principal passa a ser:
 *
 * Hoje · Agenda · Clientes · Atendimento · Financeiro · Crescimento · Gestão
 * Configurações
 *
 * V1 abre `Clientes` como área de primeira ordem. A ficha individual deixa de
 * ficar escondida dentro de Atendimento e passa a ter uma porta própria.
 *
 * O painel do dono mora em Gestão. O Assistente continua no mesmo registro para
 * não criar uma segunda fonte de nome/href/permissão, mas `posicao: 'utilitario'`
 * tira-o do menu de áreas; o casco o apresenta como ação transversal no topo.
 */

import type { Permissao } from '@barbearia/core';

export type MoldeDePagina = 'operacional' | 'cadastro' | 'gestao' | 'configuracao' | 'excecao';

export type Modulo =
  | 'hoje'
  | 'agenda'
  | 'clientes'
  | 'atendimento'
  | 'financeiro'
  | 'crescimento'
  | 'gestao'
  | 'configuracoes';

export interface Destino {
  readonly href: string;
  readonly nome: string;
  readonly secao: string;
  readonly nota: string;
  readonly recurso?: string;
  readonly permissao?: readonly Permissao[];
  readonly grupo?: string;
  /** V7: padrão visual/estrutural desta tela. `excecao` exige justificativa. */
  readonly molde: MoldeDePagina;
  readonly excecaoDeMolde?: string;
  /**
   * Destino transversal: existe, tem seção e permissão, mas não compete com as
   * áreas de trabalho no menu. Hoje só o Assistente usa esta posição; no V11
   * ele passa a dividir a barra superior com a busca global.
   */
  readonly posicao?: 'menu' | 'utilitario';
}

export interface DestinoInterno {
  readonly secao: string;
  readonly nome: string;
  readonly nota: string;
  /** V7: páginas internas também declaram o mesmo contrato visual. */
  readonly molde: MoldeDePagina;
  readonly excecaoDeMolde?: string;
  /** Tela listada que funciona como porta de volta, quando houver. */
  readonly pai?: string;
  readonly recurso?: string;
  readonly permissao?: readonly Permissao[];
}

export interface ModuloDoPainel {
  readonly id: Modulo;
  readonly nome: string;
  readonly telas: readonly Destino[];
  /**
   * Seções que pertencem ao módulo, mas não ocupam uma aba própria.
   *
   * V3 dá nome e contexto a elas porque a migalha precisa ser derivada do
   * registro tanto na porta quanto numa ficha aberta por id. Guardar só a
   * string da seção deixava justamente as telas internas sem vocabulário.
   */
  readonly dentro: readonly DestinoInterno[];
  /** Configuração é visualmente secundária às áreas usadas no dia a dia. */
  readonly categoria?: 'principal' | 'configuracao';
}

export const MODULOS = [
  {
    id: 'hoje',
    nome: 'Hoje',
    telas: [
      { href: '/admin/dia', nome: 'Hoje', secao: 'dia', molde: 'operacional', nota: 'operação do dia em tempo real', permissao: ['appointments.view'] },
    ],
    // A tela privada do barbeiro pertence ao mesmo momento operacional.
    dentro: [{ secao: 'meu-dia', molde: 'operacional', nome: 'Meu dia', nota: 'sua agenda e seus atendimentos', pai: 'dia', permissao: ['appointments.view'] }],
  },
  {
    id: 'agenda',
    nome: 'Agenda',
    telas: [
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', molde: 'operacional', nota: 'dia, semana e próximos horários', permissao: ['appointments.view'] },
    ],
    dentro: [],
  },
  {
    id: 'clientes',
    nome: 'Clientes',
    telas: [
      { href: '/admin/clientes', nome: 'Clientes', secao: 'clientes', molde: 'cadastro', nota: 'buscar, reconhecer e agir sobre a base', permissao: ['customers.view'] },
    ],
    // A ficha pertence à mesma área, embora continue sendo aberta por id.
    dentro: [{ secao: 'cliente', molde: 'cadastro', nome: 'Ficha do cliente', nota: 'histórico, preferências e relacionamento', pai: 'clientes', permissao: ['customers.view'] }],
  },
  {
    id: 'atendimento',
    nome: 'Atendimento',
    telas: [
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', molde: 'operacional', nota: 'clientes que chegaram sem marcar', grupo: 'Agora', recurso: 'fila', permissao: ['appointments.view'] },
      { href: '/admin/comanda', nome: 'Cobrar', secao: 'comanda', molde: 'operacional', nota: 'cobrança dos atendimentos', grupo: 'Agora', permissao: ['cashier.open'] },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', molde: 'gestao', nota: 'sugestões e reclamações de clientes', grupo: 'Voz do cliente', permissao: ['feedback.view'] },
      { href: '/admin/recepcao', nome: 'Recepção', secao: 'recepcao', molde: 'operacional', nota: 'perguntas que o site não soube responder', grupo: 'Voz do cliente', permissao: ['feedback.view'] },
      { href: '/admin/avaliacoes', nome: 'Avaliações', secao: 'avaliacoes', molde: 'gestao', nota: 'notas dos atendimentos e nota baixa a tratar', grupo: 'Voz do cliente', permissao: ['reviews.view'] },
    ],
    dentro: [],
  },
  {
    id: 'financeiro',
    nome: 'Financeiro',
    telas: [
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', molde: 'operacional', nota: 'abertura, movimentos e fechamento', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', molde: 'operacional', nota: 'valores em aberto de clientes', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/financeiro', nome: 'Contas', secao: 'financeiro', molde: 'gestao', nota: 'o que a casa deve e tem a receber', grupo: 'Fechamento', permissao: ['finance.view'] },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', molde: 'gestao', nota: 'o que a casa precisa pagar', grupo: 'Fechamento', permissao: ['commission.view_own', 'commission.view_all'] },
      { href: '/admin/dre', nome: 'Resultado', secao: 'dre', molde: 'gestao', nota: 'o que sobrou depois de tudo', grupo: 'Fechamento', permissao: ['finance.view_profit'] },
    ],
    dentro: [{ secao: 'meus-numeros', molde: 'gestao', nome: 'Meus números', nota: 'seu resultado e suas comissões', pai: 'comissao', permissao: ['commission.view_own'] }],
  },
  {
    id: 'crescimento',
    nome: 'Crescimento',
    telas: [
      { href: '/admin/whatsapp', nome: 'WhatsApp', secao: 'whatsapp', molde: 'configuracao', nota: 'o número por onde tudo sai — conecte antes de enviar', grupo: 'Relacionamento', permissao: ['whatsapp.manage'] },
      { href: '/admin/campanhas', nome: 'Campanhas', secao: 'campanhas', molde: 'gestao', nota: 'horários vazios e quem chamar', grupo: 'Relacionamento', permissao: ['marketing.send'] },
      { href: '/admin/automacoes', nome: 'Automações', secao: 'automacoes', molde: 'configuracao', nota: 'o que a casa manda sozinha', grupo: 'Relacionamento', permissao: ['marketing.send'] },
      { href: '/admin/avisos', nome: 'Avisos ao cliente', secao: 'avisos', molde: 'configuracao', nota: 'confirmação, lembrete e retorno', grupo: 'Relacionamento', recurso: 'avisos', permissao: ['settings.manage'] },
      { href: '/admin/retencao', nome: 'Retenção', secao: 'retencao', molde: 'gestao', nota: 'quem está indo embora, e por quê', grupo: 'Retorno', permissao: ['customers.view', 'customers.view_notes', 'reviews.view'] },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', molde: 'gestao', nota: 'pontos, visitas ou cashback', grupo: 'Retorno', permissao: ['appointments.view'] },
      { href: '/admin/clube', nome: 'Clube', secao: 'clube', molde: 'gestao', nota: 'planos de assinatura e quem assina', grupo: 'Retorno', permissao: ['appointments.view'] },
    ],
    dentro: [],
  },
  {
    id: 'gestao',
    nome: 'Gestão',
    telas: [
      // A primeira tela é deliberadamente o painel: esta é a casa do dono.
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', molde: 'gestao', nota: 'indicadores e visão do negócio', grupo: 'Visão do negócio', permissao: ['reports.operational'] },
      { href: '/admin/assistente', nome: 'Assistente de gestão', secao: 'assistente', molde: 'gestao', nota: 'pergunte em português', grupo: 'Visão do negócio', posicao: 'utilitario' },
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', molde: 'cadastro', nota: 'preço, duração e regras do serviço', grupo: 'Oferta', permissao: ['settings.manage'] },
      { href: '/admin/precos', nome: 'Preços por horário', secao: 'precos', molde: 'cadastro', nota: 'cobrar menos na hora vazia e mais na cheia', grupo: 'Oferta', permissao: ['settings.manage'] },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', molde: 'cadastro', nota: 'combos pagos adiantado, como 5 cortes', grupo: 'Oferta', permissao: ['appointments.view'] },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', molde: 'cadastro', nota: 'barbeiros, jornadas e metas', grupo: 'Operação', permissao: ['settings.manage'] },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', molde: 'cadastro', nota: 'cadeiras, lavatórios e salas', grupo: 'Operação', permissao: ['settings.manage'] },
      { href: '/admin/estoque', nome: 'Estoque', secao: 'estoque', molde: 'cadastro', nota: 'produtos, contagem e ficha de consumo', grupo: 'Operação', permissao: ['inventory.view'] },
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', molde: 'configuracao', nota: 'logo e imagens da página pública', grupo: 'Estrutura', permissao: ['settings.manage'] },
      { href: '/admin/franquia', nome: 'Franquia', secao: 'franquia', molde: 'configuracao', nota: 'o cardápio padrão da rede e o que esta casa adotou', grupo: 'Estrutura', permissao: ['settings.manage'] },
      { href: '/admin/unidades', nome: 'Unidades', secao: 'unidades', molde: 'configuracao', nota: 'lojas da rede, quem opera cada uma e estoque entre elas', grupo: 'Estrutura' },
      { href: '/admin/fiscal', nome: 'Nota fiscal', secao: 'fiscal', molde: 'configuracao', nota: 'CNPJ, regime e notas emitidas', grupo: 'Estrutura', recurso: 'fiscal', permissao: ['fiscal.settings', 'finance.view'] },
    ],
    dentro: [],
  },
  {
    id: 'configuracoes',
    nome: 'Configurações',
    categoria: 'configuracao',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', molde: 'configuracao', nota: 'contas, papéis e permissões', grupo: 'Conta', permissao: ['team.manage'] },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', molde: 'configuracao', nota: 'senha e segundo fator', grupo: 'Conta' },
      { href: '/admin/chaves', nome: 'Chaves de API', secao: 'chaves', molde: 'configuracao', nota: 'integração do seu site ou do seu ERP', grupo: 'Integrações', permissao: ['team.manage'] },
      { href: '/admin/webhooks', nome: 'Webhooks', secao: 'webhooks', molde: 'configuracao', nota: 'avisar outro sistema quando algo acontece aqui', grupo: 'Integrações', permissao: ['team.manage'] },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', molde: 'configuracao', nota: 'solicitações e dados de clientes', grupo: 'Conta e dados', permissao: ['settings.manage'] },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', molde: 'configuracao', nota: 'histórico de alterações', grupo: 'Conta e dados', permissao: ['settings.manage'] },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', molde: 'configuracao', nota: 'trazer base de outro sistema', grupo: 'Conta e dados', recurso: 'importacao', permissao: ['customers.edit'] },
      { href: '/admin/plano', nome: 'Plano e cobrança', secao: 'plano', molde: 'gestao', nota: 'assinatura, uso e limites', grupo: 'Negócio', permissao: ['settings.manage'] },
      { href: '/admin/configuracoes', nome: 'Preferências', secao: 'configuracoes', molde: 'configuracao', nota: 'horários, políticas e preferências', grupo: 'Negócio', permissao: ['settings.manage'] },
    ],
    dentro: [{ secao: 'onboarding', molde: 'configuracao', nome: 'Primeiros passos', nota: 'o necessário para colocar a casa no ar', permissao: ['settings.manage'] }],
  },
] as const satisfies readonly ModuloDoPainel[];

export type Secao =
  | (typeof MODULOS)[number]['telas'][number]['secao']
  | (typeof MODULOS)[number]['dentro'][number]['secao'];

const MOLDE_DA_SECAO = new Map<string, MoldeDePagina>(
  MODULOS.flatMap((m) => [
    ...m.telas.map((t) => [t.secao, t.molde] as const),
    ...m.dentro.map((s) => [s.secao, s.molde] as const),
  ]),
);

const MODULO_DA_SECAO = new Map<string, Modulo>(
  MODULOS.flatMap((m) => [
    ...m.telas.map((t) => [t.secao, m.id] as const),
    ...m.dentro.map((s) => [s.secao, m.id] as const),
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
    dentro: modulo.dentro.filter(
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


/** O que ocupa espaço na navegação da área; utilitários transversais ficam fora. */
export function telasDoMenu(modulo: ModuloDoPainel): readonly Destino[] {
  return modulo.telas.filter((tela) => tela.posicao !== 'utilitario');
}

/** Utilitários visíveis, já depois dos cortes de recurso e permissão. */
export function utilitariosVisiveis(modulos: readonly ModuloDoPainel[]): readonly Destino[] {
  return modulos.flatMap((modulo) => modulo.telas).filter((tela) => tela.posicao === 'utilitario');
}

export interface OrientacaoDaTela {
  readonly modulo: Modulo;
  readonly moduloNome: string;
  readonly moduloHref: string;
  readonly secao: string;
  readonly nome: string;
  readonly nota: string;
  readonly pai?: string;
  readonly listada: boolean;
  readonly molde: MoldeDePagina;
}

/**
 * O vocabulário que o V3 desenha acima de cada tela, derivado da mesma fonte
 * que decide menu, permissão e módulo ativo. Não existe uma segunda lista de
 * breadcrumbs para esquecer quando entrar uma tela nova.
 */
export function orientacoesVisiveis(
  modulos: readonly ModuloDoPainel[],
): readonly OrientacaoDaTela[] {
  return modulos.flatMap((modulo) => {
    const porta = telasDoMenu(modulo)[0]?.href ?? modulo.telas[0]?.href;
    if (!porta) return [];

    const listadas: OrientacaoDaTela[] = modulo.telas.map((tela) => ({
      modulo: modulo.id,
      moduloNome: modulo.nome,
      moduloHref: porta,
      secao: tela.secao,
      nome: tela.nome,
      nota: tela.nota,
      listada: tela.posicao !== 'utilitario',
      molde: tela.molde,
    }));

    const internas: OrientacaoDaTela[] = modulo.dentro.map((tela) => ({
      modulo: modulo.id,
      moduloNome: modulo.nome,
      moduloHref: porta,
      secao: tela.secao,
      nome: tela.nome,
      nota: tela.nota,
      ...(tela.pai !== undefined ? { pai: tela.pai } : {}),
      listada: false,
      molde: tela.molde,
    }));

    return [...listadas, ...internas];
  });
}

/** Os destinos que só existem quando a plataforma liga o recurso. */
export const DESTINOS_GATEADOS: readonly (Destino & { readonly recurso: string })[] = REGISTRO
  .flatMap((modulo) => modulo.telas)
  .filter((tela): tela is Destino & { readonly recurso: string } => tela.recurso !== undefined);

export function secao(nome: Secao): {
  readonly 'data-secao': string;
  readonly 'data-modulo-atual': Modulo;
  readonly 'data-molde': MoldeDePagina;
} {
  const modulo = MODULO_DA_SECAO.get(nome);
  const molde = MOLDE_DA_SECAO.get(nome);
  if (!modulo || !molde) throw new Error(`seção fora do casco: ${nome}`);
  return { 'data-secao': nome, 'data-modulo-atual': modulo, 'data-molde': molde };
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
  MODULOS.map((m) => [m.id, [...m.telas.map((t) => t.secao), ...m.dentro.map((s) => s.secao)]]),
);

export const SECOES_POR_MODULO = PORTA_ABERTA as Readonly<Record<Modulo, readonly string[]>>;
