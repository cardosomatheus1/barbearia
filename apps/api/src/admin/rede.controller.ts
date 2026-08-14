import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import {
  RedeError,
  metasDaRede,
  meuLugar,
  redeDaFranqueadora,
  salvarMetaDaRede,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { mesDaRedeSchema, metaDaRedeSchema, periodoDaRedeSchema } from './rede.schemas.js';

/**
 * Indicadores consolidados e metas da rede (bloco 77).
 *
 * ## `finance.view` em tudo, e o segundo fator vem junto — de propósito
 *
 * Estas rotas devolvem **faturamento de outras empresas**. É a leitura mais
 * sensível do produto, e a única em que um tenant enxerga o dinheiro de outro.
 * O prefixo `finance.` cobra TOTP a cada 30 minutos, o que na tela de consulta
 * do bloco 65 foi motivo para **não** declarar a permissão — a diferença aqui é
 * que lá o número era da própria casa.
 *
 * Combinar a meta exige `franchise.manage` **junto**: ler a rede é o contrato de
 * franquia funcionando, escrever o alvo de outra empresa é ato da franqueadora.
 * Com `finance.view` sozinha, um gerente da franqueadora — papel que já tem essa
 * permissão por padrão — passaria a definir a meta das franqueadas.
 *
 * ## A lista crua não sai por rota nenhuma
 *
 * `meuLugar` devolve só o agregado. A redação da identidade já acontece dentro
 * da função SQL; esta é a segunda camada, e ela existe porque uma rota nova que
 * devolvesse a lista entregaria os faturamentos anônimos da rede — dos quais,
 * numa rede de quatro, se deduz muita coisa.
 */

const STATUS: Record<string, number> = {
  sem_franquia: 404,
  nao_e_franqueadora: 403,
  mes_invalido: 400,
  meta_invalida: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof RedeError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/rede')
@UseGuards(StaffGuard, PermissaoGuard)
export class RedeController {
  @Exige('finance.view')
  @Get('consolidado')
  async consolidado(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDaRedeSchema)) query: { de: string; ate: string },
  ) {
    try {
      return { rede: await redeDaFranqueadora(staff.tenantId, query) };
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('finance.view')
  @Get('meu-lugar')
  async lugar(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDaRedeSchema)) query: { de: string; ate: string },
  ) {
    try {
      return { lugar: await meuLugar(staff.tenantId, query) };
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('finance.view')
  @Get('metas')
  async metas(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(mesDaRedeSchema)) query: { mes: string },
  ) {
    try {
      return { metas: await metasDaRede(staff.tenantId, query.mes) };
    } catch (erro) {
      toHttp(erro);
    }
  }

  // Ler a rede é o contrato funcionando; escrever a meta de outra empresa é ato da franqueadora.
  @Exige('finance.view', 'franchise.manage')
  @Put('metas')
  async salvarMeta(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(metaDaRedeSchema)) body: {
      franqueadaId: string;
      mes: string;
      metaCents: number;
    },
  ) {
    try {
      await salvarMetaDaRede({ tenantId: staff.tenantId, ...body });
      return { ok: true };
    } catch (erro) {
      toHttp(erro);
    }
  }
}
