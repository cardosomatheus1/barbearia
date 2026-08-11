import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  RecadoError,
  assumirRecado,
  encerrarRecado,
  recadosDaCasa,
  responderRecado,
} from '@barbearia/crm';
import { primaryLocation } from '@barbearia/scheduling';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { filaDeRecadosSchema, respostaAoRecadoSchema } from '../booking/recado.schemas.js';

/**
 * A fila de triagem dos recados (bloco 40).
 *
 * ## Duas permissões, e a que não existe
 *
 * `feedback.view` lê a fila; `feedback.manage` assume, responde e encerra.
 * Mesma separação de `customers.view_notes` e `customers.edit_notes`: ler o que
 * reclamaram e **responder em nome da casa** são tarefas diferentes.
 *
 * Não existe `feedback.delete`, e a ausência é o bloco inteiro: a SPEC §4.10
 * proíbe oferecer "apagar avaliação ruim", e aqui a proibição não depende de
 * ninguém lembrar — o role da aplicação não tem `DELETE` na tabela.
 *
 * ## Ler a fila revela o nome do cliente, e por isso pede `customers.view`
 *
 * O recado traz quem reclamou. Uma rota que agrega declara **todas** as
 * permissões do que devolve, e não a mais próxima do nome — é o precedente da
 * exportação do titular, achado da revisão do bloco 31.
 */

const STATUS: Record<string, number> = {
  recado_nao_encontrado: 404,
  responsavel_desconhecido: 404,
  transicao_invalida: 409,
  sem_contato: 409,
  resposta_vazia: 400,
  resposta_longa: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof RecadoError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/recados')
@UseGuards(StaffGuard, PermissaoGuard)
export class RecadoController {
  @Exige('feedback.view', 'customers.view')
  @Get()
  async fila(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(filaDeRecadosSchema))
    query: { incluirEncerrados?: '0' | '1' },
  ) {
    const local = await primaryLocation(staff.tenantId);
    if (!local) throw notFound('unknown_location', 'Unidade não encontrada');

    const recados = await recadosDaCasa(staff.tenantId, {
      locationId: local.id,
      incluirEncerrados: query.incluirEncerrados === '1',
    });
    return { recados };
  }

  /**
   * Assumir é sempre **para si**, e o corpo não escolhe por quem.
   *
   * A primeira versão aceitava `responsavelId` do cliente, e a tela mandava
   * vazio: o botão dizia "Assumir" e devolvia o recado à triagem. Um corpo que
   * escolhe o dono também deixaria alguém pendurar a própria reclamação no
   * colega — e o gesto que a tela oferece é um só.
   *
   * Passar para outra pessoa é outro gesto e ainda não existe; quando existir,
   * será uma rota com nome próprio.
   */
  @Exige('feedback.manage')
  @Post(':id/assumir')
  async assumir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      await assumirRecado({
        tenantId: staff.tenantId,
        recadoId: id,
        responsavelId: staff.staffUserId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      return { assumido: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /** A saída de "assumi por engano": o recado volta para a fila de triagem. */
  @Exige('feedback.manage')
  @Post(':id/devolver')
  async devolver(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      await assumirRecado({
        tenantId: staff.tenantId,
        recadoId: id,
        responsavelId: null,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      return { devolvido: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('feedback.manage')
  @Post(':id/responder')
  async responder(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(respostaAoRecadoSchema)) body: { resposta: string },
  ) {
    try {
      return await responderRecado({
        tenantId: staff.tenantId,
        recadoId: id,
        resposta: body.resposta,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('feedback.manage')
  @Post(':id/encerrar')
  async encerrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      await encerrarRecado({
        tenantId: staff.tenantId,
        recadoId: id,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      return { encerrado: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
