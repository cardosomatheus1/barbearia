import { describe, expect, it } from 'vitest';
import {
  DIAS_ATE_BLOQUEIO,
  diasAteOBloqueio,
  proximoPassoDaRegua,
  ratear,
  type EstadoDaFatura,
} from './cobranca.js';

const dia = (n: number): Date => new Date(Date.UTC(2026, 2, n, 12, 0, 0));

const aberta = (parcial: Partial<EstadoDaFatura> = {}): EstadoDaFatura => ({
  status: 'open',
  vencimento: dia(10),
  tentativas: 1,
  avisadaEm: null,
  vencidaEm: null,
  ...parcial,
});

describe('régua de cobrança', () => {
  it('avisa o dono antes do vencimento, não na véspera do bloqueio', () => {
    expect(proximoPassoDaRegua(aberta(), dia(7))).toBe('avisar_vencimento');
  });

  it('não avisa duas vezes a mesma fatura', () => {
    expect(proximoPassoDaRegua(aberta({ avisadaEm: dia(7) }), dia(8))).toBe('nada');
  });

  it('longe do vencimento não faz nada — aviso cedo demais vira ruído', () => {
    expect(proximoPassoDaRegua(aberta(), dia(1))).toBe('nada');
  });

  it('no dia do vencimento marca vencida em vez de bloquear', () => {
    expect(proximoPassoDaRegua(aberta(), dia(10))).toBe('marcar_vencida');
  });

  it('retenta na escada declarada, e não antes', () => {
    const vencida = aberta({ vencidaEm: dia(10), tentativas: 1 });
    expect(proximoPassoDaRegua(vencida, dia(10))).toBe('nada');
    expect(proximoPassoDaRegua(vencida, dia(11))).toBe('retentar');
  });

  it('cada tentativa empurra a próxima para mais longe', () => {
    const base = { vencidaEm: dia(10) };
    expect(proximoPassoDaRegua(aberta({ ...base, tentativas: 2 }), dia(12))).toBe('nada');
    expect(proximoPassoDaRegua(aberta({ ...base, tentativas: 2 }), dia(13))).toBe('retentar');
    expect(proximoPassoDaRegua(aberta({ ...base, tentativas: 3 }), dia(16))).toBe('nada');
    expect(proximoPassoDaRegua(aberta({ ...base, tentativas: 3 }), dia(24))).toBe('retentar');
  });

  it('esgotada a escada, espera o prazo em vez de cobrar sem parar', () => {
    const fatura = aberta({ vencidaEm: dia(10), tentativas: 5 });
    expect(proximoPassoDaRegua(fatura, dia(28))).toBe('nada');
  });

  it('bloqueia só depois das três semanas', () => {
    const fatura = aberta({ vencidaEm: dia(10), tentativas: 5 });
    expect(proximoPassoDaRegua(fatura, dia(30))).toBe('nada');
    expect(proximoPassoDaRegua(fatura, dia(31))).toBe('bloquear');
  });

  /**
   * O caso do worker parado.
   *
   * Uma fatura de dois meses atrás não pode ficar presa em "marcar vencida" e
   * gastar uma volta da régua por dia para chegar ao bloqueio — ela já passou
   * do prazo, e o passo grave vence o leve.
   */
  it('fatura esquecida bloqueia direto, sem refazer a escada', () => {
    expect(proximoPassoDaRegua(aberta({ vencimento: dia(1) }), dia(60))).toBe('bloquear');
  });

  it('fatura paga ou cancelada sai da régua', () => {
    expect(proximoPassoDaRegua(aberta({ status: 'paid' }), dia(60))).toBe('nada');
    expect(proximoPassoDaRegua(aberta({ status: 'void' }), dia(60))).toBe('nada');
  });

  it('a contagem para o bloqueio não fica negativa', () => {
    expect(diasAteOBloqueio(dia(10), dia(10))).toBe(DIAS_ATE_BLOQUEIO);
    expect(diasAteOBloqueio(dia(10), dia(20))).toBe(11);
    expect(diasAteOBloqueio(dia(10), dia(60))).toBe(0);
  });
});

describe('rateio da troca de plano', () => {
  const periodo = { periodoInicio: dia(1), periodoFim: dia(31) };

  it('subir de plano no meio do período cobra só a diferença do que falta', () => {
    const r = ratear({ ...periodo, precoAtualCents: 9900, precoNovoCents: 24900, agora: dia(16) });
    expect(r.diasDoPeriodo).toBe(30);
    expect(r.diasRestantes).toBe(15);
    // 24900 * 15/30 = 12450 a cobrar; 9900 * 15/30 = 4950 de crédito.
    expect(r.cobrarCents).toBe(7500);
    expect(r.creditarCents).toBe(0);
  });

  it('descer de plano gera crédito, não cobrança', () => {
    const r = ratear({ ...periodo, precoAtualCents: 24900, precoNovoCents: 9900, agora: dia(16) });
    expect(r.cobrarCents).toBe(0);
    expect(r.creditarCents).toBe(7500);
  });

  it('trocar no primeiro dia cobra a diferença cheia', () => {
    const r = ratear({ ...periodo, precoAtualCents: 4900, precoNovoCents: 9900, agora: dia(1) });
    expect(r.diasRestantes).toBe(30);
    expect(r.cobrarCents).toBe(5000);
  });

  it('trocar no último dia não cobra o mês inteiro de novo', () => {
    const r = ratear({ ...periodo, precoAtualCents: 4900, precoNovoCents: 24900, agora: dia(31) });
    expect(r.diasRestantes).toBe(0);
    expect(r.cobrarCents).toBe(0);
    expect(r.creditarCents).toBe(0);
  });

  /**
   * O arredondamento tem lado, e o lado é declarado.
   *
   * 4900 em 30 dias com 7 restantes dá 1143,33… centavos: cobrar arredonda para
   * baixo (1143) e creditar para cima (1144). A diferença é um centavo, e é
   * exatamente o tipo de decisão que, tomada em silêncio, sempre acaba a favor
   * de quem emite a fatura.
   */
  it('arredonda a favor da barbearia nos dois sentidos', () => {
    const sobe = ratear({ ...periodo, precoAtualCents: 0, precoNovoCents: 4900, agora: dia(24) });
    expect(sobe.diasRestantes).toBe(7);
    expect(sobe.cobrarCents).toBe(1143);

    const desce = ratear({ ...periodo, precoAtualCents: 4900, precoNovoCents: 0, agora: dia(24) });
    expect(desce.creditarCents).toBe(1144);
  });

  it('trocar depois do fim do período não inventa dia negativo', () => {
    const r = ratear({ ...periodo, precoAtualCents: 4900, precoNovoCents: 24900, agora: dia(40) });
    expect(r.diasRestantes).toBe(0);
    expect(r.cobrarCents).toBe(0);
  });

  it('período de um dia não divide por zero', () => {
    const r = ratear({
      periodoInicio: dia(1),
      periodoFim: dia(1),
      precoAtualCents: 0,
      precoNovoCents: 9900,
      agora: dia(1),
    });
    expect(r.diasDoPeriodo).toBe(1);
    expect(r.cobrarCents).toBe(9900);
  });

  it('trocar para o mesmo preço não cobra nem credita', () => {
    const r = ratear({ ...periodo, precoAtualCents: 9900, precoNovoCents: 9900, agora: dia(16) });
    expect(r.cobrarCents).toBe(0);
    expect(r.creditarCents).toBe(0);
  });
});
