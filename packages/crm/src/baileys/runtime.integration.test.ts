import { PrismaClient } from '@prisma/client';
import { withTenant } from '@barbearia/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { selecionarCanal, solicitarConexaoBaileys, situacaoBaileys, desconectarBaileys } from './sessao.js';
import { exportarDadosDoTitular } from '../lgpd.js';
import { anonimizarCliente } from '../anonimizacao.js';
import { expirarConteudoBaileys } from './retencao.js';
import { salvarTextoBaileys, textoBaileysParaEnvio } from './textos.js';
import { enviarNoCanalDaUnidade } from '../whatsapp-canal.js';
import { conciliarEnviosBaileys } from './conciliacao.js';
import { criarCampanha, despacharCampanha } from '../campanha.js';
import { templatesDaUnidade } from '../whatsapp-templates.js';
import { registrarDesfechoDaNotificacao } from '@barbearia/jobs';
import { RuntimeBaileys } from './runtime.js';
import type { EventosSocketBaileys, FabricaBaileys, SocketBaileys } from './socket.js';
import { aguardarEnvioBaileys, prepararEnvioBaileys } from './outbox.js';

const TENANT = '64111111-1111-1111-1111-111111111111';
const RIVAL = '64222222-2222-2222-2222-222222222222';
const LOCATION = '64111111-0000-0000-0000-000000000001';
const STAFF = '64111111-0000-0000-0000-000000000002';
const CUSTOMER = '64111111-0000-0000-0000-000000000003';
const ator = { tenantId: TENANT, locationId: LOCATION, staffId: STAFF, staffName: 'Operadora sintetica' };
const CONTEUDO = { telefone: '+5511999993333', texto: 'Mensagem sintetica', customerId: CUSTOMER, templateId: null, appointmentId: null };
const describeDb = process.env['SEED_DATABASE_URL'] && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
let admin: PrismaClient; let runtimes: RuntimeBaileys[] = [];

