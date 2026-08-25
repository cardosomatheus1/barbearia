import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { clientesNaPorta, FILTROS_DA_PORTA, type FiltroDaPorta } from '@barbearia/crm';
import { pode } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { z } from 'zod';
import { DomainError } from '../common/errors.js';
import { diaISO } from '../common/data.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';

const portaSchema = z.object({
  q: z.string().trim().max(80).optional(),
  filtro: z.enum(FILTROS_DA_PORTA).default('todos'),
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  hoje: diaISO,
});

/**
 * A porta da base de clientes (V1).
 *
 * `customers.view` abre apenas a identidade da pessoa. Segmento, agenda e fiado
 * são enriquecimentos de outros domínios e não pegam carona nessa permissão:
 * ficam nulos/indisponíveis quando a sessão não tem o direito correspondente.
 */
@Controller('v1/admin/customers')
@UseGuards(StaffGuard, PermissaoGuard)
export class ClientesController {
  @Exige('customers.view')
  @Get('directory')
  async listar(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(portaSchema))
    query: { q?: string; filtro: FiltroDaPorta; pagina: number; hoje: string },
  ) {
    // Ver a agenda da casa inteira é diferente de ver a própria agenda. A porta
    // não pode revelar o próximo cliente do colega a um barbeiro só porque ele
    // tem `appointments.view`.
    const podeVerAgenda = pode(staff.permissions, 'appointments.view_all_professionals');
    const podeVerSegmento = pode(staff.permissions, 'customers.view_notes');
    const podeVerFiado =
      pode(staff.permissions, 'cashier.open') || pode(staff.permissions, 'finance.view');

    if (['em_risco', 'vip', 'assinantes'].includes(query.filtro) && !podeVerSegmento) {
      throw new DomainError('forbidden', 403, 'Sem permissão para ver segmentos da base.');
    }
    if (query.filtro === 'hoje' && !podeVerAgenda) {
      throw new DomainError('forbidden', 403, 'Sem permissão para ver a agenda da equipe.');
    }
    if (query.filtro === 'fiado' && !podeVerFiado) {
      throw new DomainError('forbidden', 403, 'Sem permissão para ver valores em aberto.');
    }

    return clientesNaPorta({
      tenantId: staff.tenantId,
      hoje: query.hoje,
      filtro: query.filtro,
      ...(query.q !== undefined ? { busca: query.q } : {}),
      pagina: query.pagina,
      podeVerAgenda,
      podeVerSegmento,
      podeVerFiado,
    });
  }
}
