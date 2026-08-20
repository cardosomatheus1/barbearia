import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  acertoDoProfissional,
  aplicarModeloDaAssinatura,
  comissaoDoPeriodo,
  disponivelParaAdiantar,
  podeAdiantar,
  validarMotivoDoVale,
  type EstadoDoVale,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { lancamentosAbertos, lerModeloDaAssinatura, paraLancamento } from './comissao.js';

/**
 * Vale / adiantamento ao profissional (bloco 52, SPEC §3.10).
 *
 * A regra mora em `packages/core`. Aqui se carrega o que ele já fez, se pergunta
 * ao domínio e se grava — junto do movimento de caixa, quando o dinheiro sai da
 * gaveta.
 *
 * ## O teto sai do banco, nunca do parâmetro
 *
 * Quanto o profissional acumulou de comissão é calculado **pela mesma função**
 * que o extrato e o fechamento usam, dentro da transação que concede o vale.
 * Recebê-lo pelo corpo faria a tela decidir o próprio limite — é o mesmo
 * precedente de "ninguém concede o que não tem" do bloco 30.
 */

export type ValeRepoFailure =
  | 'valor_invalido'
  | 'motivo_obrigatorio'
  | 'vale_maior_que_a_comissao'
  | 'vale_nao_aberto'
  | 'vale_nao_encontrado'
  | 'profissional_nao_encontrado'
  | 'sem_caixa_aberto';

export class ValeError extends Error {
  constructor(
    readonly code: ValeRepoFailure,
    message: string,
    readonly detalhe?: Record<string, number>,
  ) {
    super(message);
    this.name = 'ValeError';
  }
}

const MENSAGEM: Readonly<Record<ValeRepoFailure, string>> = {
  valor_invalido: 'Confira o valor.',
  motivo_obrigatorio: 'Escreva o motivo.',
  vale_maior_que_a_comissao: 'O vale não pode passar do que o profissional já fez no período.',
  vale_nao_aberto: 'Este vale já foi descontado ou cancelado.',
  vale_nao_encontrado: 'Este vale não existe.',
  profissional_nao_encontrado: 'Profissional não encontrado.',
  sem_caixa_aberto:
    'Não há caixa aberto. Abra o caixa para tirar ou devolver dinheiro da gaveta.',
};

function recusar(code: ValeRepoFailure, detalhe?: Record<string, number>): never {
  throw new ValeError(code, MENSAGEM[code], detalhe);
}

export interface ValeNaTela {
  readonly id: string;
  readonly professionalId: string;
  readonly professionalName: string;
  readonly valorCents: number;
  readonly concedidoEm: string;
  readonly motivo: string | null;
  readonly estado: EstadoDoVale;
  readonly pelaGaveta: boolean;
  readonly criadoPor: string;
}

const dia = (valor: Date | string): string =>
  typeof valor === 'string' ? valor.slice(0, 10) : valor.toISOString().slice(0, 10);

/**
 * Quanto o profissional acumulou de comissão no período **aberto**.
 *
 * Pela mesma função do extrato e do fechamento, incluindo o modelo de comissão
 * sobre assinatura: o número que a tela usa para dizer "dá para adiantar até
 * R$ 900" tem que ser o mesmo que o acerto vai pagar, senão o vale de hoje vira
 * a discussão do dia 30.
 */
async function comissaoAcumulada(
  tx: TransactionClient,
  params: { readonly professionalId: string; readonly de: string; readonly ate: string },
): Promise<number> {
  const lancamentos = await lancamentosAbertos(tx, { de: params.de, ate: params.ate });
  if (lancamentos.length === 0) return 0;

  const modelo = await lerModeloDaAssinatura(tx);
  const contas = comissaoDoPeriodo(
    aplicarModeloDaAssinatura(lancamentos.map(paraLancamento), modelo),
  );
  return contas.find((c) => c.professionalId === params.professionalId)?.comissaoCents ?? 0;
}

