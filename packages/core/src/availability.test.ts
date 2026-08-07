import { describe, expect, it } from 'vitest';
import { collapseByStart, computeAvailability } from './availability.js';
import { resolveDuration } from './duration.js';
import { parseHHMM, type TimeRange } from './time.js';
import type { ProfessionalDay, Service } from './types.js';

function r(spec: string): TimeRange {
  const [start, end] = spec.split('-');
  return { start: parseHHMM(start!), end: parseHHMM(end!) };
}

function service(id: string, minutes: number, buffers: Partial<Service> = {}): Service {
  return {
    id,
    durationMinutes: minutes,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...buffers,
  };
}

const CORTE = service('corte', 20);
const BARBA = service('barba', 20);

function prof(id: string, working: string, extra: Partial<ProfessionalDay> = {}): ProfessionalDay {
  return { professionalId: id, working: [r(working)], ...extra };
}

const starts = (result: { slots: readonly { start: string }[] }): string[] =>
  result.slots.map((s) => s.start);

describe('resolveDuration', () => {
  it('soma as durações de vários serviços', () => {
    const resolved = resolveDuration([CORTE, BARBA]);
    expect(resolved.serviceMinutes).toBe(40);
    expect(resolved.occupiedMinutes).toBe(40);
  });

  it('aplica buffer externo uma vez só, não por serviço', () => {
    const corte = service('corte', 20, { bufferAfterMinutes: 5 });
    const barba = service('barba', 20, { bufferAfterMinutes: 5 });
    const resolved = resolveDuration([corte, barba]);

    // Uma limpeza no fim do bloco, não uma entre corte e barba do mesmo cliente.
    expect(resolved.serviceMinutes).toBe(40);
    expect(resolved.occupiedMinutes).toBe(45);
  });

  it('usa o maior buffer entre os serviços escolhidos', () => {
    const corte = service('corte', 20, { bufferAfterMinutes: 5 });
    const quimica = service('quimica', 40, { bufferAfterMinutes: 15 });
    expect(resolveDuration([corte, quimica]).occupiedMinutes).toBe(75);
  });

  it('soma os buffers quando a política é perService', () => {
    const corte = service('corte', 20, { bufferAfterMinutes: 5 });
    const barba = service('barba', 20, { bufferAfterMinutes: 5 });
    const resolved = resolveDuration([corte, barba], { bufferPolicy: 'perService' });
    expect(resolved.occupiedMinutes).toBe(50);
  });

  it('aplica combo declarado', () => {
    const resolved = resolveDuration([CORTE, BARBA], {
      comboRules: [
        { id: 'combo-1', componentServiceIds: ['corte', 'barba'], declaredDurationMinutes: 30 },
      ],
    });
    expect(resolved.serviceMinutes).toBe(30);
    expect(resolved.appliedComboId).toBe('combo-1');
  });

  it('ignora combo cujo conjunto não casa exatamente', () => {
    const resolved = resolveDuration([CORTE], {
      comboRules: [
        { id: 'combo-1', componentServiceIds: ['corte', 'barba'], declaredDurationMinutes: 30 },
      ],
    });
    expect(resolved.serviceMinutes).toBe(20);
    expect(resolved.appliedComboId).toBeNull();
  });

  it('nunca infere encurtamento sem regra declarada — defeito D4', () => {
    // O sistema analisado tinha "Cabelo + Barba + Sobrancelha = 30 min" por R$ 94,
    // com componentes somando 55 min. Sem regra, aqui a duração é a soma real.
    const sobrancelha = service('sobrancelha', 15);
    expect(resolveDuration([CORTE, BARBA, sobrancelha]).serviceMinutes).toBe(55);
  });

  it('rejeita seleção vazia e duração inválida', () => {
    expect(() => resolveDuration([])).toThrow();
    expect(() => resolveDuration([service('x', 0)])).toThrow();
  });
});

