import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Alerta } from '@barbearia/core';
import {
  avisarDaOperacao,
  CODIGO_DA_RETENCAO,
  FakeOperacaoProvider,
} from './aviso-operacional.js';

/**
 * O canal do alerta operacional contra Postgres real (bloco 33).
 *
 * A lacuna que isto fecha estava declarada desde o bloco 22: as regras
 * decidiam, o coletor alimentava, e a lista pronta não ia para lugar nenhum.
 * O que faltava não era código de envio — era a decisão de **o que** interrompe
 * o dono e **com que frequência**, e é isso que estes testes prendem.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LOCAL = 'a3333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DONO = 'd3333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** 14h em Salvador: dentro da janela em que o aviso pode sair. */
const DE_DIA = new Date('2026-08-10T17:00:00Z');
/** 23h em Salvador. */
const DE_MADRUGADA = new Date('2026-08-11T02:00:00Z');

const CRITICO: Alerta = {
  regra: 'fila_travada',
  severidade: 'critico',
  frase: 'A fila de trabalho tem tarefa parada há mais de uma hora.',
  valor: 12,
  referencia: 0,
};

const AVISO: Alerta = {
  regra: 'volume_caiu',
  severidade: 'aviso',
  frase: 'Hoje entraram 40% menos agendamentos que na semana passada.',
  valor: 6,
  referencia: 10,
};

