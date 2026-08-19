import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import {
  AutomacaoError,
  automacoesDaCasa,
  definirAutomacaoAtiva,
  salvarAutomacao,
} from '@barbearia/crm';
import { saudeDaFila } from '@barbearia/jobs';
import type { Gatilho, Objetivo, Segmento, TipoDeNotificacao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { automacaoSchema, estadoDaAutomacaoSchema } from './automacao.schemas.js';

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
  /**
   * A fila está andando? (bloco 101)
   *
   * `marketing.send` e nada mais: a resposta são três contagens e um instante —
   * não devolve cadastro, nem nome, nem centavo. Quem monta campanha é quem
   * precisa saber se o que ela promete vai acontecer.
   */
  @Exige('marketing.send')
  @Get('fila')
  async fila(@Staff() staff: AuthenticatedStaff) {
    return saudeDaFila(staff.tenantId, new Date());
  }

  @Exige('marketing.send')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    return { automacoes: await automacoesDaCasa(staff.tenantId) };
  }

  /**
   * Ligar e desligar, por porta própria.
   *
   * `PATCH` e não `PUT`: isto muda **uma** coluna, e a diferença não é
   * cosmética. Enquanto o freio passava pelo formulário inteiro, uma regra nova
   * sobre o conteúdo da automação trancava a saída das linhas antigas — e foi o
   * que aconteceu quando o tipo foi fechado em `TIPOS_DE_CAMPANHA`: a automação
   * com tipo velho respondia 400 e continuava ligada, sem saída pela tela.
   *
   * Desligar é o freio de emergência de um canal que fala com cliente. Ele não
   * pode depender de o resto da linha ainda ser válido.
   */
  @Exige('marketing.send')
  @Patch('estado')
  async estado(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(estadoDaAutomacaoSchema)) body: { id: string; ativa: boolean },
  ) {
    try {
      return await definirAutomacaoAtiva({
        tenantId: staff.tenantId,
        id: body.id,
        ativa: body.ativa,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
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
      templateId?: string | null;
      publico?: Segmento | null;
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
        templateId: body.templateId ?? null,
        // Ausente é "não mexa": o spread condicional é o que preserva a
        // distinção entre "todo mundo" (null) e "não veio no corpo".
        ...(body.publico === undefined ? {} : { publico: body.publico }),
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
