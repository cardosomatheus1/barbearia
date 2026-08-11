import { describe, expect, it } from 'vitest';
import {
  ESTADOS_DO_PACOTE,
  ROTULO_DO_PACOTE,
  diferidoDoPacote,
  estadoDoPacote,
  fraseDoPacote,
  pacoteCobre,
  proximoAConsumir,
  reembolsoProporcional,
  restamNoPacote,
  restoDaPrimeiraUnidade,
  valorDaUnidade,
  vencimentoDoPacote,
  type PacoteDoCliente,
} from './pacote.js';

const AGORA = new Date('2026-11-01T12:00:00Z');
const CORTE = 'servico-corte';

let contador = 0;
const pacote = (extra: Partial<PacoteDoCliente> = {}): PacoteDoCliente => {
  contador += 1;
  return {
    id: `p${contador}`,
    serviceId: CORTE,
    total: 5,
    usados: 0,
    venceEm: null,
    valorDaUnidadeCents: 5000,
    compradoEm: new Date(AGORA.getTime() - 30 * 86_400_000),
    transferivel: false,
    reembolsadoEm: null,
    ...extra,
  };
};

describe('o estado do pacote é calculado, não guardado', () => {
  it('nasce ativo', () => {
    expect(estadoDoPacote(pacote(), AGORA)).toBe('ativo');
  });

  it('vira esgotado quando o último é usado', () => {
    expect(estadoDoPacote(pacote({ usados: 5 }), AGORA)).toBe('esgotado');
  });

  it('vence pelo relógio, sem esperar varredura', () => {
    /**
     * Uma coluna com este valor estaria errada todo dia entre a meia-noite e a
     * varredura passar — e a recepção tentaria usar o pacote justamente aí.
     */
    const ontem = new Date(AGORA.getTime() - 86_400_000);
    expect(estadoDoPacote(pacote({ venceEm: ontem }), AGORA)).toBe('vencido');
  });

  it('reembolsado vence os outros dois', () => {
    // Um pacote devolvido e esgotado é devolvido: o dinheiro voltou.
    const devolvido = pacote({ usados: 5, reembolsadoEm: AGORA });
    expect(estadoDoPacote(devolvido, AGORA)).toBe('reembolsado');
  });

  it('todo estado tem rótulo', () => {
    for (const estado of ESTADOS_DO_PACOTE) expect(ROTULO_DO_PACOTE[estado]).toBeTruthy();
  });
});

describe('o que o pacote cobre', () => {
  it('só o serviço que ele comprou', () => {
    expect(pacoteCobre(pacote(), 'servico-barba', AGORA)).toBe(false);
    expect(pacoteCobre(pacote(), CORTE, AGORA)).toBe(true);
  });

  it('pacote vencido com saldo não cobre nada', () => {
    // É o caso que mais aparece no balcão, e o que a recepção tenta usar.
    const vencido = pacote({ venceEm: new Date(AGORA.getTime() - 1000), usados: 2 });
    expect(restamNoPacote(vencido)).toBe(3);
    expect(pacoteCobre(vencido, CORTE, AGORA)).toBe(false);
  });

  it('pacote esgotado não cobre', () => {
    expect(pacoteCobre(pacote({ usados: 5 }), CORTE, AGORA)).toBe(false);
  });
});

describe('qual pacote usar primeiro', () => {
  it('o que vence antes', () => {
    /**
     * Mesma ordem do saldo de fidelidade e de qualquer estoque perecível:
     * consumir o de prazo maior deixaria vencer saldo que o cliente podia ter
     * usado — e ele veria o número cair duas vezes pelo mesmo corte.
     */
    const longe = pacote({ venceEm: new Date('2027-06-01T00:00:00Z') });
    const perto = pacote({ venceEm: new Date('2026-12-01T00:00:00Z') });
    expect(proximoAConsumir([longe, perto], CORTE, AGORA)?.id).toBe(perto.id);
  });

  it('com prazo vence quem não tem prazo', () => {
    const semPrazo = pacote({ venceEm: null });
    const comPrazo = pacote({ venceEm: new Date('2027-06-01T00:00:00Z') });
    expect(proximoAConsumir([semPrazo, comPrazo], CORTE, AGORA)?.id).toBe(comPrazo.id);
  });

  it('entre dois sem prazo, o mais antigo', () => {
    const novo = pacote({ compradoEm: new Date(AGORA.getTime() - 86_400_000) });
    const antigo = pacote({ compradoEm: new Date(AGORA.getTime() - 300 * 86_400_000) });
    expect(proximoAConsumir([novo, antigo], CORTE, AGORA)?.id).toBe(antigo.id);
  });

  it('sem pacote que sirva, devolve nulo — e não é erro', () => {
    expect(proximoAConsumir([pacote({ usados: 5 })], CORTE, AGORA)).toBeNull();
    expect(proximoAConsumir([], CORTE, AGORA)).toBeNull();
  });
});

