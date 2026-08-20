import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESCADA_DO_WEBHOOK } from '@barbearia/core';
import {
  assinarEntrega,
  cadastrarEndpoint,
  desligarEndpoint,
  endpointsDaCasa,
  entregarWebhook,
  entregasDaCasa,
  varrerEntregasPendentes,
} from './webhook.js';

/**
 * Webhooks contra Postgres real (bloco 79).
 *
 * O que só o banco prova: que o segredo não fica em claro, que a assinatura é
 * conferível do outro lado, que a escada para na recusa definitiva e que a
 * varredura alcança o que a tarefa perdeu.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '79797979-1111-1111-1111-111111111111';
const VIZINHA = '79797979-2222-2222-2222-222222222222';
const DONO = '79797979-d000-0000-0000-000000000001';

const AGORA = new Date('2026-11-03T10:00:00Z');

/**
 * A resolução de nome é simulada, e é o único jeito de testar isto aqui.
 *
 * A suíte roda sem DNS, então `erp.exemplo.com.br` não resolveria e toda
 * entrega cairia na guarda de destino interno — o teste mediria a guarda, e não
 * a entrega. O mapa devolve um endereço público de verdade para o nome
 * legítimo, e é sobrescrito no caso que exercita a guarda.
 */
const RESOLVE: Record<string, string> = { 'erp.exemplo.com.br': '203.0.113.7' };

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    const address = RESOLVE[hostname] ?? hostname;
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  },
}));

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('webhook para terceiros', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['WEBHOOK_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${CASA}', 'Barbearia Dock'), ('${VIZINHA}', 'Casa Vizinha');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${CASA}', 'Matheus', 'dono@dock.com.br', 'x', 'owner')
    `);
  });

  const cadastrar = (eventos: readonly string[] = ['appointment.created']) =>
    cadastrarEndpoint({
      tenantId: CASA,
      staffId: DONO,
      staffName: 'Matheus',
      nome: 'ERP do contador',
      url: 'https://erp.exemplo.com.br/barber-dock',
      eventos,
    });

  /** Uma entrega pendente, pronta para o worker pegar. */
  async function pendencia(endpointId: string): Promise<string> {
    const [linha] = await admin.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload)
       VALUES ('${CASA}', '${endpointId}', 'appointment.created',
               '{"event":"appointment.created","object_id":"abc"}'::jsonb)
       RETURNING id`,
    );
    return linha?.id ?? '';
  }

  it('o segredo sai uma vez, e o banco guarda só o cifrado', async () => {
    const { id, segredo } = await cadastrar();
    expect(segredo.length).toBeGreaterThan(30);

    const [linha] = await admin.$queryRawUnsafe<{ secret_cipher: string }[]>(
      `SELECT secret_cipher FROM webhook_endpoints WHERE id = '${id}'`,
    );
    expect(linha?.secret_cipher).not.toContain(segredo);
    // Três partes: iv, tag e dado. AES-256-GCM, como o token de WhatsApp.
    expect(linha?.secret_cipher.split('.')).toHaveLength(3);

    // E a leitura da tela nunca traz o segredo.
    expect(JSON.stringify(await endpointsDaCasa(CASA))).not.toContain(segredo);
  });

  it('endereço http é recusado antes de tocar o banco', async () => {
    // A assinatura prova a origem; ela não esconde o conteúdo.
    await expect(
      cadastrarEndpoint({
        tenantId: CASA,
        staffId: DONO,
        staffName: 'Matheus',
        nome: 'Inseguro',
        url: 'http://erp.exemplo.com.br/hook',
        eventos: ['appointment.created'],
      }),
    ).rejects.toThrow(/https/i);
  });

  it('endereço que aponta para dentro é recusado no cadastro', async () => {
    /**
     * O risco central do bloco. `https://169.254.169.254/` passa por toda
     * validação de formato e busca credencial de nuvem — e o código de resposta
     * apareceria na tela, que é um oráculo de varredura de rede interna.
     */
    for (const dentro of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1:5432/',
      'https://localhost/hook',
      'https://db.local/hook',
      'https://10.0.0.5/hook',
    ]) {
      await expect(
        cadastrarEndpoint({
          tenantId: CASA,
          staffId: DONO,
          staffName: 'Matheus',
          nome: 'Para dentro',
          url: dentro,
          eventos: ['appointment.created'],
        }),
        dentro,
      ).rejects.toThrow(/interna/i);
    }
  });

  it('a entrega recusa quando o nome resolve para dentro depois do cadastro', async () => {
    /**
     * O cadastro recusa o nome óbvio; a entrega é a guarda de verdade, porque o
     * domínio é da barbearia e ela pode reapontá-lo depois de passar aqui.
     *
     * A semente satisfaz **tudo menos** a regra sob teste: o endereço foi
     * cadastrado com um nome legítimo, e é a resolução que muda.
     */
    const { id } = await cadastrar();
    const entregaId = await pendencia(id);
    RESOLVE['erp.exemplo.com.br'] = '169.254.169.254';

    let chamou = false;
    vi.stubGlobal('fetch', async () => {
      chamou = true;
      return new Response('', { status: 200 });
    });

    try {
      expect(await entregarWebhook(entregaId, AGORA)).toBe('retentar');
      expect(chamou).toBe(false);
      const [linha] = await entregasDaCasa(CASA);
      expect(linha?.erro).toMatch(/interna/i);
    } finally {
      RESOLVE['erp.exemplo.com.br'] = '203.0.113.7';
    }
  });

  it('a assinatura é a conta que o outro lado refaz', async () => {
    /**
     * `t=<unix>,v1=<hmac de "instante.corpo">` — a mesma forma que este produto
     * **recebe** do adquirente. Um integrador que já sabe conferir webhook da
     * Stripe sabe conferir o nosso.
     */
    const corpo = '{"event":"appointment.created"}';
    const cabecalho = assinarEntrega({ corpo, segredo: 'segredo-de-teste', instante: 1_700_000_000 });

    const doOutroLado = createHmac('sha256', 'segredo-de-teste')
      .update(`1700000000.${corpo}`)
      .digest('hex');

    expect(cabecalho).toBe(`t=1700000000,v1=${doOutroLado}`);
  });

  it('2xx entrega, e o corpo vai assinado', async () => {
    const { id, segredo } = await cadastrar();
    const entregaId = await pendencia(id);

    let visto: { url: string; assinatura: string; corpo: string } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      visto = {
        url,
        assinatura: String((init.headers as Record<string, string>)['barber-dock-signature']),
        corpo: String(init.body),
      };
      return new Response('', { status: 200 });
    });

    expect(await entregarWebhook(entregaId, AGORA)).toBe('entregue');

    const conferido = visto as unknown as { url: string; assinatura: string; corpo: string };
    expect(conferido.url).toBe('https://erp.exemplo.com.br/barber-dock');

    // O outro lado refaz a conta com o segredo que recebeu na criação.
    const instante = Math.floor(AGORA.getTime() / 1000);
    expect(conferido.assinatura).toBe(
      assinarEntrega({ corpo: conferido.corpo, segredo, instante }),
    );

    const [depois] = await entregasDaCasa(CASA);
    expect(depois?.estado).toBe('entregue');
    expect(depois?.entregueEm).not.toBeNull();
  });

  it('5xx retenta pela escada; 400 desiste na hora', async () => {
    /**
     * A regra da recusa definitiva do adquirente: contra um `400`, os seis
     * degraus são seis chamadas que já sabem a resposta.
     */
    const { id } = await cadastrar();

    const daFalha = await pendencia(id);
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    expect(await entregarWebhook(daFalha, AGORA)).toBe('retentar');

    const [linha] = await admin.$queryRawUnsafe<{ attempts: number; next_attempt_at: Date }[]>(
      `SELECT attempts, next_attempt_at FROM webhook_deliveries WHERE id = '${daFalha}'`,
    );
    expect(Number(linha?.attempts)).toBe(1);
    expect(linha?.next_attempt_at.getTime()).toBe(
      AGORA.getTime() + (ESCADA_DO_WEBHOOK[1] ?? 0) * 1000,
    );

    const daRecusa = await pendencia(id);
    vi.stubGlobal('fetch', async () => new Response('', { status: 400 }));
    expect(await entregarWebhook(daRecusa, AGORA)).toBe('desistiu');
  });

  it('a varredura alcança o que a tarefa perdeu', async () => {
    /**
     * A tarefa da fila acompanha **uma** entrega e morre com ela. Se o processo
     * cair entre a falha e a reprogramação, aquela entrega fica pendente e
     * ninguém a chama de novo — é a mesma rede de segurança da nota fiscal.
     */
    const { id } = await cadastrar();
    const perdida = await pendencia(id);
    // Relativo ao `agora` do teste, nunca ao relógio do processo: `AGORA` é
    // uma data futura, e `now() + 1 hora` continuaria no passado dela.
    await exec(
      `UPDATE webhook_deliveries
          SET next_attempt_at = timestamptz '${AGORA.toISOString()}' - interval '1 hour'
        WHERE id = '${perdida}'`,
    );

    expect(await varrerEntregasPendentes(AGORA)).toContain(perdida);

    // E o que ainda não venceu fica fora.
    const futura = await pendencia(id);
    await exec(
      `UPDATE webhook_deliveries
          SET next_attempt_at = timestamptz '${AGORA.toISOString()}' + interval '1 hour'
        WHERE id = '${futura}'`,
    );
    expect(await varrerEntregasPendentes(AGORA)).not.toContain(futura);
  });

  it('endereço desligado depois não é falha: desiste com o motivo escrito', async () => {
    const { id } = await cadastrar();
    const entregaId = await pendencia(id);
    await desligarEndpoint({
      tenantId: CASA,
      staffId: DONO,
      staffName: 'Matheus',
      endpointId: id,
    });

    let chamou = false;
    vi.stubGlobal('fetch', async () => {
      chamou = true;
      return new Response('', { status: 200 });
    });

    expect(await entregarWebhook(entregaId, AGORA)).toBe('desistiu');
    // Nem chega a bater no endereço: a barbearia mudou de ideia.
    expect(chamou).toBe(false);

    const [linha] = await entregasDaCasa(CASA);
    expect(linha?.erro).toMatch(/desligado/i);
  });

  it('segredo ilegível vira desfecho gravado, não exceção', async () => {
    /**
     * Girar `WEBHOOK_SECRET_KEY` é operação normal de segurança, prevista em
     * `deploy/segredos.sh`. Com o `decifrar` fora do `try`, a exceção escapava
     * de `entregarWebhook`: a tarefa morria sem gravar tentativa, motivo nem
     * próxima tentativa, e toda entrega pendente ficava em "na fila" para
     * sempre — com a coluna Resposta em `—` e nenhuma explicação em lugar
     * nenhum. Recusa dentro de tarefa de fila é desfecho, não exceção.
     */
    const { id } = await cadastrar();
    const entregaId = await pendencia(id);

    // O criptograma continua na linha; o que muda é a chave que o leria.
    const anterior = process.env['WEBHOOK_SECRET_KEY'];
    process.env['WEBHOOK_SECRET_KEY'] = Buffer.from('outra-chave-de-32-bytes---------!').toString(
      'base64',
    );

    let chamou = false;
    vi.stubGlobal('fetch', async () => {
      chamou = true;
      return new Response('', { status: 200 });
    });

    try {
      expect(await entregarWebhook(entregaId, AGORA)).toBe('desistiu');
    } finally {
      if (anterior === undefined) delete process.env['WEBHOOK_SECRET_KEY'];
      else process.env['WEBHOOK_SECRET_KEY'] = anterior;
    }

    // Não bate no endereço com assinatura que o outro lado não conseguiria
    // conferir, e a linha explica por que parou.
    expect(chamou).toBe(false);
    const [linha] = await entregasDaCasa(CASA);
    expect(linha?.erro).toMatch(/segredo ileg/i);
  });

  it('o endereço da vizinha não é visto nem desligado', async () => {
    await exec(`
      INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
      VALUES ('${VIZINHA}', 'Da vizinha', 'https://vizinha.com.br/hook', 'x',
              ARRAY['appointment.created']::webhook_event[])
    `);

    // A consulta roda sem filtro de propósito: quem filtra é a política.
    expect(await endpointsDaCasa(CASA)).toHaveLength(0);

    const [alheio] = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM webhook_endpoints WHERE tenant_id = '${VIZINHA}'`,
    );
    await expect(
      desligarEndpoint({
        tenantId: CASA,
        staffId: DONO,
        staffName: 'Matheus',
        endpointId: alheio?.id ?? '',
      }),
    ).rejects.toThrow(/não encontrado/i);
  });

  it('a trilha registra o endereço e os eventos, nunca o segredo', async () => {
    const { segredo } = await cadastrar(['appointment.created', 'order.paid']);

    const [linha] = await admin.$queryRawUnsafe<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_log WHERE action = 'webhook.registered'`,
    );
    const registrado = JSON.stringify(linha?.after);
    expect(registrado).toContain('erp.exemplo.com.br');
    expect(registrado).toContain('order.paid');
    expect(registrado).not.toContain(segredo);
  });

  it('sem `WEBHOOK_SECRET_KEY` o cadastro falha alto', async () => {
    const antes = process.env['WEBHOOK_SECRET_KEY'];
    delete process.env['WEBHOOK_SECRET_KEY'];
    try {
      await expect(cadastrar()).rejects.toThrow(/WEBHOOK_SECRET_KEY/);
    } finally {
      process.env['WEBHOOK_SECRET_KEY'] = antes;
    }
  });
});
