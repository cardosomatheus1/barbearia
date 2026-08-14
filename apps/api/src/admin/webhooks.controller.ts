import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  WebhookError,
  cadastrarEndpoint,
  desligarEndpoint,
  endpointsDaCasa,
  entregasDaCasa,
} from '@barbearia/identity';
import type { AuthenticatedStaff } from '@barbearia/identity';
import type { EventoDeWebhook } from '@barbearia/core';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { novoEndpointSchema } from './webhooks.schemas.js';

/**
 * Webhooks para terceiros (bloco 79).
 *
 * ## `team.manage`, como a chave de API
 *
 * Cadastrar um endereço é abrir um canal por onde fatos da casa saem para fora,
 * com um segredo compartilhado. É da mesma natureza de criar uma conta ou uma
 * chave, e não de escolher uma preferência.
 *
 * ## E o que sai por ali não pede permissão nenhuma além desta
 *
 * Porque o corpo não carrega dado de ninguém: id do objeto, tipo do evento e
 * instante. Se um dia alguém quiser mandar o nome do cliente junto, a regra da
 * rota que agrega volta a valer — e a resposta certa continua sendo não mandar.
 */

const STATUS: Record<string, number> = {
  chave_ausente: 500,
  url_invalida: 400,
  destino_interno: 400,
  evento_desconhecido: 400,
  sem_evento: 400,
  nome_curto: 400,
  endpoint_nao_encontrado: 404,
};

function toHttp(erro: unknown): never {
  if (erro instanceof WebhookError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message, erro.detalhe);
  }
  throw erro;
}

@Controller('v1/admin/webhooks')
@UseGuards(StaffGuard, PermissaoGuard)
export class WebhooksController {
  @Exige('team.manage')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    const [endpoints, entregas] = await Promise.all([
      endpointsDaCasa(staff.tenantId),
      entregasDaCasa(staff.tenantId),
    ]);
    return { endpoints, entregas };
  }

  @Exige('team.manage')
  @Post()
  async cadastrar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(novoEndpointSchema)) body: {
      nome: string;
      url: string;
      eventos: EventoDeWebhook[];
    },
  ) {
    try {
      return await cadastrarEndpoint({
        tenantId: staff.tenantId,
        staffId: staff.staffUserId,
        staffName: staff.name,
        nome: body.nome,
        url: body.url,
        eventos: body.eventos,
      });
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('team.manage')
  @Delete(':endpointId')
  async desligar(
    @Staff() staff: AuthenticatedStaff,
    // Id malformado é 400 com motivo, nunca 500: entrada malformada que devolve
    // erro interno é defeito de borda, sempre.
    @Param('endpointId', new ZodValidationPipe(uuidSchema)) endpointId: string,
  ) {
    try {
      await desligarEndpoint({
        tenantId: staff.tenantId,
        staffId: staff.staffUserId,
        staffName: staff.name,
        endpointId,
      });
      return { ok: true };
    } catch (erro) {
      toHttp(erro);
    }
  }
}
