import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  abrirCaixa,
  caixaAberto,
  fecharCaixaDaUnidade,
  movimentarCaixa,
} from './caixa.js';
import {
  abrirComanda,
  adicionarItem,
  ajustarComanda,
  faturamentoDoDia,
  fecharComanda,
  getComanda,
  removerItem,
  quemEstaDevendo,
  receberFiado,
} from './comanda.js';

/**
 * Comanda, caixa e fiado contra Postgres real.
 *
 * Aqui é dinheiro: mock não prova que a gaveta bate, que a dívida tem extrato e
 * que as cinco tabelas do fechamento andam juntas ou não andam.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const STAFF = 'ffffffff-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
// A data que o controller passa: o dia da unidade, não o do servidor.
const HOJE = '2026-09-10';
const fecha = { ...operador, hojeNaUnidade: HOJE };

describeIfDb('comanda, caixa e fiado', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
             ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164, credit_limit_cents)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', 10000);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
  });

  const abrir = () =>
    abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 20000, ...operador });

  const comanda = () =>
    abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });

  const comItem = async (precoUnitarioCents = 7000) => {
    const aberta = await comanda();
    return adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'service',
      serviceId: CABELO,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents,
      professionalId: RUAN,
    });
  };

  // -- caixa ------------------------------------------------------------------

  it('abre o caixa com o troco contado, e a abertura é um movimento', async () => {
    await abrir();
    const sessao = await caixaAberto(TENANT, LOCATION);

    expect(sessao?.openingCents).toBe(20000);
    expect(sessao?.esperadoAgoraCents).toBe(20000);
    expect(sessao?.movimentos).toHaveLength(1);
    expect(sessao?.openedByName).toBe('Maria Recepção');
  });

  it('não abre dois caixas na mesma unidade', async () => {
    await abrir();
    await expect(abrir()).rejects.toMatchObject({ code: 'ja_aberto' });
  });

  it('sangria não tira mais do que existe na gaveta', async () => {
    await abrir();
    await expect(
      movimentarCaixa({
        tenantId: TENANT,
        locationId: LOCATION,
        kind: 'withdrawal',
        amountCents: 50000,
        reason: 'Banco',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'sangria_maior_que_a_gaveta' });
  });

  it('sangria e suprimento mexem no esperado nos dois sentidos', async () => {
    await abrir();
    await movimentarCaixa({
      tenantId: TENANT, locationId: LOCATION, kind: 'withdrawal',
      amountCents: 15000, reason: 'Banco', ...operador,
    });
    await movimentarCaixa({
      tenantId: TENANT, locationId: LOCATION, kind: 'supply',
      amountCents: 5000, reason: 'Troco', ...operador,
    });

    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(10000);
  });

  /**
   * O toque duplo na sangria (bloco 103).
   *
   * Reproduzido contra a API viva antes do conserto: dois envios do mesmo
   * formulário deixaram duas linhas de R$ 100 com 23 ms de diferença.
   * `cash_movements` é append-only por REVOKE — não havia desfazer, e a segunda
   * virava divergência do fechamento cego com o nome do operador e sem causa.
   *
   * A semente satisfaz **tudo menos** a regra sob teste: o caixa está aberto,
   * há dinheiro na gaveta, e os dois envios são idênticos e válidos. O que
   * separa um do outro é só a chave.
   */
  it('a mesma chave não tira duas vezes da gaveta', async () => {
    await abrir();
    const chave = 'recepcao-1:sangria-abc';
    for (const _ of [1, 2]) {
      await movimentarCaixa({
        tenantId: TENANT, locationId: LOCATION, kind: 'withdrawal',
        amountCents: 10000, reason: 'Banco', idempotencyKey: chave, ...operador,
      });
    }
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(10000);
  });

  it('duas sangrias iguais com chaves diferentes são duas sangrias', async () => {
    /**
     * O outro lado, e é ele que impede o conserto de virar defeito: R$ 100 de
     * manhã e R$ 100 à tarde acontecem, e uma chave derivada do conteúdo faria
     * a segunda ser engolida como repetição.
     */
    await abrir();
    for (const chave of ['recepcao-1:manha', 'recepcao-1:tarde']) {
      await movimentarCaixa({
        tenantId: TENANT, locationId: LOCATION, kind: 'withdrawal',
        amountCents: 5000, reason: 'Banco', idempotencyKey: chave, ...operador,
      });
    }
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(10000);
  });

  it('fecha registrando a divergência, inclusive quando bate', async () => {
    await abrir();
    const fechado = await fecharCaixaDaUnidade({
      tenantId: TENANT, locationId: LOCATION, countedCents: 20000, ...operador,
    });

    expect(fechado).toEqual({
      esperadoCents: 20000,
      contadoCents: 20000,
      divergenciaCents: 0,
    });
    expect(await caixaAberto(TENANT, LOCATION)).toBeNull();
  });

  it('falta na gaveta vira divergência negativa gravada', async () => {
    await abrir();
    const fechado = await fecharCaixaDaUnidade({
      tenantId: TENANT, locationId: LOCATION, countedCents: 19500, ...operador,
    });
    expect(fechado.divergenciaCents).toBe(-500);

    const guardado = await admin.$queryRawUnsafe<{ difference_cents: number }[]>(
      `SELECT difference_cents FROM cash_sessions WHERE tenant_id = '${TENANT}'`,
    );
    expect(guardado[0]?.difference_cents).toBe(-500);
  });

  // -- comanda ----------------------------------------------------------------

  it('a comanda nasce pré-preenchida com os serviços do agendamento', async () => {
    // A SPEC §3.1 pede isso, e a razão é o preço: redigitar é como o cobrado
    // passa a divergir do combinado.
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
      VALUES ('dddddddd-0000-0000-0000-000000000001', '${TENANT}', '${LOCATION}',
              '${CARLOS}', '${RUAN}',
              '2026-08-14T12:00:00Z', '2026-08-14T12:30:00Z',
              '2026-08-14T12:00:00Z', '2026-08-14T12:30:00Z', 4900);

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000001', '${CABELO}', '${TENANT}', 0, 4900, 30);
    `);

    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      appointmentId: 'dddddddd-0000-0000-0000-000000000001',
      staffId: STAFF,
    });

    expect(aberta.itens).toHaveLength(1);
    expect(aberta.itens[0]).toMatchObject({ descricao: 'Cabelo', precoUnitarioCents: 4900 });
    expect(aberta.itens[0]?.professionalId).toBe(RUAN);
    expect(aberta.customerId).toBe(CARLOS);
    expect(aberta.totalCents).toBe(4900);
  });

  it('abrir a comanda do mesmo atendimento duas vezes devolve a mesma comanda', async () => {
    /**
     * O balcão abre a comanda quando o corte começa, atende o telefone e volta
     * pela lista de "Cobrar" — que mostra a mesma pessoa com o mesmo botão.
     *
     * Antes desta regra o segundo pedido esbarrava em
     * `orders_uma_aberta_por_agendamento` e virava 500: a tela dizia "tente de
     * novo" e tentar de novo dava o mesmo erro para sempre. A comanda existia e
     * não havia caminho até ela.
     *
     * Chaves de idempotência **diferentes** de propósito: é o que acontece de
     * verdade, porque cada tela gera a sua. Quem identifica a comanda aqui é o
     * atendimento.
     */
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
      VALUES ('dddddddd-0000-0000-0000-000000000003', '${TENANT}', '${LOCATION}',
              '${CARLOS}', '${RUAN}',
              '2026-08-15T12:00:00Z', '2026-08-15T12:30:00Z',
              '2026-08-15T12:00:00Z', '2026-08-15T12:30:00Z', 4900);

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000003', '${CABELO}', '${TENANT}', 0, 4900, 30);
    `);

    const pedir = (chave: string) =>
      abrirComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        appointmentId: 'dddddddd-0000-0000-0000-000000000003',
        staffId: STAFF,
        idempotencyKey: chave,
      });

    const primeira = await pedir('maria:1');
    const item = await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: primeira.id,
      tipo: 'product', descricao: 'Pomada', quantidade: 1,
      precoUnitarioCents: 4500, professionalId: RUAN,
    });
    expect(item.subtotalCents).toBe(4900 + 4500);

    const segunda = await pedir('joao:1');

    expect(segunda.id).toBe(primeira.id);
    // Devolve o **estado atual**, não uma cópia do que foi aberto: a pomada
    // lançada no meio tem que aparecer, senão a segunda tela cobra menos.
    expect(segunda.subtotalCents).toBe(4900 + 4500);
    expect(segunda.itens).toHaveLength(2);

    const quantas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM orders
        WHERE appointment_id = 'dddddddd-0000-0000-0000-000000000003'`,
    );
    expect(Number(quantas[0]?.n)).toBe(1);
  });

  it('duas aberturas simultâneas do mesmo atendimento não viram erro', async () => {
    // Caminho triste de concorrência: as duas passam juntas pela consulta e a
    // segunda esbarra no índice. A transação morre no Postgres, então a leitura
    // de recuperação precisa ser numa transação nova — e é isso que se prova.
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
      VALUES ('dddddddd-0000-0000-0000-000000000004', '${TENANT}', '${LOCATION}',
              '${CARLOS}', '${RUAN}',
              '2026-08-16T12:00:00Z', '2026-08-16T12:30:00Z',
              '2026-08-16T12:00:00Z', '2026-08-16T12:30:00Z', 4900);

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000004', '${CABELO}', '${TENANT}', 0, 4900, 30);
    `);

    const pedir = (chave: string) =>
      abrirComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        appointmentId: 'dddddddd-0000-0000-0000-000000000004',
        staffId: STAFF,
        idempotencyKey: chave,
      });

    const [a, b] = await Promise.all([pedir('maria:2'), pedir('joao:2')]);

    expect(a.id).toBe(b.id);
    const quantas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM orders
        WHERE appointment_id = 'dddddddd-0000-0000-0000-000000000004'`,
    );
    expect(Number(quantas[0]?.n)).toBe(1);
  });

  it('o preço vem do que foi combinado na reserva, não do catálogo de hoje', async () => {
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('dddddddd-0000-0000-0000-000000000002', '${TENANT}', '${LOCATION}',
              '${CARLOS}', '${RUAN}',
              '2026-08-14T12:00:00Z', '2026-08-14T12:30:00Z',
              '2026-08-14T12:00:00Z', '2026-08-14T12:30:00Z');

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000002', '${CABELO}', '${TENANT}', 0, 4900, 30);

      -- Reajuste depois da reserva.
      UPDATE services SET price_cents = 7900 WHERE id = '${CABELO}';
    `);

    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      appointmentId: 'dddddddd-0000-0000-0000-000000000002',
      staffId: STAFF,
    });

    expect(aberta.itens[0]?.precoUnitarioCents).toBe(4900);
  });

  it('item adicional soma, e o executor fica no item', async () => {
    const com = await comItem(4900);
    const depois = await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      tipo: 'product', descricao: 'Pomada', quantidade: 2,
      precoUnitarioCents: 4500, professionalId: RUAN,
    });

    expect(depois.subtotalCents).toBe(4900 + 9000);
    expect(depois.itens[1]?.professionalId).toBe(RUAN);
  });

  it('desconto percentual vira centavos na hora de gravar', async () => {
    // Guardar "10%" faria o desconto do passado mudar quando alguém
    // acrescentasse um item — e a conta que o cliente já viu mudaria sozinha.
    const com = await comItem(10000);
    const ajustada = await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: com.id,
      desconto: { tipo: 'percent', valor: 10, motivo: 'Cliente antigo' },
      ...operador,
    });

    expect(ajustada.descontoCents).toBe(1000);
    expect(ajustada.totalCents).toBe(9000);

    const depois = await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      tipo: 'product', descricao: 'Pomada', quantidade: 1, precoUnitarioCents: 5000,
    });
    // O desconto continua R$ 10, não vira R$ 15.
    expect(depois.descontoCents).toBe(1000);
  });

  /**
   * O teto do desconto (bloco 30).
   *
   * Permissão diz *quem* pode descontar; o teto diz *quanto*. Sem ele,
   * conceder `finance.discount` à recepção seria conceder estorno com outro
   * nome — 100% de desconto zera a conta.
   */
  it('desconto acima do teto da barbearia é recusado, e o teto vem do banco', async () => {
    const com = await comItem(10000);

    // O padrão da migração 0032 é 20%: R$ 25 numa conta de R$ 100 não passa.
    await expect(
      ajustarComanda({
        locationId: LOCATION,
        tenantId: TENANT, orderId: com.id,
        desconto: { tipo: 'amount', valor: 2500, motivo: 'exagerado' },
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'desconto_acima_do_teto' });

    // R$ 20 passa, e o desconto anterior continua zero: a recusa não gravou.
    const dentro = await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: com.id,
      desconto: { tipo: 'amount', valor: 2000, motivo: 'no limite' },
      ...operador,
    });
    expect(dentro.descontoCents).toBe(2000);
  });

  it('o teto vale para percentual também, porque a conta é em centavos', async () => {
    // 100% e "R$ 100 numa conta de R$ 100" são a mesma coisa em centavos e
    // coisas diferentes no que foi digitado. Comparar antes de converter
    // deixaria o segundo passar.
    const com = await comItem(10000);
    await expect(
      ajustarComanda({
        locationId: LOCATION,
        tenantId: TENANT, orderId: com.id,
        desconto: { tipo: 'percent', valor: 100, motivo: 'cortesia total' },
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'desconto_acima_do_teto' });
  });

  it('subir o teto na configuração libera o desconto maior', async () => {
    // O teto é dado, não constante: a barbearia que trabalha com pacote
    // promocional muda o número na tela e ninguém faz deploy.
    await exec(admin, `UPDATE tenants SET max_discount_bps = 5000 WHERE id = '${TENANT}'`);
    try {
      const com = await comItem(10000);
      const ajustada = await ajustarComanda({
        locationId: LOCATION,
        tenantId: TENANT, orderId: com.id,
        desconto: { tipo: 'percent', valor: 50, motivo: 'promoção de inverno' },
        ...operador,
      });
      expect(ajustada.descontoCents).toBe(5000);
    } finally {
      await exec(admin, `UPDATE tenants SET max_discount_bps = 2000 WHERE id = '${TENANT}'`);
    }
  });

  /**
   * O furo que a `/security-review` do bloco 30 achou, e que o teto sozinho não
   * fechava.
   *
   * O teto era conferido **só no instante de gravar o desconto**. Bastava
   * inflar a comanda com uma linha qualquer, descontar 20% do total inflado e
   * apagar a linha: `recalcular` reescrevia subtotal e total e deixava
   * `discount_cents` intacto, e o desconto efetivo subia até zerar a conta — com
   * a trilha registrando os 20% de política.
   */
  it('apagar item depois do desconto não faz o desconto passar do teto', async () => {
    const com = await comItem(5000);
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      tipo: 'product', descricao: 'Linha inflada', quantidade: 1, precoUnitarioCents: 20000,
    });

    // 20% de R$ 250,00 são R$ 50,00 — passa no teto, e é o serviço inteiro.
    const descontada = await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: com.id,
      desconto: { tipo: 'amount', valor: 5000, motivo: 'no limite do inflado' },
      ...operador,
    });
    expect(descontada.descontoCents).toBe(5000);

    const inflada = await getComanda(TENANT, com.id, LOCATION);
    const linha = inflada!.itens.find((i) => i.descricao === 'Linha inflada');
    const depois = await removerItem({
      locationId: LOCATION,
      tenantId: TENANT, orderId: com.id, itemId: linha!.id,
    });

    // Sobrou R$ 50,00 de subtotal: o teto agora é R$ 10,00, e é nele que o
    // desconto tem que estar — não nos R$ 50,00 que zerariam a conta.
    expect(depois.subtotalCents).toBe(5000);
    expect(depois.descontoCents).toBe(1000);
    expect(depois.totalCents).toBe(4000);
  });

  it('serviço de outra barbearia não entra na comanda desta', async () => {
    await exec(admin, `
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('eeeeeeee-0000-0000-0000-000000000009', '${RIVAL}', 'Do rival', 1000, 30);
    `);
    const com = await comanda();

    await expect(
      adicionarItem({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        tipo: 'service', serviceId: 'eeeeeeee-0000-0000-0000-000000000009',
        descricao: 'Invasor', quantidade: 1, precoUnitarioCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'servico_desconhecido' });
  });

  // -- fechamento -------------------------------------------------------------

  it('sem caixa aberto a comanda não fecha', async () => {
    // A venda precisa saber em qual gaveta entrou, senão a divergência do
    // fechamento não tem dono.
    const com = await comItem();
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        pagamentos: [{ forma: 'cash', valorCents: 7000 }], ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'caixa_fechado' });
  });

  it('dinheiro entra na gaveta; cartão não', async () => {
    await abrir();
    const com = await comItem(10000);

    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [
        { forma: 'cash', valorCents: 4000 },
        { forma: 'credit', valorCents: 6000 },
      ],
      ...fecha,
    });

    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(24000);
  });

  it('o troco sai da gaveta junto com a venda', async () => {
    await abrir();
    const com = await comItem(7000);

    const fechada = await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'cash', valorCents: 10000 }], ...fecha,
    });

    expect(fechada.trocoCents).toBe(3000);
    // 20000 de abertura + 7000 de venda líquida.
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(27000);
  });

  it('não se fecha a mesma comanda duas vezes', async () => {
    await abrir();
    const com = await comItem();
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'cash', valorCents: 7000 }], ...fecha,
    });

    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        pagamentos: [{ forma: 'cash', valorCents: 7000 }], ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'comanda_fechada' });
  });

  it('pagamento a menos não fecha a comanda', async () => {
    await abrir();
    const com = await comItem(10000);
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        pagamentos: [{ forma: 'pix', valorCents: 5000 }], ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  // -- fiado ------------------------------------------------------------------

  it('fiado vira dívida com extrato, e não entra na gaveta', async () => {
    await abrir();
    const com = await comItem(7000);

    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    const cliente = await admin.$queryRawUnsafe<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(cliente[0]?.balance_cents).toBe(-7000);

    const extrato = await admin.$queryRawUnsafe<
      { kind: string; amount_cents: number; balance_after_cents: number }[]
    >(`SELECT kind, amount_cents, balance_after_cents FROM customer_ledger WHERE tenant_id = '${TENANT}'`);
    expect(extrato).toHaveLength(1);
    expect(extrato[0]).toMatchObject({ kind: 'fiado', amount_cents: -7000, balance_after_cents: -7000 });

    // A gaveta não se moveu: fiado não é dinheiro.
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(20000);
  });

  it('fiado acima do limite é recusado e nada é gravado', async () => {
    await abrir();
    const com = await comItem(15000);

    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        pagamentos: [{ forma: 'fiado', valorCents: 15000 }], ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });

    const cliente = await admin.$queryRawUnsafe<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(cliente[0]?.balance_cents).toBe(0);
  });

  it('cliente sem limite não fia', async () => {
    await exec(admin, `UPDATE customers SET credit_limit_cents = 0 WHERE id = '${CARLOS}'`);
    await abrir();
    const com = await comItem(1000);

    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: com.id,
        pagamentos: [{ forma: 'fiado', valorCents: 1000 }], ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('receber o fiado abate a dívida e entra na gaveta', async () => {
    await abrir();
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    const { saldoCents } = await receberFiado({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS,
      amountCents: 5000, forma: 'cash', ...operador,
    });

    expect(saldoCents).toBe(-2000);
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(25000);

    const devendo = await quemEstaDevendo(TENANT);
    expect(devendo.devedores).toHaveLength(1);
    expect(devendo.devedores[0]).toMatchObject({ name: 'Carlos Souza', saldoCents: -2000 });
    // O total e a contagem saem do domínio, não da lista: é o que a tela usa.
    expect(devendo).toMatchObject({ quantos: 1, totalCents: 2000 });
  });

  /**
   * O toque duplo no recebimento **parcial** (bloco 103).
   *
   * Pagar a dívida inteira já era barrado pelo estado — o segundo toque cai em
   * "este cliente não tem dívida em aberto". Por isso o defeito passou
   * despercebido: o formulário vem pré-preenchido com a dívida cheia, e quem
   * recebe parcial é que perdia. Reproduzido: devia R$ 200, entregou R$ 50, a
   * dívida caiu R$ 100 e a gaveta passou a esperar dinheiro que ninguém deu.
   *
   * O caso paga 5.000 de uma dívida de 7.000: sobra dívida, então o estado
   * **não** barra o segundo toque, e só a chave separa.
   */
  it('a mesma chave não abate a dívida duas vezes', async () => {
    await abrir();
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    const chave = 'recepcao-1:fiado-abc';
    const primeira = await receberFiado({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS,
      amountCents: 5000, forma: 'cash', idempotencyKey: chave, ...operador,
    });
    const segunda = await receberFiado({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS,
      amountCents: 5000, forma: 'cash', idempotencyKey: chave, ...operador,
    });

    expect(primeira.saldoCents).toBe(-2000);
    expect(segunda.saldoCents).toBe(-2000);
    // A gaveta também: sem isto, a linha de `debt_payment` repetida passaria
    // despercebida enquanto o saldo do cliente estivesse certo.
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(25000);
  });

  it('não se recebe mais do que a dívida', async () => {
    await abrir();
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    await expect(
      receberFiado({
        tenantId: TENANT, locationId: LOCATION, customerId: CARLOS,
        amountCents: 9000, forma: 'cash', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('não se paga fiado com fiado', async () => {
    await abrir();
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    await expect(
      receberFiado({
        tenantId: TENANT, locationId: LOCATION, customerId: CARLOS,
        amountCents: 1000, forma: 'fiado', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  // -- faturamento ------------------------------------------------------------

  it('o faturamento do dia separa recebido de fiado', async () => {
    // Somar fiado ao faturamento é a barbearia comemorar um mês que não
    // aconteceu.
    await abrir();

    const paga = await comItem(10000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: paga.id,
      pagamentos: [{ forma: 'cash', valorCents: 10000 }], ...fecha,
    });

    const fiada = await comItem(6000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: fiada.id,
      pagamentos: [{ forma: 'fiado', valorCents: 6000 }], ...fecha,
    });

    const total = await faturamentoDoDia({
      tenantId: TENANT,
      locationId: LOCATION,
      de: new Date(Date.now() - 3600_000),
      ate: new Date(Date.now() + 3600_000),
    });

    expect(total.recebidoCents).toBe(10000);
    expect(total.fiadoCents).toBe(6000);
    expect(total.comandas).toBe(2);
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('caixa, comanda e dívida de uma barbearia não existem para a outra', async () => {
    await abrir();
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }], ...fecha,
    });

    expect(await caixaAberto(RIVAL, LOCATION)).toBeNull();
    expect(await quemEstaDevendo(RIVAL)).toEqual({ devedores: [], quantos: 0, totalCents: 0 });

    await expect(
      receberFiado({
        tenantId: RIVAL, locationId: LOCAL_RIVAL, customerId: CARLOS,
        amountCents: 1000, forma: 'cash', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cliente_nao_encontrado' });

    // E a dívida da casa continua de pé.
    const devendo = await quemEstaDevendo(TENANT);
    expect(devendo.devedores[0]?.saldoCents).toBe(-7000);
  });

  // -- a trilha ---------------------------------------------------------------

  it('sangria e fechamento de comanda ficam na trilha, com nome', async () => {
    // A SPEC §1.7 pede sangria auditada. O motivo prático é o dia seguinte:
    // divergência de caixa sem dono é desconfiança de todo mundo contra todo
    // mundo, e é isso que o controle de caixa existe para não produzir.
    await abrir();
    await movimentarCaixa({
      tenantId: TENANT, locationId: LOCATION, kind: 'withdrawal',
      amountCents: 5000, reason: 'Depósito no banco', ...operador,
    });
    const com = await comItem(7000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'cash', valorCents: 7000 }], ...fecha,
    });

    const trilha = await admin.$queryRawUnsafe<{ action: string; actor_name: string }[]>(
      `SELECT action, actor_name FROM audit_log WHERE tenant_id = '${TENANT}' ORDER BY id`,
    );
    const acoes = trilha.map((linha) => linha.action);

    expect(acoes).toContain('cash.opened');
    expect(acoes).toContain('cash.withdrawal');
    expect(acoes).toContain('order.closed');
    expect(trilha.every((linha) => linha.actor_name === 'Maria Recepção')).toBe(true);
  });

  it('a sangria recusada não deixa rastro de sangria', async () => {
    // A trilha grava dentro da transação de quem move: o que não aconteceu não
    // pode aparecer nela. Registrar a tentativa aqui faria a conferência do dia
    // seguinte procurar um dinheiro que nunca saiu.
    await abrir();
    await expect(
      movimentarCaixa({
        tenantId: TENANT, locationId: LOCATION, kind: 'withdrawal',
        amountCents: 999999, reason: 'Engano', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'sangria_maior_que_a_gaveta' });

    const trilha = await admin.$queryRawUnsafe<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE tenant_id = '${TENANT}'`,
    );
    expect(trilha.map((l) => l.action)).not.toContain('cash.withdrawal');
  });

  it('o desconto entra na trilha; a gorjeta não', async () => {
    const com = await comItem(10000);
    await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: com.id,
      desconto: { tipo: 'amount', valor: 1500, motivo: 'Cliente antigo' },
      gorjetaCents: 500,
      ...operador,
    });

    const trilha = await admin.$queryRawUnsafe<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_log WHERE tenant_id = '${TENANT}'`,
    );
    const descontos = trilha.filter((l) => l.action === 'order.discount');
    expect(descontos).toHaveLength(1);
    expect(descontos[0]?.after).toMatchObject({ descontoCents: 1500, motivo: 'Cliente antigo' });
  });

  // -- concorrência ------------------------------------------------------------

  it('dois toques simultâneos no "Receber" cobram uma vez só', async () => {
    // O caminho que a `/security-review` encontrou: `exigirAberta` lia sem
    // travar, então as duas transações viam a comanda aberta, as duas passavam
    // pela conferência e as duas gravavam — dois pagamentos, dois movimentos de
    // caixa e duas linhas num extrato que é append-only.
    await abrir();
    const com = await comItem(7000);

    const pagamento = {
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'cash' as const, valorCents: 7000 }], ...fecha,
    };
    const [a, b] = await Promise.allSettled([
      fecharComanda(pagamento),
      fecharComanda(pagamento),
    ]);

    const venceram = [a, b].filter((r) => r.status === 'fulfilled');
    expect(venceram).toHaveLength(1);

    const pagos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM order_payments WHERE order_id = '${com.id}'`,
    );
    expect(Number(pagos[0]?.n)).toBe(1);

    // E a gaveta tem a venda uma vez: 20000 de abertura + 7000.
    expect((await caixaAberto(TENANT, LOCATION))?.esperadoAgoraCents).toBe(27000);
  });

  it('duas comandas fiadas ao mesmo tempo não furam o limite do cliente', async () => {
    // O limite é a única coisa entre a barbearia e crédito sem fim. Conferido
    // contra um saldo lido antes de travar, as duas transações veem a dívida de
    // antes da outra e as duas passam.
    await abrir();
    const uma = await comItem(6000);
    const outra = await comItem(6000);

    const fiar = (orderId: string) =>
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId,
        pagamentos: [{ forma: 'fiado' as const, valorCents: 6000 }], ...fecha,
      });

    // Limite do Carlos é 10000: cabe uma de 6000, não cabem duas.
    const resultados = await Promise.allSettled([fiar(uma.id), fiar(outra.id)]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const devendo = await quemEstaDevendo(TENANT);
    expect(devendo.devedores[0]?.saldoCents).toBe(-6000);
  });

  it('a mesma chave de idempotência devolve a comanda paga, não um erro', async () => {
    await abrir();
    const com = await comItem(7000);

    const pagamento = {
      tenantId: TENANT, locationId: LOCATION, orderId: com.id,
      pagamentos: [{ forma: 'cash' as const, valorCents: 7000 }],
      idempotencyKey: 'balcao-1', ...fecha,
    };

    const primeira = await fecharComanda(pagamento);
    const repetida = await fecharComanda(pagamento);

    expect(repetida.id).toBe(primeira.id);
    expect(repetida.status).toBe('paid');

    const pagos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM order_payments WHERE order_id = '${com.id}'`,
    );
    expect(Number(pagos[0]?.n)).toBe(1);
  });
});
