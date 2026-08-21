import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  EstornoError,
  TransferenciaDePacoteError,
  ValeError,
  cancelarVale,
  conceberVale,
  dreDoPeriodo,
  estornarVenda,
  tetoDoVale,
  transferirPacote,
  valesDoPeriodo,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { unidadeDoBalcao, unidadeDoRelatorio } from './unidade.js';
import {
  cancelamentoDeValeSchema,
  estornoSchema,
  mesDaUnidade,
  periodoDoDreSchema,
  periodoDoValeSchema,
  transferenciaDePacoteSchema,
  valeNovoSchema,
} from './dre.schemas.js';

/**
 * DRE gerencial, vale, estorno e transferência de pacote (bloco 52).
 *
 * ## O DRE exige `finance.view_profit`, nunca `finance.view`
 *
 * Ele devolve resultado, margem e CMV — a decomposição inteira do lucro. É
 * exatamente o que o gerente padrão **não** tem, e é assim que o dono delega a
 * operação sem entregar a estratégia. Há teste que deriva dos tipos de retorno
 * de `core` e `finance` quais funções revelam resultado e cobra a permissão em
 * toda rota que as chame — este controller nasce coberto por ele.
 *
 * ## As três operações são de dinheiro, e cada uma tem a sua
 *
 * - **Vale** é `finance.advance`: dinheiro sai da gaveta hoje e volta na folha.
 * - **Estorno** é `finance.order_refund`: devolve o que já entrou e desfaz
 *   comissão, repasse, estoque, fidelidade e fiado de uma vez.
 * - **Transferir pacote** é `finance.package_transfer`: as unidades restantes
 *   valem dinheiro e mudam de dono.
 *
 * As três caem no grupo de dinheiro pelo prefixo, e por isso vêm com segundo
 * fator derivado.
 */

const STATUS: Record<string, number> = {
  venda_nao_encontrada: 404,
  venda_nao_paga: 409,
  ja_estornada: 409,
  motivo_obrigatorio: 400,
  periodo_fechado: 409,
  valor_invalido: 400,
  vale_maior_que_a_comissao: 409,
  vale_nao_aberto: 409,
  vale_nao_encontrado: 404,
  profissional_nao_encontrado: 404,
  sem_caixa_aberto: 409,
  pacote_nao_encontrado: 404,
  pacote_nao_transferivel: 409,
  sem_saldo: 409,
  mesma_pessoa: 400,
  destino_nao_encontrado: 404,
  pacote_reembolsado: 409,
};

function toHttp(erro: unknown): never {
  if (
    erro instanceof ValeError
    || erro instanceof EstornoError
    || erro instanceof TransferenciaDePacoteError
  ) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class DreController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('finance.view_profit')
  @Get('dre')
  async dre(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDoDreSchema))
    query: { de?: string; ate?: string; unidade?: string },
  ) {
    // O dia padrão continua saindo da loja **de operação**: "este mês" é o mês
    // da unidade em que a pessoa está, e no consolidado de uma rede que cruza
    // fusos alguma delas tem que decidir — a do balcão é a que ela reconhece.
    const local = await this.unidade(staff);
    const padrao = mesDaUnidade(local.today);
    return dreDoPeriodo({
      tenantId: staff.tenantId,
      unidade: await unidadeDoRelatorio(staff, query.unidade),
      de: query.de ?? padrao.de,
      ate: query.ate ?? padrao.ate,
    });
  }

  /**
   * A lista de vales.
   *
   * `commission.view_all` e não `finance.advance`: ler quanto cada barbeiro
   * adiantou é a mesma informação que a comissão de todo mundo, vista pelo outro
   * lado. Quem concede é outra decisão, e tem permissão própria.
   */
  @Exige('commission.view_all')
  @Get('vales')
  async vales(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDoValeSchema)) query: {
      de: string;
      ate: string;
      professionalId?: string;
    },
  ) {
    const local = await this.unidade(staff);
    return {
      vales: await valesDoPeriodo({
        tenantId: staff.tenantId,
        locationId: local.id,
        de: query.de,
        ate: query.ate,
        somenteProfessionalId: query.professionalId ?? null,
      }),
    };
  }

  @Exige('finance.advance')
  @Get('vales/teto/:professionalId')
  async teto(
    @Staff() staff: AuthenticatedStaff,
    @Param('professionalId', new ZodValidationPipe(uuidSchema)) professionalId: string,
    @Query(new ZodValidationPipe(periodoDoValeSchema)) query: { de: string; ate: string },
  ) {
    const local = await this.unidade(staff);
    return tetoDoVale({
      locationId: local.id,
      tenantId: staff.tenantId,
      professionalId,
      de: query.de,
      ate: query.ate,
    });
  }

  @Exige('finance.advance')
  @Post('vales')
  async adiantar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(valeNovoSchema)) body: {
      professionalId: string;
      valorCents: number;
      de: string;
      ate: string;
      motivo?: string | null;
      pelaGaveta: boolean;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw new DomainError('invalid_request', 400, 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff);
    try {
      return await conceberVale({
        tenantId: staff.tenantId,
        locationId: local.id,
        concedidoEm: local.today,
        ...body,
        // Escopada por operador, como em toda rota de dinheiro: a chave vem do
        // cliente e é livre, e duas recepcionistas mandando "1" fariam a segunda
        // receber o vale da primeira de volta em vez de lançar o dela.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.advance')
  @Post('vales/:id/cancelar')
  async cancelarOVale(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelamentoDeValeSchema)) body: { motivo: string },
  ) {
    try {
      const local = await this.unidade(staff);
      await cancelarVale({
        tenantId: staff.tenantId,
        locationId: local.id,
        valeId: id,
        motivo: body.motivo,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.order_refund')
  @Post('comandas/:id/estornar')
  async estornar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(estornoSchema)) body: { motivo: string },
  ) {
    const local = await this.unidade(staff);
    try {
      return await estornarVenda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        motivo: body.motivo,
        hoje: local.today,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.package_transfer')
  @Post('pacotes/:id/transferir')
  async transferir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(transferenciaDePacoteSchema)) body: {
      paraCustomerId: string;
      motivo: string;
    },
  ) {
    try {
      return await transferirPacote({
        tenantId: staff.tenantId,
        customerPackageId: id,
        paraCustomerId: body.paraCustomerId,
        motivo: body.motivo,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
