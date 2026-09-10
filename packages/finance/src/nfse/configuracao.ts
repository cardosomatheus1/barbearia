import { withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { lerCertificadoA1, type CertificadoA1 } from './certificado.js';
import { cifrarFiscal, decifrarFiscal, chaveFiscal } from './cofre.js';
import { recusarNfse } from './erros.js';

export interface ConfiguracaoNfse {
  readonly ambiente: 'homologacao' | 'producao';
  readonly serie: number;
  readonly codigoNacional: string;
  readonly codigoMunicipal: string | null;
  readonly nbs: string | null;
  readonly aliquotaTotalSimplesBps: number | null;
  readonly habilitada: boolean;
}
export interface AtorFiscal {
  readonly tenantId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly staffName: string;
}
interface ConfigRow {
  environment: ConfiguracaoNfse['ambiente']; series: number; national_service_code: string;
  municipal_service_code: string | null; nbs: string | null; simples_total_bps: number | null; enabled: boolean;
}
export async function lerConfiguracaoNfse(tx: TransactionClient, locationId: string): Promise<ConfiguracaoNfse | null> {
  const rows = await tx.$queryRaw<ConfigRow[]>`
    SELECT environment, series, national_service_code, municipal_service_code, nbs, simples_total_bps, enabled
      FROM fiscal_native_settings WHERE location_id = ${locationId}::uuid
  `;
  const r = rows[0];
  return r ? { ambiente: r.environment, serie: r.series, codigoNacional: r.national_service_code,
    codigoMunicipal: r.municipal_service_code, nbs: r.nbs, aliquotaTotalSimplesBps: r.simples_total_bps,
    habilitada: r.enabled } : null;
}

export async function situacaoNfse(tenantId: string, locationId: string, agora = new Date(), tx?: TransactionClient) {
  const dentro = async (tx: TransactionClient) => {
    const configuracao = await lerConfiguracaoNfse(tx, locationId);
    const rows = await tx.$queryRaw<{ cnpj: string; regime: string; valid_from: Date | null; valid_until: Date | null; certificate_cnpj: string | null }[]>`
      SELECT s.cnpj, s.regime::text, c.valid_from, c.valid_until, c.cnpj AS certificate_cnpj
        FROM fiscal_settings s LEFT JOIN fiscal_certificates c ON c.location_id = s.location_id
       WHERE s.location_id = ${locationId}::uuid
    `;
    const s = rows[0];
    const motivo = !s ? 'Cadastre os dados fiscais da unidade.'
      : !configuracao ? 'Configure o emissor nacional.'
      : !['mei', 'simples'].includes(s.regime) ? 'Este perfil tributário ainda não é atendido pelo emissor nacional do sistema.'
      : s.regime === 'simples' && configuracao.aliquotaTotalSimplesBps === null ? 'Informe o percentual total de tributos do Simples com seu contador.'
      : !s.valid_until ? 'Adicione o certificado A1 desta unidade.'
      : s.certificate_cnpj !== s.cnpj ? 'O certificado não corresponde ao CNPJ da unidade.'
      : !s.valid_from || s.valid_from > agora || s.valid_until <= agora ? 'Renove o certificado A1.'
      : !configuracao.habilitada ? 'Habilite a emissão após conferir a configuração.' : null;
    return { configuracao, certificado: s?.valid_until ? { validoAte: s.valid_until.toISOString(),
      correspondeAoCnpj: s.certificate_cnpj === s.cnpj } : null, pronta: motivo === null, motivo };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

async function conferirAtor(tx: TransactionClient, p: AtorFiscal): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM staff_users WHERE id = ${p.staffId}::uuid
  `;
  if (!rows[0]) recusarNfse('nfse_ator_invalido', 'Sua conta não pode alterar esta unidade.', 403);
}

export async function salvarConfiguracaoNfse(p: AtorFiscal & { readonly config: ConfiguracaoNfse }): Promise<void> {
  const c = p.config;
  if (!['homologacao', 'producao'].includes(c.ambiente) || !Number.isInteger(c.serie) || c.serie < 1 || c.serie > 49999 ||
    !/^\d{6}$/.test(c.codigoNacional) || (c.codigoMunicipal !== null && !/^\d{3}$/.test(c.codigoMunicipal)) ||
    (c.nbs !== null && !/^\d{9}$/.test(c.nbs)) || (c.aliquotaTotalSimplesBps !== null &&
      (!Number.isInteger(c.aliquotaTotalSimplesBps) || c.aliquotaTotalSimplesBps < 0 || c.aliquotaTotalSimplesBps > 9999))) {
    recusarNfse('nfse_configuracao_invalida', 'Confira os dados do emissor nacional.', 400);
  }
  chaveFiscal();
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    const rows = await tx.$queryRaw<{ regime: string }[]>`
      SELECT regime::text FROM fiscal_settings WHERE location_id = ${p.locationId}::uuid FOR UPDATE
    `;
    const base = rows[0];
    if (!base) recusarNfse('nao_configurado', 'Cadastre os dados fiscais da unidade.');
    if (c.habilitada && (!['mei', 'simples'].includes(base.regime) ||
      (base.regime === 'simples' && c.aliquotaTotalSimplesBps === null))) {
      recusarNfse('nfse_perfil_nao_atendido', 'Este perfil precisa de revisão tributária antes de habilitar a emissão.');
    }
    await tx.$executeRaw`
      INSERT INTO fiscal_native_settings
        (location_id, tenant_id, environment, series, national_service_code, municipal_service_code, nbs, simples_total_bps, enabled)
      VALUES (${p.locationId}::uuid, ${p.tenantId}::uuid, ${c.ambiente}, ${c.serie}, ${c.codigoNacional},
        ${c.codigoMunicipal}, ${c.nbs}, ${c.aliquotaTotalSimplesBps}, ${c.habilitada})
      ON CONFLICT (location_id) DO UPDATE SET environment = EXCLUDED.environment, series = EXCLUDED.series,
        national_service_code = EXCLUDED.national_service_code, municipal_service_code = EXCLUDED.municipal_service_code,
        nbs = EXCLUDED.nbs, simples_total_bps = EXCLUDED.simples_total_bps, enabled = EXCLUDED.enabled, updated_at = now()
    `;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'fiscal.native_settings_changed',
      entity: 'fiscal_settings', entityId: p.locationId, after: { ambiente: c.ambiente, serie: c.serie, habilitada: c.habilitada } });
  });
}

export async function salvarCertificadoNfse(p: AtorFiscal & { readonly pfx: Buffer; readonly senha: string; readonly agora?: Date }): Promise<void> {
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    const rows = await tx.$queryRaw<{ cnpj: string }[]>`
      SELECT cnpj FROM fiscal_settings WHERE location_id = ${p.locationId}::uuid FOR UPDATE
    `;
    if (!rows[0]) recusarNfse('nao_configurado', 'Cadastre o CNPJ antes do certificado.');
    let cert: CertificadoA1;
    try { cert = lerCertificadoA1(p.pfx, p.senha, rows[0].cnpj, p.agora ?? new Date()); }
    catch { recusarNfse('nfse_certificado_invalido', 'Confira arquivo, senha, CNPJ e validade do certificado A1.', 400); }
    const envelope = cifrarFiscal(JSON.stringify({ pfx: p.pfx.toString('base64'), senha: p.senha }), `${p.tenantId}:${p.locationId}:a1`);
    await tx.$executeRaw`
      INSERT INTO fiscal_certificates (location_id, tenant_id, cnpj, envelope_cipher, fingerprint, valid_from, valid_until)
      VALUES (${p.locationId}::uuid, ${p.tenantId}::uuid, ${cert.cnpj}, ${envelope}, ${cert.fingerprint}, ${cert.validoDesde}, ${cert.validoAte})
      ON CONFLICT (location_id) DO UPDATE SET cnpj = EXCLUDED.cnpj, envelope_cipher = EXCLUDED.envelope_cipher,
        fingerprint = EXCLUDED.fingerprint, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until, updated_at = now()
    `;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'fiscal.certificate_changed',
      entity: 'fiscal_settings', entityId: p.locationId, after: { validoAte: cert.validoAte.toISOString() } });
  });
}

export async function removerCertificadoNfse(p: AtorFiscal): Promise<void> {
  await withTenant(p.tenantId, async tx => {
    await conferirAtor(tx, p);
    const removidas = await tx.$executeRaw`DELETE FROM fiscal_certificates WHERE location_id = ${p.locationId}::uuid`;
    if (removidas) await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'fiscal.certificate_removed',
      entity: 'fiscal_settings', entityId: p.locationId });
  });
}

export async function certificadoDaUnidade(tenantId: string, locationId: string, cnpj: string, agora = new Date()): Promise<CertificadoA1> {
  const rows = await withTenant(tenantId, tx => tx.$queryRaw<{ envelope_cipher: string }[]>`
    SELECT envelope_cipher FROM fiscal_certificates WHERE location_id = ${locationId}::uuid AND cnpj = ${cnpj}
  `);
  if (!rows[0]) recusarNfse('nfse_certificado_ausente', 'Adicione o certificado A1 correspondente ao CNPJ da nota.');
  const envelope = JSON.parse(decifrarFiscal(rows[0].envelope_cipher, `${tenantId}:${locationId}:a1`)) as { pfx: string; senha: string };
  try { return lerCertificadoA1(Buffer.from(envelope.pfx, 'base64'), envelope.senha, cnpj, agora); }
  catch { recusarNfse('nfse_certificado_invalido', 'Renove o certificado A1 antes de continuar.'); }
}
