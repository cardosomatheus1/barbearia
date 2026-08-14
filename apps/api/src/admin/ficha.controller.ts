import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  apagarFoto,
  FichaError,
  FotoError,
  fotosDoCliente,
  lerFicha,
  publicarFoto,
  registrarFoto,
  salvarPreferencias,
} from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { fotoSchema, preferenciasSchema, publicarSchema, type EntradaDeFoto } from './ficha.schemas.js';
import { uuidSchema } from './caixa.schemas.js';

const STATUS: Record<string, number> = {
  cliente_nao_encontrado: 404,
  preferencia_invalida: 400,
  foto_nao_encontrada: 404,
  // 422 e não 400: o pedido está bem formado, e o que falta é uma decisão do
  // titular. A mensagem do domínio vai inteira, porque ela diz o que fazer.
  sem_consentimento: 422,
  sem_uso_publico: 422,
  url_invalida: 400,
};

function toHttp(error: unknown): never {
  if (error instanceof FichaError || error instanceof FotoError) {
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

  /**
   * As fotos do cliente (bloco 74, SPEC §4.2).
   *
   * `customers.view_photos` sozinha, e a decisão é escrita: esta rota devolve
   * **só as fotos** — url, tipo, legenda e se está no portfólio. Nada de nome,
   * telefone ou anotação, então ela não precisa declarar `customers.view`. A
   * regra da rota que agrega vale para o que a rota **devolve**, e o que ela
   * devolve aqui é uma coisa só.
   *
   * A leitura é auditada dentro da transação, como a SPEC manda.
   */
  @Exige('customers.view_photos')
  @Get(':id/fotos')
  async fotos(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      const fotos = await fotosDoCliente({
        tenantId: staff.tenantId,
        customerId: id,
        ator: { id: staff.staffUserId, nome: staff.name },
      });
      return { fotos };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Registra uma foto.
   *
   * `customers.manage_photos`, não `view_photos`: criar a foto do rosto de
   * alguém e publicá-la é escrita, e escrita guardada por permissão de leitura
   * é defeito. Só o dono tem por padrão.
   */
  @Exige('customers.manage_photos')
  @Post(':id/fotos')
  async registrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(fotoSchema)) body: EntradaDeFoto,
  ) {
    try {
      return await registrarFoto({
        tenantId: staff.tenantId,
        customerId: id,
        tipo: body.tipo,
        url: body.url,
        ...(body.appointmentId ? { appointmentId: body.appointmentId } : {}),
        ...(body.professionalId ? { professionalId: body.professionalId } : {}),
        ...(body.legenda ? { legenda: body.legenda } : {}),
        noPortfolio: body.noPortfolio === true,
        ator: { id: staff.staffUserId, nome: staff.name },
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('customers.manage_photos')
  @Put('fotos/:fotoId/portfolio')
  async publicar(
    @Staff() staff: AuthenticatedStaff,
    @Param('fotoId', new ZodValidationPipe(uuidSchema)) fotoId: string,
    @Body(new ZodValidationPipe(publicarSchema)) body: { publicar: boolean },
  ) {
    try {
      await publicarFoto({
        tenantId: staff.tenantId,
        fotoId,
        publicar: body.publicar,
        ator: { id: staff.staffUserId, nome: staff.name },
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Apaga uma foto.
   *
   * `DELETE` de verdade, e é a exceção deliberada no meio de um schema em que
   * quase tudo é append-only: o titular que pede para tirar uma foto não pediu
   * para escondê-la. A revogação do consentimento já apaga tudo por gatilho;
   * isto é o caso avulso — saiu tremida, entrou a pessoa errada.
   */
  @Exige('customers.manage_photos')
  @Delete('fotos/:fotoId')
  async apagar(
    @Staff() staff: AuthenticatedStaff,
    @Param('fotoId', new ZodValidationPipe(uuidSchema)) fotoId: string,
  ) {
    try {
      await apagarFoto({
        tenantId: staff.tenantId,
        fotoId,
        ator: { id: staff.staffUserId, nome: staff.name },
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
