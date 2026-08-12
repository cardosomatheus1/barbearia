import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { atendimentosAAvaliar, avaliarAtendimento } from '@barbearia/crm';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
import { avaliacaoParaHttp } from '../admin/avaliacao.controller.js';
import { novaAvaliacaoSchema } from './avaliacao.schemas.js';

/**
 * O cliente avalia o atendimento dele (bloco 43, SPEC §4.10).
 *
 * ## Sessão obrigatória, e o id vem dela
 *
 * Nunca do corpo. A RLS separa barbearias e **não** separa clientes dentro de
 * uma: com o `customerId` vindo da requisição, qualquer pessoa autenticada
 * avaliaria o corte de qualquer outra — e a nota entraria na média do barbeiro
 * dela. O domínio confere que o agendamento é de quem está pedindo.
 *
 * ## Um atendimento que aconteceu, e só
 *
 * "Avaliação só existe vinculada a atendimento real concluído" é a primeira
 * linha da seção da SPEC, e é o que separa este produto de review aberta de
 * marketplace. Cancelado e faltado não geram nota: não houve serviço, e a falta
 * tem outro lugar no produto — o score de confiabilidade.
 */
@Controller('v1/b/:slug/reviews')
@UseGuards(CustomerGuard)
export class AvaliacaoDoClienteController {
  /** Os atendimentos que esta pessoa ainda pode avaliar. */
  @Get('pendentes')
  async pendentes(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
  ) {
    return { atendimentos: await atendimentosAAvaliar(tenantId, customer.customerId) };
  }

  @Post()
  async avaliar(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(novaAvaliacaoSchema))
    body: {
      appointmentId: string;
      nota: number;
      comentario?: string;
      categorias?: {
        atendimento?: number;
        qualidade?: number;
        pontualidade?: number;
        ambiente?: number;
      };
    },
  ) {
    try {
      return await avaliarAtendimento({
        tenantId,
        customerId: customer.customerId,
        appointmentId: body.appointmentId,
        nota: body.nota,
        ...(body.categorias ? { categorias: body.categorias } : {}),
        ...(body.comentario ? { comentario: body.comentario } : {}),
      });
    } catch (erro) {
      return avaliacaoParaHttp(erro);
    }
  }
}
