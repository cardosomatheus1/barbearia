import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { FichaError, lerFicha, salvarPreferencias } from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { preferenciasSchema } from './ficha.schemas.js';
import { uuidSchema } from './caixa.schemas.js';

const STATUS: Record<string, number> = {
  cliente_nao_encontrado: 404,
  preferencia_invalida: 400,
};

function toHttp(error: unknown): never {
  if (error instanceof FichaError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

/**
 * A ficha do cliente — a tela que o barbeiro abre antes de atender.
 *
 * **`customers.view_notes` nas duas rotas, ler e escrever.** A permissão existe
 * desde o bloco 12 e é negada à recepção de propósito: quem atende no balcão
 * precisa achar o cliente, não ler o que anotaram sobre ele.
 *
 * Escrever exige a mesma permissão que ler, e é decisão, não descuido: quem lê
 * "não usar navalha" é exatamente quem escreveu — o barbeiro, com o cliente na
 * cadeira. Uma permissão separada de escrita não teria hoje nenhum papel que a
 * concedesse e outro que não, e inventar permissão que ninguém distingue foi o
 * erro que o bloco 18 declarou como lacuna em vez de cometer. Ela entra no
 * bloco 30, junto com a tela que permite conceder — e está escrito lá.
 */
@Controller('v1/admin/customers')
@UseGuards(StaffGuard, PermissaoGuard)
export class FichaController {
  @Exige('customers.view_notes')
  @Get(':id/ficha')
  async ler(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      return await lerFicha(staff.tenantId, id);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('customers.view_notes')
  @Put(':id/preferences')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(preferenciasSchema))
    body: Parameters<typeof salvarPreferencias>[0]['preferencias'],
  ) {
    try {
      await salvarPreferencias({
        tenantId: staff.tenantId,
        customerId: id,
        staffUserId: staff.staffUserId,
        preferencias: body,
      });
      return { saved: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
