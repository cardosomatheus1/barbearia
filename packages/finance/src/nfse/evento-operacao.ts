import { autenticarRespostaAtual } from './prova-resposta.js';
import { withTenant } from '@barbearia/db';
import type { CertificadoA1 } from './certificado.js';
import type { DocumentoNfse } from './documentos.js';
import { escopoDocumento } from './documentos.js';
import { assinarPedidoDeCancelamento } from './assinatura.js';
import { gerarPedidoDeCancelamento } from './cancelamento.js';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { NfseError } from './erros.js';
import { lerCancelamentoConfirmado } from './respostas.js';
import { validarSchemaNfse } from './schema.js';
import { codigosDaResposta, type TransporteNfse } from './transporte.js';
import { compactarXmlFiscal } from './xml-seguro.js';

export async function processarCancelamentoNfse(p: {
  readonly tenantId: string; readonly doc: DocumentoNfse; readonly token: string;
  readonly certificado: CertificadoA1; readonly transporte: TransporteNfse; readonly motivo?: string;
}): Promise<void> {
  const { doc, tenantId, token } = p;
  if (!doc.access_key || !doc.nfse_cipher) throw new NfseError('nota_nao_cancelavel', 'A nota ainda não foi autorizada.');
  if (doc.cancel_error_code && p.motivo === undefined) return;
  let pedido: string;
  if (doc.cancel_request_cipher && !doc.cancel_error_code) {
    pedido = decifrarFiscal(doc.cancel_request_cipher, escopoDocumento(tenantId, doc, 'cancelamento'));
  } else {
    if (!p.motivo || p.motivo.trim().length < 15 || p.motivo.trim().length > 255) {
      throw new NfseError('nfse_motivo_invalido', 'Descreva o motivo do cancelamento em 15 a 255 caracteres.', 400);
    }
    const gerado = gerarPedidoDeCancelamento({ ambiente: doc.environment, cnpj: p.certificado.cnpj,
      chave: doc.access_key, motivo: p.motivo, quando: new Date() });
    pedido = assinarPedidoDeCancelamento(gerado.xml, p.certificado, gerado.id, 'sha1');
    validarSchemaNfse(pedido, 'pedRegEvento');
    const cipher = cifrarFiscal(pedido, escopoDocumento(tenantId, doc, 'cancelamento'));
    const mudou = await withTenant(tenantId, tx => tx.$executeRaw`
      UPDATE fiscal_native_documents SET cancel_request_cipher = ${cipher}, cancel_error_code = NULL, updated_at = now()
       WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid
    `);
    if (!mudou) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
  }
  const base = { ambiente: doc.environment, certificado: p.certificado };
  const caminho = `/nfse/${doc.access_key}/eventos`;
  const consulta = await p.transporte({ ...base, metodo: 'GET', caminho: `${caminho}/101101/1` });
  let dados: unknown;
  if (consulta.status === 200) dados = consulta.dados;
  else {
    if (consulta.status !== 404) throw new NfseError('nfse_consulta_falhou', 'Não foi possível confirmar o cancelamento.', 503);
    const resposta = await p.transporte({ ...base, metodo: 'POST', caminho,
      corpo: { pedidoRegistroEventoXmlGZipB64: compactarXmlFiscal(pedido) } });
    const codigos = codigosDaResposta(resposta.dados);
    if (codigos.includes('E1805')) throw new NfseError('nfse_evento_ja_recebido', 'O evento já foi recebido. O cancelamento será consultado novamente.');
    // Só a recusa explícita permite encerrar a tentativa como recusada.
    // Timeout/5xx/JSON incompleto mantém o pedido persistido para consulta.
    if (resposta.status === 400 && codigos.length) {
      await withTenant(tenantId, tx => tx.$executeRaw`
        UPDATE fiscal_native_documents SET cancel_error_code = ${codigos.join(',').slice(0, 80)}, updated_at = now()
         WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid
      `);
      return;
    }
    if (resposta.status < 200 || resposta.status >= 300) throw new NfseError('nfse_cancelamento_sem_confirmacao', 'O cancelamento será consultado novamente.', 503);
    dados = resposta.dados;
  }
  const xml = lerCancelamentoConfirmado(dados, doc.access_key, doc.environment);
  const prova = await autenticarRespostaAtual(xml, 'evento', escopoDocumento(tenantId, doc, 'validacao_evento'));
  const cipher = cifrarFiscal(xml, escopoDocumento(tenantId, doc, 'evento'));
  const mudou = await withTenant(tenantId, tx => tx.$executeRaw`
    UPDATE fiscal_native_documents SET cancel_event_cipher = ${cipher}, cancel_validation_cipher = ${prova.envelope}, cancel_error_code = NULL, last_error_code = NULL, updated_at = now()
     WHERE invoice_id = ${doc.invoice_id}::uuid AND lease_token = ${token}::uuid AND cancel_event_cipher IS NULL
  `);
  if (!mudou) throw new NfseError('nfse_tentativa_substituida', 'Outra tentativa está processando esta nota.');
}
