import { sql, withTenant } from '@barbearia/db';
import {
  BOTOES_DO_AVISO,
  BOTOES_POSSIVEIS,
  TETO_DE_LIGACAO,
  TETO_DE_LINK,
  TETO_DE_RESPOSTA_RAPIDA,
  botaoConhecido,
  botaoQueLevaConhecido,
  type BotaoDaMensagem,
  type BotaoQueLeva,
  type EstadoDoTemplate,
  type TipoDeNotificacao,
  type WhatsAppProvider,
} from '@barbearia/core';
import { recusar } from './whatsapp-erros.js';
import { registrarFalhaDaSubmissao, reservarSubmissaoDeTemplate } from './whatsapp-template-submissao.js';

export interface TemplateNaTela {
  readonly id: string;
  readonly tipo: TipoDeNotificacao;
  readonly nome: string;
  /**
   * O nome em português, quando a barbearia deu um (bloco 94).
   *
   * Nulo é texto anterior ao bloco: a tela cai no rótulo do tipo, que é o que
   * ela já mostrava. Com vários textos do mesmo tipo, é ele que os distingue —
   * o `nome` é o identificador da Meta e não distingue nada para quem lê.
   */
  readonly titulo: string | null;
  readonly idioma: string;
  readonly estado: EstadoDoTemplate;
  readonly corpo: string;
  readonly botoes: readonly BotaoDaMensagem[];
  readonly motivoDaRecusa: string | null;
  /**
   * Ainda não saiu daqui (bloco 133).
   *
   * `pendente` passou a significar duas coisas quando a ida à Meta virou
   * tarefa: *esperando a fila levar* e *a Meta recebeu e está avaliando*. A
   * tela precisa dizer qual, senão ela promete "a Meta costuma responder em
   * minutos" sobre um texto que nem chegou lá — e a barbearia vai procurar no
   * painel dela um texto que não existe.
   *
   * Obrigatório e não opcional: `undefined` é falso, e o defeito que a omissão
   * produziria é o silencioso — a tela voltaria a dizer "Na Meta" sobre tudo,
   * com o compilador calado.
   */
  readonly naFila: boolean;
}

const COLUNAS_DO_TEMPLATE = sql`id, kind::text AS kind, name, titulo, language,
                                status::text AS status, body, buttons, rejection_reason,
                                submission_state = 'sending' AS na_fila`;

const paraTela = (l: {
  id: string;
  kind: TipoDeNotificacao;
  name: string;
  titulo: string | null;
  language: string;
  status: EstadoDoTemplate;
  body: string;
  buttons: unknown;
  rejection_reason: string | null;
  na_fila: boolean;
}): TemplateNaTela => ({
  id: l.id,
  tipo: l.kind,
  nome: l.name,
  titulo: l.titulo,
  idioma: l.language,
  estado: l.status,
  corpo: l.body,
  botoes: Array.isArray(l.buttons) ? (l.buttons as BotaoDaMensagem[]) : [],
  motivoDaRecusa: l.rejection_reason,
  naFila: l.na_fila,
});

export async function templatesDaUnidade(
  tenantId: string,
  locationId: string,
): Promise<readonly TemplateNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Parameters<typeof paraTela>[0][]>(sql`
      SELECT ${COLUNAS_DO_TEMPLATE}
        FROM whatsapp_templates
       WHERE location_id = ${locationId}::uuid
       ORDER BY kind, created_at DESC
    `);
    return linhas.map(paraTela);
  });
}

const NOME_DO_TEMPLATE = /^[a-z0-9_]{1,512}$/;

/**
 * Cria o texto e o manda para a Meta aprovar.
 *
 * A linha nasce **antes** da chamada, e é a mesma ordem da cobrança online do
 * bloco 41: a chamada acontece fora da transação, e se o processo cair depois
 * dela o template existiria na Meta e não aqui — invisível, e impossível de
 * consultar porque nem o nome estaria gravado.
 *
 * Os botões saem de `BOTOES_DO_AVISO`, não do formulário. O que a Meta aprova
 * precisa ser o que o motor manda: um template aprovado com "Remarcar" que o
 * lembrete de 2h não oferece seria aprovação gasta à toa, e o contrário —
 * mandar um botão que não foi aprovado — a Meta recusa na hora do envio.
 */
