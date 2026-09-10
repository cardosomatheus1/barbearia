import { randomUUID } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { cifrarBaileys, decifrarBaileys, desserializarBaileys, hashBaileys, serializarBaileys } from './cofre.js';
import type { EstadoBaileys } from './semantica.js';

export class BaileysError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'BaileysError'; }
}
export interface EscopoBaileys { tenantId: string; locationId: string }
export interface PosseBaileys extends EscopoBaileys { generation: string; ownerToken: string }
export interface AtorBaileys extends EscopoBaileys { staffId: string; staffName: string }
export interface SessaoBaileys {
  location_id: string; generation: string; logout_generation: string | null; desired: boolean; status: EstadoBaileys;
  pairing_until: Date | null; qr_cipher: string | null; qr_until: Date | null;
  phone_e164: string | null; owner_token: string | null; lease_until: Date | null;
  retry_at: Date | null; attempts: number; last_error: string | null;
}

export function baileysHabilitado(): boolean {
  const valor = process.env['BAILEYS_HABILITADO'];
  if (valor === undefined || valor === '' || valor === '0') return false;
  if (valor !== '1') throw new Error('BAILEYS_HABILITADO deve ser 0 ou 1');
  hashBaileys('validar_configuracao');
  return true;
}
function exigirBaileys(): void {
  if (!baileysHabilitado()) throw new BaileysError('baileys_indisponivel', 'A conexão por QR está indisponível nesta instalação.', 503);
}
async function conferirAtor(tx: TransactionClient, p: AtorBaileys): Promise<void> {
  const [ator] = await tx.$queryRaw<{ id: string }[]>`
    SELECT u.id FROM staff_users u CROSS JOIN locations l
     WHERE u.id = ${p.staffId}::uuid AND u.active AND l.id = ${p.locationId}::uuid
  `;
  if (!ator) throw new BaileysError('baileys_nao_permitido', 'Não foi possível alterar esta conexão.', 403);
}
export async function canalDaUnidade(p: EscopoBaileys, tx?: TransactionClient): Promise<'meta' | 'baileys'> {
  const ler = async (db: TransactionClient) => {
    const [linha] = await db.$queryRaw<{ transport: 'meta' | 'baileys' }[]>`
      SELECT transport FROM whatsapp_channels WHERE location_id = ${p.locationId}::uuid
    `;
    return linha?.transport ?? 'meta';
  };
  return tx ? ler(tx) : withTenant(p.tenantId, ler);
}

