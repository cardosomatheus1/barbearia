import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import {
  assinar,
  assinaturaDoCliente,
  assinaturaQueCobre,
  cancelarAssinatura,
  clubeDaCasa,
  dependentes,
  incluirDependente,
  planos,
  removerDependente,
  salvarPlano,
  usoDisponivel,
} from './assinatura.js';

/**
 * O clube de assinatura contra Postgres real (bloco 45).
 *
 * O que só o banco prova: que uma pessoa não tem duas assinaturas vivas, que o
 * uso é append-only, que a cota e o cooldown seguram de verdade dentro da
 * transação que fecha a comanda, e que o preço congelado na adesão não muda
 * quando o plano muda.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '45454545-1111-1111-1111-111111111111';
const RIVAL = '45454545-2222-2222-2222-222222222222';
const LOCAL = 'a4545454-0000-0000-0000-000000000001';
const CARLOS = 'c4545454-0000-0000-0000-000000000001';
const BRUNO = 'c4545454-0000-0000-0000-000000000002';
const DONO = 'd4545454-0000-0000-0000-000000000001';
const RUAN = 'e4545454-0000-0000-0000-000000000001';
const CORTE = 'f4545454-0000-0000-0000-000000000001';
const BARBA = 'f4545454-0000-0000-0000-000000000002';

const HOJE = '2026-11-15';
const AGORA = new Date('2026-11-15T12:00:00Z');
const ator = { id: DONO, name: 'Matheus' };
const operador = { staffId: DONO, staffName: 'Matheus' };
const fecha = { ...operador, hojeNaUnidade: HOJE, agora: AGORA };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const novoPlano = (extra: Partial<Parameters<typeof salvarPlano>[0]> = {}) =>
  salvarPlano({
    tenantId: TENANT,
    nome: 'Premium',
    precoCents: 14_900,
    descontoEmProdutoBps: 1000,
    ativo: true,
    beneficios: [{ serviceId: CORTE, quantidade: 2, cooldownDias: 0 }],
    ator,
    ...extra,
  });

/** Um corte fechado pelo plano, como o balcão faz. */
async function usarPlano(cliente = CARLOS, servico = CORTE, preco = 6000): Promise<void> {
  const aberta = await abrirComanda({
    tenantId: TENANT, locationId: LOCAL, customerId: cliente, staffId: DONO,
  });
  await adicionarItem({
    tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
    serviceId: servico, descricao: 'Corte', quantidade: 1, precoUnitarioCents: preco,
    professionalId: RUAN, ...operador,
  });
  await fecharComanda({
    tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
    pagamentos: [{ forma: 'assinatura', valorCents: preco }],
    servicoDaAssinatura: servico,
    ...fecha,
  });
}

