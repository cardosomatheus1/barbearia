import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CampanhaError, campanhasDaCasa, criarCampanha, type FiltroDeCampanha } from '@barbearia/crm';
import { gradeDeOcupacao } from '@barbearia/scheduling';
import type { TipoDeNotificacao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { campanhaSchema } from './campanha.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Campanhas e o heatmap (bloco 57, SPEC §4.13 e §5.9).
 *
 * As duas coisas na mesma rota porque são o mesmo fluxo: *"célula fria é
 * clicável e vira campanha direcionada — o heatmap não é relatório, é ponto de
 * partida de ação"*. Separá-las faria a tela pedir dois carregamentos para
 * desenhar uma decisão só.
 *
 * `marketing.send` guarda as duas. A grade é ocupação — não é dinheiro, não
 * revela cadastro, e é o insumo de quem decide a campanha.
 */

const STATUS: Record<string, number> = { nao_encontrada: 404, invalida: 400, ja_enviada: 409 };

function toHttp(erro: unknown): never {
  if (erro instanceof CampanhaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/campanhas')
@UseGuards(StaffGuard, PermissaoGuard)
export class CampanhaController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('marketing.send')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    const [campanhas, grade] = await Promise.all([
      campanhasDaCasa(staff.tenantId),
      gradeDeOcupacao({ tenantId: staff.tenantId, locationId: local.id, agora: new Date() }),
    ]);
    return { campanhas, grade };
  }

  @Exige('marketing.send')
  @Post()
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(campanhaSchema)) body: {
      nome: string;
      filtro: FiltroDeCampanha;
      valorDoFiltro: number | null;
      diaDaSemana: number | null;
      tipo: TipoDeNotificacao;
      janelaDias: number;
    },
  ) {
    try {
      return await criarCampanha({
        tenantId: staff.tenantId,
        nome: body.nome,
        filtro: body.filtro,
        valorDoFiltro: body.valorDoFiltro,
        diaDaSemana: body.diaDaSemana,
        tipo: body.tipo,
        janelaDias: body.janelaDias,
        agora: new Date(),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
