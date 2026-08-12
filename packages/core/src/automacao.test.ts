import { describe, expect, it } from 'vitest';
import {
  EXPLICACAO_DA_FALHA,
  EXPLICACAO_DE_NAO_DISPARAR,
  GATILHOS,
  JANELA_MAXIMA_DIAS,
  LIMIAR_DO_GATILHO,
  OBJETIVOS,
  ROTULO_DO_GATILHO,
  ROTULO_DO_OBJETIVO,
  chaveDoFato,
  decidirDisparo,
  gatilhoPedeLimiar,
  objetivoAlcancado,
  validarAutomacao,
} from './automacao.js';
import { TETO_PROMOCIONAL_MES } from './notificacao.js';

/**
 * O motor de automação (bloco 56, SPEC §4.11).
 *
 * O que estes testes prendem são as quatro proteções que a SPEC lista e a
 * atribuição, que é o que separa "mandamos duzentas mensagens" de "isto
 * funciona".
 */

const BASE = {
  ativa: true,
  tipo: 'retorno' as const,
  jaDisparouPorEsteFato: false,
  jaRecebeuHoje: false,
  temTelefone: true,
  aceitaPromocional: true,
  promocionaisNoMes: 0,
  atrasoMinutos: 0,
  timeZone: 'America/Bahia',
};
// 14h em Salvador: dentro da janela.
const TARDE = new Date('2026-11-25T17:00:00Z');

describe('o vocabulário', () => {
  it('todo gatilho tem rótulo e diz se pede número', () => {
    for (const gatilho of GATILHOS) {
      expect(ROTULO_DO_GATILHO[gatilho]).toBeTruthy();
      expect(LIMIAR_DO_GATILHO[gatilho]).not.toBeUndefined();
    }
  });

  it('todo objetivo tem rótulo', () => {
    for (const objetivo of OBJETIVOS) expect(ROTULO_DO_OBJETIVO[objetivo]).toBeTruthy();
  });

  it('todo motivo de não disparar tem explicação para a tela', () => {
    for (const motivo of [
      'automacao_desligada',
      'ja_disparou_por_este_fato',
      'ja_recebeu_hoje',
      'sem_telefone',
      'optou_por_nao_receber',
      'teto_do_mes',
    ] as const) {
      expect(EXPLICACAO_DE_NAO_DISPARAR[motivo]).toBeTruthy();
    }
  });
});

describe('a automação é montável?', () => {
  const valida = {
    nome: 'Volta, Carlos',
    gatilho: 'sem_retorno' as const,
    limiar: 30,
    atrasoMinutos: 0,
    janelaDias: 7,
  };

  it('a completa passa', () => {
    expect(validarAutomacao(valida)).toBeNull();
  });

  it('gatilho que pede número sem número é recusado', () => {
    /**
     * `sem_retorno` sem número não é automação incompleta: é uma que dispara
     * para a base inteira no primeiro dia. Ela passaria pela borda, pelo banco,
     * e só apareceria na conta da Meta.
     */
    expect(validarAutomacao({ ...valida, limiar: null })).toBe('limiar_obrigatorio');
    expect(validarAutomacao({ ...valida, limiar: 0 })).toBe('limiar_invalido');
  });

  it('gatilho que não pede número passa sem ele', () => {
    expect(
      validarAutomacao({ ...valida, gatilho: 'primeiro_atendimento', limiar: null }),
    ).toBeNull();
    expect(gatilhoPedeLimiar('primeiro_atendimento')).toBe(false);
    expect(gatilhoPedeLimiar('sem_retorno')).toBe(true);
  });

  it('a janela do objetivo tem as duas pontas', () => {
    // Zero faria o objetivo nunca ser alcançável — a automação nasceria morta
    // com cara de ligada. Dois anos daria crédito por um corte que a pessoa
    // faria de qualquer jeito.
    expect(validarAutomacao({ ...valida, janelaDias: 0 })).toBe('janela_invalida');
    expect(validarAutomacao({ ...valida, janelaDias: JANELA_MAXIMA_DIAS })).toBeNull();
    expect(validarAutomacao({ ...valida, janelaDias: JANELA_MAXIMA_DIAS + 1 })).toBe(
      'janela_invalida',
    );
  });

  it('sem nome não passa, e a falha tem texto', () => {
    expect(validarAutomacao({ ...valida, nome: '  ' })).toBe('nome_obrigatorio');
    expect(EXPLICACAO_DA_FALHA['nome_obrigatorio']).toBeTruthy();
  });
});

