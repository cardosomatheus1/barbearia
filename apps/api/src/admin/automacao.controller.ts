import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AutomacaoError, automacoesDaCasa, salvarAutomacao } from '@barbearia/crm';
import type { Gatilho, Objetivo, TipoDeNotificacao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { automacaoSchema } from './automacao.schemas.js';

/**
 * As automações da casa (bloco 56, SPEC §4.11).
 *
 * `marketing.send` e não permissão nova: ela já existe no catálogo desde o
 * bloco 30 e é exatamente isto — decidir o que a casa manda para a base de
 * clientes. Uma permissão própria seria uma segunda porta para a mesma sala.
 *
 * Não deriva segundo fator: não move centavo. O que ela custa é mensagem, e o
 * teto que protege isso é do bloco 20.
 */

const STATUS: Record<string, number> = { nao_encontrada: 404, invalida: 400 };

function toHttp(erro: unknown): never {
  if (erro instanceof AutomacaoError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/automacoes')
@UseGuards(StaffGuard, PermissaoGuard)
export class AutomacaoController {
  /**
   * A lista traz **enviadas e alcançadas** junto.
   *
   * Sem os dois números, a tela seria uma lista de automações que ninguém
   * consegue defender nem matar — que é o que a SPEC §4.11 proíbe em letras:
   * *"sem isso não há como desligar o que não funciona"*.
   */
  @Exige('marketing.send')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    return { automacoes: await automacoesDaCasa(staff.tenantId) };
  }

  @Exige('marketing.send')
  @Put()
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(automacaoSchema)) body: {
      id?: string;
      nome: string;
      gatilho: Gatilho;
      limiar: number | null;
      atrasoMinutos: number;
      tipo: TipoDeNotificacao;
      objetivo: Objetivo;
      janelaDias: number;
      ativa: boolean;
    },
  ) {
    try {
      return await salvarAutomacao({
        tenantId: staff.tenantId,
        ...(body.id ? { id: body.id } : {}),
        nome: body.nome,
        gatilho: body.gatilho,
        limiar: body.limiar,
        atrasoMinutos: body.atrasoMinutos,
        tipo: body.tipo,
        objetivo: body.objetivo,
        janelaDias: body.janelaDias,
        ativa: body.ativa,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
