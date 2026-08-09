import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { RETENCAO_ANOS, AVISO_DE_RETENCAO_DIAS } from '@barbearia/core';
import { anonimizarCliente, varrerRetencao } from './anonimizacao.js';
import { abrirPedidoDoTitular, atenderExclusao, encerrarPedidoDoTitular, LgpdError, pedidosDoTitular } from './lgpd.js';

/**
 * Anonimização e retenção contra Postgres real (bloco 32).
 *
 * O que só o banco responde: que a pessoa some e o dinheiro fica, que a
 * varredura enxerga interação em quatro tabelas diferentes, que o pedido de
 * exclusão e a anonimização são atômicos, e que nada disso atravessa a
 * fronteira do tenant.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '32323232-1111-1111-1111-111111111111';
const RIVAL = '32323232-2222-2222-2222-222222222222';
const LOCAL = 'a2323232-0000-0000-0000-000000000001';
const RUAN = 'e2323232-0000-0000-0000-000000000001';
const CARLOS = 'c2323232-0000-0000-0000-000000000001';
const JOAO = 'c2323232-0000-0000-0000-000000000002';
const DELA = 'c2323232-0000-0000-0000-000000000003';
const DONO = 'd2323232-0000-0000-0000-000000000001';

const AGORA = new Date('2026-08-09T12:00:00Z');
const DIA = 86_400_000;
const diasAtras = (n: number) => new Date(AGORA.getTime() - n * DIA);
const MUITO_TEMPO = RETENCAO_ANOS * 365 + 40;

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const ator = { id: DONO, name: 'Matheus' };

describeIfDb('anonimização e retenção', () => {
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
      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164, birth_date, created_at) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', '1990-04-12',
         '${diasAtras(MUITO_TEMPO).toISOString()}'),
        ('${JOAO}', '${TENANT}', 'João Nunes', '+5571966665555', NULL,
         '${diasAtras(MUITO_TEMPO).toISOString()}'),
        ('${DELA}', '${RIVAL}', 'Cliente da vizinha', '+5571977776666', NULL, now());

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  const cadastro = (id: string) =>
    admin.$queryRawUnsafe<
      { name: string; phone_e164: string | null; anonymized_at: Date | null; balance_cents: number }[]
    >(`SELECT name, phone_e164, anonymized_at, balance_cents FROM customers WHERE id = '${id}'`);

  // -- anonimizar --------------------------------------------------------------

  it('a pessoa some, a venda fica, e a trilha guarda o apelido — nunca o nome', async () => {
    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, subtotal_cents, total_cents, opened_at, closed_at)
      VALUES ('0a323232-0000-0000-0000-000000000001', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', '2024-01-10', 5000, 5000, '2024-01-10T13:00:00Z', '2024-01-10T14:00:00Z');
    `);

    const resultado = await anonimizarCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      motivo: 'pedido de exclusão do titular',
      ator,
    });

    expect(resultado.anonimizado).toBe(true);
    expect(resultado.apelido).toBe('cliente_anonimizado_c232');

    const [depois] = await cadastro(CARLOS);
    expect(depois?.name).toBe('cliente_anonimizado_c232');
    expect(depois?.phone_e164).toBeNull();
    expect(depois?.anonymized_at).not.toBeNull();

    // A venda continua lá, apontando para a mesma linha.
    const vendas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM orders WHERE customer_id = '${CARLOS}'`,
    );
    expect(Number(vendas[0]?.n)).toBe(1);

    /**
     * A trilha não pode conter o nome que saiu.
     *
     * `audit_log` é append-only: registrar "anonimizou Carlos Souza" apagaria o
     * dado de um lugar e o eternizaria noutro, que é o oposto do que a operação
     * existe para fazer.
     */
    const trilha = await admin.$queryRawUnsafe<{ after: unknown }[]>(
      `SELECT after FROM audit_log WHERE action = 'customer.anonymized'`,
    );
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha[0]?.after)).not.toContain('Carlos');
    expect(JSON.stringify(trilha[0]?.after)).toContain('cliente_anonimizado_c232');
  });

  it('não anonimiza o cliente da vizinha, mesmo com o id na mão', async () => {
    const resultado = await anonimizarCliente({
      tenantId: TENANT,
      customerId: DELA,
      motivo: 'tentativa',
      ator,
    });

    expect(resultado.anonimizado).toBe(false);

    const [intacta] = await cadastro(DELA);
    expect(intacta?.name).toBe('Cliente da vizinha');
    expect(intacta?.phone_e164).toBe('+5571977776666');
  });

  it('exige motivo escrito', async () => {
    await expect(
      anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: ' ', ator }),
    ).rejects.toBeInstanceOf(Error);

    const [intacto] = await cadastro(CARLOS);
    expect(intacto?.anonymized_at).toBeNull();
  });

  // -- o pipeline de exclusão --------------------------------------------------

  it('atender exclusão apaga a pessoa e fecha o pedido na mesma transação', async () => {
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT,
      customerId: CARLOS,
      tipo: 'deletion',
    });

    const resultado = await atenderExclusao({
      tenantId: TENANT,
      customerId: CARLOS,
      motivo: 'pedido de exclusão do titular',
      ator,
    });

    expect(resultado.anonimizou).toBe(true);
    expect(resultado.pedidosFechados).toBe(1);

    const abertos = await pedidosDoTitular(TENANT);
    expect(abertos).toHaveLength(0);

    const todos = await pedidosDoTitular(TENANT, true);
    expect(todos.find((p) => p.id === pedido.id)?.estado).toBe('done');

    const [depois] = await cadastro(CARLOS);
    expect(depois?.phone_e164).toBeNull();
  });

  it('atender exclusão funciona sem pedido aberto — o balcão também recebe o pedido', async () => {
    // Quem pede na frente do barbeiro não deveria precisar que alguém abra um
    // chamado antes. A trilha da anonimização é o registro.
    const resultado = await atenderExclusao({
      tenantId: TENANT,
      customerId: CARLOS,
      motivo: 'pediu no balcão',
      ator,
    });

    expect(resultado.anonimizou).toBe(true);
    expect(resultado.pedidosFechados).toBe(0);
  });

  it('marcar um pedido de exclusão como atendido pela outra rota é recusado', async () => {
    /**
     * A defesa contra o pior estado possível: o registro dizendo que a
     * obrigação foi cumprida enquanto o cadastro continua inteiro. Silenciar
     * seria pior que recusar — a barbearia acreditaria ter cumprido.
     */
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT,
      customerId: CARLOS,
      tipo: 'deletion',
    });

    await expect(
      encerrarPedidoDoTitular({ tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator }),
    ).rejects.toMatchObject({ code: 'exclusao_tem_caminho_proprio' });

    const [intacto] = await cadastro(CARLOS);
    expect(intacto?.anonymized_at).toBeNull();

    // E o pedido continua aberto: nada foi marcado.
    expect(await pedidosDoTitular(TENANT)).toHaveLength(1);
  });

  it('recusar um pedido de exclusão continua valendo, com motivo', async () => {
    // Recusar não destrói nada, e é a resposta legítima quando a guarda fiscal
    // obriga. Por isso continua na rota de encerrar.
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT,
      customerId: CARLOS,
      tipo: 'deletion',
    });

    await encerrarPedidoDoTitular({
      tenantId: TENANT,
      pedidoId: pedido.id,
      atendido: false,
      nota: 'Guarda fiscal obrigatória de cinco anos sobre a última venda',
      ator,
    });

    const todos = await pedidosDoTitular(TENANT, true);
    expect(todos[0]?.estado).toBe('refused');

    const [intacto] = await cadastro(CARLOS);
    expect(intacto?.anonymized_at).toBeNull();
  });

  // -- retenção ----------------------------------------------------------------

  it('avisa antes de anonimizar, e só anonimiza depois do prazo', async () => {
    const primeira = await varrerRetencao({ tenantId: TENANT, agora: AGORA });

    // Ninguém sai na primeira volta: a SPEC manda avisar antes.
    expect(primeira.anonimizados).toBe(0);
    expect(primeira.avisados.map((a) => a.customerId).sort()).toEqual([CARLOS, JOAO].sort());

    const semPrazo = await varrerRetencao({
      tenantId: TENANT,
      agora: new Date(AGORA.getTime() + (AVISO_DE_RETENCAO_DIAS - 1) * DIA),
    });
    expect(semPrazo.anonimizados).toBe(0);
    // E não avisa de novo: o carimbo já está lá.
    expect(semPrazo.avisados).toHaveLength(0);

    const depois = await varrerRetencao({
      tenantId: TENANT,
      agora: new Date(AGORA.getTime() + AVISO_DE_RETENCAO_DIAS * DIA),
    });
    expect(depois.anonimizados).toBe(2);

    const [carlos] = await cadastro(CARLOS);
    expect(carlos?.phone_e164).toBeNull();
  });

  it('interação recente segura o cadastro — nas quatro tabelas', async () => {
    /**
     * A parte que o teste puro não alcança: o que conta como interação.
     *
     * Cada um destes cadastros está parado há mais de cinco anos **no
     * `created_at`**, e cada um tem uma marca recente numa tabela diferente.
     * Se a consulta esquecer qualquer uma delas, aquele cliente é anonimizado —
     * e é um erro sem volta.
     */
    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, subtotal_cents, total_cents, opened_at, closed_at)
      VALUES ('0a323232-0000-0000-0000-000000000002', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', '2026-08-01', 5000, 5000, '${diasAtras(5).toISOString()}',
              '${diasAtras(5).toISOString()}');

      INSERT INTO customer_ledger
        (tenant_id, customer_id, kind, amount_cents, balance_after_cents, created_by_name, created_at)
      VALUES ('${TENANT}', '${JOAO}', 'fiado', -5000, -5000, 'Maria',
              '${diasAtras(3).toISOString()}');
    `);

    const resultado = await varrerRetencao({ tenantId: TENANT, agora: AGORA });
    expect(resultado.avisados).toHaveLength(0);
    expect(resultado.anonimizados).toBe(0);
  });

  it('agendamento recente também conta como interação', async () => {
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
      VALUES ('0b323232-0000-0000-0000-000000000001', '${TENANT}', '${LOCAL}', '${CARLOS}',
              '${RUAN}', '${diasAtras(10).toISOString()}', '${diasAtras(9.9).toISOString()}',
              '${diasAtras(10).toISOString()}', '${diasAtras(9.9).toISOString()}', 5000, 'completed');
    `);

    const resultado = await varrerRetencao({ tenantId: TENANT, agora: AGORA });
    expect(resultado.avisados.map((a) => a.customerId)).toEqual([JOAO]);
  });

  it('quem voltou depois de avisado não é anonimizado', async () => {
    /**
     * O pior resultado possível, e o que a ordem das perguntas em
     * `decidirRetencao` protege: o dono é avisado, corre atrás, traz o cliente
     * de volta — e o sistema apaga o cadastro assim mesmo.
     */
    await varrerRetencao({ tenantId: TENANT, agora: AGORA });

    const voltou = new Date(AGORA.getTime() + 5 * DIA);
    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, subtotal_cents, total_cents, opened_at, closed_at)
      VALUES ('0a323232-0000-0000-0000-000000000003', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', '2026-08-14', 5000, 5000, '${voltou.toISOString()}',
              '${voltou.toISOString()}');
    `);

    const depois = await varrerRetencao({
      tenantId: TENANT,
      agora: new Date(AGORA.getTime() + AVISO_DE_RETENCAO_DIAS * DIA),
    });

    expect(depois.anonimizados).toBe(1);
    const [carlos] = await cadastro(CARLOS);
    expect(carlos?.phone_e164).toBe('+5571988887777');
    const [joao] = await cadastro(JOAO);
    expect(joao?.phone_e164).toBeNull();
  });

  it('quem voltou perde o carimbo do aviso, e volta a ter os trinta dias', async () => {
    /**
     * O defeito que a `/security-review` deste bloco apontou.
     *
     * O carimbo só era escrito, nunca apagado. Um cliente avisado que voltasse
     * e parasse de vir de novo, anos depois, seria anonimizado na **primeira**
     * varredura — com um `avisadoEm` velho dizendo que o prazo já tinha
     * vencido. A operação é irreversível, e o aviso prévio é justamente o que a
     * SPEC exige antes dela.
     */
    await varrerRetencao({ tenantId: TENANT, agora: AGORA });

    const carimbado = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customers WHERE retention_notified_at IS NOT NULL`,
    );
    expect(Number(carimbado[0]?.n)).toBe(2);

    // Carlos volta.
    const voltou = new Date(AGORA.getTime() + 5 * DIA);
    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, subtotal_cents, total_cents, opened_at, closed_at)
      VALUES ('0a323232-0000-0000-0000-000000000004', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', '2026-08-14', 5000, 5000, '${voltou.toISOString()}',
              '${voltou.toISOString()}');
    `);

    await varrerRetencao({ tenantId: TENANT, agora: new Date(AGORA.getTime() + 6 * DIA) });

    const doCarlos = await admin.$queryRawUnsafe<{ retention_notified_at: Date | null }[]>(
      `SELECT retention_notified_at FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(doCarlos[0]?.retention_notified_at).toBeNull();

    /**
     * E o prazo recomeça do zero na próxima vez.
     *
     * Cinco anos depois da volta, a varredura **avisa** — não anonimiza. É a
     * diferença entre cumprir o aviso prévio e apagar o cadastro de surpresa.
     */
    const cincoAnosDepois = new Date(voltou.getTime() + (RETENCAO_ANOS * 365 + 1) * DIA);
    const deNovo = await varrerRetencao({ tenantId: TENANT, agora: cincoAnosDepois });
    expect(deNovo.avisados.map((a) => a.customerId)).toContain(CARLOS);

    /**
     * A asserção é sobre **o Carlos**, e não sobre o total.
     *
     * A primeira versão esperava zero anonimizados e falhou — com razão: o João
     * foi avisado lá atrás e nunca voltou, então cinco anos depois ele sai
     * mesmo, e sair é o comportamento certo. Contar o total misturava as duas
     * histórias e teria escondido a que importa.
     */
    const [carlos] = await cadastro(CARLOS);
    expect(carlos?.anonymized_at).toBeNull();
    expect(carlos?.phone_e164).toBe('+5571988887777');
  });

  it('o desafio de OTP do número antigo some, senão o nome verdadeiro volta', async () => {
    /**
     * O outro achado da `/security-review`.
     *
     * `otp_challenges` guarda o telefone em claro e o `pending_name`, e
     * `verifyOtp` reaproveita esse nome ao criar o cadastro. Sem apagar a linha,
     * a mesma pessoa entrando de novo com o número antigo reapareceria com o
     * **nome verdadeiro** — a anonimização desfeita pela porta dos fundos.
     */
    await exec(`
      INSERT INTO otp_challenges (tenant_id, phone_e164, code_hash, pending_name, expires_at)
      VALUES ('${TENANT}', '+5571988887777', 'hash', 'Carlos Souza', now() + interval '5 min');
    `);

    await anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: 'pedido', ator });

    const restou = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM otp_challenges WHERE phone_e164 = '+5571988887777'`,
    );
    expect(Number(restou[0]?.n)).toBe(0);
  });

  it('a varredura de uma barbearia não toca na outra', async () => {
    await exec(`
      UPDATE customers SET created_at = '${diasAtras(MUITO_TEMPO).toISOString()}'
       WHERE id = '${DELA}'
    `);

    await varrerRetencao({
      tenantId: TENANT,
      agora: new Date(AGORA.getTime() + AVISO_DE_RETENCAO_DIAS * DIA),
    });
    await varrerRetencao({
      tenantId: TENANT,
      agora: new Date(AGORA.getTime() + 2 * AVISO_DE_RETENCAO_DIAS * DIA),
    });

    const [intacta] = await cadastro(DELA);
    expect(intacta?.anonymized_at).toBeNull();
  });

  it('cadastro já anonimizado não volta para a varredura', async () => {
    await anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: 'pedido', ator });

    const resultado = await varrerRetencao({ tenantId: TENANT, agora: AGORA });
    expect(resultado.avisados.map((a) => a.customerId)).toEqual([JOAO]);
  });

  it('a anonimização não vaza para a listagem por telefone da outra barbearia', async () => {
    // Prova indireta do isolamento: depois de anonimizado, o telefone é nulo, e
    // o índice único por (tenant, telefone) aceita outra pessoa com o antigo.
    await anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: 'pedido', ator });

    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`
        INSERT INTO customers (tenant_id, name, phone_e164)
        VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                'Outro Carlos', '+5571988887777')
      `,
    );

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customers WHERE phone_e164 = '+5571988887777'`,
    );
    expect(Number(linhas[0]?.n)).toBe(1);
  });

  it('erro de domínio é do tipo certo, não erro solto', async () => {
    await expect(
      encerrarPedidoDoTitular({
        tenantId: TENANT,
        pedidoId: '00000000-0000-0000-0000-000000000000',
        atendido: true,
        ator,
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });
});
