import { autenticarRespostaAtual, exigirAutoridadeFiscalDisponivel } from './prova-resposta.js';
import { CHAVE_NFSE } from './identificadores.js';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@barbearia/db';
import type { FiscalProvider, NotaEmitida, PedidoDeNota } from '@barbearia/core';
import { assinarDps } from './assinatura.js';
import { gerarDps } from './dps.js';
import { certificadoDaUnidade } from './configuracao.js';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { lerDocumentoNfse, snapshotDoDocumento, escopoDocumento, type DocumentoNfse } from './documentos.js';
import { NfseError } from './erros.js';
import { codigosDaResposta, httpNfse, registro, type TransporteNfse } from './transporte.js';
import { compactarXmlFiscal, lerXmlFiscal } from './xml-seguro.js';
import { lerNotaAutorizada } from './respostas.js';
import { validarSchemaNfse } from './schema.js';
import { processarCancelamentoNfse } from './evento-operacao.js';
import { conferirMunicipioNfse } from './capacidade.js';
import { certificadosDasAutoridades } from './assinatura-resposta.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function identificar(id: string): { tenantId: string; invoiceId: string } {
  const m = new RegExp(`^nfse:(${UUID}):(${UUID})$`, 'i').exec(id);
  if (!m?.[1] || !m[2]) throw new NfseError('nfse_referencia_invalida', 'Referência fiscal inválida.');
  return { tenantId: m[1], invoiceId: m[2] };
}
export function referenciaNfse(tenantId: string, invoiceId: string): string { return `nfse:${tenantId}:${invoiceId}`; }

export function respostaLocalNfse(tenantId: string, doc: DocumentoNfse): NotaEmitida {
  let numero: string | null = null;
  if (doc.nfse_cipher) {
    const xml = decifrarFiscal(doc.nfse_cipher, escopoDocumento(tenantId, doc, 'nfse'));
    const n = registro(registro(registro(lerXmlFiscal(xml))['NFSe'])['infNFSe'])['nNFSe'];
    if (typeof n !== 'string') throw new NfseError('nfse_documento_invalido', 'O documento fiscal precisa ser conferido.');
    numero = n;
  }
  return { estado: doc.cancel_event_cipher ? 'cancelada' : doc.nfse_cipher ? 'autorizada' : 'processando',
    notaId: referenciaNfse(tenantId, doc.invoice_id), numero, linkPdf: null, motivoDaRecusa: null,
    ...(doc.cancel_error_code ? { cancelamentoRecusado: true } : {}) };
}

/** Integração direta com a SEFIN Nacional. Todo estado necessário sobrevive ao processo. */
export class EmissorNacionalNfse implements FiscalProvider {
  constructor(private readonly transporte: TransporteNfse = httpNfse) {}
  validarMotivoDeCancelamento(motivo: string): void {
    if (motivo.trim().length < 15 || motivo.trim().length > 255) throw new NfseError('nfse_motivo_invalido', 'Descreva o motivo do cancelamento em 15 a 255 caracteres.', 400);
  }

  emitir(pedido: PedidoDeNota): Promise<NotaEmitida> { return this.executar(pedido.tenantId, pedido.invoiceId); }
  consultar(notaId: string): Promise<NotaEmitida> {
    const p = identificar(notaId); return this.executar(p.tenantId, p.invoiceId);
  }
  async cancelar(notaId: string, motivo: string): Promise<void> {
    const p = identificar(notaId);
    const resposta = await this.executar(p.tenantId, p.invoiceId, motivo);
    if (resposta.cancelamentoRecusado) throw new NfseError('nfse_cancelamento_recusado', 'O emissor recusou o cancelamento. A nota permanece válida.');
    if (resposta.estado !== 'cancelada') throw new NfseError('nfse_cancelamento_pendente', 'O cancelamento ainda aguarda confirmação do emissor.');
  }

