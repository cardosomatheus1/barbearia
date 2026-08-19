import { describe, expect, it } from 'vitest';
import { contencaoDeHorario } from './booking.js';

/**
 * Os códigos que significam "duas pessoas no mesmo horário" (bloco 105).
 *
 * ## Por que este teste é unitário, e a corrida não substitui
 *
 * `booking.integration.test.ts` dispara seis reservas simultâneas e prova a
 * propriedade que importa — nenhuma recusa escapa crua. O que ele **não** pode
 * prometer é *qual* SQLSTATE cada uma recebeu: isso depende do entrelaçamento,
 * e um teste de corrida que dependesse disso não seria teste
 * (*"ou é determinístico, ou não é teste"*).
 *
 * Aqui a pergunta é outra e tem resposta fixa: dado o erro, a função o
 * reconhece? Os três positivos são os desfechos de disputa pela constraint de
 * exclusão; os negativos existem para que a função não vire um `catch (_)`
 * disfarçado — chave estrangeira violada e coluna inexistente são defeito
 * nosso, e virar "este horário já não está disponível" esconderia o defeito
 * atrás de uma frase plausível no balcão.
 */

/** O formato em que o Prisma entrega o SQLSTATE de uma consulta crua. */
const comoOPrismaEntrega = (sqlstate: string): Error =>
  Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: sqlstate } });

describe('o que conta como disputa pelo mesmo horário', () => {
  it.each([
    ['23P01', 'violação da constraint de exclusão'],
    ['40P01', 'deadlock entre duas inserções no mesmo índice GiST'],
    ['40001', 'falha de serialização'],
  ])('%s (%s) é contenção', (sqlstate) => {
    expect(contencaoDeHorario(comoOPrismaEntrega(sqlstate))).toBe(true);
  });

  it.each([
    ['23503', 'chave estrangeira'],
    ['23505', 'unicidade — é idempotência, e tem tratamento próprio'],
    ['42703', 'coluna inexistente'],
    ['42883', 'função inexistente'],
  ])('%s (%s) não é contenção', (sqlstate) => {
    expect(contencaoDeHorario(comoOPrismaEntrega(sqlstate))).toBe(false);
  });

  it('erro sem SQLSTATE nenhum não é contenção', () => {
    expect(contencaoDeHorario(new Error('conexão caiu'))).toBe(false);
    expect(contencaoDeHorario(null)).toBe(false);
    expect(contencaoDeHorario(undefined)).toBe(false);
  });
});
