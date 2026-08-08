import { describe, expect, it } from 'vitest';
import {
  ANTECEDENCIA,
  chaveDaNotificacao,
  decidirEnvioDeAgendamento,
  decidirRetorno,
  foraDoSilencio,
  naturezaDe,
  TETO_PROMOCIONAL_MES,
  TIPOS_DE_NOTIFICACAO,
} from './notificacao.js';

/**
 * O lembrete é o recurso de maior retorno do produto e o que mais rápido
 * destrói a reputação de um número de WhatsApp. As duas coisas dependem das
 * mesmas regras, e por isso cada uma tem aqui um caso que a derruba.
 */

const BAHIA = 'America/Bahia'; // UTC-3 o ano inteiro
const TOKYO = 'Asia/Tokyo'; // UTC+9, para provar que o fuso da unidade manda

/**
 * Instante a partir da hora local em Salvador — o jeito de escrever o teste.
 *
 * Via `Date.UTC`, que normaliza a virada: 22h locais são 25h UTC no mesmo dia,
 * ou seja 01h do dia seguinte. A primeira versão montava a string à mão e
 * produzia `T25:30:00Z`, que é data inválida — e `Invalid Date` fazia metade
 * dos casos de silêncio passarem pelo motivo errado.
 */
const emSalvador = (dia: string, hora: number, minuto = 0): Date => {
  const [ano = 0, mes = 0, d = 0] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, d, hora + 3, minuto));
};

describe('a natureza da mensagem', () => {
  it('confirmação e lembrete são serviço, não marketing', () => {
    // Ninguém "opta por não receber" a confirmação do próprio agendamento.
    expect(naturezaDe('confirmacao')).toBe('transacional');
    expect(naturezaDe('lembrete_24h')).toBe('transacional');
    expect(naturezaDe('lembrete_2h')).toBe('transacional');
    expect(naturezaDe('sua_vez')).toBe('transacional');
    expect(naturezaDe('senha_de_acesso')).toBe('transacional');
  });

  it('"volte sempre" é promoção', () => {
    expect(naturezaDe('retorno')).toBe('promocional');
  });

  it('todo tipo tem natureza declarada', () => {
    // Tipo novo sem natureza cairia no padrão de alguém, e o padrão errado aqui
    // ou vaza spam ou silencia lembrete.
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      expect(['transacional', 'promocional'], tipo).toContain(naturezaDe(tipo));
    }
  });
});

describe('janela de silêncio', () => {
  it('meio da tarde passa direto', () => {
    const tarde = emSalvador('2026-09-10', 15);
    expect(foraDoSilencio(tarde, BAHIA).toISOString()).toBe(tarde.toISOString());
  });

  it('de madrugada espera as oito da mesma manhã', () => {
    const madrugada = emSalvador('2026-09-10', 3);
    expect(foraDoSilencio(madrugada, BAHIA).toISOString()).toBe(
      emSalvador('2026-09-10', 8).toISOString(),
    );
  });

  it('depois das 21h espera as oito do dia seguinte', () => {
    const noite = emSalvador('2026-09-10', 22, 30);
    expect(foraDoSilencio(noite, BAHIA).toISOString()).toBe(
      emSalvador('2026-09-11', 8).toISOString(),
    );
  });

  it('21h em ponto já é silêncio; 20h59 ainda não', () => {
    // Fronteira: o intervalo é semiaberto como todos os outros do sistema.
    expect(foraDoSilencio(emSalvador('2026-09-10', 20, 59), BAHIA).toISOString()).toBe(
      emSalvador('2026-09-10', 20, 59).toISOString(),
    );
    expect(foraDoSilencio(emSalvador('2026-09-10', 21), BAHIA).toISOString()).toBe(
      emSalvador('2026-09-11', 8).toISOString(),
    );
  });

  it('8h em ponto já pode; 7h59 ainda não', () => {
    expect(foraDoSilencio(emSalvador('2026-09-10', 8), BAHIA).toISOString()).toBe(
      emSalvador('2026-09-10', 8).toISOString(),
    );
    expect(foraDoSilencio(emSalvador('2026-09-10', 7, 59), BAHIA).toISOString()).toBe(
      emSalvador('2026-09-10', 8).toISOString(),
    );
  });

  it('atravessa a virada do mês', () => {
    expect(foraDoSilencio(emSalvador('2026-09-30', 23), BAHIA).toISOString()).toBe(
      emSalvador('2026-10-01', 8).toISOString(),
    );
  });

  it('o fuso é o da unidade, não o do processo', () => {
    /**
     * 23h em Salvador é meio-dia do dia seguinte em Tóquio. A mesma instante
     * é silêncio numa barbearia e horário comercial na outra — e é a unidade
     * que decide, porque a hora que o cliente associa ao corte é a de lá.
     */
    const instante = emSalvador('2026-09-10', 23);
    expect(foraDoSilencio(instante, BAHIA).toISOString()).not.toBe(instante.toISOString());
    expect(foraDoSilencio(instante, TOKYO).toISOString()).toBe(instante.toISOString());
  });
});