/**
 * O identificador da Meta a partir do título que a barbearia escreveu.
 *
 * A Meta só aceita minúsculas, números e sublinhado — sem acento, sem espaço,
 * sem pontuação. Até o bloco 89 o balcão era obrigado a acertar isso na mão, e
 * "Lembrete 24h" voltava como "Parâmetro inválido: nome"; depois disso o nome
 * passou a sair do tipo, o que deu **um texto por tipo** e fez as onze
 * automações possíveis mandarem a mesma frase.
 *
 * Sai do título para que dois títulos diferentes produzam dois textos. Sem
 * título — que é o caminho dos seis avisos do motor — continua saindo do tipo.
 *
 * A colisão é possível ("Volta, Carlos!" e "volta carlos" dão o mesmo) e é
 * tratada onde ela aparece: o `ON CONFLICT` reescreve o texto daquele nome, que
 * é o comportamento certo para quem está corrigindo o mesmo texto e o errado
 * para quem queria um segundo. A tela avisa antes, comparando os títulos.
 */
export function identificadorDoTexto(titulo: string | undefined, tipo: TipoDeNotificacao): string {
  const limpo = (titulo ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return limpo === '' ? tipo : limpo;
}

/**
 * Para onde cada botão que leva aponta, lido do cadastro da barbearia.
 *
 * Resolvido aqui e não no provedor: ele não fala com banco, e um destino
 * montado lá dentro seria a segunda noção de "qual é a página desta casa" — a
 * primeira já mora no slug, que é permanente por decisão do bloco 1.
 */
export async function destinosDosBotoes(
  tenantId: string,
  locationId: string,
  acoes: readonly BotaoQueLeva[],
): Promise<readonly { readonly botao: BotaoQueLeva; readonly destino: string }[]> {
  const casa = await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ slug: string | null; telefone: string | null }[]>`
      SELECT (SELECT slug FROM tenant_slugs
               WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
               ORDER BY created_at LIMIT 1) AS slug,
             (SELECT phone_e164 FROM locations WHERE id = ${locationId}::uuid) AS telefone
    `;
    return linhas[0] ?? null;
  });

  const base = process.env['WEB_URL'] ?? '';
  return acoes.map((botao) => {
    if (botao === 'ligar') {
      if (!casa?.telefone) recusar('sem_telefone_da_casa');
      return { botao, destino: casa.telefone };
    }
    if (!casa?.slug || base === '') recusar('sem_pagina_da_casa');
    return { botao, destino: `${base}/${casa.slug}` };
  });
}

