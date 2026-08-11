import { withTenant, type TransactionClient } from '@barbearia/db';
import { POLITICA_SEM_SINAL, decidirReembolso, type DesfechoDoSinal } from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * O sinal recebido, e o que acontece com ele depois (bloco 37).
 *
 * ## Por que isto não é uma cobrança online
 *
 * O sinal deste bloco é o Pix que o cliente manda para o número da barbearia,
 * dias antes, para garantir o sábado. É como a esmagadora maioria das
 * barbearias do país cobra sinal hoje, e não passa por adquirente nenhum: o
 * comprovante chega no WhatsApp e alguém confere.
 *
 * O que falta aqui é a cobrança **pelo produto** — QR Code emitido na tela de
 * agendamento, webhook confirmando, devolução automática. Isso é o mecanismo
 * dos blocos 35 e 36 aplicado ao agendamento em vez da comanda, e está
 * declarado como lacuna. O que este arquivo entrega é o registro, que é o que
 * transforma `deposit_paid_cents` de coluna morta em dinheiro rastreável.
 *
 * ## O que impede o dobro
 *
 * Não é chave de idempotência: é o estado. `deposit_paid_cents = 0` no `WHERE`
 * faz o segundo toque não escrever nada, mesmo vindo de outro aparelho, de
 * outra sessão ou com chave nova — que é justamente o que uma chave gerada pelo
 * cliente não garante. O segundo toque devolve o estado atual em vez de erro,
 * porque a operação de fato aconteceu.
 */

export type SinalFailure =
  | 'agendamento_nao_encontrado'
  | 'sem_sinal_exigido'
  | 'valor_diferente_do_exigido'
  | 'sinal_ja_registrado'
  | 'sinal_nao_registrado';

export class SinalError extends Error {
  constructor(readonly code: SinalFailure, message: string) {
    super(message);
    this.name = 'SinalError';
  }
}

export interface SinalDoAgendamento {
  readonly appointmentId: string;
  readonly exigidoCents: number;
  readonly pagoCents: number;
  readonly motivo: string | null;
  /** Nulo enquanto o agendamento não foi cancelado. */
  readonly reembolso: DesfechoDoSinal | null;
  readonly porqueDoReembolso: string | null;
}

interface LinhaDoSinal {
  readonly id: string;
  readonly deposit_required_cents: number;
  readonly deposit_paid_cents: number;
  readonly deposit_reason: string | null;
  readonly status: string;
  readonly service_starts_at: Date;
  readonly cancelled_at: Date | null;
  readonly deposit_refund_hours: number;
}

const MS_POR_HORA = 3_600_000;

/**
 * Lê o sinal e já resolve o que a tela precisa dizer sobre ele.
 *
 * O `JOIN` com `locations` traz o prazo de reembolso na mesma consulta: sem ele
 * a tela faria uma segunda ida ao banco por agendamento, que é o N+1 que o
 * CLAUDE.md §3 proíbe — e a lista de cancelados do dia é justamente onde isso
 * apareceria.
 */
async function carregar(
  tx: TransactionClient,
  appointmentId: string,
): Promise<SinalDoAgendamento> {
  const linhas = await tx.$queryRaw<LinhaDoSinal[]>`
    SELECT a.id, a.deposit_required_cents, a.deposit_paid_cents, a.deposit_reason,
           a.status::text AS status, a.service_starts_at, a.cancelled_at,
           l.deposit_refund_hours
      FROM appointments a
      JOIN locations l ON l.id = a.location_id
     WHERE a.id = ${appointmentId}::uuid
       -- O remarcado não é um agendamento: ele virou outro, e o sinal foi
       -- junto. Aceitar o id antigo faria a recepção registrar um Pix contra
       -- uma linha morta — ou devolver de novo um dinheiro já devolvido, com o
       -- id que está no primeiro e-mail de confirmação. Achado da revisão de
       -- segurança deste bloco.
       AND a.status <> 'rescheduled'
  `;
  const linha = linhas[0];
  if (!linha) {
    throw new SinalError('agendamento_nao_encontrado', 'Agendamento não encontrado.');
  }
  return montar(linha);
}

function montar(linha: LinhaDoSinal): SinalDoAgendamento {
  const base = {
    appointmentId: linha.id,
    exigidoCents: linha.deposit_required_cents,
    pagoCents: linha.deposit_paid_cents,
    motivo: linha.deposit_reason,
  };

  const encerrado =
    linha.status === 'cancelled_customer' ||
    linha.status === 'cancelled_business' ||
    linha.status === 'no_show';
  if (linha.deposit_paid_cents <= 0 || !encerrado) {
    return { ...base, reembolso: null, porqueDoReembolso: null };
  }

  const quem =
    linha.status === 'no_show'
      ? ('falta' as const)
      : linha.status === 'cancelled_business'
        ? ('casa' as const)
        : ('cliente' as const);

  // Antecedência desconhecida entra como nula e devolve — o carimbo só falta em
  // agendamento anterior à migração 0039, e reter dinheiro por um registro que a
  // casa não fez é cobrar pelo próprio buraco.
  const horas = linha.cancelled_at
    ? (linha.service_starts_at.getTime() - linha.cancelled_at.getTime()) / MS_POR_HORA
    : null;

  const decisao = decidirReembolso({
    politica: { ...POLITICA_SEM_SINAL, horasParaReembolso: linha.deposit_refund_hours },
    quem,
    horasDeAntecedencia: horas,
  });
  return { ...base, reembolso: decisao.desfecho, porqueDoReembolso: decisao.porque };
}

