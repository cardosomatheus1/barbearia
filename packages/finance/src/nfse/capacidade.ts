import type { DadosDps } from './dps.js';
import type { CertificadoA1 } from './certificado.js';
import { NfseError } from './erros.js';
import { registro, type TransporteNfse } from './transporte.js';

/** MEI usa o emissor nacional mesmo nas exceções municipais previstas na RN E0016. */
export async function conferirMunicipioNfse(dados: DadosDps, certificado: CertificadoA1, transporte: TransporteNfse): Promise<void> {
  if (dados.regime === 'mei') return;
  const r = await transporte({ ambiente: dados.ambiente, certificado, metodo: 'GET',
    caminho: `/parametros_municipais/${dados.municipioEmissor}/convenio` });
  if (r.status !== 200) throw new NfseError('nfse_municipio_nao_verificado', 'Não foi possível verificar o convênio do município.', 503);
  const convenio = registro(registro(r.dados)['parametrosConvenio']);
  if (convenio['aderenteEmissorNacional'] === 0 || convenio['aderenteAmbienteNacional'] === 0) {
    throw new NfseError('nfse_municipio_sem_emissor_nacional', 'Este município exige integração com seu emissor municipal para este regime.');
  }
  if (convenio['aderenteEmissorNacional'] !== 1 || convenio['aderenteAmbienteNacional'] !== 1) {
    throw new NfseError('nfse_municipio_nao_verificado', 'A resposta não confirmou a disponibilidade do emissor nacional para o município.', 503);
  }
}
