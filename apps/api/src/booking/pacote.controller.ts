import { Controller, Get, UseGuards } from '@nestjs/common';
import { pacotesDoCliente } from '@barbearia/finance';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';

/**
 * Os pacotes do próprio cliente (bloco 42, SPEC §4.7).
 *
 * ## Sessão obrigatória, e o id vem dela
 *
 * Nunca do endereço. A RLS separa barbearias e **não** separa clientes dentro de
 * uma — com o id no caminho, conhecer o uuid de alguém bastaria para ler quantos
 * cortes essa pessoa comprou e quando ela usou cada um. É o mesmo precedente do
 * saldo de fidelidade.
 *
 * ## Quantos restam é a pergunta, e ela é dele
 *
 * "Ainda tenho corte?" é o que o cliente pergunta no WhatsApp da barbearia, e é
 * a pergunta que esta rota tira da recepção. A frase vem do domínio, a mesma que
 * o balcão lê — vocabulário de transição mora num lugar só.
 */
@Controller('v1/b/:slug/packages')
@UseGuards(CustomerGuard)
export class PacoteDoClienteController {
  @Get()
  async meusPacotes(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
  ) {
    return { pacotes: await pacotesDoCliente(tenantId, customer.customerId) };
  }
}