export async function submeterTemplate(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * O nome do template na Meta — e por padrão **é o próprio tipo do aviso**.
   *
   * A regra da Meta é minúsculas, números e sublinhado, sem acento e sem
   * espaço. É identificador de sistema, e o balcão estava sendo obrigado a
   * digitá-lo: "Lembrete 24h" batia na validação e voltava como "Parâmetro
   * inválido: nome", sobre um campo que a pessoa não tem como acertar sem
   * conhecer a documentação da Meta.
   *
   * Os tipos deste produto já são nomes válidos (`lembrete_24h`,
   * `convite_retorno`), e a tela diz "um por aviso" — então o nome é derivado e
   * o campo saiu. Continua aceito por parâmetro para quem tem um nome já
   * aprovado do lado de lá e precisa casar com ele.
   */
  readonly nome?: string;
  /**
   * O nome que a barbearia deu ao texto, em português (bloco 94).
   *
   * `nome` é o identificador da Meta e só aceita minúsculas, números e
   * sublinhado — nunca foi para ser lido por gente. Com vários textos do mesmo
   * tipo, a tela precisa de algo que os distinga, e "retorno_2" não distingue
   * nada.
   *
   * É ele que gera o identificador quando não vem um pronto, então dois títulos
   * diferentes produzem dois textos, que é o ponto deste bloco inteiro.
   */
  readonly titulo?: string;
  /**
   * Os botões deste texto, quando a barbearia escolheu (bloco 94).
   *
   * Ausente cai em `BOTOES_DO_AVISO`, que é o caminho dos seis avisos que o
   * motor dispara sozinho. Quem escreve um texto de campanha escolhe entre os
   * dois que agem sem horário marcado — os outros precisam de um agendamento
   * provado, e quem recebe campanha não tem.
   */
  readonly botoes?: readonly BotaoDaMensagem[];
  /**
   * Os botões que levam a algum lugar (bloco 95).
   *
   * O destino não vem daqui: sai do slug da barbearia e do telefone da unidade,
   * resolvidos logo abaixo. Um campo livre seria um link digitado errado uma vez
   * e mandado para mil pessoas — e um lugar onde alguém cola um endereço que não
   * é dela.
   */
  readonly acoes?: readonly BotaoQueLeva[];
  readonly idioma?: string;
  readonly corpo: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<TemplateNaTela> {
  const nome = params.nome ?? identificadorDoTexto(params.titulo, params.tipo);
  if (!NOME_DO_TEMPLATE.test(nome)) recusar('nome_invalido');
  const idioma = params.idioma ?? 'pt_BR';

  /**
   * Os botões escolhidos, conferidos contra o que a barbearia **pode** escolher.
   *
   * A lista é **por tipo**, e as duas camadas existem porque uma delas é a que
   * sobrevive: `confirmar` e `cancelar` mexem num agendamento provado, e um
   * texto de campanha não tem nenhum. Aprovado com eles, o cliente apertaria e
   * o produto responderia "o horário não é de quem respondeu" — nada acontece,
   * e ninguém sabe por quê. Ao contrário, `agendar_novamente` num lembrete
   * ofereceria marcar de novo a quem já tem hora marcada.
   */
  const escolhidos = params.botoes;
  if (escolhidos?.some((b) => !BOTOES_POSSIVEIS[params.tipo].includes(b))) {
    recusar('botao_invalido');
  }
  const botoes = escolhidos ?? BOTOES_DO_AVISO[params.tipo];
  if (botoes.length > TETO_DE_RESPOSTA_RAPIDA) recusar('botao_invalido');

  const acoes = [...new Set(params.acoes ?? [])];
  if (acoes.filter((a) => a === 'abrir_agenda').length > TETO_DE_LINK) recusar('botao_invalido');
  if (acoes.filter((a) => a === 'ligar').length > TETO_DE_LIGACAO) recusar('botao_invalido');

  /**
   * O destino de cada botão que leva, do cadastro da casa.
   *
   * `abrir_agenda` vai para a página pública da barbearia, que é onde a grade
   * está; `ligar` vai para o telefone da unidade. Sem telefone cadastrado o
   * botão de ligação é **recusado** em vez de sair vazio: a Meta aprovaria um
   * botão que não disca, e o cliente apertaria sem nada acontecer.
   */
  const destinos = acoes.length === 0 ? [] : await destinosDosBotoes(params.tenantId, params.locationId, acoes);

  const criado = await reservarSubmissaoDeTemplate({
    tenantId: params.tenantId,
    locationId: params.locationId,
    tipo: params.tipo,
    nome,
    idioma,
    corpo: params.corpo,
    botoes: [...botoes, ...acoes],
    titulo: params.titulo ?? null,
    staffId: params.staffId,
    staffName: params.staffName,
  });

  /**
   * Fim do caminho da requisição. A ida à Meta é da fila (bloco 133).
   *
   * `destinos` continua sendo resolvido **aqui** de propósito: sem telefone
   * cadastrado o botão de ligação é recusado, e recusa de entrada tem que
   * chegar a quem está digitando. Do lado do worker ela viraria uma tarefa que
   * falha seis vezes contra um cadastro que ninguém vai corrigir, porque
   * ninguém foi avisado.
   */
  const atual = await templateDaUnidade(params.tenantId, criado.id);
  if (!atual) recusar('template_nao_encontrado');
  return atual;
}

export async function templateDaUnidade(
  tenantId: string,
  templateId: string,
): Promise<TemplateNaTela | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Parameters<typeof paraTela>[0][]>(sql`
      SELECT ${COLUNAS_DO_TEMPLATE} FROM whatsapp_templates WHERE id = ${templateId}::uuid
    `);
    const linha = linhas[0];
    return linha ? paraTela(linha) : null;
  });
}

export async function gravarRespostaDoTemplate(params: {
  readonly tenantId: string;
  readonly templateId: string;
  readonly resposta: { readonly metaId: string | null; readonly estado: EstadoDoTemplate; readonly motivoDaRecusa: string | null };
  readonly claim?: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE whatsapp_templates
         SET meta_id = COALESCE(${params.resposta.metaId}, meta_id),
             status = ${params.resposta.estado}::whatsapp_template_status,
             rejection_reason = ${params.resposta.motivoDaRecusa},
             submission_state = 'idle',
             submission_claim = NULL,
             submission_updated_at = now(),
             updated_at = now()
       WHERE id = ${params.templateId}::uuid
         AND (${params.claim ?? null}::uuid IS NULL OR submission_claim = ${params.claim ?? null}::uuid)
    `;
  });
}

/** Os templates que ainda esperam resposta da Meta. */
export async function templatesEmCurso(
  tenantId: string,
  locationId?: string,
  limite = 50,
): Promise<readonly { readonly id: string; readonly nome: string; readonly idioma: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; name: string; language: string }[]>`
      SELECT id, name, language FROM whatsapp_templates
       WHERE status = 'pendente'
         AND (${locationId ?? null}::uuid IS NULL OR location_id = ${locationId ?? null}::uuid)
         AND (submission_state <> 'sending'
              OR submission_updated_at < now() - interval '2 minutes')
       ORDER BY created_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({ id: l.id, nome: l.name, idioma: l.language }));
  });
}

// ---------------------------------------------------------------------------
// O envio
// ---------------------------------------------------------------------------

