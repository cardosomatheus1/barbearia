import { randomUUID } from 'node:crypto';
import { withTenant } from '@barbearia/db';
import type { FiscalProvider, NotaEmitida, PedidoDeNota } from '@barbearia/core';
import { certificadoDaUnidade } from '../nfse/configuracao.js';
import { cifrarFiscal } from '../nfse/cofre.js';
import { NfseError } from '../nfse/erros.js';
import { urlDoDocumento } from '../nfse/link.js';
import { credenciaisMunicipais } from './configuracao.js';
import { executarMotorMunicipal, type MotorMunicipal } from './ponte.js';
import { conferirNotaMunicipal, escopoMunicipal, lerDocumentoMunicipal, snapshotMunicipal, type DocumentoMunicipal } from './documentos.js';
import type { PedidoMunicipal, ResultadoMunicipal } from './contrato.js';
import { rpsAusente } from './ausencia.js';

export function referenciaMunicipal(tenantId: string, invoiceId: string): string { return `nfse-municipal:${tenantId}:${invoiceId}`; }
function identificar(ref: string): { tenantId: string; invoiceId: string } {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const m = new RegExp(`^nfse-municipal:(${uuid}):(${uuid})$`, 'i').exec(ref);
  if (!m?.[1] || !m[2]) throw new NfseError('nfse_referencia_invalida', 'Referência fiscal inválida.');
  return { tenantId: m[1], invoiceId: m[2] };
}
function estadoLocal(tenantId: string, doc: DocumentoMunicipal): NotaEmitida {
  return { notaId: referenciaMunicipal(tenantId, doc.invoice_id), numero: doc.number,
    linkPdf: doc.nfse_cipher ? urlDoDocumento({ tenantId, locationId: doc.location_id, invoiceId: doc.invoice_id }) : null,
    estado: doc.rejection_codes ? 'rejeitada' : doc.cancel_event_cipher ? 'cancelada' : doc.cancel_request_cipher && !doc.cancel_error_code ? 'cancelando'
      : doc.nfse_cipher ? 'autorizada' : 'processando', motivoDaRecusa: doc.rejection_codes?.includes('LOCAL_RPS_EXISTENTE')
        ? 'A consulta encontrou um RPS já utilizado. Confira a série e a numeração antes de solicitar outra nota.'
        : doc.rejection_codes?.includes('LOCAL_DADOS_INVALIDOS')
          ? 'Não foi possível preparar a nota com estes dados. Confira o cadastro fiscal e solicite outra nota; nenhum RPS foi transmitido.'
          : doc.rejection_codes ? `A prefeitura recusou o RPS (${doc.rejection_codes.join(', ')}). Confira o cadastro fiscal antes de solicitar outra nota.` : null,
    ...(doc.cancel_error_code ? { cancelamentoRecusado: true } : {}) };
}
function exigirConfirmacao(r: ResultadoMunicipal): void {
  if (r.erro || r.codigos.includes('0')) throw new NfseError('nfse_municipal_confirmacao_pendente',
    'A prefeitura ainda não confirmou a operação. O sistema consultará o resultado sem repetir o envio.', 503);
}
export class EmissorMunicipalNfse implements FiscalProvider {
  constructor(private readonly motor: MotorMunicipal = executarMotorMunicipal) {}
  emitir(p: PedidoDeNota): Promise<NotaEmitida> { return this.executar(p.tenantId, p.invoiceId); }
  consultar(ref: string): Promise<NotaEmitida> { const p = identificar(ref); return this.executar(p.tenantId, p.invoiceId); }
  validarMotivoDeCancelamento(motivo: string): void {
    if (motivo.trim().length < 15 || motivo.trim().length > 255)
      throw new NfseError('nfse_motivo_invalido', 'Descreva o motivo do cancelamento em 15 a 255 caracteres.', 400);
  }
  async cancelar(ref: string, motivo: string): Promise<void> {
    this.validarMotivoDeCancelamento(motivo);
    const p = identificar(ref); const r = await this.executar(p.tenantId, p.invoiceId, motivo);
    if (r.cancelamentoRecusado) throw new NfseError('nfse_cancelamento_recusado', 'A prefeitura recusou o cancelamento.');
    if (r.estado !== 'cancelada') throw new NfseError('nfse_cancelamento_pendente', 'O cancelamento aguarda confirmação da prefeitura.');
  }
  private async executar(tenantId: string, invoiceId: string, motivo?: string): Promise<NotaEmitida> {
    const lease = randomUUID();
    const obtida = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_municipal_documents SET lease_token = ${lease}::uuid, lease_until = now() + interval '5 minutes'
       WHERE invoice_id = ${invoiceId}::uuid AND (lease_until IS NULL OR lease_until <= now())
    `);
    if (!obtida) return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, invoiceId));
    try {
      const doc = await lerDocumentoMunicipal(tenantId, invoiceId);
      if (doc.cancel_event_cipher || doc.rejection_codes || doc.cancel_error_code) return estadoLocal(tenantId, doc);
      const rows = await withTenant(tenantId, tx => tx.$queryRaw<{ status: string; cancel_reason: string | null }[]>`
        SELECT status::text, cancel_reason FROM fiscal_invoices WHERE id = ${invoiceId}::uuid
      `);
      const motivoAtual = motivo ?? (rows[0]?.status === 'cancelando' ? rows[0].cancel_reason ?? undefined : undefined);
      if (doc.nfse_cipher && !motivoAtual && !doc.cancel_request_cipher) return estadoLocal(tenantId, doc);
      const snapshot = snapshotMunicipal(tenantId, doc);
      const certificado = await certificadoDaUnidade(tenantId, doc.location_id, snapshot.cnpj);
      const credenciais = await credenciaisMunicipais(tenantId, doc.location_id);
      const pedido: PedidoMunicipal = { ...snapshot, ...credenciais, operacao: 'consultar',
        certificadoPem: certificado.cadeiaPem, chavePem: certificado.chavePem };
      if (motivoAtual || doc.cancel_request_cipher) return await this.cancelarDocumento(tenantId, doc, lease, pedido, motivoAtual);
      let resposta: ResultadoMunicipal;
      if (doc.attempt_at) {
        // Timeout pode significar nota emitida. A ausência de confirmação nunca
        // autoriza reenviar o RPS: a conciliação repete somente a consulta.
        resposta = await this.motor(pedido);
      } else {
        // Uma série confirmada como exclusiva ainda pode ter sido usada por
        // engano. Uma nota anterior nunca pode ser apropriada por esta venda.
        const anterior = await this.motor(pedido);
        exigirConfirmacao(anterior);
        if (anterior.notas.length) return await this.recusarAntesDoEnvio(tenantId, doc, lease, 'LOCAL_RPS_EXISTENTE');
        if (!anterior.sucesso && !rpsAusente(pedido.municipio, anterior)) throw new NfseError('nfse_municipal_preconsulta_pendente',
          'A prefeitura não confirmou a consulta prévia do RPS. Confira a configuração municipal.', 503);
        let preparada: ResultadoMunicipal;
        try { preparada = await this.motor({ ...pedido, operacao: 'preparar' }); }
        catch { return await this.recusarAntesDoEnvio(tenantId, doc, lease, 'LOCAL_DADOS_INVALIDOS'); }
        if (preparada.erro || !preparada.sucesso || !preparada.requisicao)
          return await this.recusarAntesDoEnvio(tenantId, doc, lease, 'LOCAL_DADOS_INVALIDOS');
        const cipher = cifrarFiscal(JSON.stringify(preparada.requisicao), escopoMunicipal(tenantId, doc, 'pedido'));
        const marcada = await withTenant(tenantId, tx => tx.$executeRaw`
          UPDATE fiscal_municipal_documents SET request_cipher = ${cipher}, attempt_at = now(), updated_at = now()
           WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${lease}::uuid AND attempt_at IS NULL
        `);
        if (!marcada) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
        resposta = await this.motor({ ...pedido, operacao: 'emitir', requisicao: preparada.requisicao });
        await this.arquivarResposta(tenantId, doc, lease, resposta, true);
        exigirConfirmacao(resposta);
        if (!resposta.sucesso && resposta.codigos.length) {
          return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, invoiceId));
        }
      }
      if (doc.attempt_at) await this.arquivarResposta(tenantId, doc, lease, resposta);
      exigirConfirmacao(resposta);
      if (resposta.notas.length) {
        if (!resposta.sucesso || resposta.notas.length !== 1) throw new NfseError('nfse_municipal_resposta_divergente', 'A resposta municipal precisa ser conferida.');
        const nota = resposta.notas[0];
        if (!nota) throw new NfseError('nfse_municipal_resposta_divergente', 'A resposta municipal precisa ser conferida.');
        conferirNotaMunicipal(nota, snapshot);
        const cipher = cifrarFiscal(nota.xml, escopoMunicipal(tenantId, doc, 'nfse'));
        await withTenant(tenantId, tx => tx.$executeRaw`
          UPDATE fiscal_municipal_documents SET nfse_cipher = ${cipher}, number = ${nota.numero},
            verification_code = ${nota.verificacao}, last_error_code = NULL, updated_at = now()
           WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${lease}::uuid AND nfse_cipher IS NULL
        `);
        if (nota.situacao === 'cancelada') await this.arquivarCancelamento(tenantId, doc, lease, nota.xml);
      }
      return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, invoiceId));
    } catch (erro) {
      const code = erro instanceof NfseError && /^[a-z0-9_]{1,80}$/.test(erro.code) ? erro.code : 'nfse_municipal_processamento_falhou';
      await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_municipal_documents SET last_error_code = ${code}, updated_at = now()
         WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${lease}::uuid
      `);
      throw erro;
    } finally {
      await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_municipal_documents SET lease_token = NULL, lease_until = NULL
         WHERE invoice_id = ${invoiceId}::uuid AND lease_token = ${lease}::uuid
      `);
    }
  }
  private async recusarAntesDoEnvio(tenantId: string, doc: DocumentoMunicipal, lease: string, codigo: string): Promise<NotaEmitida> {
    const gravada = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_municipal_documents SET rejection_codes = ${[codigo]}::text[], updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${lease}::uuid AND attempt_at IS NULL
    `);
    if (!gravada) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
    return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, doc.invoice_id));
  }
  private async arquivarResposta(tenantId: string, doc: DocumentoMunicipal, lease: string, r: ResultadoMunicipal, inicial = false, cancelamento = false): Promise<void> {
    const cipher = cifrarFiscal(JSON.stringify(r), escopoMunicipal(tenantId, doc, 'resposta'));
    const primeira = inicial ? cifrarFiscal(JSON.stringify(r), escopoMunicipal(tenantId, doc, 'primeira_resposta')) : null;
    const recusada = !r.sucesso && !r.erro && !r.codigos.includes('0') && r.codigos.length > 0 && Boolean(r.xmlRetorno);
    await withTenant(tenantId, async tx => {
      const gravada = await tx.$executeRaw`
      UPDATE fiscal_municipal_documents SET response_cipher = ${cipher},
        initial_response_cipher = COALESCE(initial_response_cipher, ${primeira}),
        rejection_codes = CASE WHEN ${inicial && recusada} THEN ${[...r.codigos]}::text[] ELSE rejection_codes END,
        cancel_error_code = CASE WHEN ${cancelamento && recusada} THEN 'nfse_cancelamento_recusado' ELSE cancel_error_code END,
        protocol = COALESCE(protocol, ${r.protocolo}), batch_number = COALESCE(batch_number, ${r.lote}), updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${lease}::uuid
      `;
      if (!gravada) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
      await tx.$executeRaw`
        INSERT INTO fiscal_municipal_exchanges (tenant_id, location_id, invoice_id, operation, payload_cipher)
        VALUES (${tenantId}::uuid, ${doc.location_id}::uuid, ${doc.invoice_id}::uuid,
          ${inicial ? 'emitir' : cancelamento ? 'cancelar' : 'consultar'}, ${cipher})
      `;
    });
  }
  private async cancelarDocumento(tenantId: string, doc: DocumentoMunicipal, lease: string, pedido: PedidoMunicipal, motivo?: string): Promise<NotaEmitida> {
    if (!doc.nfse_cipher || !doc.number) throw new NfseError('nfse_cancelamento_indisponivel', 'Aguarde a autorização antes de cancelar.');
    if (doc.cancel_request_cipher) {
      const resposta = await this.motor({ ...pedido, operacao: 'consultar' });
      await this.arquivarResposta(tenantId, doc, lease, resposta);
      exigirConfirmacao(resposta);
      if (resposta.sucesso && resposta.notas.length === 1 && resposta.notas[0]) {
        const nota = resposta.notas[0];
        conferirNotaMunicipal(nota, snapshotMunicipal(tenantId, doc));
        if (nota.numero !== doc.number || nota.verificacao !== doc.verification_code)
          throw new NfseError('nfse_municipal_resposta_divergente', 'A consulta não corresponde à nota em cancelamento.');
        if (nota.situacao === 'cancelada') await this.arquivarCancelamento(tenantId, doc, lease, nota.xml);
      }
      return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, doc.invoice_id));
    }
    const texto = motivo ?? '';
    this.validarMotivoDeCancelamento(texto);
    const cancelar: PedidoMunicipal = { ...pedido, operacao: 'cancelar', numeroNota: doc.number,
      codigoVerificacao: doc.verification_code, codigoCancelamento: pedido.codigoCancelamento ?? null, motivoCancelamento: texto };
    const preparada = await this.motor({ ...cancelar, operacao: 'preparar_cancelamento' });
    if (preparada.erro || !preparada.sucesso || !preparada.requisicao)
      throw new NfseError('nfse_municipal_layout_invalido', 'Confira os dados do cancelamento municipal.');
    const cipherPedido = cifrarFiscal(JSON.stringify({ motivo: texto, requisicao: preparada.requisicao }), escopoMunicipal(tenantId, doc, 'cancelamento_pedido'));
    const marcada = await withTenant(tenantId, async tx => {
      const quantidade = await tx.$executeRaw`
        UPDATE fiscal_municipal_documents SET cancel_request_cipher = ${cipherPedido}
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${lease}::uuid AND cancel_request_cipher IS NULL
      `;
      if (quantidade) await tx.$executeRaw`
        INSERT INTO fiscal_municipal_exchanges (tenant_id, location_id, invoice_id, operation, payload_cipher)
        VALUES (${tenantId}::uuid, ${doc.location_id}::uuid, ${doc.invoice_id}::uuid, 'preparar_cancelamento', ${cipherPedido})
      `;
      return quantidade;
    });
    if (!marcada) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
    const resposta = await this.motor({ ...cancelar, requisicao: preparada.requisicao });
    await this.arquivarResposta(tenantId, doc, lease, resposta, false, true);
    exigirConfirmacao(resposta);
    if (resposta.sucesso && resposta.xmlRetorno) {
      await this.arquivarCancelamento(tenantId, doc, lease, resposta.xmlRetorno);
    } else if (!resposta.codigos.length || !resposta.xmlRetorno)
      throw new NfseError('nfse_cancelamento_pendente', 'O cancelamento aguarda confirmação da prefeitura.');
    return estadoLocal(tenantId, await lerDocumentoMunicipal(tenantId, doc.invoice_id));
  }
  private async arquivarCancelamento(tenantId: string, doc: DocumentoMunicipal, lease: string, xml: string): Promise<void> {
    const cipher = cifrarFiscal(xml, escopoMunicipal(tenantId, doc, 'cancelamento'));
    await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_municipal_documents SET cancel_event_cipher = ${cipher}, cancel_error_code = NULL, last_error_code = NULL, updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${lease}::uuid AND cancel_event_cipher IS NULL
    `);
  }
}
