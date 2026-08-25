import { FakeFiscalProvider, type FiscalProvider } from '@barbearia/core';

export type ModoFiscal = 'nenhum' | 'fake';

/**
 * O fake existe para teste e desenvolvimento, nunca para um processo de
 * produção. Aceitá-lo em produção faria uma instalação parecer integrada ao
 * fiscal enquanto nenhuma nota chega à prefeitura — pior do que iniciar com o
 * recurso explicitamente desligado.
 */
function modoSeguroParaOAmbiente(modo: ModoFiscal): ModoFiscal {
  if (modo === 'fake' && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'FISCAL_MODO=fake não pode ser usado em produção. ' +
        'Use nenhum até existir um emissor fiscal real integrado.',
    );
  }
  return modo;
}

export function modoFiscal(bruto = process.env['FISCAL_MODO']): ModoFiscal {
  if (bruto === undefined || bruto === '') return 'nenhum';
  if (bruto === 'nenhum' || bruto === 'fake') return modoSeguroParaOAmbiente(bruto);
  throw new Error(
    `FISCAL_MODO inválido: ${bruto}. Use nenhum ou fake — ` +
      'não há emissor de verdade integrado, e inventar um nome não contrata nenhum.',
  );
}

/**
 * O emissor do processo, ou `null` quando a casa não emite.
 *
 * O parâmetro explícito existe para teste, mas passa pela mesma trava de
 * produção do valor vindo do ambiente para não criar um atalho perigoso.
 */
export function emissorFiscal(modo = modoFiscal()): FiscalProvider | null {
  return modoSeguroParaOAmbiente(modo) === 'fake' ? new FakeFiscalProvider() : null;
}