async function jaAdiantado(
  tx: TransactionClient,
  professionalId: string,
): Promise<number> {
  const linhas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(amount_cents)::int AS total FROM professional_advances
     WHERE professional_id = ${professionalId}::uuid AND status = 'aberto'
  `;
  return linhas[0]?.total ?? 0;
}

export interface TetoDoVale {
  readonly comissaoAcumuladaCents: number;
  readonly jaAdiantadoCents: number;
  readonly disponivelCents: number;
}

/** O que a tela mostra antes de alguém digitar um valor. */
export async function tetoDoVale(params: {
  readonly tenantId: string;
  /**
   * A loja do balcão.
   *
   * O bloco escopou `conceberVale`, `valesDoPeriodo` e `cancelarVale` — as três
   * do mesmo arquivo — e deixou esta de fora. Ela devolve comissão acumulada,
   * já adiantado e disponível de **qualquer** profissional da barbearia, e o id
   * dele é público: `GET /{slug}` lista os profissionais da página. Uma
   * requisição entregava o holerite do barbeiro da outra loja.
   */
  readonly locationId: string;
  readonly professionalId: string;
  readonly de: string;
  readonly ate: string;
}): Promise<TetoDoVale> {
  return withTenant(params.tenantId, async (tx) => {
    const daLoja = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals
       WHERE id = ${params.professionalId}::uuid
         AND location_id = ${params.locationId}::uuid
    `;
    // Mesma mensagem de inexistente: "existe, mas nao e seu" confirma o id.
    if (daLoja.length === 0) recusar('profissional_nao_encontrado');

    const comissaoAcumuladaCents = await comissaoAcumulada(tx, params);
    const jaAdiantadoCents = await jaAdiantado(tx, params.professionalId);
    return {
      comissaoAcumuladaCents,
      jaAdiantadoCents,
      disponivelCents: disponivelParaAdiantar({ comissaoAcumuladaCents, jaAdiantadoCents }),
    };
  });
}

/**
 * Concede o vale.
 *
 * A trava é no profissional, e ela é o que impede dois adiantamentos
 * simultâneos do mesmo teto: sem ela, dois toques leem "disponível R$ 900" os
 * dois e gravam R$ 900 cada. É a mesma lição do pacote no bloco 43.
 */
export async function conceberVale(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly professionalId: string;
  readonly valorCents: number;
  readonly concedidoEm: string;
  readonly de: string;
  readonly ate: string;
  readonly motivo?: string | null;
  readonly pelaGaveta: boolean;
  readonly idempotencyKey?: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string }> {
  const falhaDoMotivo = validarMotivoDoVale(params.motivo);
  if (falhaDoMotivo) recusar('motivo_obrigatorio');

  return withTenant(params.tenantId, async (tx) => {
    /**
     * Dois vales iguais no mesmo dia são caso legítimo — o barbeiro pede R$ 100
     * de manhã e R$ 100 à tarde —, e por isso o toque duplo precisa de chave: não
     * há estado que distinga o segundo da repetição do primeiro. É a mesma
     * situação da transferência entre contas do bloco 51.
     */
    if (params.idempotencyKey) {
      const jaFeito = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professional_advances
         WHERE idempotency_key = ${params.idempotencyKey}
      `;
      const anterior = jaFeito[0];
      if (anterior) return { id: anterior.id };
    }

    /**
     * A loja do profissional vem **antes** de qualquer conta sobre ele.
     *
     * A conferência existia, e existia na última instrução: o `WHERE EXISTS` do
     * `INSERT`. Entre uma coisa e outra rodavam `comissaoAcumulada`,
     * `jaAdiantado` e `podeAdiantar`, que recusam com
     * `vale_maior_que_a_comissao` — e os dois códigos chegam ao cliente. Busca
     * binária sobre o valor, contra um `professionalId` da matriz, encontrava a
     * fronteira exata entre os dois códigos, que é o disponível ao centavo.
     *
     * O holerite do colega em trinta requisições, com uma permissão que a
     * gerente da filial precisa ter para conceder vale na própria loja. Achado
     * da `/security-review` deste bloco.
     */
    const profissional = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals
       WHERE id = ${params.professionalId}::uuid
         AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    if (profissional.length === 0) recusar('profissional_nao_encontrado');

    const comissaoAcumuladaCents = await comissaoAcumulada(tx, params);
    const jaAdiantadoCents = await jaAdiantado(tx, params.professionalId);

    const falha = podeAdiantar({
      valorCents: params.valorCents,
      comissaoAcumuladaCents,
      jaAdiantadoCents,
    });
    if (falha) {
      recusar(falha === 'valor_invalido' ? 'valor_invalido' : 'vale_maior_que_a_comissao', {
        disponivelCents: disponivelParaAdiantar({ comissaoAcumuladaCents, jaAdiantadoCents }),
      });
    }

    let movimentoId: string | null = null;
    if (params.pelaGaveta) {
      movimentoId = await sangriaDoVale(tx, {
        locationId: params.locationId,
        valorCents: params.valorCents,
        staffName: params.staffName,
        staffId: params.staffId,
      });
    }

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO professional_advances
        (tenant_id, location_id, professional_id, amount_cents, granted_on, reason,
         cash_movement_id, idempotency_key, created_by, created_by_name)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.professionalId}::uuid,
             ${params.valorCents}, ${params.concedidoEm}::date,
             ${params.motivo?.trim() || null}, ${movimentoId}::uuid,
             ${params.idempotencyKey ?? null},
             ${params.staffId}::uuid, ${params.staffName}
       -- O profissional precisa ser **desta loja**, e nao so existir.
       -- A versao anterior conferia a unidade, nunca a cadeira: a gerente
       -- escopada a filial concedia vale ao barbeiro da matriz tirando o
       -- dinheiro da gaveta dela. O fechamento da folha descontava na loja onde
       -- ele trabalha, e a gaveta da filial fechava faltando.
       WHERE EXISTS (
         SELECT 1 FROM professionals p
          WHERE p.id = ${params.professionalId}::uuid
            AND p.location_id = ${params.locationId}::uuid
       )
      RETURNING id
    `;
    const criado = linhas[0];
    if (!criado) recusar('profissional_nao_encontrado');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'advance.granted',
      entity: 'professional_advance',
      entityId: criado.id,
      after: {
        professionalId: params.professionalId,
        valorCents: params.valorCents,
        concedidoEm: params.concedidoEm,
        pelaGaveta: params.pelaGaveta,
        disponivelAntesCents: disponivelParaAdiantar({
          comissaoAcumuladaCents,
          jaAdiantadoCents,
        }),
      },
    });

    return { id: criado.id };
  });
}