describe('lembrete de agendamento', () => {
  const base = {
    timeZone: BAHIA,
    temTelefone: true,
    aindaVale: true,
    jaEnviada: false,
  };

  it('o de 24h sai um dia antes', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });

    expect(decisao.enviar).toBe(true);
    expect(decisao.quando?.toISOString()).toBe(emSalvador('2026-09-10', 15).toISOString());
  });

  it('o de 2h sai duas horas antes', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'lembrete_2h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.quando?.toISOString()).toBe(emSalvador('2026-09-11', 13).toISOString());
  });

  it('lembrete que cairia de madrugada espera as oito', () => {
    // Corte às 9h: o de 24h cairia às 9h do dia anterior (ok), mas o de 2h de
    // um corte às 9h cairia às 7h — dentro do silêncio.
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'lembrete_2h',
      comecaEm: emSalvador('2026-09-11', 9),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.quando?.toISOString()).toBe(emSalvador('2026-09-11', 8).toISOString());
  });

  it('lembrete que chegaria depois do corte não é enviado', () => {
    /**
     * A regra que separa "avisar" de "parecer quebrado".
     *
     * Corte às 8h30. O lembrete de 2h cairia às 6h30, e empurrado para fora do
     * silêncio iria às 8h... ainda antes. Mas o de um corte às 8h cairia às 6h,
     * empurrado para 8h — em cima da hora, inútil e constrangedor.
     */
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'lembrete_2h',
      comecaEm: emSalvador('2026-09-11', 8),
      agora: emSalvador('2026-09-01', 10),
    });

    expect(decisao.enviar).toBe(false);
    expect(decisao.motivo).toBe('passou_da_hora');
  });

  it('quem marca de véspera não recebe "faltam 24 horas"', () => {
    // Marcou às 22h para as 9h da manhã seguinte: o de 24h já passou. Ele
    // recebe a confirmação, que é o aviso certo para este caso.
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 9),
      agora: emSalvador('2026-09-10', 22),
    });
    expect(decisao.enviar).toBe(false);
    expect(decisao.motivo).toBe('passou_da_hora');
  });

  it('a confirmação sai mesmo em cima da hora — ela não promete tempo', () => {
    // "Está marcado" continua verdadeiro a qualquer distância do corte.
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'confirmacao',
      comecaEm: emSalvador('2026-09-10', 15),
      agora: emSalvador('2026-09-10', 14, 50),
    });
    expect(decisao.enviar).toBe(true);
  });

  it('a confirmação de madrugada também espera as oito', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      tipo: 'confirmacao',
      comecaEm: emSalvador('2026-09-12', 15),
      agora: emSalvador('2026-09-10', 23, 30),
    });
    expect(decisao.quando?.toISOString()).toBe(emSalvador('2026-09-11', 8).toISOString());
  });

  it('agendamento cancelado não gera lembrete', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      aindaVale: false,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.motivo).toBe('cancelado');
  });

  it('sem telefone não há como avisar', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      temTelefone: false,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.motivo).toBe('sem_telefone');
  });

  it('já enviada não sai de novo', () => {
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      jaEnviada: true,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.motivo).toBe('ja_enviada');
  });

  it('opt-out de marketing não silencia o lembrete', () => {
    /**
     * O erro que esta regra existe para impedir: quem recusou promoção em
     * março deixar de ser avisado do corte de setembro. São coisas diferentes,
     * e confundi-las custa a falta que o lembrete existia para evitar.
     */
    const decisao = decidirEnvioDeAgendamento({
      ...base,
      aceitaPromocional: false,
      promocionaisNoMes: 99,
      tipo: 'lembrete_24h',
      comecaEm: emSalvador('2026-09-11', 15),
      agora: emSalvador('2026-09-01', 10),
    });
    expect(decisao.enviar).toBe(true);
  });

  it('as antecedências são as que o nome diz', () => {
    expect(ANTECEDENCIA['lembrete_24h']).toBe(24 * 60);
    expect(ANTECEDENCIA['lembrete_2h']).toBe(2 * 60);
    // Confirmação não tem antecedência: ela sai quando o fato acontece.
    expect(ANTECEDENCIA['confirmacao']).toBeUndefined();
  });
});