describe('computeAvailability — geração básica', () => {
  it('gera slots ancorados no início da jornada', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-10:00')],
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:00', '09:20', '09:40']);
  });

  it('respeita o fim do expediente — último slot cabe inteiro', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00')],
      granularityMinutes: 15,
    });
    // 17:40 + 20 = 18:00 cabe; 17:45 + 20 = 18:05 não.
    expect(result.slots.at(-1)?.start).toBe('17:40');
  });

  it('subtrai intervalo de almoço', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-14:00', { breaks: [r('12:00-13:00')] })],
      granularityMinutes: 60,
    });
    // 11:40 e 13:40 são slots de cauda: cabem inteiros antes do almoço e do
    // fechamento. A grade fixa os desperdiçaria.
    expect(starts(result)).toEqual(['09:00', '10:00', '11:00', '11:40', '13:00', '13:40']);
  });

  it('subtrai agendamentos existentes', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-11:00', { busy: [r('09:20-09:40')] })],
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:00', '09:40', '10:00', '10:20', '10:40']);
  });

  it('subtrai bloqueios pontuais', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-11:00', { blocks: [r('10:00-11:00')] })],
      granularityMinutes: 30,
    });
    expect(starts(result)).toEqual(['09:00', '09:30', '09:40']);
  });

  it('dia fechado não gera slot', () => {
    const result = computeAvailability({
      date: '2026-08-10',
      services: [CORTE],
      professionals: [{ professionalId: 'p1', working: [] }],
    });
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('closed');
    expect(result.waitlistAvailable).toBe(false);
  });
});

describe('computeAvailability — slot ancorado vs grade fixa (defeito D1)', () => {
  const professional = prof('p1', '09:00-11:00', { busy: [r('09:00-09:20')] });

  it('grade fixa desperdiça o resto entre agendamentos', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [professional],
      strategy: 'grid',
      granularityMinutes: 15,
    });
    // A janela livre começa 09:20, mas a grade só oferece 09:30 — 10 min mortos.
    expect(starts(result)[0]).toBe('09:30');
  });

  it('slot ancorado aproveita o encaixe justo', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [professional],
      strategy: 'anchored',
      granularityMinutes: 20,
    });
    expect(starts(result)[0]).toBe('09:20');
  });

  it('ancorado oferece mais horários que a grade na mesma jornada', () => {
    const base = {
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00', { busy: [r('11:10-11:30')] })],
    } as const;

    const anchored = computeAvailability({ ...base, strategy: 'anchored', granularityMinutes: 20 });
    const grid = computeAvailability({ ...base, strategy: 'grid', granularityMinutes: 20 });


    expect(anchored.slots.length).toBeGreaterThan(grid.slots.length);
  });

  it('ancorado oferece o último início que cabe (slot de cauda)', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00')],
      strategy: 'anchored',
      granularityMinutes: 15,
    });
    // Passo 15 a partir de 09:00 chega a 17:30; 17:40 é o último início que
    // cabe inteiro. Sem o slot de cauda, esses 10 minutos morreriam.
    expect(result.slots.at(-1)?.start).toBe('17:40');
    expect(result.slots.at(-2)?.start).toBe('17:30');
  });

  it('grade fixa não recebe slot de cauda — a rigidez é o comportamento desejado', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00')],
      strategy: 'grid',
      granularityMinutes: 15,
    });
    expect(result.slots.at(-1)?.start).toBe('17:30');
  });

  it('não duplica quando o passo já cai no último início possível', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-10:00')],
      strategy: 'anchored',
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:00', '09:20', '09:40']);
  });

  it('usa granularidade padrão por estratégia', () => {
    const anchored = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00')],
    });
    expect(anchored.granularityMinutes).toBe(5);

    const grid = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00')],
      strategy: 'grid',
    });
    expect(grid.granularityMinutes).toBe(15);
  });
});

describe('computeAvailability — buffers', () => {
  it('ocupa o buffer na agenda mas não o mostra ao cliente', () => {
    const corte = service('corte', 40, { bufferAfterMinutes: 5 });
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corte],
      professionals: [prof('p1', '09:00-10:30')],
      granularityMinutes: 45,
    });

    expect(result.slots[0]).toMatchObject({
      start: '09:00',
      end: '09:40', // cliente vê 40 min
      occupiedStart: '09:00',
      occupiedEnd: '09:45', // agenda reserva 45
    });
    expect(result.totalDurationMinutes).toBe(45);
    expect(result.serviceDurationMinutes).toBe(40);
  });

  it('desloca o início visível quando há buffer antes', () => {
    const corte = service('corte', 40, { bufferBeforeMinutes: 10 });
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corte],
      professionals: [prof('p1', '09:00-10:00')],
      granularityMinutes: 60,
    });
    // Buffer de 10 min antes: a agenda ocupa desde 09:00, o cliente chega 09:10.
    expect(result.slots[0]).toMatchObject({
      start: '09:10',
      end: '09:50',
      occupiedStart: '09:00',
      occupiedEnd: '09:50',
    });
  });

  it('impede slot cujo buffer não cabe no expediente', () => {
    const corte = service('corte', 40, { bufferAfterMinutes: 20 });
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corte],
      professionals: [prof('p1', '09:00-10:00')],
      granularityMinutes: 10,
    });
    // 60 min de ocupação numa janela de 60 min: só o início de 09:00 cabe.
    expect(starts(result)).toEqual(['09:00']);
  });
});

