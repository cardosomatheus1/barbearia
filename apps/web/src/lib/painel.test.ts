import { describe, expect, it } from 'vitest';
import { destinoInicialDoPainel } from './painel';

const estado = (
  role: string,
  permissions: readonly string[] = [],
  publishedAt: string | null = '2026-08-22T12:00:00.000Z',
) => ({ publishedAt, staff: { role, permissions } });

describe('destino inicial do painel', () => {
  it('leva o barbeiro para Meu dia', () => {
    expect(destinoInicialDoPainel(estado('professional', ['appointments.view']))).toBe('/admin/meu-dia');
  });

  it('leva recepção e gerência operacional para Hoje', () => {
    expect(destinoInicialDoPainel(estado('receptionist', ['appointments.view']))).toBe('/admin/dia');
    expect(destinoInicialDoPainel(estado('manager', ['appointments.view', 'finance.view']))).toBe('/admin/dia');
  });

  it('leva o dono publicado para o Painel', () => {
    expect(destinoInicialDoPainel(estado('owner', ['reports.operational']))).toBe('/admin/painel');
  });

  it('mantém onboarding acima da home diária enquanto a casa não foi publicada', () => {
    expect(
      destinoInicialDoPainel(estado('owner', ['settings.manage', 'reports.operational'], null)),
    ).toBe('/admin/onboarding');
  });

  it('respeita escopo de dono explicitamente delegado', () => {
    expect(
      destinoInicialDoPainel(
        estado('manager', ['reports.operational', 'finance.view_profit', 'team.manage']),
      ),
    ).toBe('/admin/painel');
  });

  it('não oferece Painel quando a conta não pode abri-lo', () => {
    expect(destinoInicialDoPainel(estado('owner', []))).toBe('/admin/dia');
  });
});
