import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  AssinaturaError,
  agendarCancelamento,
  assinaturaDoCliente,
  desfazerCancelamento,
  minhasFaturas,
} from '@barbearia/finance';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
import { assinaturaParaHttp } from '../admin/assinatura.controller.js';
import { meuCancelamentoSchema } from '../admin/assinatura.schemas.js';

/**
 * O plano do próprio cliente, e o cancelamento self-service (bloco 47, SPEC §4.6).
 *
 * ## Por que esta rota existe
 *
 * *"Cancelamento self-service obrigatório."* Não é gentileza: o clube que só
 * cancela por telefone é o que vira reclamação no Procon e estorno no cartão —
 * e o estorno custa mais caro que o mês que ele tentou segurar. O caminho que a
 * pessoa não encontra ela abre pelo banco.
 *
 * ## O id vem da sessão, nunca do endereço
 *
 * A RLS separa barbearias e **não** separa clientes dentro de uma. Com o id no
 * caminho, conhecer o uuid de alguém bastaria para cancelar o plano dessa pessoa
 * — e o filtro por `customer_id` vai junto lá embaixo, no `WHERE`, porque a
 * defesa de borda sozinha é a que alguém esquece na rota seguinte.
 *
 * ## Não é atrito disfarçado
 *
 * O motivo é opcional, o cancelamento é imediato de registrar, e a saída tem
 * volta: quem muda de ideia antes do fim do ciclo desfaz por um botão. Um fluxo
 * que exige justificativa para deixar sair é o mesmo telefone com outro nome.
 */
@Controller('v1/b/:slug/plano')
@UseGuards(CustomerGuard)
export class AssinaturaDoClienteController {
  /**
   * O que eu assino, quanto pago e até quando vale.
   *
   * A tela do cliente precisa das três coisas juntas, e as três são dele: o
   * plano, o extrato das mensalidades e — quando pediu para sair — a data em que
   * o benefício acaba, congelada no pedido.
   */
  @Get()
  async meuPlano(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer) {
    const [assinatura, faturas] = await Promise.all([
      assinaturaDoCliente(tenantId, customer.customerId),
      minhasFaturas(tenantId, customer.customerId),
    ]);
    return { assinatura, faturas };
  }

  @Post('cancelar')
  async cancelar(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(meuCancelamentoSchema)) body: { motivo?: string },
  ) {
    const assinatura = await assinaturaDoCliente(tenantId, customer.customerId);
    if (!assinatura) {
      return assinaturaParaHttp(
        new AssinaturaError('assinatura_nao_encontrada', 'Você não tem um plano ativo.'),
      );
    }

    try {
      return await agendarCancelamento({
        tenantId,
        assinaturaId: assinatura.id,
        motivo: body.motivo ?? '',
        /**
         * Sem ator de equipe: quem cancelou foi o cliente. A trilha registra
         * `actor_id` nulo e o nome escrito, porque `audit_log.actor_id` aponta
         * para `staff_users` e o cliente não é um.
         */
        ator: null,
        customerId: customer.customerId,
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /** Mudei de ideia. É o estado que mais vale ter saída, e ela é um botão. */
  @Post('manter')
  async manter(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer) {
    const assinatura = await assinaturaDoCliente(tenantId, customer.customerId);
    if (!assinatura) {
      return assinaturaParaHttp(
        new AssinaturaError('assinatura_nao_encontrada', 'Você não tem um plano ativo.'),
      );
    }

    try {
      return await desfazerCancelamento({
        tenantId,
        assinaturaId: assinatura.id,
        ator: null,
        customerId: customer.customerId,
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }
}
