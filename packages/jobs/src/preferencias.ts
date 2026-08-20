import { withTenant, type TransactionClient } from '@barbearia/db';
import type { TipoDeNotificacao } from '@barbearia/core';
import { enfileirar } from './fila.js';

/**
 * O que a barbearia escolheu avisar, e o que de fato saiu.
 *
 * As colunas nasceram na migração 0020 com padrão razoável. Isto é o que impede
 * que elas fiquem sendo "campo que o motor aceita e ninguém preenche": sem tela,
 * mudar o prazo de retorno exigiria SQL, e desligar o lembrete de 2h seria
 * impossível para quem o acha intrusivo.
 */

export interface PreferenciasDeAviso {
  readonly confirmacao: boolean;
  readonly lembrete24h: boolean;
  readonly lembrete2h: boolean;
  readonly retorno: boolean;
  readonly diasParaRetorno: number;
}

export interface EnvioRegistrado {
  readonly id: string;
  readonly tipo: TipoDeNotificacao;
  readonly enviadoEm: string;
  readonly status: 'sent' | 'failed' | 'skipped';
  readonly motivo: string | null;
  readonly telefone: string | null;
  readonly quem: string | null;
}

export async function lerPreferenciasDeAviso(
  tenantId: string,
  locationId: string,
): Promise<PreferenciasDeAviso | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        notify_confirmation: boolean;
        notify_reminder_24h: boolean;
        notify_reminder_2h: boolean;
        notify_comeback: boolean;
        comeback_after_days: number;
      }[]
    >`
      SELECT notify_confirmation, notify_reminder_24h, notify_reminder_2h,
             notify_comeback, comeback_after_days
        FROM locations WHERE id = ${locationId}::uuid
    `;
    const unidade = linhas[0];
    if (!unidade) return null;

    return {
      confirmacao: unidade.notify_confirmation,
      lembrete24h: unidade.notify_reminder_24h,
      lembrete2h: unidade.notify_reminder_2h,
      retorno: unidade.notify_comeback,
      diasParaRetorno: unidade.comeback_after_days,
    };
  });
}

export async function salvarPreferenciasDeAviso(
  tenantId: string,
  locationId: string,
  input: PreferenciasDeAviso,
  agora: Date = new Date(),
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET
        notify_confirmation = ${input.confirmacao},
        notify_reminder_24h = ${input.lembrete24h},
        notify_reminder_2h = ${input.lembrete2h},
        notify_comeback = ${input.retorno},
        comeback_after_days = ${input.diasParaRetorno},
        updated_at = now()
      WHERE id = ${locationId}::uuid
    `;

    // Ligar a mensagem de retorno é o que **cria** a varredura. Sem isto o
    // handler existiria sem nada que o chamasse — e não há alternativa de
    // plataforma: `locations` tem RLS, então nenhum processo sem tenant no
    // contexto consegue descobrir quem quer a varredura.
    if (input.retorno) await agendarVarreduraDeRetorno(tx, { tenantId, quando: agora });
  });
}

/**
 * Programa a próxima varredura de retorno desta barbearia.
 *
 * A cadeia se mantém sozinha: o handler chama isto de novo ao terminar. Ela
 * começa quando a barbearia liga a mensagem e para quando desliga — a checagem
 * de `notify_comeback` aqui é o que a interrompe, sem precisar apagar tarefa.
 *
 * A chave inclui tenant **e** dia: o índice único de `jobs` é global, então
 * `retorno:2026-08-09` sozinho deixaria uma barbearia bloquear a varredura de
 * todas as outras naquele dia.
 */
export async function agendarVarreduraDeRetorno(
  tx: TransactionClient,
  params: { readonly tenantId: string; readonly quando: Date },
): Promise<boolean> {
  const querem = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM locations WHERE notify_comeback
  `;
  if (Number(querem[0]?.n ?? 0) === 0) return false;

  const dia = params.quando.toISOString().slice(0, 10);
  await enfileirar(tx, {
    kind: 'notificacao.retorno',
    rodarApos: params.quando,
    idempotencyKey: `retorno:${params.tenantId}:${dia}`,
  });
  return true;
}

/**
 * O histórico de envio, mais recente primeiro.
 *
 * Mostra também o que **não** saiu, com o motivo. "O cliente foi avisado?" é
 * pergunta de discussão sobre falta, e "não, porque não tinha telefone" é uma
 * resposta — "nada aqui" não é.
 */
export async function listarEnvios(
  tenantId: string,
  opcoes: { readonly limite?: number } = {},
): Promise<readonly EnvioRegistrado[]> {
  const limite = Math.min(Math.max(1, opcoes.limite ?? 50), 200);

  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        kind: TipoDeNotificacao;
        sent_at: Date;
        status: 'sent' | 'failed' | 'skipped';
        reason: string | null;
        phone_masked: string | null;
        quem: string | null;
      }[]
    >`
      SELECT n.id, n.kind, n.sent_at, n.status, n.reason, n.phone_masked,
             COALESCE(c.name, s.name) AS quem
        FROM notifications n
        LEFT JOIN customers c ON c.id = n.customer_id
        LEFT JOIN staff_users s ON s.id = n.staff_user_id
       ORDER BY n.sent_at DESC, n.id DESC
       LIMIT ${limite}
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      tipo: linha.kind,
      enviadoEm: linha.sent_at.toISOString(),
      status: linha.status,
      motivo: linha.reason,
      telefone: linha.phone_masked,
      quem: linha.quem,
    }));
  });
}
