import { withTenant } from '@barbearia/db';
import {
  ehConversa,
  EXPLICACAO_DO_SEGMENTO,
  PREFERENCIAS_VAZIAS,
  type Conversa,
  type Preferencias,
  type Segmento,
} from '@barbearia/core';
import { segmentosDaBase } from './segmento.js';

/**
 * A ficha do cliente — SPEC Parte 4 §4.1 e §4.3.
 *
 * "A tela que o barbeiro abre antes de atender." Duas coisas juntas porque são
 * a mesma pergunta feita de dois jeitos: **como esta pessoa gosta de ser
 * atendida** (o que ela disse) e **como ela vem sendo atendida** (o que
 * aconteceu). Uma sozinha engana — preferência escrita há dois anos por um
 * barbeiro que saiu vale menos do que o corte do mês passado.
 *
 * Pacote próprio porque é o começo do domínio de CRM, que a SPEC trata como
 * parte separada e que os blocos 22 e 61 vão povoar. Ele depende só de `core` e
 * `db`: não sabe que existe agenda, comanda ou comissão, e nenhuma seta volta.
 */

export class FichaError extends Error {
  constructor(readonly code: 'cliente_nao_encontrado' | 'preferencia_invalida', message: string) {
    super(message);
    this.name = 'FichaError';
  }
}

export interface VisitaNaLinhaDoTempo {
  readonly id: string;
  /** Instante ISO. A tela formata no fuso da unidade. */
  readonly quando: string;
  readonly status: string;
  readonly profissional: string;
  readonly servicos: readonly string[];
  readonly precoCents: number;
  /**
   * Em qual loja a visita aconteceu (bloco 59).
   *
   * O cadastro do cliente sempre foi da empresa — `customers` nunca teve
   * `location_id`. O que faltava para o histórico ser de fato **unificado** era
   * a linha do tempo dizer onde ele esteve: sem isso, numa rede, "cortou dia 12"
   * é meia resposta.
   */
  readonly unidade: string | null;
}

export interface Ficha {
  readonly customerId: string;
  readonly nome: string;
  /** Só os quatro últimos dígitos: a tela fica virada para o salão. */
  /** Nulo depois da anonimização (bloco 32): não há mais telefone para mostrar. */
  readonly telefoneFinal: string | null;
  /** O cadastro deixou de identificar uma pessoa. A tela precisa dizer isso. */
  readonly anonimizado: boolean;
  readonly preferencias: Preferencias;
  readonly anotadoEm: string | null;
  readonly anotadoPor: string | null;
  readonly linhaDoTempo: readonly VisitaNaLinhaDoTempo[];
  /** Quantas vezes já veio de fato. É o número que muda como se trata alguém. */
  readonly visitas: number;
  readonly desde: string | null;
  /** Último atendimento concluído; faltas/cancelamentos não contam como visita. */
  readonly ultimaVisita: string | null;
  /**
   * O segmento e o ritmo (bloco 61, SPEC §4.4) — **sem nenhum valor em reais**.
   *
   * O segmento em si é derivado de gasto entre outras coisas, mas o que sai daqui
   * é o rótulo, o ciclo em dias e há quantos dias a pessoa não vem.
   *
   * O **total acumulado** fica de fora de propósito. A linha do tempo já traz o
   * preço de cada visita, que é o que o barbeiro precisa para conversar sobre o
   * corte; o acumulado é outra coisa — é o LTV, o número sobre o qual o decil de
   * VIP é construído, e ele é `finance.view`. Um campo de cada vez é como a rota
   * da nota fiscal virou o caminho curto para o CPF de toda a base no bloco 54.
   */
  readonly segmento: Segmento;
  readonly explicacaoDoSegmento: string;
  readonly cicloDias: number | null;
  readonly diasSemVir: number | null;
}

interface LinhaDaFicha {
  name: string;
  phone_e164: string | null;
  anonymized_at: Date | null;
  maquina_laterais: string | null;
  tipo_degrade: string | null;
  topo: string | null;
  barba_estilo: string | null;
  produtos_evitar: string | null;
  conversa: string | null;
  observacoes: string | null;
  anotado_em: Date | null;
  anotado_por: string | null;
  visitas: bigint;
  desde: Date | null;
}

/**
 * Quantas visitas a linha do tempo mostra.
 *
 * O barbeiro decide o corte olhando as últimas, não a vida inteira. Um teto
 * baixo é o que mantém a tela legível no celular — e quem quiser o histórico
 * completo tem a agenda.
 */