describe('mensagem de retorno', () => {
  const base = {
    diasParaRetorno: 30,
    timeZone: BAHIA,
    temTelefone: true,
    aceitaPromocional: true,
    promocionaisNoMes: 0,
    jaEnviada: false,
  };

  it('sai quando o intervalo vence', () => {
    const decisao = decidirRetorno({
      ...base,
      ultimaVisita: emSalvador('2026-08-01', 10),
      agora: emSalvador('2026-09-05', 10),
    });
    expect(decisao.enviar).toBe(true);
  });

  it('não sai antes de vencer', () => {
    const decisao = decidirRetorno({
      ...base,
      ultimaVisita: emSalvador('2026-08-20', 10),
      agora: emSalvador('2026-09-05', 10),
    });
    expect(decisao.enviar).toBe(false);
  });

  it('respeita o opt-out — é promoção', () => {
    const decisao = decidirRetorno({
      ...base,
      aceitaPromocional: false,
      ultimaVisita: emSalvador('2026-08-01', 10),
      agora: emSalvador('2026-09-05', 10),
    });
    expect(decisao.motivo).toBe('optou_por_nao_receber');
  });

  it('respeita o teto do mês', () => {
    // Automação sem teto vira spam e queima o número da barbearia.
    const decisao = decidirRetorno({
      ...base,
      promocionaisNoMes: TETO_PROMOCIONAL_MES,
      ultimaVisita: emSalvador('2026-08-01', 10),
      agora: emSalvador('2026-09-05', 10),
    });
    expect(decisao.motivo).toBe('teto_do_mes');
  });

  it('quem nunca veio não recebe "sentimos sua falta"', () => {
    const decisao = decidirRetorno({
      ...base,
      ultimaVisita: null,
      agora: emSalvador('2026-09-05', 10),
    });
    expect(decisao.enviar).toBe(false);
  });

  it('também espera a janela de silêncio', () => {
    const decisao = decidirRetorno({
      ...base,
      ultimaVisita: emSalvador('2026-08-01', 10),
      agora: emSalvador('2026-09-05', 23),
    });
    expect(decisao.quando?.toISOString()).toBe(emSalvador('2026-09-06', 8).toISOString());
  });
});

describe('a chave de deduplicação', () => {
  it('é determinística por tipo e alvo', () => {
    expect(chaveDaNotificacao('lembrete_24h', 'ap-1')).toBe(
      chaveDaNotificacao('lembrete_24h', 'ap-1'),
    );
  });

  it('separa os dois lembretes do mesmo agendamento', () => {
    // Sem isso, o de 2h seria considerado duplicata do de 24h e nunca sairia.
    expect(chaveDaNotificacao('lembrete_24h', 'ap-1')).not.toBe(
      chaveDaNotificacao('lembrete_2h', 'ap-1'),
    );
  });

  it('separa agendamentos diferentes', () => {
    expect(chaveDaNotificacao('lembrete_24h', 'ap-1')).not.toBe(
      chaveDaNotificacao('lembrete_24h', 'ap-2'),
    );
  });
});