export interface RegistroDeSinal {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly valorCents: number;
  readonly staffId: string;
  readonly staffName: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * Registra que o sinal chegou.
 *
 * O valor é conferido contra o exigido em vez de aceito como veio. Quem digita
 * é quem confere o comprovante, e um campo livre aqui deixaria "recebi R$ 2" de
 * um sinal de R$ 20 passar como quitação — a diferença sumiria, porque não há
 * segunda pessoa olhando um Pix que entrou no celular da recepção.
 */
export async function registrarSinalRecebido(
  entrada: RegistroDeSinal,
): Promise<SinalDoAgendamento> {
  return withTenant(entrada.tenantId, async (tx) => {
    const atual = await carregar(tx, entrada.appointmentId);

    if (atual.exigidoCents <= 0) {
      throw new SinalError(
        'sem_sinal_exigido',
        'Este agendamento não exige sinal. Não há o que registrar.',
      );
    }
    if (atual.pagoCents > 0) {
      throw new SinalError('sinal_ja_registrado', 'O sinal deste agendamento já foi registrado.');
    }
    if (entrada.valorCents !== atual.exigidoCents) {
      throw new SinalError(
        'valor_diferente_do_exigido',
        'O valor recebido precisa ser igual ao sinal exigido.',
      );
    }

    const afetadas = await tx.$executeRaw`
      UPDATE appointments
         SET deposit_paid_cents = ${entrada.valorCents}, updated_at = now()
       WHERE id = ${entrada.appointmentId}::uuid
         AND deposit_paid_cents = 0
         AND deposit_required_cents = ${entrada.valorCents}
    `;
    if (afetadas === 0) {
      // Outra sessão registrou entre a leitura e a escrita. Devolver o estado é
      // mais certo que erro: a operação que a pessoa queria aconteceu.
      return carregar(tx, entrada.appointmentId);
    }

    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'deposit.received',
      entity: 'appointment',
      entityId: entrada.appointmentId,
      before: { pagoCents: 0 },
      after: { pagoCents: entrada.valorCents },
      ...(entrada.ip ? { ip: entrada.ip } : {}),
      ...(entrada.userAgent ? { userAgent: entrada.userAgent } : {}),
    });

    return carregar(tx, entrada.appointmentId);
  });
}

/**
 * Devolve o sinal.
 *
 * Zera `deposit_paid_cents` porque a barbearia deixou de ter o dinheiro — e
 * não zera `deposit_required_cents`, que é o registro de que o sinal foi
 * exigido um dia. Apagar os dois faria a devolução parecer que nunca houve
 * sinal, e a trilha é o que conta a história.
 *
 * A decisão de **se** devolve é do domínio (`decidirReembolso`) e aparece na
 * tela; a de **quando** é de quem opera, porque o Pix de volta sai da mão de
 * alguém. Forçar a política aqui recusaria a devolução de cortesia que a
 * barbearia decide fazer — e ela é a resposta certa para metade das reclamações
 * de balcão.
 */
export async function devolverSinal(entrada: RegistroDeSinal): Promise<SinalDoAgendamento> {
  return withTenant(entrada.tenantId, async (tx) => {
    const atual = await carregar(tx, entrada.appointmentId);
    if (atual.pagoCents <= 0) {
      throw new SinalError(
        'sinal_nao_registrado',
        'Não há sinal registrado neste agendamento para devolver.',
      );
    }

    const afetadas = await tx.$executeRaw`
      UPDATE appointments
         SET deposit_paid_cents = 0, updated_at = now()
       WHERE id = ${entrada.appointmentId}::uuid
         AND deposit_paid_cents > 0
    `;
    if (afetadas === 0) return carregar(tx, entrada.appointmentId);

    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'deposit.refunded',
      entity: 'appointment',
      entityId: entrada.appointmentId,
      before: { pagoCents: atual.pagoCents },
      after: { pagoCents: 0 },
      ...(entrada.ip ? { ip: entrada.ip } : {}),
      ...(entrada.userAgent ? { userAgent: entrada.userAgent } : {}),
    });

    return carregar(tx, entrada.appointmentId);
  });
}

/** O sinal de um agendamento, para a tela. */
export async function sinalDoAgendamento(
  tenantId: string,
  appointmentId: string,
): Promise<SinalDoAgendamento> {
  return withTenant(tenantId, (tx) => carregar(tx, appointmentId));
}
