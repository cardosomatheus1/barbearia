/** Anexo VIII RTC v1.01.00, item 06.01. O perfil é escolhido pelo emitente. */
export const PERFIL_IBSCBS_BARBEARIA = 'regular_presencial' as const;
export type PerfilIbsCbs = typeof PERFIL_IBSCBS_BARBEARIA;
export const CLASSIFICACAO_IBSCBS_BARBEARIA = {
  codigoNacional: '060101', nbs: '126021000', indicadorOperacao: '030101',
  situacaoTributaria: '000', classificacaoTributaria: '000001',
} as const;

export function perfilIbsCbsCompativel(p: {
  readonly perfil: unknown; readonly regime: string;
  readonly codigoNacional: string; readonly nbs: string | null;
}): boolean {
  return p.perfil === PERFIL_IBSCBS_BARBEARIA && p.regime === 'normal' &&
    p.codigoNacional === CLASSIFICACAO_IBSCBS_BARBEARIA.codigoNacional &&
    p.nbs === CLASSIFICACAO_IBSCBS_BARBEARIA.nbs;
}