describe('computeAvailability — antecedência mínima', () => {
  it('descarta horários antes do corte', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-12:00')],
      granularityMinutes: 60,
      earliestStartMinute: parseHHMM('10:30'),
    });
    expect(starts(result)).toEqual(['11:00', '11:40']);
  });

  it('reporta past_cutoff quando o corte elimina tudo', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-12:00')],
      earliestStartMinute: parseHHMM('23:00'),
    });
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('past_cutoff');
  });
});

describe('computeAvailability — limite diário', () => {
  it('exclui profissional que atingiu o teto', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00', { dailyLimit: 8, appointmentCount: 8 })],
    });
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('daily_limit_reached');
    expect(result.waitlistAvailable).toBe(true);
  });

  it('mantém profissional abaixo do teto', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-10:00', { dailyLimit: 8, appointmentCount: 7 })],
      granularityMinutes: 60,
    });
    expect(starts(result)).toEqual(['09:00', '09:40']);
  });
});

describe('computeAvailability — recursos', () => {
  const corteComCadeira: Service = {
    ...CORTE,
    requiredResources: [{ resourceType: 'cadeira', quantity: 1 }],
  };

  it('oferece slot quando há capacidade', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corteComCadeira],
      professionals: [prof('p1', '09:00-10:00')],
      resourcePools: [{ resourceType: 'cadeira', capacity: 2, busy: [r('09:00-09:20')] }],
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:00', '09:20', '09:40']);
  });

  it('bloqueia slot quando o recurso está esgotado', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corteComCadeira],
      professionals: [prof('p1', '09:00-10:00')],
      resourcePools: [
        { resourceType: 'cadeira', capacity: 1, busy: [r('09:00-09:20'), r('09:40-10:00')] },
      ],
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:20']);
  });

  it('ancora o slot na liberação do recurso, não na grade', () => {
    // A única cadeira libera 09:20. O barbeiro está livre desde 09:00, então a
    // janela dele ancoraria em 09:00 e o passo de 20 min pularia direto para
    // 09:40 — perdendo 09:20. Recortar a faixa saturada antes de gerar os slots
    // faz o próximo nascer exatamente na liberação.
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corteComCadeira],
      professionals: [prof('p1', '09:00-11:00')],
      resourcePools: [{ resourceType: 'cadeira', capacity: 1, busy: [r('09:00-09:20')] }],
      granularityMinutes: 20,
    });
    expect(starts(result)[0]).toBe('09:20');
  });

  it('trata recurso exigido e não cadastrado como indisponível', () => {
    const comMaca: Service = {
      ...CORTE,
      requiredResources: [{ resourceType: 'maca', quantity: 1 }],
    };
    const result = computeAvailability({
      date: '2026-08-11',
      services: [comMaca],
      professionals: [prof('p1', '09:00-18:00')],
      resourcePools: [{ resourceType: 'cadeira', capacity: 3 }],
    });
    expect(result.slots).toEqual([]);
    expect(result.unavailableReason).toBe('resource_unavailable');
  });

  it('agrega necessidade por máximo, não por soma', () => {
    // Corte e barba usam a mesma cadeira: a visita consome 1, não 2.
    const barbaComCadeira: Service = {
      ...BARBA,
      requiredResources: [{ resourceType: 'cadeira', quantity: 1 }],
    };
    const result = computeAvailability({
      date: '2026-08-11',
      services: [corteComCadeira, barbaComCadeira],
      professionals: [prof('p1', '09:00-10:00')],
      resourcePools: [{ resourceType: 'cadeira', capacity: 1 }],
      granularityMinutes: 20,
    });
    expect(starts(result)).toEqual(['09:00', '09:20']);
  });
});

