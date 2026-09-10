import { withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { cifrarFiscal, decifrarFiscal, chaveFiscal } from '../nfse/cofre.js';
import { certificadoDaUnidade, type AtorFiscal } from '../nfse/configuracao.js';
import { NfseError } from '../nfse/erros.js';
import { exigirMunicipioReaproveitado, municipioReaproveitado, executavelMunicipal, type MunicipioReaproveitado } from './catalogo.js';
import type { ConfiguracaoMunicipal, EnderecoMunicipal } from './contrato.js';

export interface CredenciaisMunicipais { readonly usuario?: string | null; readonly senha?: string | null; readonly token?: string | null }
export interface SituacaoMunicipal {
  readonly configuracao: ConfiguracaoMunicipal | null; readonly municipio: MunicipioReaproveitado | null;
  readonly emissor: string; readonly temCredenciais: boolean; readonly pronta: boolean; readonly motivo: string | null;
}
const falha = (mensagem: string) => new NfseError('nfse_municipal_configuracao_invalida', mensagem, 400);
export function validarEnderecoMunicipal(e: EnderecoMunicipal): void {
  if (!e || !/^\d{8}$/.test(e.cep) || !/^[A-Z]{2}$/.test(e.uf) || !Number.isInteger(e.municipio) ||
      e.municipio < 1000000 || e.municipio > 9999999 ||
      ![e.logradouro, e.numero, e.bairro, e.nomeMunicipio].every(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 150) ||
      (e.complemento != null && (typeof e.complemento !== 'string' || e.complemento.length > 150)))
    throw falha('Confira o endereço fiscal completo da unidade.');
}
export function validarConfiguracaoMunicipal(c: ConfiguracaoMunicipal): void {
  if (!c || !['homologacao', 'producao'].includes(c.ambiente) || !/^[a-zA-Z0-9]{1,5}$/.test(c.serie) ||
      !/^[0-9.]{1,10}$/.test(c.itemListaServico) || !/^[a-zA-Z0-9.]{1,20}$/.test(c.codigoMunicipal) ||
      !c.razaoSocial?.trim() || c.razaoSocial.length > 150 || typeof c.habilitada !== 'boolean' ||
      c.layoutSaoPaulo !== 1 || !Number.isInteger(c.numeroInicial) || c.numeroInicial < 1 || c.numeroInicial > 2_000_000_000 ||
      c.serieExclusiva !== true || (c.cnae !== null && !/^\d{7}$/.test(c.cnae)) ||
      !/^[a-zA-Z0-9]{1,10}$/.test(c.codigoCancelamento) ||
      (c.nbs !== null && !/^\d{9}$/.test(c.nbs))) throw falha('Confira a configuração do emissor municipal.');
  validarEnderecoMunicipal(c.enderecoPrestador);
  if (c.enderecoPrestador.municipio !== 3550308 && !/^[1-9][0-9]{0,4}$/.test(c.serie))
    throw falha('Para este emissor, use uma série numérica de 1 a 99999, sem zeros à esquerda.');
}
export async function emissorDaUnidade(tx: TransactionClient, locationId: string): Promise<'nacional' | 'municipal'> {
  const rows = await tx.$queryRaw<{ native_emitter: 'nacional' | 'municipal' }[]>`
    SELECT native_emitter FROM fiscal_settings WHERE location_id = ${locationId}::uuid
  `;
  return rows[0]?.native_emitter ?? 'nacional';
}
export async function lerConfiguracaoMunicipal(tx: TransactionClient, locationId: string): Promise<ConfiguracaoMunicipal | null> {
  const rows = await tx.$queryRaw<{ configuration: ConfiguracaoMunicipal }[]>`
    SELECT configuration FROM fiscal_municipal_settings WHERE location_id = ${locationId}::uuid
  `;
  return rows[0]?.configuration ?? null;
}
export async function credenciaisMunicipais(tenantId: string, locationId: string): Promise<CredenciaisMunicipais> {
  const rows = await withTenant(tenantId, tx => tx.$queryRaw<{ credentials_cipher: string | null }[]>`
    SELECT credentials_cipher FROM fiscal_municipal_settings WHERE location_id = ${locationId}::uuid
  `);
  return rows[0]?.credentials_cipher ? JSON.parse(decifrarFiscal(rows[0].credentials_cipher, `${tenantId}:${locationId}:municipal_credenciais`)) as CredenciaisMunicipais : {};
}
export async function situacaoMunicipal(tenantId: string, locationId: string, tx?: TransactionClient): Promise<SituacaoMunicipal> {
  const dentro = async (t: TransactionClient) => {
    const configuracao = await lerConfiguracaoMunicipal(t, locationId);
    const rows = await t.$queryRaw<{ cnpj: string; regime: string; municipality_ibge: string; municipal_registration: string | null; native_emitter: string; tem_credenciais: boolean }[]>`
      SELECT s.cnpj, s.regime::text, s.municipality_ibge, s.municipal_registration, s.native_emitter,
             (m.credentials_cipher IS NOT NULL) AS tem_credenciais
        FROM fiscal_settings s LEFT JOIN fiscal_municipal_settings m ON m.location_id = s.location_id
       WHERE s.location_id = ${locationId}::uuid
    `;
    const base = rows[0];
    const municipio = base ? municipioReaproveitado(base.municipality_ibge) : null;
    let motivo: string | null = !base ? 'Cadastre os dados fiscais da unidade.' : !configuracao ? 'Configure o emissor municipal.'
      : !municipio?.[configuracao.ambiente] ? 'Este município não tem integração municipal disponível neste ambiente. Utilize o portal da prefeitura.'
      : !['simples', 'normal'].includes(base.regime) ? 'Este regime ainda não é atendido pelo emissor municipal.'
      : !base.municipal_registration ? 'Informe a inscrição municipal nos dados fiscais.'
      : configuracao.enderecoPrestador.municipio !== Number(base.municipality_ibge) ? 'O endereço fiscal precisa ser do município cadastrado.'
      : !configuracao.habilitada || base.native_emitter !== 'municipal' ? 'Habilite o emissor municipal após conferir os dados.' : null;
    if (!motivo && base) {
      try { executavelMunicipal(); await certificadoDaUnidade(tenantId, locationId, base.cnpj, new Date(), t); }
      catch (erro) { motivo = erro instanceof NfseError ? erro.message : 'Confira o certificado A1 e a configuração da plataforma.'; }
    }
    return { configuracao, municipio, emissor: base?.native_emitter ?? 'nacional',
      temCredenciais: base?.tem_credenciais ?? false, pronta: motivo === null, motivo };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}
export async function salvarConfiguracaoMunicipal(p: AtorFiscal & {
  readonly config: ConfiguracaoMunicipal; readonly credenciais?: CredenciaisMunicipais;
}): Promise<void> {
  validarConfiguracaoMunicipal(p.config); chaveFiscal();
  if (p.credenciais && !Object.values(p.credenciais).every(v => v === null || typeof v === 'string' && v.length <= 2000))
    throw falha('As credenciais municipais excedem o limite permitido.');
  await withTenant(p.tenantId, async tx => {
    const ator = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff_users WHERE id = ${p.staffId}::uuid`;
    if (!ator[0]) throw new NfseError('nfse_ator_invalido', 'Sua conta não pode alterar esta unidade.', 403);
    const rows = await tx.$queryRaw<{ municipality_ibge: string; regime: string; cnpj: string; municipal_registration: string | null }[]>`
      SELECT municipality_ibge, regime::text, cnpj, municipal_registration FROM fiscal_settings
       WHERE location_id = ${p.locationId}::uuid FOR UPDATE
    `;
    const base = rows[0];
    if (!base) throw falha('Cadastre os dados fiscais da unidade.');
    if (p.config.enderecoPrestador.municipio !== Number(base.municipality_ibge)) throw falha('O município do endereço precisa corresponder ao cadastro fiscal.');
    const municipio = municipioReaproveitado(base.municipality_ibge);
    if (municipio && (p.config.enderecoPrestador.uf !== municipio.uf || p.config.enderecoPrestador.nomeMunicipio !== municipio.nome))
      throw falha('O nome e a UF do município precisam corresponder ao cadastro fiscal.');
    const anterior = await lerConfiguracaoMunicipal(tx, p.locationId);
    if (anterior && anterior.serie === p.config.serie && anterior.ambiente === p.config.ambiente && anterior.numeroInicial !== p.config.numeroInicial)
      throw falha('O número inicial de uma série já configurada não pode ser alterado. Use uma nova série exclusiva.');
    if (p.config.habilitada) {
      exigirMunicipioReaproveitado(base.municipality_ibge, p.config.ambiente);
      if (!['simples', 'normal'].includes(base.regime) || !base.municipal_registration) throw falha('Confira o regime e a inscrição municipal.');
      executavelMunicipal();
      await certificadoDaUnidade(p.tenantId, p.locationId, base.cnpj, new Date(), tx);
    }
    const credenciais = p.credenciais === undefined ? null : cifrarFiscal(JSON.stringify(p.credenciais), `${p.tenantId}:${p.locationId}:municipal_credenciais`);
    await tx.$executeRaw`
      INSERT INTO fiscal_municipal_settings (location_id, tenant_id, configuration, credentials_cipher)
      VALUES (${p.locationId}::uuid, ${p.tenantId}::uuid, ${JSON.stringify(p.config)}::jsonb, ${credenciais})
      ON CONFLICT (location_id) DO UPDATE SET configuration = EXCLUDED.configuration,
        credentials_cipher = CASE WHEN ${p.credenciais !== undefined} THEN EXCLUDED.credentials_cipher ELSE fiscal_municipal_settings.credentials_cipher END,
        updated_at = now()
    `;
    await tx.$executeRaw`UPDATE fiscal_settings SET native_emitter = 'municipal' WHERE location_id = ${p.locationId}::uuid`;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'fiscal.settings_changed',
      entity: 'fiscal_settings', entityId: p.locationId, after: { ambiente: p.config.ambiente,
        emissor: 'municipal', habilitada: p.config.habilitada, alterouCredenciais: p.credenciais !== undefined } });
  });
}