describeIfDb('clube de assinatura', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CORTE}', '${TENANT}', 'Corte', 6000, 30),
        ('${BARBA}', '${TENANT}', 'Barba', 5500, 25);
    `);
    await abrirCaixa({
      tenantId: TENANT, locationId: LOCAL, openingCents: 10_000, ...operador,
    });
  });

  // -- o plano -----------------------------------------------------------------

  it('o plano nasce com os benefícios que ele dá', async () => {
    await novoPlano();
    const lista = await planos(TENANT);
    expect(lista[0]).toMatchObject({ nome: 'Premium', precoCents: 14_900, assinantes: 0 });
    expect(lista[0]?.beneficios[0]).toMatchObject({
      servicoNome: 'Corte', quantidade: 2, cooldownDias: 0,
    });
  });

  it('serviço de outra barbearia não vira benefício aqui', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o id, e o plano nasceria dando um corte que
     * esta casa não vende.
     */
    const alheio = 'f4545454-9999-0000-0000-000000000001';
    await exec(`
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${alheio}', '${RIVAL}', 'Corte da vizinha', 5000, 30);
    `);
    await expect(
      novoPlano({ beneficios: [{ serviceId: alheio, quantidade: 1, cooldownDias: 0 }] }),
    ).rejects.toMatchObject({ code: 'servico_nao_encontrado' });
  });

  // -- a adesão ----------------------------------------------------------------

  it('assinar congela o preço do plano', async () => {
    /**
     * A barbearia sobe o Premium de R$ 149 para R$ 169 em março, e quem assinou
     * em janeiro continua pagando R$ 149. Recalcular na leitura faria o MRR de
     * um mês fechado mudar sozinho.
     */
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    await salvarPlano({
      tenantId: TENANT, id: planoId, nome: 'Premium', precoCents: 16_900,
      descontoEmProdutoBps: 1000, ativo: true,
      beneficios: [{ serviceId: CORTE, quantidade: 2, cooldownDias: 0 }], ator,
    });

    const dele = await assinaturaDoCliente(TENANT, CARLOS, AGORA);
    expect(dele?.precoCents).toBe(14_900);
  });

  it('uma assinatura viva por cliente', async () => {
    // Duas fariam a cota de cada uma ser contada em separado e a grade oferecer
    // o dobro — e no balcão ninguém saberia qual está sendo usada.
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });
    await expect(
      assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA }),
    ).rejects.toMatchObject({ code: 'ja_assina' });
  });

  it('cancelar libera para assinar de novo', async () => {
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await cancelarAssinatura({
      tenantId: TENANT, assinaturaId: id, motivo: 'trocou de plano', ator, agora: AGORA,
    });
    await expect(
      assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('o cliente não cancela a assinatura de outro', async () => {
    /**
     * A RLS separa barbearias e não separa clientes dentro de uma: sem o filtro
     * por `customer_id`, um id vazado bastaria para cancelar a assinatura alheia.
     */
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await expect(
      cancelarAssinatura({
        tenantId: TENANT, assinaturaId: id, motivo: 'nao quero mais', ator,
        customerId: BRUNO, agora: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'assinatura_nao_encontrada' });
  });

  // -- o uso, na comanda -------------------------------------------------------

  it('usar o plano gasta a cota na mesma transação que fecha a comanda', async () => {
    /**
     * Fora dela, a comanda fecharia com o corte quitado e a cota continuaria
     * cheia — corte ilimitado de graça, um por comanda.
     */
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    await usarPlano();

    const dele = await assinaturaDoCliente(TENANT, CARLOS, AGORA);
    expect(dele?.beneficios[0]).toMatchObject({ usados: 1 });
  });

  it('a cota do ciclo acaba', async () => {
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    await usarPlano();
    await usarPlano();

    await expect(usarPlano()).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('o cooldown segura o segundo corte', async () => {
    // Sem o intervalo, "ilimitado" é prejuízo garantido no primeiro assinante
    // entusiasmado.
    const { id: planoId } = await novoPlano({
      beneficios: [{ serviceId: CORTE, quantidade: null, cooldownDias: 7 }],
    });
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    await usarPlano();
    await expect(usarPlano()).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('o plano de corte não paga uma barba', async () => {
    /**
     * Os valores poderiam bater, o domínio aceitaria, e o cliente perderia um
     * corte que pagou na mensalidade. É a mesma lição do pacote no bloco 42.
     */
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: BARBA, descricao: 'Barba', quantidade: 1, precoUnitarioCents: 5500,
      professionalId: RUAN, ...operador,
    });
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
        pagamentos: [{ forma: 'assinatura', valorCents: 5500 }],
        servicoDaAssinatura: CORTE, ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('quem não assina não paga com assinatura', async () => {
    await novoPlano();
    const disponivel = await usoDisponivel({
      tenantId: TENANT, customerId: BRUNO, serviceId: CORTE, precoCents: 6000, agora: AGORA,
    });
    expect(disponivel).toBeNull();
  });

  it('assinatura suspensa não usa; inadimplente usa', async () => {
    /**
     * *"Suspensão de benefício é gradual e avisada — cortar o acesso no primeiro
     * erro de cartão gera cancelamento por raiva, não por preço."* SPEC §4.6.
     */
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });

    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE club_subscriptions SET status = 'inadimplente' WHERE id = ${id}::uuid`,
    );
    await expect(usarPlano()).resolves.toBeUndefined();

    await withTenant(TENANT, (tx) =>
      // `suspended_at` junto: desde o bloco 47 a `CHECK` do banco exige coerência
      // — suspensão sem data seria um benefício cortado sem "desde quando".
      tx.$executeRaw`
        UPDATE club_subscriptions SET status = 'suspensa', suspended_at = now()
         WHERE id = ${id}::uuid
      `,
    );
    await expect(usarPlano()).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('o uso é append-only', async () => {
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });
    await usarPlano();

    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM club_uses`),
    ).rejects.toThrow();
    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`UPDATE club_uses SET value_cents = 0`),
    ).rejects.toThrow();
  });

  // -- o MRR da barbearia ------------------------------------------------------

  it('o MRR do clube é o que os clientes pagam à barbearia', async () => {
    /**
     * É o outro MRR da SPEC §8, declarado como lacuna no bloco 29 — aquele é o
     * que a barbearia paga a nós.
     */
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });
    await assinar({ tenantId: TENANT, customerId: BRUNO, planId: planoId, ator, agora: AGORA });

    const clube = await clubeDaCasa(TENANT);
    expect(clube).toMatchObject({ mrrCents: 29_800, ativas: 2, inadimplentes: 0 });
    expect(clube.porPlano[0]).toMatchObject({ nome: 'Premium', assinantes: 2 });
  });

  it('cancelada sai do MRR; inadimplente fica', async () => {
    const { id: planoId } = await novoPlano();
    const a = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    const b = await assinar({
      tenantId: TENANT, customerId: BRUNO, planId: planoId, ator, agora: AGORA,
    });

    await cancelarAssinatura({
      tenantId: TENANT, assinaturaId: a.id, motivo: 'foi embora', ator, agora: AGORA,
    });
    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE club_subscriptions SET status = 'inadimplente' WHERE id = ${b.id}::uuid`,
    );

    expect(await clubeDaCasa(TENANT)).toMatchObject({
      mrrCents: 14_900, ativas: 1, inadimplentes: 1,
    });
  });

  it('a vizinha não vê o clube desta casa', async () => {
    const { id: planoId } = await novoPlano();
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    expect(await planos(RIVAL, true)).toEqual([]);
    expect(await clubeDaCasa(RIVAL)).toMatchObject({ mrrCents: 0, ativas: 0 });
  });

  it('o cooldown atravessa a virada do ciclo', async () => {
    /**
     * Achado durante o bloco: a primeira versão sintetizava os usos a partir da
     * contagem **do ciclo**, e o cooldown sumia toda vez que o mês virava entre
     * dois cortes. Quem cortou no dia 28 cortava de novo no dia 30.
     */
    const { id: planoId } = await novoPlano({
      beneficios: [{ serviceId: CORTE, quantidade: null, cooldownDias: 7 }],
    });
    // Adesão no dia 1º: o ciclo vira no dia 1º de cada mês.
    const adesao = new Date('2026-10-01T10:00:00Z');
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: adesao });

    // Um corte no dia 30 de outubro — véspera da virada.
    const fimDeOutubro = new Date('2026-10-30T12:00:00Z');
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'assinatura', valorCents: 6000 }],
      servicoDaAssinatura: CORTE, ...operador,
      hojeNaUnidade: '2026-10-30', agora: fimDeOutubro,
    });

    // No dia 2 de novembro o ciclo já virou e a contagem zerou — mas faltam
    // cinco dias para o intervalo fechar.
    const doisDeNovembro = new Date('2026-11-02T12:00:00Z');
    const dele = await assinaturaDoCliente(TENANT, CARLOS, doisDeNovembro);
    expect(dele?.beneficios[0]).toMatchObject({ usados: 0 });

    const disponivel = await usoDisponivel({
      tenantId: TENANT, customerId: CARLOS, serviceId: CORTE,
      precoCents: 6000, agora: doisDeNovembro,
    });
    expect(disponivel).toMatchObject({ recusa: 'dentro_do_cooldown' });
  });


  // -- restrição de horário, dependentes e antecedência (bloco 46) --------------

  it('o plano não vale no horário de pico bloqueado', async () => {
    /**
     * *"Assinante do plano Essencial pode não ter acesso a sábado 09:00–13:00, o
     * horário mais disputado."* Sem a restrição, o plano barato ocupa a hora que
     * a casa vende cheia — e o clube passa a substituir receita em vez de somar.
     */
    const { id: planoId } = await novoPlano({
      bloqueios: [{ diaDaSemana: 6, inicio: 540, fim: 780 }],
    });
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    const noPico = await usoDisponivel({
      tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, precoCents: 6000,
      agora: AGORA, quandoLocal: { diaDaSemana: 6, minuto: 600 },
    });
    expect(noPico).toMatchObject({ recusa: 'fora_do_horario_do_plano' });

    // E à tarde do mesmo sábado, vale.
    const aTarde = await usoDisponivel({
      tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, precoCents: 6000,
      agora: AGORA, quandoLocal: { diaDaSemana: 6, minuto: 900 },
    });
    expect(aTarde).toMatchObject({ subscriptionId: expect.any(String) });
  });

  it('sem o horário, a restrição não barra o balcão', async () => {
    /**
     * O balcão fecha o que **já aconteceu**: barrar ali seria punir o cliente por
     * um horário que a própria casa concedeu.
     */
    const { id: planoId } = await novoPlano({
      bloqueios: [{ diaDaSemana: 6, inicio: 540, fim: 780 }],
    });
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    const semHorario = await usoDisponivel({
      tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, precoCents: 6000, agora: AGORA,
    });
    expect(semHorario).toMatchObject({ subscriptionId: expect.any(String) });
  });

  it('o dependente usa a cota do titular', async () => {
    /**
     * É o plano família da SPEC §4.6: *"cada dependente é cliente próprio, com
     * agenda e histórico, consumindo da mesma cota"*. Sem isto, o filho no plano
     * do pai pagaria o corte inteiro — e a família descobriria que "plano
     * família" não incluía a família.
     */
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await incluirDependente({
      tenantId: TENANT, subscriptionId: id, customerId: BRUNO, ator,
    });

    const cobre = await assinaturaQueCobre(TENANT, BRUNO);
    expect(cobre).toMatchObject({ subscriptionId: id, titularId: CARLOS });

    // E o uso dele gasta a cota da família, não uma cota própria.
    await usarPlano(BRUNO);
    const doTitular = await assinaturaDoCliente(TENANT, CARLOS, AGORA);
    expect(doTitular?.beneficios[0]).toMatchObject({ usados: 1 });
  });

  it('o extrato da família diz quem usou', async () => {
    // "3 de 5 usados" numa família de quatro é um número que ninguém confere.
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await incluirDependente({ tenantId: TENANT, subscriptionId: id, customerId: BRUNO, ator });
    await usarPlano(BRUNO);

    const dele = await assinaturaDoCliente(TENANT, CARLOS, AGORA);
    const lista = await dependentes(
      TENANT, id, new Date(dele!.cicloDe), new Date(dele!.cicloAte),
    );
    expect(lista).toEqual([{ customerId: BRUNO, nome: 'Bruno Lima', usosNoCiclo: 1 }]);
  });

  it('o titular não é dependente de si mesmo', async () => {
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await expect(
      incluirDependente({ tenantId: TENANT, subscriptionId: id, customerId: CARLOS, ator }),
    ).rejects.toMatchObject({ code: 'e_o_titular' });
  });

  it('ninguém é dependente de duas assinaturas', async () => {
    // A mesma cota seria descontada de dois lugares, e no balcão ninguém saberia
    // de qual plano o corte saiu.
    const { id: planoId } = await novoPlano();
    const primeira = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await incluirDependente({
      tenantId: TENANT, subscriptionId: primeira.id, customerId: BRUNO, ator,
    });

    const TERCEIRO = 'c4545454-0000-0000-0000-000000000003';
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${TERCEIRO}', '${TENANT}', 'Ana Paula', '+5571966665555');
    `);
    const segunda = await assinar({
      tenantId: TENANT, customerId: TERCEIRO, planId: planoId, ator, agora: AGORA,
    });

    await expect(
      incluirDependente({ tenantId: TENANT, subscriptionId: segunda.id, customerId: BRUNO, ator }),
    ).rejects.toMatchObject({ code: 'ja_e_dependente' });
  });

  it('remover o dependente tira a cobertura dele', async () => {
    const { id: planoId } = await novoPlano();
    const { id } = await assinar({
      tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA,
    });
    await incluirDependente({ tenantId: TENANT, subscriptionId: id, customerId: BRUNO, ator });
    await removerDependente({ tenantId: TENANT, subscriptionId: id, customerId: BRUNO, ator });

    expect(await assinaturaQueCobre(TENANT, BRUNO)).toBeNull();
  });

  it('a janela de antecedência maior fica no plano', async () => {
    const { id: planoId } = await novoPlano({ janelaDeAgendamentoDias: 60 });
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: planoId, ator, agora: AGORA });

    const dele = await assinaturaDoCliente(TENANT, CARLOS, AGORA);
    expect(dele?.janelaDeAgendamentoDias).toBe(60);
  });

});