describe('computeAvailability — vários profissionais', () => {
  it('mescla e ordena por horário', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [
        prof('ruan', '10:00-10:20'),
        prof('gleidson', '09:00-09:20'),
      ],
      granularityMinutes: 20,
    });
    expect(result.slots.map((s) => [s.start, s.professionalId])).toEqual([
      ['09:00', 'gleidson'],
      ['10:00', 'ruan'],
    ]);
  });

  it('mantém o mesmo horário para profissionais diferentes', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('ruan', '09:00-09:20'), prof('gleidson', '09:00-09:20')],
      granularityMinutes: 20,
    });
    expect(result.slots).toHaveLength(2);
  });

  it('reporta ausência de profissional habilitado', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [],
    });
    expect(result.unavailableReason).toBe('no_qualified_professional');
    expect(result.waitlistAvailable).toBe(false);
  });

  it('reporta agenda cheia e habilita lista de espera', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('p1', '09:00-18:00', { busy: [r('09:00-18:00')] })],
    });
    expect(result.unavailableReason).toBe('fully_booked');
    expect(result.waitlistAvailable).toBe(true);
  });

  it('anexa o preço do profissional ao slot', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [CORTE],
      professionals: [prof('senior', '09:00-09:20', { price: 80 })],
      granularityMinutes: 20,
    });
    expect(result.slots[0]?.price).toBe(80);
  });
});

describe('collapseByStart — "qualquer profissional"', () => {
  const slots = [
    { start: '09:00', end: '09:20', occupiedStart: '09:00', occupiedEnd: '09:20', professionalId: 'ruan' },
    { start: '09:00', end: '09:20', occupiedStart: '09:00', occupiedEnd: '09:20', professionalId: 'gleidson' },
    { start: '10:00', end: '10:20', occupiedStart: '10:00', occupiedEnd: '10:20', professionalId: 'gleidson' },
  ];

  it('devolve um slot por horário', () => {
    expect(collapseByStart(slots)).toHaveLength(2);
  });

  it('preferred_first escolhe o barbeiro habitual', () => {
    const chosen = collapseByStart(slots, {
      strategy: 'preferred_first',
      preferredProfessionalId: 'gleidson',
    });
    expect(chosen[0]?.professionalId).toBe('gleidson');
  });

  it('balance_load escolhe quem tem menos carga', () => {
    const chosen = collapseByStart(slots, {
      strategy: 'balance_load',
      loadByProfessional: new Map([
        ['ruan', 8],
        ['gleidson', 2],
      ]),
    });
    expect(chosen[0]?.professionalId).toBe('gleidson');
  });

  it('maximize_density prefere quem já tem atendimento adjacente', () => {
    const chosen = collapseByStart(slots, {
      strategy: 'maximize_density',
      busyByProfessional: new Map([
        ['ruan', [r('08:00-09:00')]], // encosta em 09:00
        ['gleidson', [r('15:00-16:00')]], // longe
      ]),
    });
    expect(chosen[0]?.professionalId).toBe('ruan');
  });

  it('mantém ordem cronológica', () => {
    expect(collapseByStart(slots).map((s) => s.start)).toEqual(['09:00', '10:00']);
  });
});

describe('cenário real — Domari Barber Club', () => {
  // Dados extraídos da API do sistema em produção (docs/01-analise-salonsoft.md).
  const jornada = '09:00-18:00';

  it('reproduz a grade do concorrente com strategy: grid', () => {
    const result = computeAvailability({
      date: '2026-08-11',
      services: [service('cabelo', 20)],
      professionals: [prof('332448', jornada)],
      strategy: 'grid',
      granularityMinutes: 15,
    });

    expect(starts(result)[0]).toBe('09:00');
    expect(result.slots.at(-1)?.start).toBe('17:30');
    expect(result.slots).toHaveLength(35); // idêntico à resposta real da API
  });

  it('modo ancorado entrega mais horários no mesmo dia', () => {
    const base = {
      date: '2026-08-11',
      services: [service('cabelo', 20)],
      professionals: [prof('332448', jornada, { busy: [r('10:10-10:30'), r('14:05-14:25')] })],
    } as const;

    const grid = computeAvailability({ ...base, strategy: 'grid', granularityMinutes: 15 });
    const anchored = computeAvailability({ ...base, strategy: 'anchored', granularityMinutes: 15 });

    expect(anchored.slots.length).toBeGreaterThan(grid.slots.length);
  });

  it('combo do concorrente sem regra declarada ocupa a soma real', () => {
    // "Cabelo + Barba" está cadastrado como 30 min no sistema real,
    // mas Cabelo (20) + Barba (20) = 40. Sem regra declarada, vale 40.
    const result = computeAvailability({
      date: '2026-08-11',
      services: [service('cabelo', 20), service('barba', 20)],
      professionals: [prof('332448', jornada)],
    });
    expect(result.serviceDurationMinutes).toBe(40);
  });
});
