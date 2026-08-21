import { describe, expect, it } from 'vitest';

import {
  assinaturaDaPlataformaEmDia,
  ESTADOS_DA_ASSINATURA_DA_PLATAFORMA,
  ROTULO_DO_ESTADO_DA_ASSINATURA_DA_PLATAFORMA,
} from './assinatura-da-plataforma.js';
import { ESTADOS_DA_ASSINATURA } from './assinatura.js';

describe('o estado da assinatura da plataforma', () => {
  it('todo estado tem rótulo', () => {
    // `Record` total sobre a união: o estado novo faz o compilador cobrar a
    // frase, em vez de a tela mostrar o valor cru do banco.
    for (const estado of ESTADOS_DA_ASSINATURA_DA_PLATAFORMA) {
      expect(ROTULO_DO_ESTADO_DA_ASSINATURA_DA_PLATAFORMA[estado], estado).toBeTruthy();
    }
  });

  it('não colide com o estado da assinatura do clube', () => {
    /**
     * Os dois se chamavam `EstadoDaAssinatura` e são fatos diferentes: este é o
     * que a barbearia paga à plataforma, o outro é o que o cliente paga à
     * barbearia. É a mesma distinção que separa `subscriptions` de
     * `club_subscriptions` no schema, e sem o sufixo o barril de `core`
     * exportaria dois nomes iguais — a armadilha de `PESO_DO_ATRASO`.
     */
    const daPlataforma = new Set<string>(ESTADOS_DA_ASSINATURA_DA_PLATAFORMA);
    const doClube = new Set<string>(ESTADOS_DA_ASSINATURA);
    expect([...daPlataforma].filter((e) => doClube.has(e))).toEqual([]);
  });

  it('teste conta como em dia: o benefício está entregue', () => {
    expect(assinaturaDaPlataformaEmDia('trialing')).toBe(true);
    expect(assinaturaDaPlataformaEmDia('active')).toBe(true);
    // Inadimplente continua usando o plano (SPEC §4.6) e mesmo assim não está
    // em dia: a contagem da tela é sobre quem pagou, não sobre quem opera.
    expect(assinaturaDaPlataformaEmDia('past_due')).toBe(false);
    expect(assinaturaDaPlataformaEmDia('canceled')).toBe(false);
  });
});
