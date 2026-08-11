import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';

/**
 * O override do score de confiabilidade (bloco 37, SPEC §2.13 regra 7).
 *
 * ## Por que a fórmula precisa de uma válvula
 *
 * O score mede desfecho, não circunstância. Ele não distingue o cliente que
 * faltou três vezes por causa de uma internação do que faltou três vezes porque
 * esqueceu — e a barbearia distingue, porque ela conversou com os dois. Sem a
 * válvula, o produto obrigaria o gerente a escolher entre cobrar sinal de quem
 * ele sabe que não devia e desligar a política para todo mundo.
 *
 * O inverso também: histórico impecável e a chave da barbearia sumida no mesmo
 * dia. A fórmula não tem entrada para isso e nunca vai ter.
 *
 * ## Por que o motivo é obrigatório
 *
 * A SPEC pede "justificativa auditada", e as duas palavras fazem trabalho
 * diferente. A trilha guarda **quem** mexeu; o motivo escrito guarda **por
 * quê**, e é o que sobra seis meses depois, quando quem escreveu já não
 * trabalha ali e o número continua dispensando aquele cliente do sinal.
 *
 * O comprimento mínimo é cobrado no banco, e é de propósito: "ok" cabe num
 * campo obrigatório e não explica nada.
 */

export type ConfiancaFailure = 'cliente_nao_encontrado' | 'score_invalido' | 'motivo_curto';

export class ConfiancaError extends Error {
  constructor(readonly code: ConfiancaFailure, message: string) {
    super(message);
    this.name = 'ConfiancaError';
  }
}

/** O mesmo piso que a CHECK da migração 0039 cobra. */
export const MINIMO_DE_MOTIVO = 10;

export interface OverrideDeConfianca {
  readonly tenantId: string;
  readonly customerId: string;
  /** Nulo devolve o cliente à fórmula. */
  readonly score: number | null;
  readonly motivo: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface ConfiancaGravada {
  readonly score: number | null;
  readonly motivo: string | null;
  readonly quando: string | null;
}

/**
 * Grava — ou remove — o override.
 *
 * Remover também exige motivo e também é auditado. Devolver um cliente à
 * fórmula é uma decisão sobre dinheiro tanto quanto tirá-lo dela: quem estava
 * dispensado do sinal volta a pagá-lo, e a pergunta do balcão no dia seguinte é
 * a mesma.
 */
export async function definirConfianca(
  entrada: OverrideDeConfianca,
): Promise<ConfiancaGravada> {
  if (entrada.score !== null && (!Number.isInteger(entrada.score) || entrada.score < 0 || entrada.score > 100)) {
    throw new ConfiancaError('score_invalido', 'O score precisa ser um inteiro de 0 a 100.');
  }
  const motivo = entrada.motivo.trim();
  if (motivo.length < MINIMO_DE_MOTIVO) {
    throw new ConfiancaError(
      'motivo_curto',
      'Escreva o motivo do ajuste — ele é o que explica a decisão depois.',
    );
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const antes = await tx.$queryRaw<
      { reliability_override: number | null; reliability_override_reason: string | null }[]
    >`
      SELECT reliability_override, reliability_override_reason
        FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    const anterior = antes[0];
    // Cliente de outra barbearia não existe: a RLS devolve zero linhas, e a
    // resposta é a mesma de um id inventado.
    if (!anterior) {
      throw new ConfiancaError('cliente_nao_encontrado', 'Este cliente não existe.');
    }

    // O motivo acompanha o `NULL` em vez de sumir com ele: a CHECK só o exige
    // quando há score, e apagá-lo apagaria a explicação de quem tirou o cliente
    // do override — que é exatamente o que a trilha precisa cruzar.
    const linhas = await tx.$queryRaw<
      { reliability_override: number | null; reliability_override_reason: string | null;
        reliability_override_at: Date | null }[]
    >`
      UPDATE customers
         SET reliability_override = ${entrada.score},
             reliability_override_reason = ${motivo},
             reliability_override_at = now(),
             updated_at = now()
       WHERE id = ${entrada.customerId}::uuid
      RETURNING reliability_override, reliability_override_reason, reliability_override_at
    `;
    const linha = linhas[0];
    if (!linha) {
      throw new ConfiancaError('cliente_nao_encontrado', 'Este cliente não existe.');
    }

    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'customer.reliability_override',
      entity: 'customer',
      entityId: entrada.customerId,
      before: { score: anterior.reliability_override },
      after: { score: entrada.score, motivo },
      ...(entrada.ip ? { ip: entrada.ip } : {}),
      ...(entrada.userAgent ? { userAgent: entrada.userAgent } : {}),
    });

    return {
      score: linha.reliability_override,
      motivo: linha.reliability_override_reason,
      quando: linha.reliability_override_at?.toISOString() ?? null,
    };
  });
}
