import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  normalizarCnpj,
  validarConfiguracaoFiscal,
  type ConfiguracaoFiscal,
  type RegimeFiscal,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { recusar } from './fiscal-erros.js';

export interface ConfiguracaoNaTela extends ConfiguracaoFiscal {
  readonly inscricaoMunicipal: string | null;
  readonly contaNoEmissor: string | null;
}

export async function configuracaoFiscal(
  tenantId: string,
  locationId: string,
  tx?: TransactionClient,
): Promise<ConfiguracaoNaTela | null> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      {
        cnpj: string;
        regime: RegimeFiscal;
        service_code: string;
        iss_bps: number;
        municipality_ibge: string;
        municipal_registration: string | null;
        provider_account_id: string | null;
        auto_issue: boolean;
      }[]
    >`
      SELECT cnpj, regime::text AS regime, service_code, iss_bps, municipality_ibge,
             municipal_registration, provider_account_id, auto_issue
        FROM fiscal_settings
       WHERE location_id = ${locationId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      cnpj: linha.cnpj,
      regime: linha.regime,
      codigoDeServico: linha.service_code,
      issBps: linha.iss_bps,
      municipioIbge: linha.municipality_ibge,
      emitirAutomaticamente: linha.auto_issue,
      inscricaoMunicipal: linha.municipal_registration,
      contaNoEmissor: linha.provider_account_id,
    };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export async function salvarConfiguracaoFiscal(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly config: ConfiguracaoFiscal;
  readonly inscricaoMunicipal?: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<ConfiguracaoNaTela> {
  const config = { ...params.config, cnpj: normalizarCnpj(params.config.cnpj) };
  const falha = validarConfiguracaoFiscal(config);
  if (falha) recusar(falha);

  return withTenant(params.tenantId, async (tx) => {
    const antes = await configuracaoFiscal(params.tenantId, params.locationId, tx);

    // A unidade vem do servidor, mas a conferência sob RLS fica: a chave
    // estrangeira aceitaria a de outra barbearia, porque a checagem referencial
    // ignora row security.
    const gravadas = await tx.$executeRaw`
      INSERT INTO fiscal_settings
        (location_id, tenant_id, cnpj, regime, service_code, iss_bps,
         municipality_ibge, municipal_registration, auto_issue, updated_by)
      SELECT ${params.locationId}::uuid,
             NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${config.cnpj}, ${config.regime}::fiscal_regime,
             ${config.codigoDeServico.trim()}, ${config.issBps},
             ${config.municipioIbge}, ${params.inscricaoMunicipal?.trim() || null},
             ${config.emitirAutomaticamente}, ${params.staffId}::uuid
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id) DO UPDATE SET
        cnpj = EXCLUDED.cnpj,
        regime = EXCLUDED.regime,
        service_code = EXCLUDED.service_code,
        iss_bps = EXCLUDED.iss_bps,
        municipality_ibge = EXCLUDED.municipality_ibge,
        municipal_registration = EXCLUDED.municipal_registration,
        auto_issue = EXCLUDED.auto_issue,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `;
    if (gravadas === 0) recusar('nao_configurado');

    /**
     * Auditado porque **muda o que sai em nome da casa**.
     *
     * Não carrega centavo, e por isso fica na trilha de gestão e não na de
     * dinheiro: o que ele guarda é CNPJ, regime e alíquota. A pergunta que
     * responde — "quem mudou o regime para MEI?" — é de quem administra a
     * barbearia, e é a que aparece quando o contador acha uma nota errada.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'fiscal.settings_changed',
      entity: 'fiscal_settings',
      entityId: params.locationId,
      ...(antes
        ? {
            before: {
              cnpj: antes.cnpj,
              regime: antes.regime,
              issBps: antes.issBps,
              emitirAutomaticamente: antes.emitirAutomaticamente,
            },
          }
        : {}),
      after: {
        cnpj: config.cnpj,
        regime: config.regime,
        issBps: config.issBps,
        emitirAutomaticamente: config.emitirAutomaticamente,
      },
    });

    const salva = await configuracaoFiscal(params.tenantId, params.locationId, tx);
    if (!salva) recusar('nao_configurado');
    return salva;
  });
}