const VISITAS_NA_TELA = 10;

export async function lerFicha(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<Ficha> {
  return withTenant(tenantId, async (tx) => {
    // Uma consulta para a ficha e uma para a linha do tempo. Duas, não uma por
    // visita: a tela abre com o cliente sentado na cadeira.
    const linhas = await tx.$queryRaw<LinhaDaFicha[]>`
      SELECT c.name, c.phone_e164, c.anonymized_at,
             p.maquina_laterais, p.tipo_degrade, p.topo, p.barba_estilo,
             p.produtos_evitar, p.conversa, p.observacoes,
             p.updated_at AS anotado_em, s.name AS anotado_por,
             (SELECT count(*) FROM appointments a
               WHERE a.customer_id = c.id AND a.status = 'completed')::bigint AS visitas,
             (SELECT min(a.service_starts_at) FROM appointments a
               WHERE a.customer_id = c.id AND a.status = 'completed') AS desde
        FROM customers c
        LEFT JOIN customer_preferences p ON p.customer_id = c.id
        LEFT JOIN staff_users s ON s.id = p.updated_by
       WHERE c.id = ${customerId}::uuid
    `;

    const linha = linhas[0];
    // Cliente de outra barbearia não existe: a RLS devolve zero linhas, e a
    // resposta é a mesma de um id inventado.
    if (!linha) {
      throw new FichaError('cliente_nao_encontrado', 'Este cliente não existe.');
    }

    const visitas = await tx.$queryRaw<
      {
        id: string;
        quando: Date;
        status: string;
        profissional: string;
        servicos: string[] | null;
        price_cents: number;
        unidade: string | null;
      }[]
    >`
      SELECT a.id, a.service_starts_at AS quando, a.status::text AS status,
             pr.name AS profissional, a.price_cents, lo.name AS unidade,
             (SELECT array_agg(sv.name ORDER BY aps.position)
                FROM appointment_services aps
                JOIN services sv ON sv.id = aps.service_id
               WHERE aps.appointment_id = a.id) AS servicos
        FROM appointments a
        JOIN professionals pr ON pr.id = a.professional_id
        -- A loja de cada visita (bloco 59). O cadastro do cliente sempre foi da
        -- empresa: o que faltava era a linha do tempo dizer onde ele esteve, que
        -- e o que a SPEC §1.1 chama de historico unificado.
        LEFT JOIN locations lo ON lo.id = a.location_id
       WHERE a.customer_id = ${customerId}::uuid
         AND a.status IN ('completed', 'no_show', 'cancelled_customer', 'cancelled_business')
       ORDER BY a.service_starts_at DESC
       LIMIT ${VISITAS_NA_TELA}
    `;

    /**
     * O segmento vem da base inteira, e é por isso que ele custa uma consulta a
     * mais em vez de sair da linha acima.
     *
     * "Frequente" é ciclo abaixo da mediana da base e "VIP" é o topo do decil de
     * gasto: não existe versão barata que responda por uma pessoa. Calcular aqui
     * só os quatro segmentos que cabem no histórico individual seria mais rápido
     * e faria esta tela discordar da contagem do dono sobre a mesma pessoa —
     * duas telas mostrando o mesmo fato precisam concordar (§6, pergunta 6).
     */
    const naBase = (await segmentosDaBase(tenantId, agora, tx)).find(
      (c) => c.customerId === customerId,
    );

    return {
      customerId,
      nome: linha.name,
      /**
       * Nulo depois da anonimização (bloco 32).
       *
       * A coluna passou a aceitar nulo, e este `.slice(-4)` quebrava a ficha
       * inteira de um cadastro apagado. O tipo do banco não avisa o TypeScript:
       * quem escreve a interface da linha é quem escreve a consulta, e ela
       * dizia `string`.
       */
      telefoneFinal: linha.phone_e164?.slice(-4) ?? null,
      anonimizado: linha.anonymized_at !== null,
      preferencias: dasColunas(linha),
      anotadoEm: linha.anotado_em?.toISOString() ?? null,
      anotadoPor: linha.anotado_por,
      linhaDoTempo: visitas.map((visita) => ({
        id: visita.id,
        quando: visita.quando.toISOString(),
        status: visita.status,
        profissional: visita.profissional,
        servicos: visita.servicos ?? [],
        precoCents: visita.price_cents,
        unidade: visita.unidade,
      })),
      visitas: Number(linha.visitas),
      desde: linha.desde?.toISOString() ?? null,
      ultimaVisita: naBase?.ultimaVisita?.toISOString() ?? null,
      /**
       * Cliente anonimizado sai da base — e a ficha dele continua abrindo, para
       * a tela poder dizer que o cadastro foi apagado. `novo` é o rótulo honesto
       * de quem não tem mais histórico legível.
       */
      segmento: naBase?.segmento ?? 'novo',
      explicacaoDoSegmento: EXPLICACAO_DO_SEGMENTO[naBase?.segmento ?? 'novo'],
      cicloDias: naBase?.ciclo?.medianaDias ?? null,
      diasSemVir: naBase?.diasSemVir ?? null,
    };
  });
}

/**
 * Cliente sem ficha devolve a ficha vazia, não `null`.
 *
 * A alternativa obrigaria toda tela e todo teste a tratar dois formatos para o
 * mesmo estado — "nunca foi anotado" e "foi anotado e apagaram" são a mesma
 * coisa para quem vai cortar o cabelo agora.
 */
function dasColunas(linha: LinhaDaFicha): Preferencias {
  const conversa: Conversa =
    linha.conversa && ehConversa(linha.conversa) ? linha.conversa : 'indiferente';

  return {
    maquinaLaterais: linha.maquina_laterais,
    tipoDegrade: linha.tipo_degrade,
    topo: linha.topo,
    barbaEstilo: linha.barba_estilo,
    produtosEvitar: linha.produtos_evitar,
    conversa,
    observacoes: linha.observacoes,
  };
}

export const FICHA_EM_BRANCO = PREFERENCIAS_VAZIAS;

/**
 * Grava a preferência, criando a ficha na primeira vez.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` num `UPDATE` seguido de `INSERT`: dois
 * barbeiros anotando o mesmo cliente no mesmo instante — que acontece quando um
 * cobre o outro — colidiriam na chave primária, e o segundo veria erro de banco
 * em vez de a anotação dele valer.
 *
 * O `customer_id` é conferido sob RLS **antes**: a checagem de integridade
 * referencial do Postgres ignora row security, então a chave estrangeira
 * sozinha aceitaria a ficha de um cliente de outra barbearia.
 */
export async function salvarPreferencias(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly staffUserId: string;
  readonly preferencias: Preferencias;
}): Promise<void> {
  const p = params.preferencias;
  if (!ehConversa(p.conversa)) {
    throw new FichaError('preferencia_invalida', 'Preferência de conversa desconhecida.');
  }

  await withTenant(params.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${params.customerId}::uuid
    `;
    if (!existe[0]) {
      throw new FichaError('cliente_nao_encontrado', 'Este cliente não existe.');
    }

    await tx.$executeRaw`
      INSERT INTO customer_preferences (
        customer_id, tenant_id, maquina_laterais, tipo_degrade, topo,
        barba_estilo, produtos_evitar, conversa, observacoes, updated_by, updated_at
      ) VALUES (
        ${params.customerId}::uuid,
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${vazioEhNulo(p.maquinaLaterais)}, ${vazioEhNulo(p.tipoDegrade)},
        ${vazioEhNulo(p.topo)}, ${vazioEhNulo(p.barbaEstilo)},
        ${vazioEhNulo(p.produtosEvitar)}, ${p.conversa},
        ${vazioEhNulo(p.observacoes)}, ${params.staffUserId}::uuid, now()
      )
      ON CONFLICT (customer_id) DO UPDATE SET
        maquina_laterais = EXCLUDED.maquina_laterais,
        tipo_degrade = EXCLUDED.tipo_degrade,
        topo = EXCLUDED.topo,
        barba_estilo = EXCLUDED.barba_estilo,
        produtos_evitar = EXCLUDED.produtos_evitar,
        conversa = EXCLUDED.conversa,
        observacoes = EXCLUDED.observacoes,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
  });
}

/**
 * Campo em branco vira nulo, não string vazia.
 *
 * Com string vazia, `fichaEstaVazia` e a tela precisariam conhecer dois jeitos
 * de dizer "não preenchido" — e `''` empurraria a ficha para o estado
 * "preenchida" sem nada escrito nela.
 */
function vazioEhNulo(valor: string | null): string | null {
  const limpo = valor?.trim();
  return limpo ? limpo : null;
}