let admin: PrismaClient;
let provider: FakeOperacaoProvider;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('alerta operacional para o dono', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    provider = new FakeOperacaoProvider();
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO staff_users (id, tenant_id, name, email, phone_e164, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', '+5571988887777',
              'x', 'owner');
    `);
  });

  const mandar = (alertas: readonly Alerta[], agora = DE_DIA) =>
    avisarDaOperacao({ tenantId: TENANT, alertas, provider, agora });

  it('o crítico sai por padrão, e o aviso não', () => {
    /**
     * A decisão de produto que a lacuna pedia.
     *
     * Alerta que dispara à toa é alerta que se aprende a ignorar, e um canal
     * ignorado é pior do que canal nenhum: dá a sensação de estar coberto. O
     * dono liga o resto quando quiser.
     */
    return mandar([CRITICO, AVISO]).then((resultado) => {
      expect(resultado.enviados).toBe(1);
      expect(provider.avisos.map((a) => a.titulo)).toEqual(['fila_travada']);
      expect(provider.avisos[0]?.email).toBe('dono@domari.com.br');
      expect(provider.avisos[0]?.detalhe).toMatch(/tarefa parada/);
    });
  });

  it('o dono liga o aviso e passa a receber os dois', async () => {
    await exec(`
      INSERT INTO tenant_alert_settings (tenant_id, enviar_critico, enviar_aviso)
      VALUES ('${TENANT}', true, true)
    `);

    const resultado = await mandar([CRITICO, AVISO]);
    expect(resultado.enviados).toBe(2);
  });

  it('o dono desliga o crítico e não recebe nada', async () => {
    // Desligar é direito dele. O que não pode é o produto **achar** que avisou.
    await exec(`
      INSERT INTO tenant_alert_settings (tenant_id, enviar_critico, enviar_aviso)
      VALUES ('${TENANT}', false, false)
    `);

    const resultado = await mandar([CRITICO, AVISO]);
    expect(resultado).toEqual({ enviados: 0, motivo: 'desligado' });
    expect(provider.avisos).toHaveLength(0);
  });

  it('o mesmo alerta não sai duas vezes no mesmo dia', async () => {
    /**
     * "A fila está travada" repetido a cada volta do worker é como se arquiva a
     * mensagem sem ler. E a varredura roda várias vezes por dia por construção:
     * dois workers, uma retentativa da fila, um reinício do processo.
     */
    expect((await mandar([CRITICO])).enviados).toBe(1);
    expect((await mandar([CRITICO])).enviados).toBe(0);
    expect(provider.avisos).toHaveLength(1);

    // Amanhã ele volta, se a causa continuar.
    const amanha = new Date(DE_DIA.getTime() + 86_400_000);
    expect((await mandar([CRITICO], amanha)).enviados).toBe(1);
    expect(provider.avisos).toHaveLength(2);
  });

  it('nada sai na janela de silêncio da unidade', async () => {
    // O fuso vem da unidade e nunca do processo — é o defeito D2, e aqui ele
    // mandaria alerta de madrugada para o Acre.
    const resultado = await mandar([CRITICO], DE_MADRUGADA);
    expect(resultado).toEqual({ enviados: 0, motivo: 'silencio' });

    // E não fica marcado como enviado: o alerta de amanhã continua valendo.
    const marcados = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM tenant_alerts_sent`,
    );
    expect(Number(marcados[0]?.n)).toBe(0);
  });

  it('barbearia sem dono ativo não derruba a varredura', async () => {
    // O worker processa lote. Uma barbearia em estado estranho — dono
    // desativado, conta em migração — não pode parar as outras quarenta.
    await exec(`UPDATE staff_users SET active = false WHERE id = '${DONO}'`);

    const resultado = await mandar([CRITICO]);
    expect(resultado).toEqual({ enviados: 0, motivo: 'sem_destinatario' });
  });

  it('lista vazia não vira consulta ao banco nem mensagem', async () => {
    const resultado = await mandar([]);
    expect(resultado).toEqual({ enviados: 0, motivo: 'ok' });
    expect(provider.avisos).toHaveLength(0);
  });

  it('a retenção tem interruptor próprio, e não segue o do crítico', async () => {
    /**
     * Ela é obrigação legal, não sinal operacional. O dono que desligou "me
     * avise quando a fila travar" não disse que aceita perder cadastro sem ser
     * avisado — e amarrar as duas faria uma decisão sobre ruído virar, sem
     * ninguém perceber, uma decisão sobre a LGPD.
     */
    await exec(`
      INSERT INTO tenant_alert_settings (tenant_id, enviar_critico, enviar_aviso, enviar_retencao)
      VALUES ('${TENANT}', false, false, true)
    `);

    const retencao: Alerta = {
      regra: CODIGO_DA_RETENCAO,
      severidade: 'critico',
      frase: '3 cadastro(s) sem atendimento há cinco anos serão apagados em 30 dias.',
      valor: 3,
      referencia: 0,
    };

    // O crítico está desligado e não sai; a retenção sai assim mesmo.
    const resultado = await mandar([CRITICO, retencao]);
    expect(resultado.enviados).toBe(1);
    expect(provider.avisos.map((a) => a.titulo)).toEqual([CODIGO_DA_RETENCAO]);
  });

  it('o dono desliga também a retenção, e aí nada sai', async () => {
    // Desligar continua sendo direito dele — o que não pode é o produto achar
    // que avisou. O registro de que **não** avisou é a ausência da linha.
    await exec(`
      INSERT INTO tenant_alert_settings (tenant_id, enviar_retencao) VALUES ('${TENANT}', false)
    `);

    const resultado = await mandar([
      {
        regra: CODIGO_DA_RETENCAO,
        severidade: 'critico',
        frase: 'cadastros a sair',
        valor: 1,
        referencia: 0,
      },
    ]);
    expect(resultado).toEqual({ enviados: 0, motivo: 'desligado' });
  });

  it('o registro de que avisou não é apagável pela aplicação', async () => {
    /**
     * É o que responde "por que ninguém me contou?" depois. Um registro que a
     * aplicação reescreve não responde nada — mesma razão de `audit_log` e do
     * extrato do fiado.
     */
    await mandar([CRITICO]);

    await expect(
      admin.$executeRawUnsafe(`
        SET LOCAL ROLE barbearia_app;
        DELETE FROM tenant_alerts_sent;
      `),
    ).rejects.toBeDefined();
  });
});
