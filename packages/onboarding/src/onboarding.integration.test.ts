import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signUpOwner } from '@barbearia/identity';
import { getPublicProfile, loadDayContext } from '@barbearia/scheduling';
import { computeFromContext } from '@barbearia/scheduling';
import { withTenant } from '@barbearia/db';
import {
  getOnboardingState,
  OnboardingError,
  publish,
  saveBusiness,
  saveChangeWindow,
  savePayments,
  saveProfessionals,
  saveServices,
  templatesForOnboarding,
} from './onboarding.js';

/**
 * Onboarding ponta a ponta, contra Postgres real.
 *
 * A prova que interessa não é "gravou no banco": é que **no fim das seis etapas
 * a barbearia tem grade de horário**. Um onboarding que termina sem agenda
 * publicável é um formulário, não um produto.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CONTA = {
  name: 'Matheus Cardoso',
  email: 'matheus@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

/** Terça-feira, longe o bastante do corte de antecedência mínima. */
const TERCA = '2026-08-11';
const AGORA = new Date('2026-08-01T12:00:00Z');

const JORNADA = [2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1080,
}));

/** Cadastra e devolve a sessão; o e-mail já existir aqui é erro do teste. */
async function cadastrar(conta: Parameters<typeof signUpOwner>[0]) {
  const resultado = await signUpOwner(conta);
  if (!resultado.created) throw new Error('e-mail já cadastrado');
  return resultado.session;
}

