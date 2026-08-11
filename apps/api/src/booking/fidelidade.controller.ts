import { Controller, Get, UseGuards } from '@nestjs/common';
import { saldoDoCliente } from '@barbearia/finance';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';

/**
 * O saldo de fidelidade do próprio cliente (bloco 41, SPEC §4.8).
 *
 * A SPEC pede "exibição do saldo **no app** e no PDV". Esta é a metade do app; o
 * PDV é a tela de comanda.
 *
 * ## Sessão obrigatória, e o id vem dela
 *
 * Nunca do endereço. A RLS separa barbearias e **não** separa clientes dentro de
 * uma — com o id no caminho, conhecer o uuid de alguém bastaria para ler o saldo
 * e o histórico de compras dessa pessoa.
 *
 * ## O extrato vai junto
 *
 * "Por que caiu?" é a pergunta que a barbearia recebe, e um número sozinho não
 * responde. É a mesma decisão do extrato de fiado.
 */
@Controller('v1/b/:slug/loyalty')
@UseGuards(CustomerGuard)
export class FidelidadeDoClienteController {
  @Get()
  async meuSaldo(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
  ) {
    return saldoDoCliente(tenantId, customer.customerId);
  }
}
