import { Controller, Get, Inject, Param } from '@nestjs/common';
import { queuePositionByToken } from '@barbearia/scheduling';
import { recursoLigado } from '@barbearia/platform';
import { notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from './booking.schemas.js';
import { queueTokenSchema } from '../admin/fila.schemas.js';

/**
 * A posição pelo celular — **sem autenticação, só com o link**.
 *
 * A SPEC pede acompanhar a posição "por link, sem app". O token é a
 * credencial, e é por isso que ele tem 32 bytes de entropia e vive hasheado no
 * banco.
 *
 * A resposta é o mínimo: a posição de quem tem o link, o próprio nome e a
 * frase. Nenhum nome de outra pessoa, nenhum telefone, nenhuma lista — quem tem
 * o link tem o link dele, não a fila da barbearia.
 */
@Controller('v1/b/:slug/queue')
export class FilaPublicaController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Get(':token')
  async posicao(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Param('token', new ZodValidationPipe(queueTokenSchema)) token: string,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    // O link do cliente cai junto com a fila. Sem isto, desligar o recurso
    // tiraria a fila do balcão e deixaria no ar um link que mostra a posição de
    // uma fila que ninguém mais move — pior do que não ter fila nenhuma.
    if (!(await recursoLigado(tenantId, 'fila'))) {
      throw notFound('queue_entry_not_found', 'Este link não está mais válido');
    }

    /**
     * A unidade sai do **token**, não da unidade principal.
     *
     * Esta rota chamava `primaryLocation(tenantId)` e montava a fila da matriz:
     * numa rede, quem entrou na fila da filial lia "Seu atendimento já foi
     * encerrado" sentado na cadeira esperando. Quem sabe onde a pessoa está é a
     * entrada, e o token já leva até ela.
     */
    const minha = await queuePositionByToken({ tenantId, token });

    // Mesma resposta para token inválido e para token de outra barbearia: a
    // diferença diria a quem varre links que aquele existe em algum lugar.
    if (!minha) throw notFound('queue_entry_not_found', 'Este link não está mais válido');
    return minha;
  }
}
