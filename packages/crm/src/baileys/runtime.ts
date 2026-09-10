import { semTenant, withTenant } from '@barbearia/db';
import { montarPayload, naturezaDe, ESTADOS_EM_CURSO } from '@barbearia/core';
import { expirarConteudoBaileys } from './retencao.js';
import { conciliarEnviosBaileys } from './conciliacao.js';
import { registrarRespostaNaTransacao } from '../whatsapp-mensagens.js';
import { cifrarBaileys, hashBaileys } from './cofre.js';
import { adquirirSessao, comPosse, lerSessaoBaileys, renovarSessao, type PosseBaileys } from './sessao.js';
import { comandoDeTexto, jidDePessoa, motivoDeDesconexao, telefoneDoJid, tempoDeReconexao } from './semantica.js';
import { FabricaBaileysReal, type FabricaBaileys, type MensagemSocketBaileys, type SocketBaileys } from './socket.js';
import { aplicarReciboBaileys, conteudoDoEnvio, destinoDoEnvio, falhaDoEnvio, proximoEnvioBaileys,
  referenciaBaileys, textoParaRetryBaileys, type EnvioBaileys } from './outbox.js';

interface Viva {
  posse: PosseBaileys; socket: SocketBaileys | null; fechada: boolean;
  eventos: Promise<void>; envio: Promise<void> | null; pronta: Promise<void>; resolver: () => void;
}
function statusDaFalha(erro: unknown): number | undefined {
  if (!erro || typeof erro !== 'object' || !('output' in erro)) return undefined;
  const output = erro.output;
  return output && typeof output === 'object' && 'statusCode' in output && typeof output.statusCode === 'number' ? output.statusCode : undefined;
}

/** Um runtime pode possuir várias unidades; duas instâncias disputam leases no banco. */
export class RuntimeBaileys {
  private readonly vivas = new Map<string, Viva>();
  private parada = false;
  private rodadaAtiva = false;
  private rodadaPendente: Promise<void> | null = null;
  private renovacaoPendente: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private renovando = false;
  private proximaDescoberta = 0;
  private cursorDescoberta: string | null = null;
  constructor(private readonly fabrica: FabricaBaileys = new FabricaBaileysReal(),
    private readonly reportar: (codigo: string) => void = () => undefined) {}

