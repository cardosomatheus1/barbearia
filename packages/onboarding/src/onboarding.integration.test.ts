import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signUpOwner } from '@barbearia/identity';
import { getPublicProfile, loadDayContext } from '@barbearia/scheduling';
import { computeFromContext } from '@barbearia/scheduling';
import { withTenant } from '@barbearia/db';
import {
  getOnboardingState,
  getPhotoTargets,
  OnboardingError,
  publish,
  saveBusiness,
  saveChangeWindow,
  savePayments,
  savePhotos,
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
    const inicial = await getOnboardingState(conta.tenantId);
    if (!inicial) throw new Error('estado não encontrado');

    await saveBusiness({
      tenantId: conta.tenantId,
      locationId: inicial.locationId,
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

    await savePayments(conta.tenantId, estado.locationId, ['pix', 'card', 'cash']);
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

    const local = (await getOnboardingState(conta.tenantId))!.locationId;
    await saveBusiness({
      tenantId: conta.tenantId, locationId: local, name: 'Domari', city: 'Salvador',
    });
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(2);

    await savePayments(conta.tenantId, local, ['pix']);
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(5);

    // Voltar para corrigir o endereço não pode reabrir o cadastro inteiro.
    await saveBusiness({
      tenantId: conta.tenantId, locationId: local, name: 'Domari Barber Club',
    });
    expect((await getOnboardingState(conta.tenantId))?.step).toBe(5);

    /**
     * E não pode apagar o que não foi mandado (bloco 111).
     *
     * O formulário só manda o que ele mostra, e a etapa 2 mostrava o nome. Um
     * `?? null` do outro lado transformava "corrigir o nome" em apagar cidade,
     * endereço, telefone, Instagram e as comodidades — no cadastro mais básico
     * do produto, e sem nada ficar vermelho.
     */
    const cidade = await getOnboardingState(conta.tenantId);
    expect(cidade?.empresa.city).toBe('Salvador');
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

  it('salvar a empresa mexe numa loja só, não na rede', async () => {
    /**
     * O `UPDATE locations` não tinha `WHERE` nenhum.
     *
     * A filial de Rio Branco existe com o próprio fuso justamente porque "hoje"
     * lá é outro dia — e `orders.business_day` sai desse fuso. Um clique em
     * "Continuar" na etapa 2 renomeava a filial, mudava o endereço dela e o fuso
     * dela para os da matriz: o seletor do balcão ficava com duas linhas
     * idênticas, e o dia da venda da filial passava a ser calculado errado.
     */
    const { tenantId } = await percorrer();
    const filial = 'ffff0000-0000-0000-0000-00000000f111';
    await admin.$executeRawUnsafe(`
      INSERT INTO locations (id, tenant_id, name, timezone, city)
      VALUES ('${filial}', '${tenantId}', 'Domari Rio Branco', 'America/Rio_Branco', 'Rio Branco')
    `);

    const matriz = (await getOnboardingState(tenantId))!.locationId;
    await saveBusiness({
      tenantId,
      locationId: matriz,
      name: 'Domari Barber Club',
      city: 'Salvador',
      timezone: 'America/Bahia',
    });

    const depois = await admin.$queryRawUnsafe<{ name: string; timezone: string; city: string }[]>(
      `SELECT name, timezone, city FROM locations WHERE id = '${filial}'`,
    );
    expect(depois[0]).toMatchObject({
      name: 'Domari Rio Branco',
      timezone: 'America/Rio_Branco',
      city: 'Rio Branco',
    });
  });

  it('capa e equipe de fotos respeitam a unidade escolhida', async () => {
    const { tenantId } = await percorrer();
    const matriz = (await getOnboardingState(tenantId))!.locationId;
    const filial = 'ffff0000-0000-0000-0000-00000000f222';
    await admin.$executeRawUnsafe(`
      INSERT INTO locations (id, tenant_id, name, timezone, city, cover_url)
      VALUES ('${filial}', '${tenantId}', 'Domari Filial', 'America/Bahia', 'Salvador', '/media/${tenantId}/filial.webp')
    `);

    await savePhotos(tenantId, matriz, { coverUrl: `/media/${tenantId}/matriz.webp` });

    const fotosDaMatriz = await getPhotoTargets(tenantId, matriz);
    const fotosDaFilial = await getPhotoTargets(tenantId, filial);
    expect(fotosDaMatriz?.coverUrl).toBe(`/media/${tenantId}/matriz.webp`);
    expect(fotosDaFilial?.coverUrl).toBe(`/media/${tenantId}/filial.webp`);

    // A equipe criada no onboarding pertence à matriz e não pode aparecer como
    // alvo editável quando o balcão troca para a filial.
    expect(fotosDaMatriz?.professionals.length).toBeGreaterThan(0);
    expect(fotosDaFilial?.professionals).toEqual([]);
  });

  it('a unidade de outra barbearia não é editável nem com o id na mão', async () => {
    // A RLS já barra, e o `WHERE id` é a segunda camada: o `UPDATE` alcança
    // zero linhas e o domínio recusa em vez de responder "salvo".
    const { tenantId } = await percorrer();
    const outra = await cadastrar({ ...CONTA, email: 'vizinha@teste.com.br' });
    const dela = (await getOnboardingState(outra.tenantId))!.locationId;

    await expect(
      saveBusiness({ tenantId, locationId: dela, name: 'Invadida' }),
    ).rejects.toMatchObject({ code: 'location_not_found' });
  });

  it('depois de publicada, a etapa que substitui o catálogo recusa', async () => {
    /**
     * As etapas 3 e 4 trocam o cardápio e a equipe inteiros — certo para quem
     * está montando, destruição a partir do dia seguinte: `appointment_services`
     * aponta para `services.id`, e recriar o catálogo desfaz o vínculo com o que
     * já foi vendido. `?e=3` continua sendo um endereço, e ele fica no
     * autocompletar do navegador de quem fez o cadastro uma vez.
     */
    const { tenantId } = await percorrer();
    const templates = templatesForOnboarding();

    await expect(
      saveServices(
        tenantId,
        templates.slice(0, 1).map((t) => ({
          key: t.key, name: t.name, description: t.description, category: t.category,
          durationMinutes: t.durationMinutes, bufferAfterMinutes: t.bufferAfterMinutes,
          priceCents: t.priceCents,
        })),
      ),
    ).rejects.toMatchObject({ code: 'ja_publicada' });

    const local = (await getOnboardingState(tenantId))!.locationId;
    await expect(
      saveProfessionals(tenantId, local, [{ name: 'Substituto', schedule: JORNADA }]),
    ).rejects.toMatchObject({ code: 'ja_publicada' });

    // E o cardápio continua de pé: a recusa é antes do `UPDATE ... active = false`.
    const vivos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM services WHERE tenant_id = '${tenantId}' AND active`,
    );
    expect(Number(vivos[0]?.n)).toBe(templates.length);
  });

  it('o link do mapa colado vira a coordenada que põe a casa na busca', async () => {
    /**
     * O bloco 115 fecha a lacuna que tornava o marketplace inalcançável:
     * `atualizarVitrine` delista quem não tem coordenada, `saveBusiness` era o
     * único caminho que a escrevia, e o formulário não tinha o campo. A casa
     * lia "sua barbearia aparece na busca" enquanto `/buscar` respondia
     * "nenhuma barbearia publicada ainda".
     *
     * Latitude crua seria campo que ninguém preenche; geocodificar exige conta
     * contratada. Colar o link do mapa todo mundo sabe fazer.
     */
    const { tenantId } = await percorrer();
    const local = (await getOnboardingState(tenantId))!.locationId;

    await saveBusiness({
      tenantId,
      locationId: local,
      name: 'Domari Barber Club',
      linkDoMapa: 'https://www.google.com/maps/place/Domari/@-12.9850,-38.4720,17z/data=!3m1',
    });

    const depois = await admin.$queryRawUnsafe<{ latitude: string; longitude: string }[]>(
      `SELECT latitude, longitude FROM locations WHERE id = '${local}'`,
    );
    expect(Number(depois[0]?.latitude)).toBeCloseTo(-12.985, 4);
    expect(Number(depois[0]?.longitude)).toBeCloseTo(-38.472, 4);
  });

  it('sem link, a UF põe a casa no centro da capital — e sem UF ela fica de fora', async () => {
    /**
     * O centro da capital serve à busca por cidade, não à navegação: quem
     * procura barbearia em Recife encontra a de Recife. Sem UF nenhuma, a casa
     * fica **sem** coordenada de propósito — um ponto chutado a poria no mapa
     * no lugar errado, e quem busca por raio receberia o que não serve.
     */
    const conta = await cadastrar({ ...CONTA, email: 'semlink@teste.com.br' });
    const local = (await getOnboardingState(conta.tenantId))!.locationId;

    await saveBusiness({
      tenantId: conta.tenantId, locationId: local, name: 'Sem Link', state: 'PE',
    });
    const comUf = await admin.$queryRawUnsafe<{ latitude: string | null }[]>(
      `SELECT latitude FROM locations WHERE id = '${local}'`,
    );
    expect(Number(comUf[0]?.latitude)).toBeCloseTo(-8.0476, 3);

    const outra = await cadastrar({ ...CONTA, email: 'semuf@teste.com.br' });
    const dela = (await getOnboardingState(outra.tenantId))!.locationId;
    await saveBusiness({ tenantId: outra.tenantId, locationId: dela, name: 'Sem UF' });
    const semUf = await admin.$queryRawUnsafe<{ latitude: string | null }[]>(
      `SELECT latitude FROM locations WHERE id = '${dela}'`,
    );
    expect(semUf[0]?.latitude).toBeNull();
  });

  it('corrigir o telefone não tira a barbearia do mapa', async () => {
    // A coordenada segue a regra dos vizinhos: ausente é "não mexa". Um `?? null`
    // aqui faria uma edição sem relação apagar o ponto e delistar a casa da
    // busca, em silêncio.
    const { tenantId } = await percorrer();
    const local = (await getOnboardingState(tenantId))!.locationId;

    await saveBusiness({
      tenantId, locationId: local, name: 'Domari Barber Club',
      linkDoMapa: 'https://www.google.com/maps/@-12.9850,-38.4720,17z',
    });
    await saveBusiness({
      tenantId, locationId: local, name: 'Domari Barber Club', phone: '+557133334444',
    });

    const depois = await admin.$queryRawUnsafe<{ latitude: string | null }[]>(
      `SELECT latitude FROM locations WHERE id = '${local}'`,
    );
    expect(Number(depois[0]?.latitude)).toBeCloseTo(-12.985, 4);
  });

  it('renomear a barbearia não quebra o link antigo', async () => {
    // O concorrente trocou Box Seis por Domari e o slug antigo continua
    // resolvendo. É a única coisa que ele acertou e que não se pode perder.
    const { tenantId, slug } = await percorrer();

    const local = (await getOnboardingState(tenantId))!.locationId;
    await saveBusiness({ tenantId, locationId: local, name: 'Outro Nome Barbearia' });

    const antigo = await getPublicProfile(tenantId, slug);
    expect(antigo?.name).toBe('Outro Nome Barbearia');
    expect(antigo?.slug).toBe(slug);
  });

  it('salva a janela de cancelamento pela configuração, não por SQL', async () => {
    // Era lacuna declarada do bloco 9.
    const { tenantId, slug } = await percorrer();

    await saveChangeWindow(tenantId, (await getOnboardingState(tenantId))!.locationId, {
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
    /**
     * Agendamento antigo aponta para o serviço; apagar levaria junto o
     * histórico que alimenta relatório e comissão.
     *
     * Sem publicar, de propósito: desde o bloco 111 a etapa recusa depois de a
     * casa estar no ar, e é justamente porque ela **substitui** o conjunto —
     * que é o que este teste descreve. Ela continua sendo o caminho de quem
     * ainda está montando, e é esse caminho que se prova aqui.
     */
    const conta = await cadastrar(CONTA);
    const tenantId = conta.tenantId;
    const templates = templatesForOnboarding();
    await saveServices(
      tenantId,
      templates.map((t) => ({
        key: t.key, name: t.name, description: t.description, category: t.category,
        durationMinutes: t.durationMinutes, bufferAfterMinutes: t.bufferAfterMinutes,
        priceCents: t.priceCents,
        ...(t.componentKeys ? { componentKeys: t.componentKeys } : {}),
      })),
    );

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