describe('as quatro proteções da SPEC', () => {
  it('a automação desligada não dispara', () => {
    expect(decidirDisparo({ ...BASE, ativa: false, fatoEm: TARDE, agora: TARDE })).toMatchObject({
      disparar: false,
      motivo: 'automacao_desligada',
    });
  });

  it('o mesmo fato não dispara duas vezes', () => {
    // A varredura roda de hora em hora. Sem isto, "sumiu há 30 dias" mandaria
    // uma mensagem por hora enquanto a pessoa continuasse sumida.
    expect(
      decidirDisparo({ ...BASE, jaDisparouPorEsteFato: true, fatoEm: TARDE, agora: TARDE }),
    ).toMatchObject({ disparar: false, motivo: 'ja_disparou_por_este_fato' });
  });

  it('quem já recebeu hoje não recebe de novo', () => {
    /**
     * A regra é por **cliente e dia**, não por automação: cinco automações
     * razoáveis mandariam cinco mensagens na terça, cada uma correta sozinha, e
     * o conjunto sendo spam.
     */
    expect(
      decidirDisparo({ ...BASE, jaRecebeuHoje: true, fatoEm: TARDE, agora: TARDE }),
    ).toMatchObject({ disparar: false, motivo: 'ja_recebeu_hoje' });
  });

  it('promocional respeita o opt-out e o teto do mês', () => {
    expect(
      decidirDisparo({ ...BASE, aceitaPromocional: false, fatoEm: TARDE, agora: TARDE }),
    ).toMatchObject({ disparar: false, motivo: 'optou_por_nao_receber' });
    expect(
      decidirDisparo({
        ...BASE,
        promocionaisNoMes: TETO_PROMOCIONAL_MES,
        fatoEm: TARDE,
        agora: TARDE,
      }),
    ).toMatchObject({ disparar: false, motivo: 'teto_do_mes' });
  });

  it('transacional ignora opt-out e teto', () => {
    /**
     * Ninguém "opta por não receber" a confirmação do próprio agendamento. A
     * separação é do bloco 20 e este arquivo a **chama** em vez de reescrever —
     * dois tetos no mesmo produto discordariam no primeiro ajuste.
     */
    const decisao = decidirDisparo({
      ...BASE,
      tipo: 'confirmacao',
      aceitaPromocional: false,
      promocionaisNoMes: 99,
      fatoEm: TARDE,
      agora: TARDE,
    });
    expect(decisao.disparar).toBe(true);
  });

  it('sem telefone não há para onde mandar', () => {
    expect(
      decidirDisparo({ ...BASE, temTelefone: false, fatoEm: TARDE, agora: TARDE }),
    ).toMatchObject({ disparar: false, motivo: 'sem_telefone' });
  });
});

