import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  AssinaturaError,
  assinar,
  assinaturaDoCliente,
  cancelarAssinatura,
  clubeDaCasa,
  dependentes,
  incluirDependente,
  planos,
  removerDependente,
  salvarPlano,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import {
  assinarSchema,
  cancelarSchema,
  dependenteSchema,
  planoSchema,
} from './assinatura.schemas.js';

/**
 * O clube de assinatura (bloco 45, SPEC §4.6).
 *
 * ## As permissões
 *
 * - **Ver os planos** é `appointments.view`: quem monta a comanda precisa saber
 *   o que a casa vende, e o preço de tabela não revela dinheiro de cliente algum.
 * - **Montar plano, assinar e cancelar** é `finance.subscription_manage`, que cai
 *   no grupo de dinheiro pelo prefixo e por isso vem com segundo fator derivado:
 *   assinar liga **receita recorrente**, cancelar a desliga.
 * - **A assinatura de um cliente** é `customers.view` + `finance.view`: é a ficha
 *   de uma pessoa e traz o valor que ela paga — rota que agrega declara todas as
 *   permissões do que devolve.
 */

const STATUS: Record<string, number> = {
  plano_nao_encontrado: 404,
  e_o_titular: 409,
  ja_e_dependente: 409,
  fora_do_horario_do_plano: 409,
  plano_invalido: 400,
  cliente_nao_encontrado: 404,
  ja_assina: 409,
  assinatura_nao_encontrada: 404,
  servico_nao_encontrado: 404,
  assinatura_inativa: 409,
  servico_fora_do_plano: 409,
  cota_esgotada: 409,
  dentro_do_cooldown: 409,
};

export function assinaturaParaHttp(erro: unknown): never {
  if (erro instanceof AssinaturaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/clube')
@UseGuards(StaffGuard, PermissaoGuard)
export class AssinaturaController {
  /**
   * O catálogo de planos, sem a contagem de assinantes.
   *
   * Achado da `/security-review`: `assinantes` × preço **é** o faturamento
   * recorrente da casa, que a rota do clube guarda atrás de `finance.view`.
   * Aqui, sob `appointments.view`, ele era o caminho mais curto para a permissão
   * que o dono negou — e o barbeiro tem `appointments.view` por padrão.
   *
   * O que sobra é catálogo: nome, preço de tabela e o que o plano dá. Quem monta
   * a comanda precisa disso e de nada mais.
   */
  @Exige('appointments.view')
  @Get('planos')
  async lista(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { planos: await planos(staff.tenantId, todos === 'true') };
  }

  /** O mesmo catálogo **com** a contagem, para quem já pode ver o MRR. */
  @Exige('finance.view', 'finance.subscription_manage')
  @Get('planos/contados')
  async listaContada(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { planos: await planos(staff.tenantId, todos === 'true', true) };
  }

  @Exige('finance.subscription_manage')
  @Put('planos')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(planoSchema))
    body: {
      nome: string;
      descricao?: string | null;
      precoCents: number;
      descontoEmProdutoBps: number;
      ativo: boolean;
      janelaDeAgendamentoDias?: number;
      bloqueios?: { diaDaSemana: number | null; inicio: number; fim: number }[];
      beneficios: { serviceId: string; quantidade: number | null; cooldownDias: number }[];
    },
  ) {
    try {
      return await salvarPlano({
        tenantId: staff.tenantId,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Put('planos/:id')
  async editar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(planoSchema))
    body: {
      nome: string;
      descricao?: string | null;
      precoCents: number;
      descontoEmProdutoBps: number;
      ativo: boolean;
      janelaDeAgendamentoDias?: number;
      bloqueios?: { diaDaSemana: number | null; inicio: number; fim: number }[];
      beneficios: { serviceId: string; quantidade: number | null; cooldownDias: number }[];
    },
  ) {
    try {
      return await salvarPlano({
        tenantId: staff.tenantId,
        id,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.view', 'finance.subscription_manage')
  @Get()
  async clube(@Staff() staff: AuthenticatedStaff) {
    return clubeDaCasa(staff.tenantId);
  }

  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id')
  async doCliente(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { assinatura: await assinaturaDoCliente(staff.tenantId, id) };
  }

  @Exige('finance.subscription_manage')
  @Post('assinar')
  async novaAssinatura(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(assinarSchema)) body: { customerId: string; planId: string },
  ) {
    try {
      return await assinar({
        tenantId: staff.tenantId,
        customerId: body.customerId,
        planId: body.planId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /**
   * Cancelar pelo balcão.
   *
   * Sem `customerId`: quem opera está agindo em nome da casa sobre uma
   * assinatura que ela administra, e a RLS já limita à barbearia. O
   * cancelamento **self-service** — em que o filtro por cliente é obrigatório,
   * porque a RLS não separa clientes dentro de uma casa — é do bloco 47.
   */
  /**
   * Quem mais usa a cota desta assinatura (bloco 46).
   *
   * `customers.view` junto porque a lista traz **nome de gente**: sem ela,
   * `finance.subscription_manage` viraria o caminho mais curto para a base de
   * nomes por uma rota chamada dependentes.
   */
  @Exige('finance.subscription_manage', 'customers.view')
  @Get(':id/dependentes')
  async lista_dependentes(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    // O ciclo do mês corrente: é o que a tela mostra ao lado da cota.
    const agora = new Date();
    const de = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
    const ate = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1));
    return { dependentes: await dependentes(staff.tenantId, id, de, ate) };
  }

  @Exige('finance.subscription_manage')
  @Post(':id/dependentes')
  async incluir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(dependenteSchema)) body: { customerId: string },
  ) {
    try {
      return await incluirDependente({
        tenantId: staff.tenantId,
        subscriptionId: id,
        customerId: body.customerId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Post(':id/dependentes/remover')
  async remover(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(dependenteSchema)) body: { customerId: string },
  ) {
    try {
      return await removerDependente({
        tenantId: staff.tenantId,
        subscriptionId: id,
        customerId: body.customerId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Post(':id/cancelar')
  async cancelar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelarSchema)) body: { motivo: string },
  ) {
    try {
      return await cancelarAssinatura({
        tenantId: staff.tenantId,
        assinaturaId: id,
        motivo: body.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }
}