async function sangriaDoVale(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly valorCents: number;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<string> {
  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) recusar('sem_caixa_aberto');

  const somas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(amount_cents)::int AS total FROM cash_movements
     WHERE session_id = ${sessao.id}::uuid
  `;
  const naGaveta = somas[0]?.total ?? 0;
  if (params.valorCents > naGaveta) {
    throw new ValeError(
      'valor_invalido',
      `Não há esse valor na gaveta. Disponível agora: ${naGaveta} centavos.`,
      { naGaveta },
    );
  }

  const linhas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO cash_movements
      (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${sessao.id}::uuid, 'withdrawal'::cash_movement_type, ${-params.valorCents},
      'Vale ao profissional', ${params.staffId}::uuid, ${params.staffName}
    )
    RETURNING id
  `;
  const movimento = linhas[0];
  if (!movimento) recusar('valor_invalido');
  return movimento.id;
}

export async function cancelarVale(params: {
  readonly tenantId: string;
  /**
   * A loja do balcão. Cancelar devolve o dinheiro à gaveta **do vale** — isso
   * já estava certo —, mas qualquer loja podia cancelar o vale de qualquer
   * outra: a gerente da filial cancelava o adiantamento que a matriz tinha
   * concedido, e o teto do barbeiro de lá voltava inteiro.
   */
  readonly locationId: string;
  readonly valeId: string;
  readonly motivo: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  const motivo = params.motivo.trim();
  if (motivo.length < 3) recusar('motivo_obrigatorio');

  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        status: EstadoDoVale;
        amount_cents: number;
        cash_movement_id: string | null;
        location_id: string;
      }[]
    >`
      SELECT status::text AS status, amount_cents, cash_movement_id, location_id
        FROM professional_advances
       WHERE id = ${params.valeId}::uuid
         AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const vale = linhas[0];
    if (!vale) recusar('vale_nao_encontrado');
    if (vale.status !== 'aberto') recusar('vale_nao_aberto');

    /**
     * O vale que saiu da gaveta volta para a gaveta — achado da
     * `/security-review` deste bloco, e o mais caro dela.
     *
     * A primeira versão só virava o estado. O dinheiro tinha saído de verdade,
     * o `withdrawal` continuava gravado, e cancelar apagava a dívida: o
     * fechamento do dia batia ao centavo, a folha não descontava nada, e o teto
     * voltava inteiro — dava para repetir o par conceder-cancelar até esvaziar a
     * gaveta, deixando só uma fila de sangrias de aparência normal.
     *
     * Devolver é o que **de fato** acontece no balcão quando o vale foi lançado
     * errado: o profissional devolve as notas. Sem caixa aberto a operação é
     * recusada, porque a entrada não teria onde ser lançada — e um cancelamento
     * que não devolve é o defeito de novo.
     */
    let devolvidoCents = 0;
    if (vale.cash_movement_id) {
      await devolucaoDoVale(tx, {
        locationId: vale.location_id,
        valorCents: vale.amount_cents,
        staffId: params.staffId,
        staffName: params.staffName,
      });
      devolvidoCents = vale.amount_cents;
    }

    await tx.$executeRaw`
      UPDATE professional_advances
         SET status = 'cancelado', cancel_reason = ${motivo}
       WHERE id = ${params.valeId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'advance.cancelled',
      entity: 'professional_advance',
      entityId: params.valeId,
      before: { valorCents: vale.amount_cents },
      after: { motivo, devolvidoAGavetaCents: devolvidoCents },
    });
  });
}

