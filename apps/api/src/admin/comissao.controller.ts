import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ComissaoError,
  extratoDeComissao,
  fecharPeriodoDeComissao,
  fechamentosDeComissao,
  regrasDeComissao,
  removerRegraDeComissao,
  aliquotasDoAdquirente,
  salvarAliquotaDoAdquirente,
  salvarConfiguracaoDeComissao,
  salvarRegraDeComissao,
} from '@barbearia/finance';
import {
  diaNaUnidade,
  type BaseDeComissao,
  type FaixaDeComissao,
  type ModoDeComissao,
  type FormaDePagamento,
  type TratamentoDaTaxa,
  type TratamentoDoDesconto,
} from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  aliquotaDoAdquirenteSchema,
  configuracaoDeComissaoSchema,
  fecharComissaoSchema,
  periodoSchema,
  regraDeComissaoSchema,
  uuidSchema,
} from './caixa.schemas.js';

const STATUS: Record<string, number> = {
  regra_nao_encontrada: 404,
  regra_invalida: 400,
  periodo_invalido: 400,
  // 409: quem pede tem permissão; o que mudou foi o estado do período.
  periodo_ja_fechado: 409,
  nada_a_fechar: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof ComissaoError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

/**
 * Comissão.
 *
 * A separação que a SPEC §1.3 chama de não negociável está aqui, e não numa
 * checagem espalhada: **`commission.view_own` ≠ `commission.view_all`**.
 * Barbeiro que vê a comissão do colega é o motivo nº 1 de briga interna em
 * barbearia.
 *
 * **São duas rotas, não uma com `if`**, e a razão é a guarda.
 *
 * A primeira versão tinha uma rota só, declarando `commission.view_own` e
 * decidindo por dentro se devolvia a folha inteira. Isso quebrava a premissa da
 * `PermissaoGuard`: ela deriva a exigência de segundo fator da permissão
 * **declarada**, então a rota era liberada pela permissão barata e servia o
 * dado da cara. O dono lia a folha de todo mundo sem segundo fator nenhum,
 * enquanto a rota ao lado, de mudar regra, o exigia.
 *
 * E havia um defeito de produto junto: o gerente tem `view_all` e **não** tem
 * `view_own`, então a exigência conjuntiva o trancava para fora da própria
 * tela. O controle estava invertido nos dois sentidos — quem podia ver não
 * entrava, e quem entrava via mais do que a permissão declarada permitia.
 *
 * Com duas rotas, a invariante volta: o que o `@Exige` diz é o que a rota faz.
 */
@Controller('v1/admin/commission')
@UseGuards(StaffGuard, PermissaoGuard)
export class ComissaoController {
  /**
   * O recorte do próprio profissional.
   *
   * Sem ficha de agenda, um id que não casa com nada — e não `null`, que
   * significaria "vê todo mundo". É o padrão seguro: sem vínculo, sem comissão
   * para mostrar, em vez de sem vínculo, vê tudo.
   */
  private eu(staff: AuthenticatedStaff): string {
    return staff.professionalId ?? '00000000-0000-0000-0000-000000000000';
  }

  private async periodoPadrao(staff: AuthenticatedStaff, query: { de?: string; ate?: string }) {
    const local = await unidadeDoBalcao(staff);

    // Sem período informado, o mês corrente **da unidade**. Vindo do aparelho,
    // a barbearia com relógio torto veria o mês trocado na virada (defeito D2).
    const hoje = diaNaUnidade(null, local.timezone, new Date()).dia;
    const de = query.de ?? `${hoje.slice(0, 7)}-01`;
    const ate = query.ate ?? hoje;
    return { de, ate };
  }

  /** A própria comissão. Sem segundo fator: é o holerite de quem pergunta. */
  @Exige('commission.view_own')
  @Get('mine')
  async minhaComissao(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoSchema)) query: { de?: string; ate?: string },
  ) {
    const { de, ate } = await this.periodoPadrao(staff, query);
    return extratoDeComissao({
      tenantId: staff.tenantId,
      de,
      ate,
      somenteProfessionalId: this.eu(staff),
    });
  }

  @Exige('commission.view_own')
  @Get('mine/closures')
  async meusFechamentos(@Staff() staff: AuthenticatedStaff) {
    return {
      fechamentos: await fechamentosDeComissao({
        tenantId: staff.tenantId,
        somenteProfessionalId: this.eu(staff),
      }),
    };
  }

  /** A folha inteira. `view_all` está no grupo de dinheiro: exige segundo fator. */
  @Exige('commission.view_all')
  @Get()
  async extrato(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoSchema)) query: { de?: string; ate?: string },
  ) {
    const { de, ate } = await this.periodoPadrao(staff, query);
    return extratoDeComissao({ tenantId: staff.tenantId, de, ate });
  }

  @Exige('commission.view_all')
  @Get('closures')
  async fechamentos(@Staff() staff: AuthenticatedStaff) {
    return { fechamentos: await fechamentosDeComissao({ tenantId: staff.tenantId }) };
  }

  /**
   * Fecha o período.
   *
   * `commission.edit_rules` porque fechar é o ato que **paga**: depois dele o
   * valor é imutável e o ajuste vira lançamento novo. Não é leitura de
   * relatório, e por isso não fica sob `view_all`.
   */
  @Exige('commission.edit_rules')
  @Post('closures')
  async fechar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(fecharComissaoSchema))
    body: { de: string; ate: string; notas?: string },
  ) {
    try {
      return await fecharPeriodoDeComissao({
        tenantId: staff.tenantId,
        de: body.de,
        ate: body.ate,
        staffId: staff.staffUserId,
        staffName: staff.name,
        notas: body.notas ?? null,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('commission.edit_rules')
  @Get('rules')
  async regras(@Staff() staff: AuthenticatedStaff) {
    return regrasDeComissao(staff.tenantId);
  }

  @Exige('commission.edit_rules')
  @Put('rules')
  async salvarRegra(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(regraDeComissaoSchema))
    body: {
      professionalId?: string;
      serviceId?: string;
      categoryId?: string;
      modo: ModoDeComissao;
      valor: number;
      faixas?: FaixaDeComissao[];
    },
  ) {
    try {
      return await salvarRegraDeComissao({
        tenantId: staff.tenantId,
        professionalId: body.professionalId ?? null,
        serviceId: body.serviceId ?? null,
        categoryId: body.categoryId ?? null,
        modo: body.modo,
        valor: body.valor,
        faixas: body.faixas ?? [],
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('commission.edit_rules')
  @Delete('rules/:id')
  async removerRegra(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      await removerRegraDeComissao({
        tenantId: staff.tenantId,
        id,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('commission.edit_rules')
  @Put('settings')
  async configuracao(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(configuracaoDeComissaoSchema))
    body: {
      base: BaseDeComissao;
      tratamentoDoDesconto: TratamentoDoDesconto;
      tratamentoDaTaxa: TratamentoDaTaxa;
    },
  ) {
    await salvarConfiguracaoDeComissao({
      tenantId: staff.tenantId,
      base: body.base,
      tratamentoDoDesconto: body.tratamentoDoDesconto,
      tratamentoDaTaxa: body.tratamentoDaTaxa,
      staffId: staff.staffUserId,
      staffName: staff.name,
    });
    return { ok: true };
  }

  /**
   * A alíquota que a barbearia paga ao adquirente (bloco 36).
   *
   * `commission.edit_rules` e não `finance.view`: mudar esta alíquota muda
   * quanto o barbeiro recebe quando o rateio está ligado. É a mesma permissão
   * da regra de comissão porque é a mesma consequência.
   */
  @Exige('commission.edit_rules')
  @Get('fees')
  async aliquotas(@Staff() staff: AuthenticatedStaff) {
    return { aliquotas: await aliquotasDoAdquirente(staff.tenantId) };
  }

  @Exige('commission.edit_rules')
  @Put('fees')
  async salvarAliquota(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(aliquotaDoAdquirenteSchema))
    body: { forma: FormaDePagamento; bps: number },
  ) {
    try {
      await salvarAliquotaDoAdquirente({
        tenantId: staff.tenantId,
        forma: body.forma,
        bps: body.bps,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