  iniciar(): void {
    if (this.timer) return;
    this.parada = false;
    this.timer = setInterval(() => { void this.rodarUmaVez().catch(() => this.reportar('baileys_rodada_falhou')); }, 1_000);
    this.heartbeat = setInterval(() => { void this.renovar().catch(() => this.reportar('baileys_renovacao_falhou')); }, 5_000);
    void this.rodarUmaVez().catch(() => this.reportar('baileys_rodada_falhou'));
  }
  private evento(v: Viva, acao: () => Promise<void>): void {
    v.eventos = v.eventos.then(async () => { await v.pronta; if (!v.fechada) await acao(); }).catch(async () => {
      this.reportar('baileys_evento_falhou'); await this.encerrarLocal(v);
    });
  }
  renovar(): Promise<void> {
    if (this.renovacaoPendente) return this.renovacaoPendente;
    const atual = this.renovarInterno().finally(() => { this.renovacaoPendente = null; });
    this.renovacaoPendente = atual;
    return atual;
  }
  private async renovarInterno(): Promise<void> {
    if (this.renovando || this.parada) return;
    this.renovando = true;
    try {
      await Promise.all([...this.vivas.values()].map(async v => {
        try { if (!await renovarSessao(v.posse)) await this.encerrarLocal(v); }
        catch { await this.encerrarLocal(v); }
      }));
    } finally { this.renovando = false; }
  }
  rodarUmaVez(forcarDescoberta = false): Promise<void> {
    if (this.rodadaPendente) return this.rodadaPendente;
    const atual = this.rodarInterno(forcarDescoberta).finally(() => { this.rodadaPendente = null; });
    this.rodadaPendente = atual;
    return atual;
  }
  private async rodarInterno(forcarDescoberta: boolean): Promise<void> {
    if (this.rodadaAtiva || this.parada) return;
    this.rodadaAtiva = true;
    try {
      if (forcarDescoberta || Date.now() >= this.proximaDescoberta) {
        const rotas = await semTenant(tx => tx.$queryRaw<{ tenant_id: string; location_id: string }[]>`
          SELECT r.tenant_id, r.location_id FROM whatsapp_baileys_routes r JOIN tenant_platform t ON t.tenant_id = r.tenant_id
           WHERE t.blocked_at IS NULL AND (${this.cursorDescoberta}::uuid IS NULL OR r.location_id > ${this.cursorDescoberta}::uuid)
           ORDER BY r.location_id LIMIT 100`);
        // Cada rodada avança; sessões das páginas seguintes não são tomadas por
        // removidas. A renovação verifica bloqueio, geração e desejo de conexão.
        this.cursorDescoberta = rotas.length === 100 ? rotas[rotas.length - 1]!.location_id : null;
        for (const r of rotas) if (!this.parada && !this.vivas.has(r.location_id)) {
          const p = await adquirirSessao({ tenantId: r.tenant_id, locationId: r.location_id });
          if (p) await this.abrir(p);
        }
        for (const tenantId of new Set(rotas.map(r => r.tenant_id))) { await conciliarEnviosBaileys(tenantId); await expirarConteudoBaileys(tenantId); }
        this.proximaDescoberta = Date.now() + (this.cursorDescoberta ? 1_000 : 5_000);
      }
      for (const v of this.vivas.values()) if (!this.parada && !v.envio && !v.fechada) {
        v.envio = this.despachar(v).catch(() => this.reportar('baileys_despacho_falhou')).finally(() => { v.envio = null; });
      }
    } finally { this.rodadaAtiva = false; }
  }
  private async abrir(p: PosseBaileys): Promise<void> {
    const s = await lerSessaoBaileys(p); if (!s) return;
    let resolver: () => void = () => undefined;
    const pronta = new Promise<void>(resolve => { resolver = resolve; });
    const v: Viva = { posse: p, socket: null, fechada: false, eventos: Promise.resolve(), envio: null, pronta, resolver };
    this.vivas.set(p.locationId, v);
    const podeParear = s.pairing_until !== null && s.pairing_until > new Date();
    try {
      v.socket = await this.fabrica.criar(p, {
        conexao: e => this.evento(v, async () => {
          if (e.qr) {
            const atual = await lerSessaoBaileys(p);
            if (!atual?.pairing_until || atual.pairing_until <= new Date()) { await this.fecharComMotivo(v, true, 'qr_expirado'); return; }
            if (e.qr.length > 4096) throw new Error('baileys_qr_invalido');
            const cifra = cifrarBaileys(e.qr, `${p.tenantId}:${p.locationId}:${p.generation}:qr`);
            await comPosse(p, tx => tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET status = 'aguardando_qr',
              qr_cipher = ${cifra}, qr_until = LEAST(now() + interval '30 seconds', pairing_until), updated_at = now()
              WHERE location_id = ${p.locationId}::uuid`);
          }
          if (e.connection === 'open') {
            const numero = telefoneDoJid(v.socket?.numero());
            if (!numero) { await this.fecharComMotivo(v, true, 'numero_nao_identificado'); return; }
            try {
              await comPosse(p, tx => tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET status = 'conectado',
                phone_e164 = ${numero}, phone_hash = ${hashBaileys(numero)}, connected_at = now(), qr_cipher = NULL, qr_until = NULL,
                pairing_until = NULL, attempts = 0, last_error = NULL, updated_at = now() WHERE location_id = ${p.locationId}::uuid`);
            } catch { await this.fecharComMotivo(v, true, 'numero_ou_sessao_indisponivel'); }
          }
          if (e.connection === 'close') {
            const motivo = motivoDeDesconexao(statusDaFalha(e.erro));
            await this.fecharComMotivo(v, motivo.terminal, motivo.codigo);
          }
        }),
        mensagens: e => this.evento(v, async () => {
          if (e.type !== 'notify') return;
          for (const mensagem of e.messages) await this.receber(v, mensagem);
        }),
        recibos: e => this.evento(v, async () => {
          for (const r of e) if (r.key.fromMe && r.key.id && r.key.remoteJid) {
            await aplicarReciboBaileys(p, r.key.id, r.key.remoteJid, r.update.status);
          }
        }),
        falha: () => this.evento(v, () => this.fecharComMotivo(v, true, 'credencial_nao_persistida')),
      }, podeParear, (id, jid) => textoParaRetryBaileys(p, id, jid));
    } catch {
      await this.fecharComMotivo(v, true, 'pareamento_necessario');
    } finally { resolver(); }
  }
  private async fecharComMotivo(v: Viva, terminal: boolean, codigo: string): Promise<void> {
    try {
      const s = await lerSessaoBaileys(v.posse); const espera = tempoDeReconexao(s?.attempts ?? 0);
      await comPosse(v.posse, async tx => {
        await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'uncertain', last_error = 'conexao_interrompida', updated_at = now()
          WHERE location_id = ${v.posse.locationId}::uuid AND status = 'sending'`;
        await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET desired = ${!terminal},
          status = ${terminal ? 'novo_qr' : 'reconectando'}, owner_token = NULL, lease_until = NULL,
          qr_cipher = NULL, qr_until = NULL, last_error = ${codigo}, attempts = attempts + 1,
          retry_at = now() + (${espera} * interval '1 millisecond'), updated_at = now()
          WHERE location_id = ${v.posse.locationId}::uuid`;
      });
    } catch { this.reportar('baileys_fechamento_sem_posse'); }
    await this.encerrarLocal(v);
  }
  private async encerrarLocal(v: Viva): Promise<void> {
    if (v.fechada) return;
    v.fechada = true;
    try {
      const atual = await lerSessaoBaileys(v.posse);
      if (v.socket && atual?.logout_generation === v.posse.generation) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([v.socket.logout(), new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('logout_pendente')), 5_000);
          })]);
          await withTenant(v.posse.tenantId, tx => tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET logout_generation = NULL
            WHERE location_id = ${v.posse.locationId}::uuid AND logout_generation = ${v.posse.generation}::uuid`);
        } finally { if (timeout) clearTimeout(timeout); }
      }
    } catch { this.reportar('baileys_desvinculacao_remota_pendente'); }
    v.socket?.fechar();
    if (this.vivas.get(v.posse.locationId) === v) this.vivas.delete(v.posse.locationId);
    try {
      await withTenant(v.posse.tenantId, async tx => {
        // A posse já pode ter mudado; o token evita liberar a sessão nova.
        await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET owner_token = NULL, lease_until = NULL,
          status = CASE WHEN desired THEN 'reconectando' ELSE status END, updated_at = now()
          WHERE location_id = ${v.posse.locationId}::uuid AND owner_token = ${v.posse.ownerToken}::uuid`;
      });
    } catch { this.reportar('baileys_liberação_falhou'); }
  }
  private async despachar(v: Viva): Promise<void> {
    if (!v.socket || v.fechada) return;
    const r = await proximoEnvioBaileys(v.posse); if (!r) return;
    const c = conteudoDoEnvio(v.posse, r);
    let enviando = false;
    try {
      const jid = await v.socket.consultarNumero(c.telefone);
      if (!jid || !jidDePessoa(jid)) { await falhaDoEnvio(v.posse, r.id, false, 'destinatario_indisponivel'); return; }
      await destinoDoEnvio(v.posse, r.id, jid);
      // Última checagem antes do efeito externo, após a consulta de destinatário.
      const elegivel = await comPosse(v.posse, async tx => {
        if (c.customerId) {
          const [cliente] = await tx.$queryRaw<{ accepts_marketing: boolean }[]>`SELECT accepts_marketing FROM customers
            WHERE id = ${c.customerId}::uuid AND phone_e164 = ${c.telefone} AND anonymized_at IS NULL`;
          const [saida] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_inbound
            WHERE customer_id = ${c.customerId}::uuid AND handled_at IS NULL AND payload = 'parar_de_receber:' LIMIT 1`;
          if (((r.intent_key.startsWith('promo:') || (c.tipo && naturezaDe(c.tipo) === 'promocional')) && saida) || !cliente || ((r.intent_key.startsWith('promo:') || (c.tipo && naturezaDe(c.tipo) === 'promocional')) && !cliente.accepts_marketing)) return false;
        }
        if (c.appointmentId) {
          const [a] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM appointments WHERE id = ${c.appointmentId}::uuid
            AND location_id = ${v.posse.locationId}::uuid
            AND status = ANY(${[...ESTADOS_EM_CURSO]}::appointment_status[])`;
          if (!a) return false;
        }
        return true;
      });
      if (!elegivel) { await falhaDoEnvio(v.posse, r.id, false, 'destino_ou_consentimento_alterado'); return; }
      if (v.fechada) return;
      enviando = true;
      await v.socket.enviar(jid, c.texto, r.message_id);
      // sendMessage retorna a mensagem LOCAL. Só messages.update com ACK>=2
      // promove saída. Sem recibo, a próxima leitura permanece incerta.
      await falhaDoEnvio(v.posse, r.id, true, 'aguardando_confirmacao');
    } catch {
      await falhaDoEnvio(v.posse, r.id, enviando, enviando ? 'resultado_incerto' : 'consulta_destinatario_falhou').catch(() => undefined);
    }
  }
  private async receber(v: Viva, m: MensagemSocketBaileys): Promise<void> {
    if (m.key.fromMe || !m.key.id || !jidDePessoa(m.key.remoteJid)) return;
    if (m.messageStubType === 2) { this.reportar('baileys_mensagem_nao_decifrada'); return; }
    const telefone = telefoneDoJid(m.key.remoteJid) ?? telefoneDoJid(m.key.senderPn) ?? telefoneDoJid(m.key.remoteJidAlt);
    if (!telefone) { this.reportar('baileys_remetente_sem_telefone'); return; }
    const texto = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
    if (!texto || texto.length > 4096 || m.key.id.length > 128) return;
    const comando = comandoDeTexto(texto); let payload: string | null = null;
    if (comando === 'parar_de_receber') payload = montarPayload(comando, null);
    else if (comando) {
      const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
      if (quoted) {
        const [r] = await comPosse(v.posse, tx => tx.$queryRaw<EnvioBaileys[]>`SELECT * FROM whatsapp_baileys_outbox
          WHERE location_id = ${v.posse.locationId}::uuid AND message_id = ${quoted}
            AND payload_cipher IS NOT NULL AND status IN ('sent','delivered','read') AND created_at > now() - interval '7 days'`);
        if (r) {
          const c = conteudoDoEnvio(v.posse, r);
          if (c.telefone === telefone && c.appointmentId) payload = montarPayload(comando, c.appointmentId);
        }
      }
    }
    const wamid = referenciaBaileys(v.posse.locationId, m.key.id);
    await comPosse(v.posse, tx => registrarRespostaNaTransacao(tx, { tenantId: v.posse.tenantId, wamid, telefone, texto, payload }));
  }
  async aguardarOciosidade(): Promise<void> {
    await Promise.all([...this.vivas.values()].map(async v => { await v.eventos; await v.envio; await v.eventos; }));
  }
  async parar(): Promise<void> {
    this.parada = true;
    if (this.timer) clearInterval(this.timer); if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null; this.heartbeat = null;
    await Promise.allSettled([this.rodadaPendente, this.renovacaoPendente]);
    const vivas = [...this.vivas.values()];
    await Promise.all(vivas.map(v => this.encerrarLocal(v)));
    await Promise.all(vivas.map(async v => { await v.envio; await v.eventos; }));
  }
}