/**
 * A volta do dinheiro para a gaveta, quando o vale cancelado saiu dela.
 *
 * `supply` e não `adjustment`: suprimento é dinheiro que **entra** na gaveta
 * vindo de fora do caixa, que é exatamente o que o profissional devolvendo as
 * notas é. `adjustment` é para divergência de contagem, e usá-lo aqui esconderia
 * uma entrada legítima dentro do balde de "não sabemos o que houve".
 */
async function devolucaoDoVale(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly valorCents: number;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<void> {
  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) recusar('sem_caixa_aberto');

  await tx.$executeRaw`
    INSERT INTO cash_movements
      (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${sessao.id}::uuid, 'supply'::cash_movement_type, ${params.valorCents},
      'Vale cancelado, dinheiro devolvido', ${params.staffId}::uuid, ${params.staffName}
    )
  `;
}

export async function valesDoPeriodo(params: {
  readonly tenantId: string;
  /**
   * A loja do balcão. `professional_advances.location_id` é `NOT NULL` e
   * preenchida em toda linha desde que a coluna existe — e nenhuma leitura a
   * usava: a tela de Comissão da filial listava os vales da rede inteira, cada
   * um com botão "Cancelar" ao lado. É a coluna que existe e ninguém lê.
   */
  readonly locationId: string;
  readonly de: string;
  readonly ate: string;
  readonly somenteProfessionalId?: string | null;
}): Promise<readonly ValeNaTela[]> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        professional_id: string;
        professional_name: string;
        amount_cents: number;
        granted_on: Date;
        reason: string | null;
        status: EstadoDoVale;
        cash_movement_id: string | null;
        created_by_name: string;
      }[]
    >`
      SELECT v.id, v.professional_id, p.name AS professional_name, v.amount_cents,
             v.granted_on, v.reason, v.status::text AS status, v.cash_movement_id,
             v.created_by_name
        FROM professional_advances v
        JOIN professionals p ON p.id = v.professional_id
       WHERE v.location_id = ${params.locationId}::uuid
         AND v.granted_on BETWEEN ${params.de}::date AND ${params.ate}::date
         AND (${params.somenteProfessionalId ?? null}::uuid IS NULL
              OR v.professional_id = ${params.somenteProfessionalId ?? null}::uuid)
       ORDER BY v.granted_on DESC, v.created_at DESC
       LIMIT 500
    `;

    return linhas.map((l) => ({
      id: l.id,
      professionalId: l.professional_id,
      professionalName: l.professional_name,
      valorCents: l.amount_cents,
      concedidoEm: dia(l.granted_on),
      motivo: l.reason,
      estado: l.status,
      pelaGaveta: l.cash_movement_id !== null,
      criadoPor: l.created_by_name,
    }));
  });
}

export { acertoDoProfissional };

/**
 * O desconto dos vales no fechamento mora em `comissao.ts`, e não aqui.
 *
 * Ele roda dentro da transação que cria o fechamento, e é `comissao.ts` que a
 * abre. Deixá-lo neste arquivo faria `comissao.ts` importar `vale.ts` enquanto
 * `vale.ts` já importa `comissao.ts` — um ciclo que o ESM tolera e que a
 * primeira reordenação de import quebra em silêncio. A seta fica numa direção
 * só, como no resto do repositório.
 */
export { descontarValesNoFechamento } from './comissao.js';