export async function selecionarCanal(p: AtorBaileys & { canal: 'meta' | 'baileys' }): Promise<void> {
  if (p.canal !== 'meta' && p.canal !== 'baileys') throw new BaileysError('canal_invalido', 'Escolha a conexão do WhatsApp.', 400);
  if (p.canal === 'baileys') exigirBaileys();
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    await tx.$queryRaw`SELECT id FROM locations WHERE id = ${p.locationId}::uuid FOR UPDATE`;
    if (await canalDaUnidade(p, tx) === p.canal) return;
    const [voo] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM whatsapp_baileys_outbox WHERE location_id = ${p.locationId}::uuid AND status IN ('queued', 'sending') LIMIT 1
    `;
    if (voo) throw new BaileysError('canal_com_envio', 'Aguarde os envios em andamento antes de trocar a conexão.');
    await tx.$executeRaw`
      INSERT INTO whatsapp_channels (tenant_id, location_id, transport)
      VALUES (${p.tenantId}::uuid, ${p.locationId}::uuid, ${p.canal})
      ON CONFLICT (location_id) DO UPDATE SET transport = EXCLUDED.transport, updated_at = now()
    `;
    // A troca pausa o socket, preservando autenticação para retomada explícita.
    if (p.canal === 'meta') await tx.$executeRaw`
      UPDATE whatsapp_baileys_sessions SET desired = false, status = 'desconectado',
        owner_token = NULL, lease_until = NULL, qr_cipher = NULL, qr_until = NULL, updated_at = now()
       WHERE location_id = ${p.locationId}::uuid
    `;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.settings_changed',
      entity: 'whatsapp_channel', entityId: p.locationId, after: { canal: p.canal } });
  });
}

export async function lerSessaoBaileys(p: EscopoBaileys): Promise<SessaoBaileys | null> {
  return withTenant(p.tenantId, async tx => (await tx.$queryRaw<SessaoBaileys[]>`
    SELECT * FROM whatsapp_baileys_sessions WHERE location_id = ${p.locationId}::uuid
  `)[0] ?? null);
}
export async function situacaoBaileys(p: EscopoBaileys, agora = new Date()) {
  const s = await lerSessaoBaileys(p);
  const qr = s?.desired && s.qr_cipher && s.qr_until && s.qr_until > agora && s.pairing_until && s.pairing_until > agora
    ? { codigo: decifrarBaileys(s.qr_cipher, `${p.tenantId}:${p.locationId}:${s.generation}:qr`), expira: s.qr_until.toISOString() } : null;
  const possui = s?.lease_until && s.lease_until > agora;
  return { disponivel: baileysHabilitado(), estado: s?.status === 'conectado' && !possui ? 'reconectando' :
      s?.status === 'aguardando_qr' && s.pairing_until && s.pairing_until <= agora ? 'novo_qr' : s?.status ?? 'desconectado',
    numero: s?.phone_e164 ?? null, motivo: s?.last_error ?? null,
    qr: qr?.codigo ?? null, qrExpiraEm: qr?.expira ?? null };
}

export async function solicitarConexaoBaileys(p: AtorBaileys & { novoQr: boolean }): Promise<void> {
  exigirBaileys();
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    await tx.$queryRaw`SELECT id FROM locations WHERE id = ${p.locationId}::uuid FOR UPDATE`;
    if (await canalDaUnidade(p, tx) !== 'baileys') throw new BaileysError('canal_divergente', 'Selecione a conexão por QR para continuar.');
    await tx.$executeRaw`INSERT INTO whatsapp_baileys_sessions (tenant_id, location_id)
      VALUES (${p.tenantId}::uuid, ${p.locationId}::uuid) ON CONFLICT DO NOTHING`;
    const [s] = await tx.$queryRaw<SessaoBaileys[]>`SELECT * FROM whatsapp_baileys_sessions WHERE location_id = ${p.locationId}::uuid FOR UPDATE`;
    if (!s) throw new Error('baileys_sessao_ausente');
    if (s.desired && s.status === 'conectado' && s.lease_until && s.lease_until > new Date()) return;
    if (p.novoQr && s.desired && s.pairing_until && s.pairing_until > new Date()) return;
    if (p.novoQr) {
      await tx.$executeRaw`DELETE FROM whatsapp_baileys_auth WHERE location_id = ${p.locationId}::uuid`;
      await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'failed', last_error = 'sessao_alterada', updated_at = now()
        WHERE location_id = ${p.locationId}::uuid AND status = 'queued'`;
      await tx.$executeRaw`
        UPDATE whatsapp_baileys_sessions SET generation = gen_random_uuid(), desired = true,
          status = 'aguardando_qr', pairing_until = now() + interval '3 minutes',
          qr_cipher = NULL, qr_until = NULL, owner_token = NULL, lease_until = NULL,
          retry_at = NULL, attempts = 0, last_error = NULL, phone_e164 = NULL, phone_hash = NULL, updated_at = now()
         WHERE location_id = ${p.locationId}::uuid
      `;
    } else {
      const [cred] = await tx.$queryRaw<{ key_id: string }[]>`SELECT key_id FROM whatsapp_baileys_auth
        WHERE location_id = ${p.locationId}::uuid AND generation = ${s.generation}::uuid AND record_type = 'creds' AND key_id = 'main'`;
      if (!cred) throw new BaileysError('baileys_precisa_qr', 'Gere um novo QR para conectar o número.');
      await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET desired = true, status = 'reconectando',
        retry_at = NULL, attempts = 0, last_error = NULL, updated_at = now() WHERE location_id = ${p.locationId}::uuid`;
    }
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.settings_changed',
      entity: 'whatsapp_baileys', entityId: p.locationId, after: { acao: p.novoQr ? 'parear' : 'reconectar' } });
  });
}

export async function desconectarBaileys(p: AtorBaileys): Promise<void> {
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    await tx.$queryRaw`SELECT location_id FROM whatsapp_baileys_sessions WHERE location_id = ${p.locationId}::uuid FOR UPDATE`;
    await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET desired = false, status = 'desconectado',
      logout_generation = generation, generation = gen_random_uuid(), qr_cipher = NULL, qr_until = NULL, pairing_until = NULL,
      owner_token = NULL, lease_until = NULL, phone_hash = NULL, phone_e164 = NULL, last_error = NULL, updated_at = now()
      WHERE location_id = ${p.locationId}::uuid`;
    await tx.$executeRaw`DELETE FROM whatsapp_baileys_auth WHERE location_id = ${p.locationId}::uuid`;
    await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'failed', last_error = 'desconectado', updated_at = now()
      WHERE location_id = ${p.locationId}::uuid AND status = 'queued'`;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.settings_changed',
      entity: 'whatsapp_baileys', entityId: p.locationId, after: { acao: 'desconectar' } });
  });
}

export async function adquirirSessao(p: EscopoBaileys): Promise<PosseBaileys | null> {
  const token = randomUUID();
  return withTenant(p.tenantId, async tx => {
    const [r] = await tx.$queryRaw<{ generation: string }[]>`
      UPDATE whatsapp_baileys_sessions s SET owner_token = ${token}::uuid,
        lease_until = now() + interval '30 seconds', status = 'conectando', updated_at = now()
       WHERE location_id = ${p.locationId}::uuid AND desired
         AND EXISTS (SELECT 1 FROM tenant_platform WHERE tenant_id = ${p.tenantId}::uuid AND blocked_at IS NULL)
         AND (lease_until IS NULL OR lease_until < now()) AND (retry_at IS NULL OR retry_at <= now())
         AND EXISTS (SELECT 1 FROM whatsapp_channels c WHERE c.location_id = s.location_id AND c.transport = 'baileys')
      RETURNING generation
    `;
    if (r) await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'uncertain',
      last_error = 'worker_interrompido', updated_at = now()
      WHERE location_id = ${p.locationId}::uuid AND status = 'sending'`;
    return r ? { ...p, generation: r.generation, ownerToken: token } : null;
  });
}
export async function renovarSessao(p: PosseBaileys): Promise<boolean> {
  return withTenant(p.tenantId, async tx => (await tx.$executeRaw`
    UPDATE whatsapp_baileys_sessions SET lease_until = now() + interval '30 seconds'
     WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid
       AND owner_token = ${p.ownerToken}::uuid AND desired AND lease_until > now()
       AND EXISTS (SELECT 1 FROM tenant_platform WHERE tenant_id = ${p.tenantId}::uuid AND blocked_at IS NULL)
  `) === 1);
}
export async function comPosse<T>(p: PosseBaileys, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return withTenant(p.tenantId, async tx => {
    const [s] = await tx.$queryRaw<{ location_id: string }[]>`SELECT location_id FROM whatsapp_baileys_sessions
      WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid
        AND owner_token = ${p.ownerToken}::uuid AND desired AND lease_until > now()
       AND EXISTS (SELECT 1 FROM tenant_platform WHERE tenant_id = ${p.tenantId}::uuid AND blocked_at IS NULL) FOR UPDATE`;
    if (!s) throw new BaileysError('baileys_posse_perdida', 'A conexão está sendo retomada.');
    return fn(tx);
  });
}

