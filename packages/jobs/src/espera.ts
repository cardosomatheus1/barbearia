import { foraDoSilencio } from '@barbearia/core';
import type { TransactionClient } from '@barbearia/db';
import { enfileirar } from './fila.js';

/**
 * O agendamento do aviso de vaga (bloco 39, SPEC §2.9).
 *
 * ## Por que a oferta não sai na mesma transação do cancelamento
 *
 * Oferecer manda mensagem, e mandar mensagem é rede. Fazer isso dentro da
 * transação que desmarca o horário significaria segurar a transação enquanto se
 * espera o WhatsApp — e um provedor lento travaria a tela da recepção, que é a
 * operação mais frequente do balcão.
 *
 * O que entra na transação é a **tarefa**, como todo trabalho fora de
 * requisição neste produto. Se o cancelamento volta atrás, a oferta não
 * acontece.
 *
 * ## Por que a janela de silêncio empurra a tarefa, e não a mensagem
 *
 * A vaga que abre às 22h só é oferecida às 8h. Segurar o horário desde as 22h
 * seria pior: dez horas de exclusividade para alguém que está dormindo, com o
 * horário fora da grade e ninguém podendo marcá-lo.
 *
 * O preço está escrito: uma vaga que abre às 22h para amanhã às 9h chega com
 * uma hora de antecedência. Ainda é melhor que não chegar — e acordar o cliente
 * para oferecer um horário é o jeito mais rápido de ele sair da lista.
 */

export const TAREFA_DE_OFERTA = 'espera.oferecer';
export const TAREFA_DE_VENCIMENTO = 'espera.vencer';

/**
 * Enfileira a oferta de uma vaga que acabou de abrir.
 *
 * A chave de idempotência é a **vaga**, não o cancelamento: dois cancelamentos
 * no mesmo horário — o cliente desmarca e a recepção desmarca de novo — não
 * podem produzir duas ofertas para a mesma coisa.
 */
export async function agendarOfertaDaVaga(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly professionalId: string;
    readonly inicio: Date;
    readonly fim: Date;
    readonly timezone: string;
    readonly agora: Date;
  },
): Promise<void> {
  await enfileirar(tx, {
    kind: TAREFA_DE_OFERTA,
    payload: {
      locationId: params.locationId,
      professionalId: params.professionalId,
      inicio: params.inicio.toISOString(),
      fim: params.fim.toISOString(),
    },
    rodarApos: foraDoSilencio(params.agora, params.timezone),
    idempotencyKey: `oferta:${params.professionalId}:${params.inicio.toISOString()}`,
    // Duas tentativas. Oferecer uma vaga é útil por minutos: insistir cinco
    // vezes com espera crescente entregaria o convite depois de o horário já
    // ter passado.
    maxAttempts: 2,
  });
}

/**
 * Enfileira a passagem ao próximo, para quando a janela exclusiva vencer.
 *
 * `rodarApos` é o próprio vencimento — não antes, senão a varredura encontraria
 * a oferta ainda aberta e não faria nada, e a vaga esperaria a volta seguinte
 * do laço.
 */
export async function agendarVencimentoDaOferta(
  tx: TransactionClient,
  params: { readonly ofertaId: string; readonly venceEm: Date },
): Promise<void> {
  await enfileirar(tx, {
    kind: TAREFA_DE_VENCIMENTO,
    payload: { ofertaId: params.ofertaId },
    rodarApos: params.venceEm,
    idempotencyKey: `oferta-vence:${params.ofertaId}`,
    maxAttempts: 3,
  });
}
