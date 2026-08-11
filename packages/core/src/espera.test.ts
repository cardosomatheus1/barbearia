import { describe, expect, it } from 'vitest';
import {
  DIAS_MAXIMOS_DE_ESPERA,
  LIMITE_DE_ESPERAS_ATIVAS,
  esperaExpirou,
  podeEsperar,
  vagaServe,
  type PedidoDeEspera,
  type VagaAberta,
} from './espera.js';

const SABADO = '2026-08-15';
const DOMINGO = '2026-08-16';
const RUAN = 'ruan';
const GLEIDSON = 'gleidson';

/** "Sábado, das 8h ao meio-dia, qualquer barbeiro, corte de 30 min." */
const PEDIDO: PedidoDeEspera = {
  de: SABADO,
  ate: SABADO,
  janela: { start: 8 * 60, end: 12 * 60 },
  profissionalId: null,
  duracaoMinutos: 30,
};

const vaga = (extra: Partial<VagaAberta> = {}): VagaAberta => ({
  dia: SABADO,
  janela: { start: 9 * 60, end: 10 * 60 },
  profissionalId: RUAN,
  ...extra,
});

describe('a vaga serve para o pedido', () => {
  it('mesmo dia, dentro da janela, qualquer barbeiro: serve', () => {
    expect(vagaServe(PEDIDO, vaga())).toBe(true);
  });

  it('outro dia não serve', () => {
    expect(vagaServe(PEDIDO, vaga({ dia: DOMINGO }))).toBe(false);
  });

  it('quem pediu um barbeiro não é avisado do horário de outro', () => {
    /**
     * O contrário vale: pedido sem profissional aceita qualquer um. Avisar quem
     * pediu o Ruan sobre uma vaga do Gleidson é o jeito mais rápido de a pessoa
     * aprender a ignorar o aviso — e o aviso é a alavanca inteira desta função.
     */
    const comRuan = { ...PEDIDO, profissionalId: RUAN };
    expect(vagaServe(comRuan, vaga({ profissionalId: RUAN }))).toBe(true);
    expect(vagaServe(comRuan, vaga({ profissionalId: GLEIDSON }))).toBe(false);
    expect(vagaServe(PEDIDO, vaga({ profissionalId: GLEIDSON }))).toBe(true);
  });

  it('o atendimento inteiro tem que caber na janela pedida, não só começar nela', () => {
    /**
     * A regra que separa esta função de um `overlaps` ingênuo. Quem pediu "até
     * meio-dia" está dizendo que precisa ir embora ao meio-dia — uma vaga que
     * começa 11:40 põe a pessoa na cadeira até 12:10, e o aviso vira ligação
     * inútil.
     */
    const encostada = vaga({ janela: { start: 11 * 60 + 40, end: 12 * 60 + 30 } });
    expect(vagaServe(PEDIDO, encostada)).toBe(false);

    const cabe = vaga({ janela: { start: 11 * 60 + 30, end: 12 * 60 + 30 } });
    expect(vagaServe(PEDIDO, cabe)).toBe(true);
  });

  it('a vaga precisa comportar o serviço, mesmo dentro da janela', () => {
    // Vaga de 20 min no meio da manhã não serve para um corte de 30, por mais
    // que 20 min caibam entre 8h e meio-dia.
    const curta = vaga({ janela: { start: 9 * 60, end: 9 * 60 + 20 } });
    expect(vagaServe(PEDIDO, curta)).toBe(false);
  });

  it('encostar no fim da janela conta como caber', () => {
    // Intervalo semiaberto, como em todo o resto do produto: terminar às 12:00
    // para quem pediu "até 12:00" é dentro.
    const noLimite = vaga({ janela: { start: 11 * 60 + 30, end: 12 * 60 } });
    expect(vagaServe(PEDIDO, noLimite)).toBe(true);
  });

  it('faixa de dias aceita qualquer dia dela, e nenhum de fora', () => {
    const semana = { ...PEDIDO, de: '2026-08-10', ate: '2026-08-15' };
    expect(vagaServe(semana, vaga({ dia: '2026-08-10' }))).toBe(true);
    expect(vagaServe(semana, vaga({ dia: '2026-08-13' }))).toBe(true);
    expect(vagaServe(semana, vaga({ dia: '2026-08-15' }))).toBe(true);
    expect(vagaServe(semana, vaga({ dia: '2026-08-09' }))).toBe(false);
    expect(vagaServe(semana, vaga({ dia: '2026-08-16' }))).toBe(false);
  });
});