  private async executar(tenantId: string, invoiceId: string, motivo?: string): Promise<NotaEmitida> {
    const token = randomUUID();
    const obtida = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_native_documents SET lease_token = ${token}::uuid, lease_until = now() + interval '2 minutes'
       WHERE invoice_id = ${invoiceId}::uuid AND (lease_until IS NULL OR lease_until <= now())
    `);
    if (!obtida) {
      const doc = await lerDocumentoNfse(tenantId, invoiceId);
      return { ...respostaLocalNfse(tenantId, doc), ...(motivo || doc.cancel_request_cipher ? { estado: 'cancelando' as const } : {}) };
    }
    try {
      const doc = await lerDocumentoNfse(tenantId, invoiceId);
      if (doc.cancel_event_cipher) return respostaLocalNfse(tenantId, doc);
      const notas = await withTenant(tenantId, tx => tx.$queryRaw<{ status: string; cancel_reason: string | null }[]>`
        SELECT status::text, cancel_reason FROM fiscal_invoices WHERE id = ${invoiceId}::uuid
      `);
      const recuperarMotivo = notas[0]?.status === 'cancelando' && !doc.cancel_request_cipher
        ? notas[0].cancel_reason ?? undefined : undefined;
      const motivoEfetivo = motivo ?? recuperarMotivo;
      if (doc.nfse_cipher && !motivoEfetivo && (!doc.cancel_request_cipher || doc.cancel_error_code)) return respostaLocalNfse(tenantId, doc);
      const snapshot = snapshotDoDocumento(tenantId, doc);
      // Não iniciar transmissão sem poder autenticar o retorno da autoridade.
      certificadosDasAutoridades();
      const certificado = await certificadoDaUnidade(tenantId, doc.location_id, snapshot.cnpj);
      await exigirAutoridadeFiscalDisponivel();
      if (motivoEfetivo || doc.cancel_request_cipher) {
        await processarCancelamentoNfse({ tenantId, doc, token, certificado, transporte: this.transporte,
          ...(motivoEfetivo !== undefined ? { motivo: motivoEfetivo } : {}) });
      } else if (!doc.nfse_cipher) {
        const emitida = await this.emitirDocumento(tenantId, doc, token, certificado);
        if (emitida) return emitida;
      }
      return respostaLocalNfse(tenantId, await lerDocumentoNfse(tenantId, invoiceId));
    } catch (erro) {
      const code = erro instanceof NfseError && /^[a-zA-Z0-9_]{1,80}$/.test(erro.code) ? erro.code : 'nfse_processamento_falhou';
      await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_native_documents SET last_error_code = ${code}, updated_at = now()
         WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${token}::uuid
      `);
      throw erro;
    } finally {
      await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_native_documents SET lease_token = NULL, lease_until = NULL
         WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${token}::uuid
      `);
    }
  }

  private async emitirDocumento(tenantId: string, doc: DocumentoNfse, token: string,
    certificado: Awaited<ReturnType<typeof certificadoDaUnidade>>): Promise<NotaEmitida | null> {
    const snapshot = snapshotDoDocumento(tenantId, doc);
    let dps: string;
    if (doc.signed_dps_cipher) dps = decifrarFiscal(doc.signed_dps_cipher, escopoDocumento(tenantId, doc, 'dps'));
    else {
      let gerada: ReturnType<typeof gerarDps>;
      try { gerada = gerarDps(snapshot); }
      catch { return this.recusa(tenantId, doc, 'nfse_layout_invalido'); }
      if (gerada.id !== doc.dps_id) throw new NfseError('nfse_dps_divergente', 'A numeração da nota precisa ser conferida.');
      dps = assinarDps(gerada.xml, certificado, doc.dps_id, 'sha1');
      validarSchemaNfse(dps, 'DPS');
      const cipher = cifrarFiscal(dps, escopoDocumento(tenantId, doc, 'dps'));
      const mudou = await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_native_documents SET signed_dps_cipher = ${cipher}, updated_at = now()
         WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid AND signed_dps_cipher IS NULL
      `);
      if (!mudou) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
    }
    const base = { ambiente: doc.environment, certificado };
    const consulta = await this.transporte({ ...base, metodo: 'GET', caminho: `/dps/${doc.dps_id}` });
    if (consulta.status === 200) {
      // Uma DPS que já existia antes do nosso primeiro envio pertence a outra
      // sequência/emissor. Não apropriar uma nota anterior de mesmo valor.
      if (!doc.attempt_at) return this.recusa(tenantId, doc, 'nfse_serie_ja_utilizada');
      const chave = registro(consulta.dados)['chaveAcesso'];
      if (typeof chave !== 'string' || !CHAVE_NFSE.test(chave)) throw new NfseError('nfse_resposta_invalida', 'A consulta não devolveu a chave da nota.', 502);
      const nota = await this.transporte({ ...base, metodo: 'GET', caminho: `/nfse/${chave}` });
      if (nota.status !== 200) throw new NfseError('nfse_consulta_falhou', 'A consulta fiscal será repetida.', 503);
      await this.gravarAutorizacao(tenantId, doc, token, lerNotaAutorizada(nota.dados, dps, chave));
      return null;
    }
    if (consulta.status !== 404) throw new NfseError('nfse_consulta_falhou', 'Não foi possível confirmar se esta DPS já foi emitida.', 503);
    await conferirMunicipioNfse(snapshot, certificado, this.transporte);
    const marcada = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_native_documents SET attempt_at = now(), updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid
    `);
    if (!marcada) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
    const r = await this.transporte({ ...base, metodo: 'POST', caminho: '/nfse', corpo: { dpsXmlGZipB64: compactarXmlFiscal(dps) } });
    const codigos = codigosDaResposta(r.dados);
    if (codigos.includes('E0014')) throw new NfseError('nfse_dps_ja_recebida', 'O emissor já recebeu a DPS. A nota será consultada.');
    if (r.status === 400 && codigos.length) return this.recusa(tenantId, doc, codigos.join(', '));
    if (r.status < 200 || r.status >= 300) throw new NfseError('nfse_envio_sem_confirmacao', 'O envio ficou sem confirmação. A nota será consultada antes de repetir.', 503);
    await this.gravarAutorizacao(tenantId, doc, token, lerNotaAutorizada(r.dados, dps));
    return null;
  }

  private recusa(tenantId: string, doc: DocumentoNfse, code: string): NotaEmitida {
    return { estado: 'rejeitada', notaId: referenciaNfse(tenantId, doc.invoice_id), numero: null, linkPdf: null,
      motivoDaRecusa: code === 'nfse_serie_ja_utilizada' ? 'Esta série já foi usada por outro emissor. Configure uma série exclusiva antes de emitir novamente.'
        : `O emissor recusou a DPS (${code}). Confira os dados fiscais antes de emitir novamente.` };
  }

  private async gravarAutorizacao(tenantId: string, doc: DocumentoNfse, token: string, nota: { chave: string; xml: string }): Promise<void> {
    const prova = await autenticarRespostaAtual(nota.xml, 'NFSe', escopoDocumento(tenantId, doc, 'validacao_nfse'));
    const cipher = cifrarFiscal(nota.xml, escopoDocumento(tenantId, doc, 'nfse'));
    const mudou = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_native_documents SET nfse_cipher = ${cipher}, nfse_validation_cipher = ${prova.envelope}, access_key = ${nota.chave}, last_error_code = NULL, updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid AND nfse_cipher IS NULL
    `);
    if (!mudou) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
  }
}
