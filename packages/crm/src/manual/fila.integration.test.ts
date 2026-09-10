import { exportarDadosDoTitular } from '../lgpd.js';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';
import { prepararFilaManual, filaWhatsAppManual, abrirWhatsAppManual, concluirWhatsAppManual } from './fila.js';
import { salvarTextoWhatsAppManual, textosWhatsAppManual, configuracoesWhatsAppManual, ativarAutomacaoManual } from './textos.js';
import { criarCampanha, marcarParaEnvio, despacharCampanha, campanhasDaCasa } from '../campanha.js';
import { salvarAutomacao, varrerAutomacoes, automacoesDaCasa } from '../automacao.js';
import { despacharAutomacoes } from '../automacao-despacho.js';
import { reservarDisparoPromocional } from '../disparo-promocional.js';
const rodar = process.env['SEED_DATABASE_URL'] && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
const tenantId = randomUUID(), vizinho = randomUUID(), locationId = randomUUID(), outraUnidade = randomUUID();
const staffId = randomUUID(), outroStaff = randomUUID(), customerId = randomUUID();
const ator = { tenantId, locationId, staffId, staffName: 'Operadora' };
const agora = new Date('2026-09-10T15:00:00Z');
let admin: PrismaClient;
rodar('WhatsApp manual: fila real, sem transporte externo', () => {
  beforeAll(() => { admin = new PrismaClient({ datasources: { db: { url: process.env['SEED_DATABASE_URL']! } } }); });
  afterAll(async () => { await admin?.$disconnect(); });
  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRaw`INSERT INTO tenants (id, name) VALUES (${tenantId}::uuid, 'Casa'), (${vizinho}::uuid, 'Vizinha')`;
    await admin.$executeRaw`INSERT INTO locations (id, tenant_id, name, timezone) VALUES (${locationId}::uuid, ${tenantId}::uuid, 'Matriz', 'America/Bahia'), (${outraUnidade}::uuid, ${tenantId}::uuid, 'Filial', 'America/Bahia')`;
    await admin.$executeRaw`INSERT INTO staff_users (id,tenant_id,name,email,password_hash,role) VALUES
      (${staffId}::uuid,${tenantId}::uuid,'Operadora','manual@example.invalid','x','owner'),
      (${outroStaff}::uuid,${tenantId}::uuid,'Segundo','manual2@example.invalid','x','owner')`;
    await admin.$executeRaw`INSERT INTO customers (id,tenant_id,name,phone_e164,accepts_marketing,birth_date)
      VALUES (${customerId}::uuid,${tenantId}::uuid,'Cliente Manual','+5571988887777',true,'1990-09-10')`;
  });
  async function campanha() {
    const t = await salvarTextoWhatsAppManual({ ...ator, titulo: 'Convite manual', corpo: 'Olá {{1}}, venha para {{2}}!', habilitado: true });
    const c = await criarCampanha({ ...ator, nome: 'Campanha manual', filtro: 'todos', valorDoFiltro: null, diaDaSemana: null,
      templateId: t.id, janelaDias: 7, agora });
    await marcarParaEnvio({ ...ator, campanhaId: c.id });
    const enviar = vi.fn();
    await despacharCampanha({ tenantId, campanhaId: c.id, agora, timeZone: 'America/Bahia', enviar });
    expect(enviar).not.toHaveBeenCalled();
    const [item] = (await filaWhatsAppManual(ator)).itens; expect(item).toBeDefined();
    return { id: item!.id, templateId: t.id, campanhaId: c.id };
  }
  it('prepara uma campanha uma única vez e abrir não conta como enviar', async () => {
    const c = await campanha(); await prepararFilaManual(tenantId, agora, c.campanhaId);
    expect((await filaWhatsAppManual(ator)).itens).toHaveLength(1);
    const aberto = await abrirWhatsAppManual({ ...ator, id: c.id, agora });
    expect(aberto.url).toMatch(/^https:\/\/wa.me\/5571988887777\?text=/);
    expect(aberto.texto).toContain('Olá Cliente Manual, venha para Casa!');
    expect(aberto.texto).toContain('PARAR');
    const dados = await exportarDadosDoTitular(tenantId, customerId);
    expect(dados.whatsappManual[0]?.['envio_confirmado_em']).toBeNull();
    expect(dados.whatsappManual[0]?.['conteudo_pendente']).toMatchObject({ texto: aberto.texto });
    const [antes] = (await filaWhatsAppManual(ator)).itens;
    expect(antes?.estado).toBe('em_atendimento'); expect(antes?.enviadoEm).toBeNull();
    expect(await admin.$queryRaw`SELECT id FROM notifications`).toHaveLength(0);
    const deNovo = await abrirWhatsAppManual({ ...ator, id: c.id, agora }); expect(deNovo).toEqual(aberto);
    await Promise.all([1,2].map(() => concluirWhatsAppManual({ ...ator, id: c.id, agora, acao: 'enviado' })));
    const [depois] = (await filaWhatsAppManual(ator)).itens;
    expect(depois?.estado).toBe('enviado'); expect(depois?.enviadoPor).toBe('Operadora');
    expect(await admin.$queryRaw`SELECT id FROM notifications`).toHaveLength(1);
    expect(await admin.$queryRaw`SELECT id FROM whatsapp_messages`).toHaveLength(0);
    expect(await admin.$queryRaw`SELECT id FROM whatsapp_baileys_outbox`).toHaveLength(0);
    expect(await admin.$queryRaw`SELECT payload_cipher FROM whatsapp_manual_queue`).toEqual([{ payload_cipher: null }]);
    expect((await configuracoesWhatsAppManual(ator)).campanhas[0]?.enviados).toBe(1);
    expect(await campanhasDaCasa({ tenantId, podeVerReceita: false })).toHaveLength(0);
  });
  it('dois operadores disputam a mesma reserva e somente o vencedor confirma', async () => {
    const { id } = await campanha(); const resultados = await Promise.allSettled([
      abrirWhatsAppManual({ ...ator, id, agora }), abrirWhatsAppManual({ ...ator, staffId: outroStaff, id, agora }),
    ]); expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const item = (await filaWhatsAppManual(ator)).itens[0]!;
    const perdedor = item.operadorId === staffId ? outroStaff : staffId;
    await expect(concluirWhatsAppManual({ ...ator, staffId: perdedor, id, agora, acao: 'enviado' })).rejects.toMatchObject({ code: 'manual_ocupado' });
    await concluirWhatsAppManual({ ...ator, staffId: item.operadorId!, id, agora, acao: 'liberar' });
    await expect(abrirWhatsAppManual({ ...ator, staffId: perdedor, id, agora })).resolves.toHaveProperty('url');
  });
  it('recusa confirmar sem abrir e isola outra unidade e outro tenant por RLS', async () => {
    const { id, templateId } = await campanha();
    await expect(concluirWhatsAppManual({ ...ator, id, agora, acao: 'enviado' })).rejects.toMatchObject({ code: 'manual_nao_aberto' });
    expect((await filaWhatsAppManual({ ...ator, locationId: outraUnidade })).itens).toHaveLength(0);
    expect(await withTenant(vizinho, tx => tx.$queryRaw`SELECT id FROM whatsapp_manual_queue`)).toHaveLength(0);
    await expect(abrirWhatsAppManual({ ...ator, locationId: outraUnidade, id, agora })).rejects.toMatchObject({ status: 404 });
    await expect(abrirWhatsAppManual({ ...ator, tenantId: vizinho, id, agora })).rejects.toMatchObject({ status: 404 });
    await expect(salvarTextoWhatsAppManual({ ...ator, locationId: outraUnidade, id: templateId, titulo: 'Ataque', corpo: 'Não pode alterar', habilitado: true })).rejects.toMatchObject({ status: 404 });
    expect(await textosWhatsAppManual({ ...ator, locationId: outraUnidade })).toHaveLength(0);
  });
  it('revogação entre fila e abertura impede a conversa e preserva histórico do opt-out manual', async () => {
    const { id } = await campanha();
    await concluirWhatsAppManual({ ...ator, id, agora, acao: 'optout' });
    expect(await admin.$queryRaw`SELECT accepts_marketing FROM customers WHERE id = ${customerId}::uuid`).toEqual([{ accepts_marketing: false }]);
    expect(await admin.$queryRaw`SELECT granted,text_version FROM customer_consents`).toEqual([{ granted: false, text_version: 'whatsapp-manual-parar-v1' }]);
    expect((await filaWhatsAppManual(ator)).itens[0]?.estado).toBe('descartado');
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_finalizado' });
  });
  it('relê consentimento, pausa e janela de silêncio na hora de abrir', async () => {
    const { id, templateId } = await campanha();
    await expect(abrirWhatsAppManual({ ...ator, id, agora: new Date('2026-09-10T03:00:00Z') })).rejects.toMatchObject({ code: 'manual_horario' });
    await admin.$executeRaw`UPDATE customers SET accepts_marketing = false WHERE id = ${customerId}::uuid`;
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_sem_consentimento' });
    await admin.$executeRaw`UPDATE customers SET accepts_marketing = true WHERE id = ${customerId}::uuid`;
    await salvarTextoWhatsAppManual({ ...ator, id: templateId, titulo: 'Pausada', corpo: 'Mensagem válida', habilitado: false });
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_desligado' });
  });
  it('manual ocupa a mesma cota das integrações e liberação explícita devolve a vaga', async () => {
    const { id } = await campanha(); await abrirWhatsAppManual({ ...ator, id, agora });
    const reservar = () => withTenant(tenantId, tx => reservarDisparoPromocional(tx, { tenantId, customerId, intentKey: 'promo:outra', tipo: 'retorno', agora, timeZone: 'America/Bahia' }));
    expect(await reservar()).toMatchObject({ nossa: false, motivo: 'ja_recebeu_hoje' });
    await concluirWhatsAppManual({ ...ator, id, agora, acao: 'liberar' });
    expect(await reservar()).toMatchObject({ nossa: true });
  });
  it('anonimização apaga conteúdo e torna impossível retomar a conversa', async () => {
    const { id } = await campanha(); await abrirWhatsAppManual({ ...ator, id, agora });
    await admin.$executeRaw`UPDATE customers SET anonymized_at = ${agora}, name = 'Anonimizado', phone_e164 = NULL WHERE id = ${customerId}::uuid`;
    expect(await admin.$queryRaw`SELECT payload_cipher,status FROM whatsapp_manual_queue`).toEqual([{ payload_cipher: null, status: 'descartado' }]);
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_finalizado' });
  });

  it('reserva humana atravessa o dia sem abrir outra cota e acompanha a data confirmada', async () => {
    const { id } = await campanha(); await abrirWhatsAppManual({ ...ator, id, agora });
    const amanha = new Date('2026-09-11T15:00:00Z');
    const reservar = () => withTenant(tenantId, tx => reservarDisparoPromocional(tx, { tenantId, customerId, intentKey: 'promo:amanha', tipo: 'retorno', agora: amanha, timeZone: 'America/Bahia' }));
    expect(await reservar()).toMatchObject({ nossa: false, motivo: 'ja_recebeu_hoje' });
    await concluirWhatsAppManual({ ...ator, id, agora: amanha, acao: 'enviado' });
    const [reserva] = await admin.$queryRaw<{ manual_pending: boolean; quota_date: Date }[]>`SELECT manual_pending,quota_date FROM notification_send_intents`;
    expect(reserva?.manual_pending).toBe(false); expect(reserva?.quota_date.toISOString().slice(0,10)).toBe('2026-09-11');
    expect(await reservar()).toMatchObject({ nossa: false, motivo: 'ja_recebeu_hoje' });
  });
  it('gestor assume uma reserva sem marcar enviado e operador comum não toma a reserva alheia', async () => {
    const { id } = await campanha(); await abrirWhatsAppManual({ ...ator, id, agora });
    await expect(concluirWhatsAppManual({ ...ator, staffId: outroStaff, id, agora, acao: 'assumir' })).rejects.toMatchObject({ status: 403 });
    await concluirWhatsAppManual({ ...ator, staffId: outroStaff, podeAssumir: true, id, agora, acao: 'assumir' });
    const [item] = (await filaWhatsAppManual(ator)).itens;
    expect(item?.operadorId).toBe(outroStaff); expect(item?.enviadoEm).toBeNull();
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_ocupado' });
    await expect(abrirWhatsAppManual({ ...ator, staffId: outroStaff, id, agora })).resolves.toHaveProperty('url');
  });
  it('troca de telefone exige fechar a conversa antiga e preparar novamente', async () => {
    const { id } = await campanha(); await abrirWhatsAppManual({ ...ator, id, agora });
    await admin.$executeRaw`UPDATE customers SET phone_e164 = '+5571999990000' WHERE id = ${customerId}::uuid`;
    await expect(abrirWhatsAppManual({ ...ator, id, agora })).rejects.toMatchObject({ code: 'manual_telefone_alterado' });
    await concluirWhatsAppManual({ ...ator, id, agora, acao: 'liberar' });
    expect((await abrirWhatsAppManual({ ...ator, id, agora })).telefone).toBe('+5571999990000');
  });
  it('não expõe mensagem manual como disponível para disparo avulso automático', async () => {
    await campanha();
    expect(await withTenant(tenantId, tx => tx.$queryRaw`SELECT id FROM whatsapp_templates_disponiveis WHERE transport = 'manual'`)).toHaveLength(0);
  });

  it('automação manual entra na fila, respeita pausa e nunca chama Meta/Baileys', async () => {
    const t = await salvarTextoWhatsAppManual({ ...ator, titulo: 'Aniversário', corpo: 'Parabéns {{1}}! Abraços da {{2}}.', habilitado: true });
    const a = await salvarAutomacao({ ...ator, nome: 'Aniversário manual', gatilho: 'aniversario', limiar: 0,
      atrasoMinutos: 0, tipo: 'retorno', templateId: t.id, objetivo: 'agendamento', janelaDias: 7, ativa: true });
    await varrerAutomacoes({ tenantId, agora, timeZone: 'America/Bahia' });
    const enviar = vi.fn(); expect(await despacharAutomacoes({ tenantId, agora, enviar })).toBe(0);
    expect(enviar).not.toHaveBeenCalled(); await despacharAutomacoes({ tenantId, agora, enviar });
    const fila = (await filaWhatsAppManual(ator)).itens; expect(fila).toHaveLength(1); expect(fila[0]?.tipo).toBe('automacao');
    expect(await automacoesDaCasa(tenantId)).toHaveLength(0);
    await expect(ativarAutomacaoManual({ ...ator, locationId: outraUnidade, id: a.id, ativa: false })).rejects.toMatchObject({ status: 404 });
    await ativarAutomacaoManual({ ...ator, id: a.id, ativa: false });
    await expect(abrirWhatsAppManual({ ...ator, id: fila[0]!.id, agora })).rejects.toMatchObject({ code: 'manual_desligado' });
    await ativarAutomacaoManual({ ...ator, id: a.id, ativa: true });
    await abrirWhatsAppManual({ ...ator, id: fila[0]!.id, agora });
    await concluirWhatsAppManual({ ...ator, id: fila[0]!.id, agora, acao: 'enviado' });
    expect((await configuracoesWhatsAppManual(ator)).automacoes[0]?.enviados).toBe(1);
  });

  it('banco recusa criar fila de automação com texto de outra origem e preserva o snapshot após edição', async () => {
    const original = await salvarTextoWhatsAppManual({ ...ator, titulo: 'Original', corpo: 'Parabéns {{1}}!', habilitado: true });
    const outro = await salvarTextoWhatsAppManual({ ...ator, titulo: 'Outro texto', corpo: 'Outro convite {{1}}', habilitado: true });
    const parametros = { ...ator, nome: 'Aniversário manual', gatilho: 'aniversario' as const, limiar: 0,
      atrasoMinutos: 0, tipo: 'retorno' as const, templateId: original.id, objetivo: 'agendamento' as const, janelaDias: 7, ativa: true };
    const automacao = await salvarAutomacao(parametros);
    await varrerAutomacoes({ tenantId, agora, timeZone: 'America/Bahia' });
    await expect(withTenant(tenantId, tx => tx.$executeRaw`INSERT INTO whatsapp_manual_queue
      (tenant_id,location_id,customer_id,template_id,automation_send_id,template_body,kind,created_at)
      SELECT tenant_id,${locationId}::uuid,customer_id,${outro.id}::uuid,id,'Outro convite {{1}}','retorno',${agora}
      FROM automation_sends WHERE automation_id = ${automacao.id}::uuid`)).rejects.toThrow();
    await prepararFilaManual(tenantId, agora);
    const item = (await filaWhatsAppManual(ator)).itens[0];
    if (!item) throw new Error('Fila não foi criada');
    await salvarAutomacao({ ...parametros, id: automacao.id, templateId: outro.id });
    // Editar o próximo disparo não reescreve a mensagem já preparada.
    expect((await abrirWhatsAppManual({ ...ator, id: item.id, agora })).texto).toContain('Parabéns Cliente Manual!');
    await concluirWhatsAppManual({ ...ator, id: item.id, agora, acao: 'enviado' });
  });
});