describe('o valor da unidade', () => {
  it('cinco cortes por R$ 250 valem R$ 50 cada', () => {
    expect(valorDaUnidade(25_000, 5)).toBe(5000);
    expect(restoDaPrimeiraUnidade(25_000, 5)).toBe(0);
  });

  it('o centavo que não divide fica com a primeira unidade', () => {
    /**
     * 5001 dividido por 5 dá 1000,2. Somar 1000 cinco vezes perde um centavo, e
     * um centavo por pacote é o erro que só aparece na conciliação de um ano.
     * A primeira unidade recebe o resto porque é a mais provável de ser usada —
     * assim a receita reconhecida nunca passa da diferida.
     */
    expect(valorDaUnidade(5001, 5)).toBe(1000);
    expect(restoDaPrimeiraUnidade(5001, 5)).toBe(1);
    expect(valorDaUnidade(5001, 5) * 5 + restoDaPrimeiraUnidade(5001, 5)).toBe(5001);
  });

  it('quantidade zero não divide por zero', () => {
    expect(valorDaUnidade(25_000, 0)).toBe(0);
  });
});

describe('a receita diferida', () => {
  it('é o que ainda não foi entregue', () => {
    // O passivo: dinheiro recebido por serviço que a barbearia ainda deve.
    expect(diferidoDoPacote(pacote({ usados: 2 }), AGORA)).toBe(15_000);
  });

  it('some quando o pacote vence', () => {
    /**
     * E some porque **virou receita**: a obrigação acabou sem a barbearia
     * precisar entregar nada. Mantê-la diferida para sempre encheria o balanço
     * de um passivo que nunca sai.
     */
    const vencido = pacote({ usados: 2, venceEm: new Date(AGORA.getTime() - 1000) });
    expect(diferidoDoPacote(vencido, AGORA)).toBe(0);
  });

  it('pacote esgotado não tem nada diferido', () => {
    expect(diferidoDoPacote(pacote({ usados: 5 }), AGORA)).toBe(0);
  });
});

describe('o reembolso é proporcional', () => {
  it('devolve só o que não foi usado', () => {
    // Devolver o preço cheio pagaria de volta cortes já entregues; devolver
    // nada transformaria a compra antecipada em armadilha.
    expect(reembolsoProporcional(pacote({ usados: 3 }), AGORA)).toEqual({ valorCents: 10_000 });
  });

  it('pacote esgotado não devolve nada', () => {
    expect(reembolsoProporcional(pacote({ usados: 5 }), AGORA)).toMatchObject({
      recusa: 'nada_a_devolver',
    });
  });

  it('pacote vencido não devolve — a validade é a regra que o cliente aceitou', () => {
    const vencido = pacote({ usados: 1, venceEm: new Date(AGORA.getTime() - 1000) });
    expect(reembolsoProporcional(vencido, AGORA)).toMatchObject({ recusa: 'nada_a_devolver' });
  });

  it('não devolve duas vezes', () => {
    expect(
      reembolsoProporcional(pacote({ usados: 1, reembolsadoEm: AGORA }), AGORA),
    ).toMatchObject({ recusa: 'ja_reembolsado' });
  });
});

describe('a frase que a tela mostra', () => {
  it('segue o formato da SPEC', () => {
    expect(fraseDoPacote(pacote({ usados: 3 }), AGORA)).toBe('3 de 5 usados — 2 restantes.');
  });

  it('avisa quando resta um — que é o que a SPEC pede', () => {
    // No lugar em que a recepção olha, não numa mensagem três dias depois.
    expect(fraseDoPacote(pacote({ usados: 4 }), AGORA)).toContain('É o último');
  });

  it('o vencido diz quantos ficaram sem usar', () => {
    const vencido = pacote({ usados: 2, venceEm: new Date(AGORA.getTime() - 1000) });
    expect(fraseDoPacote(vencido, AGORA)).toBe('Venceu com 3 sem usar.');
  });
});

describe('a validade', () => {
  it('conta a partir da compra', () => {
    expect(vencimentoDoPacote(180, AGORA)?.toISOString()).toBe('2027-04-30T12:00:00.000Z');
  });

  it('sem validade é uma escolha, e devolve nulo', () => {
    expect(vencimentoDoPacote(null, AGORA)).toBeNull();
  });
});