describeIfDb('onboarding', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
  });

  /** Percorre as seis etapas com o catálogo sugerido. */
  async function percorrer(): Promise<{ tenantId: string; slug: string }> {
    const conta = await cadastrar(CONTA);

    await saveBusiness({
      tenantId: conta.tenantId,
      name: 'Domari Barber Club',
      street: 'Rua Ceará, 120',
      district: 'Pituba',
      city: 'Salvador',
      state: 'BA',
      timezone: 'America/Bahia',
      amenities: ['wifi', 'pix'],
    });

    const templates = templatesForOnboarding();
    await saveServices(
      conta.tenantId,
      templates.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        category: t.category,
        durationMinutes: t.durationMinutes,
        bufferAfterMinutes: t.bufferAfterMinutes,
        priceCents: t.priceCents,
        ...(t.componentKeys ? { componentKeys: t.componentKeys } : {}),
      })),
    );

    const estado = await getOnboardingState(conta.tenantId);
    if (!estado) throw new Error('estado não encontrado');

    await saveProfessionals(conta.tenantId, estado.locationId, [
      { name: 'Ruan', schedule: JORNADA },
      { name: 'Gleidson', schedule: JORNADA },
    ]);

    await savePayments(conta.tenantId, ['pix', 'card', 'cash']);
    await publish(conta.tenantId);

    return { tenantId: conta.tenantId, slug: conta.slug };
  }

  it('das seis etapas sai uma barbearia com grade de horário', async () => {
    const { tenantId, slug } = await percorrer();

    const perfil = await getPublicProfile(tenantId, slug);
    expect(perfil?.name).toBe('Domari Barber Club');
    expect(perfil?.professionals.map((p) => p.name).sort()).toEqual(['Gleidson', 'Ruan']);
    expect(perfil?.priceFromCents).toBeGreaterThan(0);

    const servico = perfil?.categories.flatMap((c) => c.services)[0];
    expect(servico).toBeDefined();

    const grade = await withTenant(tenantId, async (tx) => {
      const contexto = await loadDayContext(tx, {
        locationId: perfil!.location.id,
        serviceIds: [servico!.id],
        date: TERCA,
      });
      return contexto ? computeFromContext(contexto, { date: TERCA, now: AGORA }) : null;
    });

    // A prova do bloco: link publicado que abre com horário de verdade.
    expect(grade?.slots.length ?? 0).toBeGreaterThan(0);
    expect(grade?.slots[0]?.start).toBe('09:00');
  });

  it('cada etapa é gravada sozinha e o contador só avança', async () => {
    // Abandonar no passo 4 não pode custar os passos 1 a 3.
    const conta = await cadastrar(CONTA);
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(1);

    await saveBusiness({ tenantId: conta.tenantId, name: 'Domari', city: 'Salvador' });
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(2);

    await savePayments(conta.tenantId, ['pix']);
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(5);

    // Voltar para corrigir o endereço não pode reabrir o cadastro inteiro.
    await saveBusiness({ tenantId: conta.tenantId, name: 'Domari Barber Club' });
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(5);
  });

  it('o combo do onboarding nasce ligado às partes que substitui', async () => {
    // É o que faz a tela do cliente avisar quando a escolha avulsa sai mais cara.
    const { tenantId, slug } = await percorrer();
    const perfil = await getPublicProfile(tenantId, slug);

    expect(perfil?.bundles).toHaveLength(1);
    const combo = perfil?.bundles[0];
    expect(combo?.componentIds).toHaveLength(2);

    const porId = new Map(
      perfil?.categories.flatMap((c) => c.services).map((s) => [s.id, s]) ?? [],
    );
    const soma = (combo?.componentIds ?? []).reduce(
      (total, id) => total + (porId.get(id)?.priceCents ?? 0),
      0,
    );
    expect(combo?.priceCents).toBeLessThan(soma);
  });

  it('recusa cardápio com combo mais curto que as partes — D4 na origem', async () => {
    const conta = await cadastrar(CONTA);

    await expect(
      saveServices(conta.tenantId, [
        { key: 'corte', name: 'Corte', category: 'Cabelo', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 4500 },
        { key: 'barba', name: 'Barba', category: 'Barba', durationMinutes: 25, bufferAfterMinutes: 5, priceCents: 3500 },
        {
          key: 'combo', name: 'Corte + Barba', category: 'Combo',
          // O número exato que o concorrente usou para um par que soma 55.
          durationMinutes: 40, bufferAfterMinutes: 5, priceCents: 7000,
          componentKeys: ['corte', 'barba'],
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_catalog' });

    // E não deixou meio cardápio gravado.
    const estado = await getOnboardingState(conta.tenantId);
    expect(estado?.counts.services).toBe(0);
  });

  it('não publica sem serviço, sem equipe ou sem jornada', async () => {
    const conta = await cadastrar(CONTA);

    // Link no ar que abre "nenhum horário" é pior que link nenhum.
    await expect(publish(conta.tenantId)).rejects.toMatchObject({
      code: 'nothing_to_publish',
    });

    await saveServices(conta.tenantId, [
      { key: 'corte', name: 'Corte', category: 'Cabelo', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 4500 },
    ]);
    await expect(publish(conta.tenantId)).rejects.toMatchObject({
      code: 'nothing_to_publish',
    });

    const estado = await getOnboardingState(conta.tenantId);
    await saveProfessionals(conta.tenantId, estado!.locationId, [
      { name: 'Ruan', schedule: [] },
    ]);
    // Equipe sem jornada: a agenda nasceria vazia.
    await expect(publish(conta.tenantId)).rejects.toMatchObject({
      code: 'nothing_to_publish',
    });
  });

  it('publicar duas vezes não muda a data da primeira', async () => {
    const { tenantId } = await percorrer();
    const primeiro = await getOnboardingState(tenantId);
    const segundo = await publish(tenantId);
    expect(segundo.publishedAt).toBe(primeiro?.publishedAt);
  });

  it('renomear a barbearia não quebra o link antigo', async () => {
    // O concorrente trocou Box Seis por Domari e o slug antigo continua
    // resolvendo. É a única coisa que ele acertou e que não se pode perder.
    const { tenantId, slug } = await percorrer();

    await saveBusiness({ tenantId, name: 'Outro Nome Barbearia' });

    const antigo = await getPublicProfile(tenantId, slug);
    expect(antigo?.name).toBe('Outro Nome Barbearia');
    expect(antigo?.slug).toBe(slug);
  });

  it('salva a janela de cancelamento pela configuração, não por SQL', async () => {
    // Era lacuna declarada do bloco 9.
    const { tenantId, slug } = await percorrer();

    await saveChangeWindow(tenantId, {
      cancelMinHours: 4,
      rescheduleMinHours: 1,
      maxReschedules: 3,
      cancellationPolicy: 'Cancelamentos em cima da hora contam para o histórico.',
    });

    const perfil = await getPublicProfile(tenantId, slug);
    expect(perfil?.location.cancelMinHours).toBe(4);
    expect(perfil?.location.cancellationPolicy).toContain('histórico');
  });

  it('regravar o cardápio desativa o antigo em vez de apagar', async () => {
    // Agendamento antigo aponta para o serviço; apagar levaria junto o
    // histórico que alimenta relatório e comissão.
    const { tenantId } = await percorrer();

    await saveServices(tenantId, [
      { key: 'so-corte', name: 'Só corte', category: 'Cabelo', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 5000 },
    ]);

    const linhas = await admin.$queryRawUnsafe<{ active: boolean; count: bigint }[]>(
      'SELECT active, count(*) FROM services GROUP BY active ORDER BY active',
    );
    const inativos = linhas.find((l) => !l.active);
    expect(Number(inativos?.count ?? 0)).toBeGreaterThan(0);
  });

  it('uma barbearia não enxerga o onboarding da outra', async () => {
    const um = await cadastrar(CONTA);
    const dois = await cadastrar({
      ...CONTA,
      email: 'rival@rival.com',
      businessName: 'Rival',
    });

    await saveServices(um.tenantId, [
      { key: 'corte', name: 'Corte da Domari', category: 'Cabelo', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 4500 },
    ]);

    const estadoRival = await getOnboardingState(dois.tenantId);
    expect(estadoRival?.counts.services).toBe(0);
  });

  it('OnboardingError carrega o detalhe do que está errado', async () => {
    const conta = await cadastrar(CONTA);
    try {
      await saveServices(conta.tenantId, [
        { key: 'a', name: 'A', category: 'X', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 4000 },
        { key: 'c', name: 'C', category: 'X', durationMinutes: 10, bufferAfterMinutes: 5, priceCents: 3000, componentKeys: ['a'] },
      ]);
      throw new Error('deveria ter recusado');
    } catch (error) {
      // A tela precisa dizer **qual** combo está errado, não "dados inválidos".
      expect(error).toBeInstanceOf(OnboardingError);
      expect((error as OnboardingError).detail).toBeDefined();
    }
  });
});