describe('a entrada expira quando o prazo passa', () => {
  it('expira no dia seguinte ao último pedido, não no primeiro', () => {
    // Quem pediu "de segunda a sábado" continua na fila na quinta. Expirar no
    // primeiro dia tiraria da lista justamente quem mais espera.
    const semana = { ate: '2026-08-15' };
    expect(esperaExpirou(semana, '2026-08-13')).toBe(false);
    expect(esperaExpirou(semana, '2026-08-15')).toBe(false);
    expect(esperaExpirou(semana, '2026-08-16')).toBe(true);
  });
});

describe('quem pode entrar na lista', () => {
  const pedir = (extra: Partial<Parameters<typeof podeEsperar>[0]> = {}) =>
    podeEsperar({
      pedido: PEDIDO,
      ativasDoCliente: 0,
      hojeNaUnidade: '2026-08-11',
      ultimoDiaAceito: '2026-10-10',
      ...extra,
    });

  it('o caso comum entra', () => {
    expect(pedir()).toEqual({ aceito: true, recusa: null });
  });

  it('janela invertida ou vazia é recusada', () => {
    const vazia = { ...PEDIDO, janela: { start: 600, end: 600 } };
    expect(pedir({ pedido: vazia }).recusa).toBe('janela_invalida');
  });

  it('período invertido é recusado', () => {
    const invertido = { ...PEDIDO, de: '2026-08-15', ate: '2026-08-10' };
    expect(pedir({ pedido: invertido }).recusa).toBe('periodo_invertido');
  });

  it('pedido que já passou por inteiro é recusado', () => {
    const ontem = { ...PEDIDO, de: '2026-08-10', ate: '2026-08-10' };
    expect(pedir({ pedido: ontem }).recusa).toBe('dia_no_passado');
  });

  it('mas um período que começou ontem e vai até sábado continua valendo', () => {
    // Recusar aqui seria pedir à pessoa que reescrevesse o intervalo por causa
    // de um dia que não muda nada: nenhuma vaga de ontem vai abrir.
    const atravessando = { ...PEDIDO, de: '2026-08-10', ate: '2026-08-15' };
    expect(pedir({ pedido: atravessando }).aceito).toBe(true);
  });

  it('a faixa aberta é recusada pelo fim, não só pelo começo', () => {
    /**
     * Achado da revisão de segurança. Conferir só o começo deixava `ate` livre:
     * "de hoje até 2099" passava, e nunca expirava — a varredura só fecha o que
     * já passou. Três dessas, cobrindo o dia de trabalho, fariam uma pessoa ser
     * candidata permanente a toda vaga que abrisse.
     */
    const semFim = { ...PEDIDO, de: '2026-08-12', ate: '2099-12-31' };
    expect(pedir({ pedido: semFim }).recusa).toBe('periodo_longo_demais');
  });

  it('pedido longe demais é recusado', () => {
    /**
     * Uma entrada para daqui a oito meses vai expirar sem nunca ter sido útil,
     * e ocupa uma das três vagas do cliente até lá. O teto existe para a lista
     * continuar significando "quero uma vaga logo".
     */
    const distante = { ...PEDIDO, de: '2026-12-01', ate: '2026-12-01' };
    expect(pedir({ pedido: distante }).recusa).toBe('periodo_longo_demais');
    expect(DIAS_MAXIMOS_DE_ESPERA).toBeGreaterThan(0);
  });

  it('a quarta entrada ativa é recusada', () => {
    // Sem teto, uma pessoa se inscreve para os sete dias da semana e passa a
    // receber todo aviso de vaga da barbearia — e o aviso deixa de significar
    // alguma coisa para todo mundo.
    expect(pedir({ ativasDoCliente: LIMITE_DE_ESPERAS_ATIVAS - 1 }).aceito).toBe(true);
    expect(pedir({ ativasDoCliente: LIMITE_DE_ESPERAS_ATIVAS }).recusa).toBe('limite_atingido');
  });
});