class FakeSocket implements SocketBaileys {
  logoutChamado = false; fechado = false; consultavel = true; perderResposta = false;
  readonly envios: { jid: string; texto: string; id: string }[] = [];
  constructor(readonly eventos: EventosSocketBaileys) {}
  numero() { return '5511999991111:2@s.whatsapp.net'; }
  async consultarNumero() { return this.consultavel ? '5511999993333@s.whatsapp.net' : null; }
  async enviar(jid: string, texto: string, id: string) {
    this.envios.push({ jid, texto, id });
    if (this.perderResposta) throw new Error('rede interrompida depois do envio');
  }
  fechar() { this.fechado = true; }
  async logout() { this.logoutChamado = true; this.fechar(); }
  ack(id: string, status: number, jid = '5511999993333@s.whatsapp.net') {
    this.eventos.recibos([{ key: { id, remoteJid: jid, fromMe: true }, update: { status } }]);
  }
}
class FakeFabrica implements FabricaBaileys {
  readonly sockets: FakeSocket[] = [];
  async criar(_p: unknown, eventos: EventosSocketBaileys) {
    const socket = new FakeSocket(eventos); this.sockets.push(socket); return socket;
  }
}
function novoRuntime(fabrica = new FakeFabrica()) {
  const r = new RuntimeBaileys(fabrica); runtimes.push(r); return { r, fabrica };
}
describeDb('Baileys com banco, outbox e socket sintético', () => {
  beforeAll(() => { admin = new PrismaClient({ datasources: { db: { url: process.env['SEED_DATABASE_URL'] ?? '' } } }); });
  afterAll(async () => { await admin?.$disconnect(); });
  afterEach(async () => { for (const r of runtimes) await r.parar(); runtimes = []; vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vi.stubEnv('BAILEYS_HABILITADO', '1'); vi.stubEnv('WHATSAPP_TOKEN_KEY', Buffer.alloc(32, 29).toString('base64'));
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRaw`INSERT INTO tenants(id,name) VALUES (${TENANT}::uuid,'Sintetica'),(${RIVAL}::uuid,'Vizinha')`;
    await admin.$executeRaw`INSERT INTO locations(id,tenant_id,name) VALUES (${LOCATION}::uuid,${TENANT}::uuid,'Matriz')`;
    await admin.$executeRaw`INSERT INTO staff_users(id,tenant_id,name,email,password_hash,role)
      VALUES (${STAFF}::uuid,${TENANT}::uuid,'Operadora','sintetica@example.invalid','x','owner')`;
    await admin.$executeRaw`INSERT INTO customers(id,tenant_id,name,phone_e164,accepts_marketing)
      VALUES (${CUSTOMER}::uuid,${TENANT}::uuid,'Cliente sintetico','+5511999993333',true)`;
    await selecionarCanal({ ...ator, canal: 'baileys' });
  });
  async function conectar() {
    await solicitarConexaoBaileys({ ...ator, novoQr: true });
    const { r, fabrica } = novoRuntime(); await r.rodarUmaVez(true); await r.aguardarOciosidade();
    const s = fabrica.sockets[0]; if (!s) throw new Error('nao abriu socket');
    s.eventos.conexao({ connection: 'open' }); await r.aguardarOciosidade();
    expect((await situacaoBaileys(ator)).estado).toBe('conectado');
    return { r, s, fabrica };
  }
  async function enviar(r: RuntimeBaileys, intentKey = 'teste:1') {
    const envio = await prepararEnvioBaileys({ ...ator, intentKey, conteudo: CONTEUDO });
    await r.rodarUmaVez(); await r.aguardarOciosidade(); return envio;
  }
  it('descoberta avança após 100 rotas e não fecha sessões de outra página', async () => {
    await solicitarConexaoBaileys({ ...ator, novoQr: true });
    await admin.$executeRaw`INSERT INTO locations(id,tenant_id,name)
      SELECT ('00111111-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,${TENANT}::uuid,'Sintética'
      FROM generate_series(1,100) n`;
    await admin.$executeRaw`INSERT INTO whatsapp_baileys_sessions(location_id,tenant_id,desired,owner_token,lease_until)
      SELECT id,tenant_id,true,gen_random_uuid(),now()+interval '1 hour' FROM locations WHERE id<>${LOCATION}::uuid`;
    const {r,fabrica}=novoRuntime();
    await r.rodarUmaVez(true);expect(fabrica.sockets).toHaveLength(0);
    await r.rodarUmaVez(true);expect(fabrica.sockets).toHaveLength(1);
    await r.rodarUmaVez(true);expect(fabrica.sockets[0]?.fechado).toBe(false);
  });
  it('perda da posse durante envio impede o runtime antigo de confirmar a saída',async()=>{
    const {r,s}=await conectar();
    let iniciou=()=>{};const iniciado=new Promise<void>(resolve=>{iniciou=resolve;});
    let terminar=()=>{};const terminou=new Promise<void>(resolve=>{terminar=resolve;});
    s.enviar=async()=>{iniciou();await terminou;};
    const envio=await prepararEnvioBaileys({...ator,intentKey:'posse:em-voo',conteudo:CONTEUDO});
    await r.rodarUmaVez();await iniciado;
    const ocioso=r.aguardarOciosidade();
    try {
      await admin.$executeRaw`UPDATE whatsapp_baileys_sessions SET lease_until=now()-interval '1 second'`;
      await r.renovar();expect(s.fechado).toBe(true);
      const outro=novoRuntime();await outro.r.rodarUmaVez(true);
      s.ack(envio.message_id,2);
    } finally {terminar();}
    await ocioso;
    const [linha]=await admin.$queryRaw<{status:string}[]>`SELECT status FROM whatsapp_baileys_outbox WHERE id=${envio.id}::uuid`;
    expect(linha?.status).toBe('uncertain');
  });
  it('não abre socket sem pareamento solicitado; QR cifrado expira e desaparece ao conectar', async () => {
    const { r, fabrica } = novoRuntime(); await r.rodarUmaVez(true);
    expect(fabrica.sockets).toHaveLength(0);
    await solicitarConexaoBaileys({ ...ator, novoQr: true }); await r.rodarUmaVez(true);
    const s = fabrica.sockets[0]; if (!s) throw new Error('sem socket');
    s.eventos.conexao({ qr: 'qr-sintetico-sem-valor' }); await r.aguardarOciosidade();
    expect((await situacaoBaileys(ator)).qr).toBe('qr-sintetico-sem-valor');
    const rows = await admin.$queryRaw<{ qr_cipher: string }[]>`SELECT qr_cipher FROM whatsapp_baileys_sessions`;
    expect(rows[0]?.qr_cipher).not.toContain('qr-sintetico');
    expect((await situacaoBaileys(ator, new Date(Date.now() + 31_000))).qr).toBeNull();
    s.eventos.conexao({ connection: 'open' }); await r.aguardarOciosidade();
    expect((await situacaoBaileys(ator)).qr).toBeNull();
  });
  it('só ACK do servidor confirma; destinatário alheio, pending e ID local não bastam', async () => {
    const { r, s } = await conectar(); const envio = await enviar(r);
    expect(s.envios).toHaveLength(1);
    await expect(aguardarEnvioBaileys(ator, envio.id, 0)).rejects.toHaveProperty('referencia');
    s.ack(envio.message_id, 1); s.ack(envio.message_id, 2, '5511999997777@s.whatsapp.net'); await r.aguardarOciosidade();
    await expect(aguardarEnvioBaileys(ator, envio.id, 0)).rejects.toHaveProperty('referencia');
    s.ack(envio.message_id, 2); await r.aguardarOciosidade();
    expect((await aguardarEnvioBaileys(ator, envio.id, 0)).wamid).toContain(envio.message_id);
    s.ack(envio.message_id, 4); s.ack(envio.message_id, 3); s.ack(envio.message_id, 0); await r.aguardarOciosidade();
    const [linha] = await admin.$queryRaw<{ status: string }[]>`SELECT status FROM whatsapp_baileys_outbox WHERE id=${envio.id}::uuid`;
    expect(linha?.status).toBe('read');
    const [log] = await admin.$queryRaw<{ status: string }[]>`SELECT status FROM whatsapp_messages`;
    expect(log?.status).toBe('lida');
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM whatsapp_baileys_outbox`)).toEqual([]);
  });
  it('resposta perdida preserva intenção e recibo atrasado resolve sem reenvio', async () => {
    const { r, s } = await conectar(); s.perderResposta = true;
    const envio = await enviar(r); await r.rodarUmaVez(); await r.aguardarOciosidade();
    const repetido = await prepararEnvioBaileys({ ...ator, intentKey: 'teste:1', conteudo: CONTEUDO });
    expect(repetido.id).toBe(envio.id); expect(s.envios).toHaveLength(1);
    await expect(prepararEnvioBaileys({ ...ator, intentKey: 'teste:1', conteudo: { ...CONTEUDO, texto: 'outro' } }))
      .rejects.toMatchObject({ code: 'baileys_intencao_divergente' });
    s.ack(envio.message_id, 3); await r.aguardarOciosidade();
    expect((await aguardarEnvioBaileys(ator, envio.id, 0)).wamid).toContain(envio.message_id);
  });
  it('dois runtimes não abrem a mesma sessão; perda de lease fecha socket antigo', async () => {
    const { r, s } = await conectar(); const outro = novoRuntime();
    await outro.r.rodarUmaVez(true); expect(outro.fabrica.sockets).toHaveLength(0);
    await admin.$executeRaw`UPDATE whatsapp_baileys_sessions SET lease_until=now()-interval '1 second'`;
    await outro.r.rodarUmaVez(true); expect(outro.fabrica.sockets).toHaveLength(1);
    await r.renovar(); expect(s.fechado).toBe(true);
  });
  it('não envia após desconectar e uma falha conhecida de destinatário não vira sucesso', async () => {
    const { r, s } = await conectar(); s.consultavel = false;
    const envio = await enviar(r);
    await expect(aguardarEnvioBaileys(ator, envio.id, 0)).rejects.toMatchObject({ code: 'baileys_envio_recusado' });
    expect(s.envios).toHaveLength(0);
    await desconectarBaileys(ator); await r.renovar(); expect(s.fechado).toBe(true); expect(s.logoutChamado).toBe(true);
    await expect(prepararEnvioBaileys({ ...ator, intentKey: 'teste:novo', conteudo: CONTEUDO })).rejects.toMatchObject({ code: 'baileys_desconectado' });
  });
  it('PARAR por mensagem recebida entra uma vez na fila; grupo e histórico não viram comandos', async () => {
    const { r, s } = await conectar();
    const mensagem = { key: { id: 'INBOUNDTEST1', remoteJid: '5511999993333@s.whatsapp.net', fromMe: false }, message: { conversation: 'PARAR' } };
    s.eventos.mensagens({ type: 'append', messages: [mensagem] }); await r.aguardarOciosidade();
    expect(await admin.$queryRaw`SELECT id FROM whatsapp_inbound`).toEqual([]);
    s.eventos.mensagens({ type: 'notify', messages: [mensagem, mensagem,
      { ...mensagem, key: { ...mensagem.key, id: 'GROUP', remoteJid: '12345@g.us' } }] });
    await r.aguardarOciosidade();
    const recebidos = await admin.$queryRaw<{ payload: string; customer_id: string }[]>`SELECT payload,customer_id FROM whatsapp_inbound`;
    expect(recebidos).toHaveLength(1); expect(recebidos[0]?.payload).toContain('parar_de_receber');
    expect(recebidos[0]?.customer_id).toBe(CUSTOMER);
    const jobs = await admin.$queryRaw`SELECT id FROM jobs WHERE kind='whatsapp.responder'`;
    expect(jobs).toHaveLength(1);
  });
  it('erro transitório reconecta; logout exige novo pareamento e não abre sozinho', async () => {
    const { r, s, fabrica } = await conectar();
    s.eventos.conexao({ connection: 'close', erro: { output: { statusCode: 408 } } }); await r.aguardarOciosidade();
    expect((await situacaoBaileys(ator)).estado).toBe('reconectando');
    await admin.$executeRaw`UPDATE whatsapp_baileys_sessions SET retry_at=now()-interval '1 second'`;
    await r.rodarUmaVez(true); expect(fabrica.sockets).toHaveLength(2);
    const segundo = fabrica.sockets[1]; if (!segundo) throw new Error('sem reconexao');
    segundo.eventos.conexao({ connection: 'close', erro: { output: { statusCode: 401 } } }); await r.aguardarOciosidade();
    expect((await situacaoBaileys(ator)).estado).toBe('novo_qr');
    await r.rodarUmaVez(true); expect(fabrica.sockets).toHaveLength(2);
  });
  it('roteador usa texto local sem aprovação e aguarda ACK mesmo após o ID local', async () => {
    const { r, s } = await conectar();
    const t = await salvarTextoBaileys({ ...ator, texto: { titulo: 'Volte', tipo: 'retorno', corpo: 'Oi {{1}}, volte à {{2}}.', habilitado: true } });
    const lista = await templatesDaUnidade(TENANT, LOCATION);
    expect(lista[0]).toMatchObject({ estado: 'rascunho', canal: 'baileys', disponivel: true });
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT id FROM whatsapp_templates_disponiveis`)).toEqual([]);
    const resultado = enviarNoCanalDaUnidade({ ...ator, intentKey: 'router:1', tipo: 'retorno', telefone: CONTEUDO.telefone,
      variaveis: ['Cliente sintetico','Sintetica'], customerId: CUSTOMER, appointmentId: null, templateId: t.id });
    await vi.waitFor(async () => { expect(await admin.$queryRaw`SELECT id FROM whatsapp_baileys_outbox`).toHaveLength(1); });
    await r.rodarUmaVez(); await r.aguardarOciosidade();
    const envio = s.envios[0]; if (!envio) throw new Error('não enviou');
    expect(envio.texto).toContain('Oi Cliente sintetico, volte à Sintetica.');
    expect(envio.texto).toContain('responda PARAR');
    s.ack(envio.id, 2); await r.aguardarOciosidade();
    expect((await resultado)?.wamid).toContain(envio.id);
  });
  it('campanha incerta é conciliada pelo ACK tardio sem duplicar mensagem ou cota', async () => {
    const { r, s } = await conectar();
    const t = await salvarTextoBaileys({ ...ator, texto: { titulo: 'Volte', tipo: 'retorno', corpo: 'Oi {{1}}, volte à {{2}}.', habilitado: true } });
    const agora = new Date('2026-09-20T15:00:00Z');
    const ca = await criarCampanha({ tenantId: TENANT, staffId: STAFF, staffName: ator.staffName,
      nome: 'Sintetica', filtro: 'todos', valorDoFiltro: null, diaDaSemana: null, templateId: t.id, janelaDias: 7, agora });
    const resultado = await despacharCampanha({ tenantId: TENANT, campanhaId: ca.id, agora, timeZone: 'America/Bahia',
      enviar: async alvo => {
        expect(alvo.locationId).toBe(LOCATION);
        const texto = await textoBaileysParaEnvio({ ...ator, tipo: alvo.tipo, templateId: alvo.templateId, variaveis: [alvo.clienteNome, alvo.barbearia] });
        const envio = await prepararEnvioBaileys({ ...ator, intentKey: `promo:campanha:${alvo.id}`,
          conteudo: { ...CONTEUDO, ...texto, tipo: alvo.tipo } });
        await r.rodarUmaVez(); await r.aguardarOciosidade();
        return (await aguardarEnvioBaileys(ator, envio.id, 0)).wamid;
      } });
    expect(resultado).toEqual({ enviados: 0, pulados: 1 });
    expect(await admin.$queryRaw`SELECT id FROM notifications WHERE status='sent'`).toHaveLength(0);
    const envio = s.envios[0]; if (!envio) throw new Error('sem envio');
    s.ack(envio.id, 4); await r.aguardarOciosidade();
    expect(await conciliarEnviosBaileys(TENANT, new Date('2026-09-20T15:01:00Z'))).toBe(1);
    expect(await conciliarEnviosBaileys(TENANT, new Date('2026-09-20T15:02:00Z'))).toBe(0);
    const [alvo] = await admin.$queryRaw<{ sent_at: Date; skipped_reason: string | null; wamid: string }[]>`SELECT sent_at,skipped_reason,wamid FROM campaign_targets`;
    expect(alvo?.sent_at).toBeInstanceOf(Date); expect(alvo?.skipped_reason).toBeNull(); expect(alvo?.wamid).toContain(envio.id);
    expect(await admin.$queryRaw`SELECT id FROM notifications WHERE status='sent'`).toHaveLength(1);
    expect(await admin.$queryRaw`SELECT id FROM notification_send_intents WHERE status='sent' AND notification_id IS NOT NULL`).toHaveLength(1);
    await r.rodarUmaVez(); await r.aguardarOciosidade(); expect(s.envios).toHaveLength(1);
  });
  it('ACK tardio corrige o histórico de aviso incerto e preserva monotonicidade', async () => {
    const { r, s } = await conectar(); const key = 'aviso:sintetico';
    await admin.$executeRaw`INSERT INTO notification_send_intents(tenant_id,intent_key,status) VALUES (${TENANT}::uuid,${key},'sending')`;
    const envio = await prepararEnvioBaileys({ ...ator, intentKey: key, conteudo: { ...CONTEUDO, tipo: 'sua_vez' } });
    await r.rodarUmaVez(); await r.aguardarOciosidade();
    const dados = { intentKey: key, tipo: 'sua_vez' as const, customerId: CUSTOMER, phoneMasked: null, agora: new Date() };
    await withTenant(TENANT, tx => registrarDesfechoDaNotificacao(tx, { ...dados, estado: 'uncertain' }));
    s.ack(envio.message_id, 2); await r.aguardarOciosidade();
    await conciliarEnviosBaileys(TENANT, new Date(Date.now()+60_000));
    await withTenant(TENANT, tx => registrarDesfechoDaNotificacao(tx, { ...dados, estado: 'uncertain' }));
    // O primeiro resultado incerto permanece; a confirmação é um novo fato vinculado.
    expect(await admin.$queryRaw`SELECT id FROM notifications`).toHaveLength(2);
    expect(await admin.$queryRaw`SELECT id FROM notifications WHERE previous_notification_id IS NOT NULL`).toHaveLength(1);
    expect(await admin.$queryRaw`SELECT id FROM notifications WHERE status='sent' AND reason IS NULL`).toHaveLength(1);
  });
  it('revogar consentimento depois de enfileirar impede a transmissão promocional', async () => {
    const { r, s } = await conectar();
    const envio = await prepararEnvioBaileys({ ...ator, intentKey: 'optout:1', conteudo: { ...CONTEUDO, tipo: 'retorno' } });
    await admin.$executeRaw`UPDATE customers SET accepts_marketing=false WHERE id=${CUSTOMER}::uuid`;
    await r.rodarUmaVez(); await r.aguardarOciosidade();
    expect(s.envios).toHaveLength(0);
    await expect(aguardarEnvioBaileys(ator,envio.id,0)).rejects.toMatchObject({ code: 'baileys_envio_recusado' });
  });

  it('retenção remove o conteúdo sem permitir reenvio da mesma intenção', async () => {
    const { r, s } = await conectar(); const envio = await enviar(r);
    s.ack(envio.message_id, 2); await r.aguardarOciosidade();
    expect(await expirarConteudoBaileys(TENANT, new Date(Date.now()+8*86_400_000))).toBe(1);
    const [limpa] = await admin.$queryRaw<{ payload_cipher: string | null; customer_id: string | null; recipient_hash: string | null }[]>`
      SELECT payload_cipher,customer_id,recipient_hash FROM whatsapp_baileys_outbox`;
    expect(limpa).toEqual({ payload_cipher: null, customer_id: null, recipient_hash: null });
    expect((await prepararEnvioBaileys({ ...ator, intentKey: 'teste:1', conteudo: CONTEUDO })).id).toBe(envio.id);
    await r.rodarUmaVez(); await r.aguardarOciosidade(); expect(s.envios).toHaveLength(1);
  });
  it.each(['queued', 'sending', 'uncertain', 'sent'] as const)('anonimização limpa mensagem %s e recibo atrasado não restaura dados', async (estado) => {
    const { r, s } = await conectar();
    const envio = await prepararEnvioBaileys({ ...ator, intentKey: 'anonimizar:1', conteudo: CONTEUDO });
    if (estado === 'sending') {
      // Estado persistido de um processo interrompido depois de tomar a mensagem.
      // A função real de anonimização precisa limpar também essa tentativa.
      await admin.$executeRaw`UPDATE whatsapp_baileys_outbox SET status='sending', started_at=now(), recipient_hash='sintetico'`;
    }
    if (estado === 'uncertain' || estado === 'sent') { await r.rodarUmaVez(); await r.aguardarOciosidade(); }
    if (estado === 'sent') { s.ack(envio.message_id, 2); await r.aguardarOciosidade(); }
    expect(await admin.$queryRaw`SELECT status FROM whatsapp_baileys_outbox`).toEqual([{ status: estado }]);
    expect((await anonimizarCliente({ tenantId: TENANT, customerId: CUSTOMER,
      motivo: 'Pedido sintetico do titular', ator: { id: STAFF, name: ator.staffName } })).anonimizado).toBe(true);
    s.ack(envio.message_id, 3); await r.aguardarOciosidade();
    expect(await admin.$queryRaw`SELECT payload_cipher, customer_id, recipient_hash, status,
      redacted_at IS NOT NULL AS redacted FROM whatsapp_baileys_outbox`).toEqual([{
      payload_cipher: null, customer_id: null, recipient_hash: null, redacted: true,
      status: estado === 'queued' ? 'failed' : estado === 'sent' ? 'sent' : 'uncertain',
    }]);
    await r.rodarUmaVez(); await r.aguardarOciosidade();
    expect(s.envios).toHaveLength(estado === 'queued' || estado === 'sending' ? 0 : 1);
  });

  it('recusa conhecida permite outra tentativa; mantém a tentativa anterior imutável', async () => {
    const { r, s } = await conectar(); s.consultavel = false;
    const anterior = await enviar(r, 'retry:mesmo-fato');
    s.consultavel = true;
    const nova = await prepararEnvioBaileys({ ...ator, intentKey: 'retry:mesmo-fato', conteudo: CONTEUDO });
    expect(nova.id).not.toBe(anterior.id); expect(nova.attempt).toBe(2);
    await admin.$executeRaw`UPDATE whatsapp_baileys_sessions SET next_send_at=now()-interval '1 second'`;
    await r.rodarUmaVez(); await r.aguardarOciosidade();
    s.ack(nova.message_id,2); await r.aguardarOciosidade();
    expect(s.envios).toHaveLength(1);
    expect((await aguardarEnvioBaileys(ator,nova.id,0)).wamid).toContain(nova.message_id);
    await expect(aguardarEnvioBaileys(ator,anterior.id,0)).rejects.toMatchObject({ code: 'baileys_envio_recusado' });
  });
  it('LID usa telefone associado e alteração de horário exige resposta ao aviso do destinatário', async () => {
    const { r, s } = await conectar();
    const prof = '64111111-0000-0000-0000-000000000099'; const appointment = '64111111-0000-0000-0000-000000000088';
    await admin.$executeRaw`INSERT INTO professionals(id,tenant_id,location_id,name,kind)
      VALUES (${prof}::uuid,${TENANT}::uuid,${LOCATION}::uuid,'Profissional sintetico','professional')`;
    await admin.$executeRaw`INSERT INTO appointments(id,tenant_id,location_id,professional_id,customer_id,starts_at,ends_at,service_starts_at,service_ends_at)
      VALUES (${appointment}::uuid,${TENANT}::uuid,${LOCATION}::uuid,${prof}::uuid,${CUSTOMER}::uuid,
        now()+interval '1 day',now()+interval '1 day 30 minutes',now()+interval '1 day',now()+interval '1 day 30 minutes')`;
    const envio = await prepararEnvioBaileys({ ...ator, intentKey: 'appointment:1', conteudo: { ...CONTEUDO, appointmentId: appointment, tipo: 'confirmacao' } });
    await r.rodarUmaVez(); await r.aguardarOciosidade(); s.ack(envio.message_id,2); await r.aguardarOciosidade();
    expect(s.envios).toHaveLength(1);
    expect(await aguardarEnvioBaileys(ator,envio.id,0)).toEqual({ wamid: `baileys:${LOCATION}:${envio.message_id}` });
    const key = { remoteJid: '123456789012345@lid', senderPn: '5511999993333@s.whatsapp.net', fromMe: false };
    s.eventos.mensagens({ type: 'notify', messages: [
      { key: { ...key, id: 'COM-CITACAO' }, message: { extendedTextMessage: { text: 'CONFIRMAR', contextInfo: { stanzaId: envio.message_id } } } },
      { key: { ...key, id: 'SEM-CITACAO' }, message: { conversation: 'CANCELAR' } },
      { key: { ...key, id: 'OUTRA-PESSOA', senderPn: '5511999994444@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'CANCELAR', contextInfo: { stanzaId: envio.message_id } } } },
    ] });
    await r.aguardarOciosidade();
    const inbound = await admin.$queryRaw<{ wamid: string; payload: string | null }[]>`SELECT wamid,payload FROM whatsapp_inbound ORDER BY received_at`;
    expect(inbound.find(m => m.wamid.endsWith('COM-CITACAO'))?.payload).toBe('confirmar:'+appointment);
    expect(inbound.find(m => m.wamid.endsWith('SEM-CITACAO'))?.payload).toBeNull();
    expect(inbound.find(m => m.wamid.endsWith('OUTRA-PESSOA'))?.payload).toBeNull();
  });
  it('parada aguarda abertura em curso e fecha o socket antes de liberar o banco', async () => {
    await solicitarConexaoBaileys({ ...ator, novoQr: true });
    let liberar!: () => void; const barreira = new Promise<void>(r => { liberar = r; });
    let entrou!: () => void; const criando = new Promise<void>(r => { entrou = r; });
    const fabrica = new FakeFabrica();
    const runtime = new RuntimeBaileys({ criar: async (p,eventos) => { entrou(); await barreira; return fabrica.criar(p,eventos); } });
    runtimes.push(runtime);
    const rodada = runtime.rodarUmaVez(true); await criando;
    let parou = false; const parada = runtime.parar().then(() => { parou = true; });
    await Promise.resolve(); expect(parou).toBe(false);
    liberar(); await rodada; await parada;
    expect(fabrica.sockets[0]?.fechado).toBe(true);
    expect(await admin.$queryRaw`SELECT location_id FROM whatsapp_baileys_sessions WHERE owner_token IS NOT NULL`).toEqual([]);
  });
  it('bloqueio do tenant fecha a sessão e não permite reabri-la na descoberta', async () => {
    const { r, s, fabrica } = await conectar();
    await admin.$executeRaw`UPDATE tenant_platform SET blocked_at=now(), blocked_reason='Bloqueio sintético para teste' WHERE tenant_id=${TENANT}::uuid`;
    await r.renovar(); expect(s.fechado).toBe(true);
    await r.rodarUmaVez(true); expect(fabrica.sockets).toHaveLength(1);
  });
  it('exportação do titular entrega o texto próprio sem chaves de sessão ou de cifra', async () => {
    const { r } = await conectar(); await enviar(r);
    const dados = await exportarDadosDoTitular(TENANT,CUSTOMER);
    expect(dados.whatsappBaileys).toHaveLength(1); expect(dados.whatsappBaileys[0]?.['texto']).toBe(CONTEUDO.texto);
    expect(JSON.stringify(dados.whatsappBaileys)).not.toContain('cipher');
    await expect(exportarDadosDoTitular(RIVAL,CUSTOMER)).rejects.toThrow();
  });

});