export function armazenamentoDeAuth(p: PosseBaileys) {
  const escopo = (tipo: string, id: string) => JSON.stringify([p.tenantId, p.locationId, p.generation, tipo, id]);
  return {
    ler: async (tipo: string, ids: string[]): Promise<Record<string, unknown>> => comPosse(p, async tx => {
      const rows = await tx.$queryRaw<{ key_id: string; cipher: string }[]>`SELECT key_id, cipher FROM whatsapp_baileys_auth
        WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid AND record_type = ${tipo} AND key_id = ANY(${ids}::text[])`;
      return Object.fromEntries(rows.map(r => [r.key_id, desserializarBaileys(decifrarBaileys(r.cipher, escopo(tipo, r.key_id)))]));
    }),
    gravar: async (dados: Record<string, Record<string, unknown> | undefined>): Promise<void> => comPosse(p, async tx => {
      // Baileys já agrupa as mutações de uma transação Signal. Todo o lote
      // precisa de um único commit; metade gravada inutilizaria a sessão.
      for (const [tipo, itens] of Object.entries(dados)) for (const [id, valor] of Object.entries(itens ?? {})) {
        if (!tipo || tipo.length > 100 || !id || id.length > 512) throw new Error('baileys_chave_invalida');
        if (valor == null) await tx.$executeRaw`DELETE FROM whatsapp_baileys_auth
          WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid AND record_type = ${tipo} AND key_id = ${id}`;
        else {
          const cipher = cifrarBaileys(serializarBaileys(valor), escopo(tipo, id));
          await tx.$executeRaw`INSERT INTO whatsapp_baileys_auth (tenant_id, location_id, generation, record_type, key_id, cipher)
            VALUES (${p.tenantId}::uuid, ${p.locationId}::uuid, ${p.generation}::uuid, ${tipo}, ${id}, ${cipher})
            ON CONFLICT (location_id, generation, record_type, key_id) DO UPDATE SET cipher = EXCLUDED.cipher, updated_at = now()`;
        }
      }
    }),
  };
}
