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

  | 'financeiro'
  | 'crescimento'
  | 'barbearia'
  | 'lojas'
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
  /**
   * As palavras que a pessoa **digita** na busca e que não cabem na legenda.
   *
   * `nota` é o que a tela diz de si na aba; isto é como o balcão chama a coisa.
   * São perguntas diferentes, e por isso são campos diferentes — enfiar
   * "shampoo" e "pomada" na legenda do Estoque pioraria a aba para melhorar a
   * busca. Invisível na tela, e a guarda de vocabulário é quem o mantém honesto.
   */
  readonly busca?: string;
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
  /**
   * As palavras que a pessoa **digita** na busca e que não cabem na legenda.
   *
   * `nota` é o que a tela diz de si na aba; isto é como o balcão chama a coisa.
   * São perguntas diferentes, e por isso são campos diferentes — enfiar
   * "shampoo" e "pomada" na legenda do Estoque pioraria a aba para melhorar a
   * busca. Invisível na tela, e a guarda de vocabulário é quem o mantém honesto.
   */
  readonly busca?: string;
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
      { href: '/admin/dia', nome: 'Hoje', secao: 'dia', molde: 'operacional', nota: 'quem chega hoje, quem está atrasado, quem faltou', grupo: 'Agora', permissao: ['appointments.view'] },
      { href: '/admin/painel', nome: 'Painel', secao: 'painel', molde: 'gestao', nota: 'faturamento, ocupação e os números do mês', grupo: 'O mês', permissao: ['reports.operational'] },
      { href: '/admin/assistente', nome: 'Assistente de gestão', secao: 'assistente', molde: 'gestao', nota: 'pergunte em português', grupo: 'O mês', posicao: 'utilitario' },
    ],
    // A tela privada do barbeiro pertence ao mesmo momento operacional.
    dentro: [{ secao: 'meu-dia', molde: 'operacional', nome: 'Meu dia', nota: 'sua agenda e seus atendimentos', pai: 'dia', permissao: ['appointments.view'] }],
  },
  {
    id: 'agenda',
    nome: 'Agenda',
    telas: [
      { href: '/admin/agenda', nome: 'Agenda', secao: 'agenda', molde: 'operacional', nota: 'marcar, remarcar e bloquear horário', permissao: ['appointments.view'] },
      { href: '/admin/fila', nome: 'Fila', secao: 'fila', molde: 'operacional', nota: 'clientes que chegaram sem marcar', recurso: 'fila', permissao: ['appointments.view'] },
    ],
    dentro: [],
  },
  {
    id: 'clientes',
    nome: 'Clientes',
    telas: [
      { href: '/admin/clientes', nome: 'Clientes', secao: 'clientes', molde: 'cadastro', nota: 'buscar o cliente e abrir a ficha dele', busca: 'cadastro base telefone aniversario', grupo: 'A base', permissao: ['customers.view'] },
      { href: '/admin/recados', nome: 'Recados', secao: 'recados', molde: 'gestao', nota: 'recado escrito pelo cliente, sem nota', grupo: 'O que o cliente disse', permissao: ['feedback.view'] },
      { href: '/admin/recepcao', nome: 'Perguntas sem resposta', secao: 'recepcao', molde: 'operacional', nota: 'perguntas que o site não soube responder', grupo: 'O que o cliente disse', permissao: ['feedback.view'] },
      { href: '/admin/avaliacoes', nome: 'Avaliações', secao: 'avaliacoes', molde: 'gestao', nota: 'a nota que o cliente deu, e a nota baixa a tratar', grupo: 'O que o cliente disse', permissao: ['reviews.view'] },
    ],
    // A ficha pertence à mesma área, embora continue sendo aberta por id.
    dentro: [{ secao: 'cliente', molde: 'cadastro', nome: 'Ficha do cliente', nota: 'fotos do corte, preferências de máquina e barba, histórico e observações', busca: 'foto antes depois corte preferencia maquina degrade barba alergia observacao anotacao ficha', pai: 'clientes', permissao: ['customers.view'] }],
  },
  {
    id: 'financeiro',
    nome: 'Financeiro',
    telas: [
      { href: '/admin/comanda', nome: 'Comanda', secao: 'comanda', molde: 'operacional', nota: 'receber o cliente: serviços, produtos e pagamento', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/caixa', nome: 'Caixa', secao: 'caixa', molde: 'operacional', nota: 'abertura, sangria e fechamento da gaveta', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/fiado', nome: 'Fiado', secao: 'fiado', molde: 'operacional', nota: 'o que os clientes levaram e ainda não pagaram', grupo: 'Balcão', permissao: ['cashier.open'] },
      { href: '/admin/financeiro', nome: 'Contas', secao: 'financeiro', molde: 'gestao', nota: 'contas da casa a pagar e a receber', grupo: 'Fechamento', permissao: ['finance.view'] },
      { href: '/admin/comissao', nome: 'Comissões', secao: 'comissao', molde: 'gestao', nota: 'o que cada barbeiro tem a receber no mês', grupo: 'Fechamento', permissao: ['commission.view_own', 'commission.view_all'] },
      { href: '/admin/dre', nome: 'Resultado', secao: 'dre', molde: 'gestao', nota: 'lucro: a receita menos custo e despesa', grupo: 'Fechamento', permissao: ['finance.view_profit'] },
      { href: '/admin/fiscal', nome: 'Nota fiscal', secao: 'fiscal', molde: 'configuracao', nota: 'CNPJ, regime e notas emitidas', grupo: 'Fechamento', recurso: 'fiscal', permissao: ['fiscal.settings', 'finance.view'] },
    ],
    dentro: [{ secao: 'meus-numeros', molde: 'gestao', nome: 'Meus números', nota: 'seu resultado e suas comissões', pai: 'comissao', permissao: ['commission.view_own'] }],
  },
  {
    id: 'crescimento',
    nome: 'Crescimento',
    telas: [
      { href: '/admin/whatsapp', nome: 'WhatsApp', secao: 'whatsapp', molde: 'configuracao', nota: 'conexões e formas de enviar mensagens', grupo: 'Relacionamento', permissao: ['whatsapp.manage'] },
      { href: '/admin/campanhas', nome: 'Campanhas', secao: 'campanhas', molde: 'gestao', nota: 'horários vazios e quem chamar', grupo: 'Relacionamento', permissao: ['marketing.send'] },
      { href: '/admin/automacoes', nome: 'Automações', secao: 'automacoes', molde: 'configuracao', nota: 'mensagem com motivo próprio: aniversário, sumiço, pós-atendimento', grupo: 'Relacionamento', permissao: ['marketing.send'] },
      { href: '/admin/avisos', nome: 'Avisos ao cliente', secao: 'avisos', molde: 'configuracao', nota: 'lembrete e confirmação do horário marcado', grupo: 'Relacionamento', recurso: 'avisos', permissao: ['settings.manage'] },
      { href: '/admin/retencao', nome: 'Retenção', secao: 'retencao', molde: 'gestao', nota: 'quem está indo embora, e por quê', grupo: 'Retorno', permissao: ['customers.view', 'customers.view_notes', 'reviews.view'] },
      { href: '/admin/fidelidade', nome: 'Fidelidade', secao: 'fidelidade', molde: 'gestao', nota: 'pontos, visitas ou cashback', grupo: 'Retorno', permissao: ['appointments.view'] },
      { href: '/admin/clube', nome: 'Clube', secao: 'clube', molde: 'gestao', nota: 'mensalidade que o cliente paga à casa', grupo: 'Retorno', permissao: ['appointments.view'] },
    ],
    dentro: [],
  },
  {
    id: 'barbearia',
    nome: 'Minha barbearia',
    telas: [
      { href: '/admin/catalogo', nome: 'Serviços', secao: 'servicos', molde: 'cadastro', nota: 'preço, duração e ficha técnica do serviço', busca: 'corte barba cardapio catalogo ficha tecnica consumo', grupo: 'O que a casa vende', permissao: ['settings.manage'] },
      { href: '/admin/precos', nome: 'Preços por horário', secao: 'precos', molde: 'cadastro', nota: 'cobrar menos na hora vazia e mais na cheia', grupo: 'O que a casa vende', permissao: ['settings.manage'] },
      { href: '/admin/pacotes', nome: 'Pacotes', secao: 'pacotes', molde: 'cadastro', nota: 'combos pagos adiantado, como 5 cortes', grupo: 'O que a casa vende', permissao: ['appointments.view'] },
      { href: '/admin/profissionais', nome: 'Profissionais', secao: 'profissionais', molde: 'cadastro', nota: 'barbeiros, jornadas e metas', grupo: 'Quem atende, e com o quê', permissao: ['settings.manage'] },
      { href: '/admin/recursos', nome: 'Recursos', secao: 'recursos', molde: 'cadastro', nota: 'cadeiras, lavatórios e salas', grupo: 'Quem atende, e com o quê', permissao: ['settings.manage'] },
      { href: '/admin/estoque', nome: 'Estoque', secao: 'estoque', molde: 'cadastro', nota: 'produtos e material de consumo: contagem, alerta de falta e custo', busca: 'shampoo pomada material insumo inventario compra fornecedor', grupo: 'Quem atende, e com o quê', permissao: ['inventory.view'] },
    ],
    dentro: [],
  },
  {
    id: 'lojas',
    nome: 'Marca e lojas',
    telas: [
      { href: '/admin/fotos', nome: 'Fotos e marca', secao: 'fotos', molde: 'configuracao', nota: 'logo e imagens da página pública', permissao: ['settings.manage'] },
      { href: '/admin/franquia', nome: 'Franquia', secao: 'franquia', molde: 'configuracao', nota: 'o cardápio padrão da rede e o que esta casa adotou', permissao: ['settings.manage'] },
      { href: '/admin/unidades', nome: 'Unidades', secao: 'unidades', molde: 'configuracao', nota: 'lojas da rede, quem opera cada uma e estoque entre elas' },
    ],
    dentro: [],
  },
  {
    id: 'configuracoes',
    nome: 'Configurações',
    categoria: 'configuracao',
    telas: [
      { href: '/admin/equipe', nome: 'Usuários e acessos', secao: 'equipe', molde: 'configuracao', nota: 'contas, papéis e permissões', grupo: 'Acesso', permissao: ['team.manage'] },
      { href: '/admin/seguranca', nome: 'Segurança', secao: 'seguranca', molde: 'configuracao', nota: 'senha e segundo fator', grupo: 'Acesso' },
      { href: '/admin/chaves', nome: 'Chaves de API', secao: 'chaves', molde: 'configuracao', nota: 'integração do seu site ou do seu ERP', grupo: 'Integrações', permissao: ['team.manage'] },
      { href: '/admin/webhooks', nome: 'Webhooks', secao: 'webhooks', molde: 'configuracao', nota: 'avisar outro sistema quando algo acontece aqui', grupo: 'Integrações', permissao: ['team.manage'] },
      { href: '/admin/lgpd', nome: 'Privacidade', secao: 'lgpd', molde: 'configuracao', nota: 'solicitações e dados de clientes', grupo: 'Dados e privacidade', permissao: ['settings.manage'] },
      { href: '/admin/trilha', nome: 'Auditoria', secao: 'trilha', molde: 'configuracao', nota: 'histórico de alterações', grupo: 'Dados e privacidade', permissao: ['settings.manage'] },
      { href: '/admin/importar', nome: 'Importar dados', secao: 'importar', molde: 'configuracao', nota: 'trazer base de outro sistema', grupo: 'Dados e privacidade', recurso: 'importacao', permissao: ['customers.edit'] },
      { href: '/admin/plano', nome: 'Seu plano Barber Dock', secao: 'plano', molde: 'gestao', nota: 'o que você paga pelo Barber Dock', grupo: 'Negócio', permissao: ['settings.manage'] },
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
  /** Ausente na tela interna, que não tem endereço próprio: a ficha abre por id. */
  readonly href?: string;
  readonly busca?: string;
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
      href: tela.href,
      ...(tela.busca !== undefined ? { busca: tela.busca } : {}),
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
      ...(tela.busca !== undefined ? { busca: tela.busca } : {}),
      ...(tela.pai !== undefined ? { pai: tela.pai } : {}),
      listada: false,
      molde: tela.molde,
    }));

    return [...listadas, ...internas];
  });
}

/**
 * O que a busca global oferece.
 *
 * Derivado de `orientacoesVisiveis`, e é por isso que existe: o casco montava a
 * lista com um `flatMap` sobre `modulo.telas`, então as quatro telas **internas**
 * — Ficha do cliente, Meu dia, Meus números, Primeiros passos — nunca entraram.
 * A Ficha é a tela mais rica do produto (fotos do corte, preferências de máquina
 * e barba, histórico) e a única sem porta no menu: quem digitava "foto" recebia
 * "Fotos e marca", que é o logo da página pública, e concluía que o produto não
 * guardava foto de corte.
 *
 * Tela interna não tem endereço próprio — a ficha abre por id —, então o destino
 * é a **porta** do módulo, que é a mesma que a migalha já usa para a volta.
 */
export function destinosDaBusca(
  modulos: readonly ModuloDoPainel[],
): readonly { href: string; nome: string; modulo: string; nota: string; busca: string }[] {
  return orientacoesVisiveis(modulos).map((tela) => ({
    href: tela.href ?? tela.moduloHref,
    nome: tela.nome,
    modulo: tela.moduloNome,
    nota: tela.nota,
    busca: tela.busca ?? '',
  }));
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