describe('o atraso e a janela de silêncio', () => {
  it('o atraso conta do fato, não da varredura', () => {
    /**
     * A varredura roda de hora em hora e pode achar um fato de trinta minutos
     * atrás. Contar de agora empurraria a mensagem de "duas horas depois do
     * corte" para duas horas depois da varredura — e o texto prometeria uma
     * coisa que já não é verdade.
     */
    const fato = new Date('2026-11-25T17:00:00Z');
    const agora = new Date('2026-11-25T17:30:00Z');
    const decisao = decidirDisparo({ ...BASE, atrasoMinutos: 120, fatoEm: fato, agora });
    expect(decisao.quando?.toISOString()).toBe('2026-11-25T19:00:00.000Z');
  });

  it('atraso já vencido sai agora, não no passado', () => {
    const fato = new Date('2026-11-25T12:00:00Z');
    const agora = new Date('2026-11-25T17:00:00Z');
    const decisao = decidirDisparo({ ...BASE, atrasoMinutos: 60, fatoEm: fato, agora });
    expect(decisao.quando?.toISOString()).toBe(agora.toISOString());
  });

  it('nada sai entre 21h e 8h da unidade', () => {
    // 22h47 em Salvador. O que chega é uma mensagem da barbearia no celular de
    // quem foi dormir, pelo mesmo número que manda o lembrete.
    const noite = new Date('2026-11-26T01:47:00Z');
    const decisao = decidirDisparo({ ...BASE, fatoEm: noite, agora: noite });
    expect(decisao.quando?.toISOString()).toBe('2026-11-26T11:00:00.000Z');
  });

  it('o fuso é o da unidade, não o do processo', () => {
    const instante = new Date('2026-11-26T00:30:00Z');
    // 21h30 na Bahia: empurra. 18h30 no Acre: sai agora.
    expect(
      decidirDisparo({ ...BASE, fatoEm: instante, agora: instante }).quando?.toISOString(),
    ).toBe('2026-11-26T11:00:00.000Z');
    expect(
      decidirDisparo({
        ...BASE,
        timeZone: 'America/Rio_Branco',
        fatoEm: instante,
        agora: instante,
      }).quando?.toISOString(),
    ).toBe(instante.toISOString());
  });
});

describe('a chave do fato', () => {
  it('aniversário é por ano, porque ele volta', () => {
    /**
     * A forma da chave **é** a regra: com chave de id, a pessoa receberia
     * parabéns uma vez na vida; com chave de data, todo ano — que é o certo.
     */
    expect(chaveDoFato({ gatilho: 'aniversario', referencia: 'x', ano: 2026 })).toBe(
      'aniversario:2026',
    );
    expect(chaveDoFato({ gatilho: 'aniversario', referencia: 'x', ano: 2027 })).not.toBe(
      chaveDoFato({ gatilho: 'aniversario', referencia: 'x', ano: 2026 }),
    );
  });

  it('os outros são pelo id do que aconteceu', () => {
    expect(chaveDoFato({ gatilho: 'servico_realizado', referencia: 'comanda-1', ano: 2026 })).toBe(
      'servico_realizado:comanda-1',
    );
  });

  it('gatilhos diferentes sobre o mesmo id não colidem', () => {
    const a = chaveDoFato({ gatilho: 'servico_realizado', referencia: 'x', ano: 2026 });
    const b = chaveDoFato({ gatilho: 'produto_comprado', referencia: 'x', ano: 2026 });
    expect(a).not.toBe(b);
  });
});

describe('a atribuição do objetivo', () => {
  const enviada = new Date('2026-11-25T12:00:00Z');

  it('o fato dentro da janela conta', () => {
    expect(
      objetivoAlcancado({
        enviadaEm: enviada,
        fatoEm: new Date('2026-11-28T12:00:00Z'),
        janelaDias: 7,
      }),
    ).toBe(true);
  });

  it('o fato anterior à mensagem não conta', () => {
    // Um agendamento feito antes da mensagem seria creditado a ela.
    expect(
      objetivoAlcancado({
        enviadaEm: enviada,
        fatoEm: new Date('2026-11-24T12:00:00Z'),
        janelaDias: 7,
      }),
    ).toBe(false);
  });

  it('o fato depois da janela não conta', () => {
    // Dois meses depois a pessoa marcaria de qualquer jeito. Atribuição frouxa
    // é pior que nenhuma, porque tem número.
    expect(
      objetivoAlcancado({
        enviadaEm: enviada,
        fatoEm: new Date('2026-12-25T12:00:00Z'),
        janelaDias: 7,
      }),
    ).toBe(false);
  });

  it('a borda exata da janela conta', () => {
    expect(
      objetivoAlcancado({
        enviadaEm: enviada,
        fatoEm: new Date('2026-12-02T12:00:00Z'),
        janelaDias: 7,
      }),
    ).toBe(true);
  });
});
