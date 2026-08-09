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
 * **Ler é `customers.view_notes`; escrever é `customers.edit_notes`.** As duas
 * são negadas à recepção por padrão: quem atende no balcão precisa achar o
 * cliente, não ler o que anotaram sobre ele.
 *
 * Até o bloco 30 as duas rotas exigiam a permissão de leitura, e o argumento
 * era razoável — quem lê "não usar navalha" costuma ser quem escreveu. Mas
 * escrita guardada por permissão de leitura é o defeito que a
 * `/security-review` do bloco 21 cobrou, e o motivo real de ele ter durado era
 * outro: não havia tela que permitisse ao dono conceder uma sem a outra.
 * Agora há, e a migração 0032 concedeu `edit_notes` a todo papel que já tinha
 * `view_notes` — ninguém perde capacidade, e a partir de agora dá para separar.
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

  @Exige('customers.edit_notes')
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
