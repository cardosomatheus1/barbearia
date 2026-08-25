import { beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({
  linhas: [] as Array<{
    total_count: bigint;
    id: string | null;
    name: string | null;
    phone_e164: string | null;
    created_at: Date | null;
    last_visit: Date | null;
    next_visit: Date | null;
    has_today: boolean | null;
    balance_cents: number | null;
  }>,
  segmentos: [] as Array<{ customerId: string; segmento: string }>,
}));

vi.mock('@barbearia/db', () => ({
  withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: async () => estado.linhas }),
}));

vi.mock('./segmento.js', () => ({
  segmentosDaBase: async () => estado.segmentos,
}));

import { clientesNaPorta, prepararBuscaDaPorta, segmentoDoFiltroDaPorta } from './clientes.js';

const AGORA = new Date('2026-08-22T12:00:00Z');
const base = () => ({
  tenantId: '11111111-1111-1111-1111-111111111111',
  hoje: '2026-08-22',
  podeVerAgenda: true,
  podeVerSegmento: true,
  podeVerFiado: true,
  agora: AGORA,
});

beforeEach(() => {
  estado.linhas = [{
    total_count: 1n,
    id: '11111111-2222-3333-8444-555555555555',
    name: 'João Silva',
    phone_e164: '+5571988887777',
    created_at: new Date('2026-01-01T12:00:00Z'),
    last_visit: new Date('2026-08-21T16:00:00Z'),
    next_visit: new Date('2026-08-29T20:30:00Z'),
    has_today: true,
    balance_cents: -5000,
  }];
  estado.segmentos = [{ customerId: '11111111-2222-3333-8444-555555555555', segmento: 'vip' }];
});

describe('porta de clientes', () => {
  it('mapeia somente a página que o banco devolveu e mascara telefone', async () => {
    const pagina = await clientesNaPorta(base());
    expect(pagina.total).toBe(1);
    expect(pagina.clientes[0]).toMatchObject({ nome: 'João Silva', segmento: 'vip', temFiado: true });
    expect(JSON.stringify(pagina)).not.toContain('988887777');
  });

  it('não devolve os enriquecimentos sem a permissão do domínio dono', async () => {
    const pagina = await clientesNaPorta({
      ...base(),
      podeVerAgenda: false,
      podeVerSegmento: false,
      podeVerFiado: false,
    });
    expect(pagina.clientes[0]).toMatchObject({
      segmento: null,
      proximaVisitaEm: null,
      temHorarioHoje: null,
      temFiado: null,
    });
  });

  it('filtros protegidos continuam fechados também no domínio', async () => {
    expect((await clientesNaPorta({ ...base(), podeVerSegmento: false, filtro: 'vip' })).total).toBe(0);
    expect((await clientesNaPorta({ ...base(), podeVerAgenda: false, filtro: 'hoje' })).total).toBe(0);
    expect((await clientesNaPorta({ ...base(), podeVerFiado: false, filtro: 'fiado' })).total).toBe(0);
  });
});

describe('preparação dos filtros que vão para SQL', () => {
  it('nome ignora acento e caixa', () => {
    expect(prepararBuscaDaPorta(' JOÃO ')).toEqual({ nome: 'joao', telefone: null, invalida: false });
  });

  it('telefone é a chave E.164 completa; número incompleto não vira LIKE', () => {
    expect(prepararBuscaDaPorta('(71) 98888-7777')).toEqual({
      nome: null,
      telefone: '+5571988887777',
      invalida: false,
    });
    expect(prepararBuscaDaPorta('7777').invalida).toBe(true);
  });

  it('traduz somente os três filtros derivados para segmento', () => {
    expect(segmentoDoFiltroDaPorta('vip')).toBe('vip');
    expect(segmentoDoFiltroDaPorta('em_risco')).toBe('em_risco');
    expect(segmentoDoFiltroDaPorta('assinantes')).toBe('assinante');
    expect(segmentoDoFiltroDaPorta('todos')).toBeNull();
  });
});
