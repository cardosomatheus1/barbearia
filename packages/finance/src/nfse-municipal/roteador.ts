import { withTenant } from '@barbearia/db';
import type { FiscalProvider, NotaEmitida, PedidoDeNota } from '@barbearia/core';
import { EmissorNacionalNfse } from '../nfse/emissor.js';
import { EmissorMunicipalNfse } from './emissor.js';

/** A nota mantém o emissor de origem mesmo que a unidade troque de configuração. */
export class EmissorProprioNfse implements FiscalProvider {
  constructor(private readonly nacional: FiscalProvider = new EmissorNacionalNfse(),
    private readonly municipal: FiscalProvider = new EmissorMunicipalNfse()) {}
  async emitir(pedido: PedidoDeNota): Promise<NotaEmitida> {
    const rows = await withTenant(pedido.tenantId, tx => tx.$queryRaw<{ invoice_id: string }[]>`
      SELECT invoice_id FROM fiscal_municipal_documents WHERE invoice_id = ${pedido.invoiceId}::uuid
    `);
    return (rows[0] ? this.municipal : this.nacional).emitir(pedido);
  }
  consultar(ref: string): Promise<NotaEmitida> { return this.peloId(ref).consultar(ref); }
  cancelar(ref: string, motivo: string): Promise<void> { return this.peloId(ref).cancelar(ref, motivo); }
  validarMotivoDeCancelamento(motivo: string): void { this.nacional.validarMotivoDeCancelamento?.(motivo); }
  private peloId(ref: string): FiscalProvider { return ref.startsWith('nfse-municipal:') ? this.municipal : this.nacional; }
}
