import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { lerPreferenciasDeAviso, listarEnvios, salvarPreferenciasDeAviso } from '@barbearia/jobs';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { preferenciasDeAvisoSchema } from './avisos.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Avisos ao cliente: o que a barbearia manda, e o que de fato saiu.
 *
 * `settings.manage` nas duas rotas, e não `marketing.send`: decidir se o
 * lembrete de 2 horas existe é configuração da casa, do mesmo tipo que a janela
 * de cancelamento. `marketing.send` é para campanha, que é outro bloco.
 *
 * O histórico entra aqui e não numa rota de relatório porque a pergunta que ele
 * responde é sempre a mesma — "o cliente foi avisado?" — e ela aparece no meio
 * de uma discussão sobre falta, não numa análise mensal.
 */
@Controller('v1/admin/notifications')
@Recurso('avisos')
@UseGuards(StaffGuard, PermissaoGuard)
export class AvisosController {
  @Exige('settings.manage')
  @Get()
  async ler(@Staff() staff: AuthenticatedStaff) {
    const preferencias = await lerPreferenciasDeAviso(staff.tenantId, (await unidadeDoBalcao(staff)).id);
    if (!preferencias) throw notFound('location_not_found', 'Unidade não encontrada.');

    return { settings: preferencias, log: await listarEnvios(staff.tenantId, { limite: 50 }) };
  }

  @Exige('settings.manage')
  @Put()
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(preferenciasDeAvisoSchema))
    body: Parameters<typeof salvarPreferenciasDeAviso>[2],
  ) {
    const local = await unidadeDoBalcao(staff);
    await salvarPreferenciasDeAviso(staff.tenantId, local.id, body);
    return { saved: true };
  }
}
