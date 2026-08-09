import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ImportacaoError,
  SlugError,
  adicionarSlugLegado,
  analisarImportacao,
  aplicarImportacao,
  lerImportacao,
  listarImportacoes,
  listarSlugs,
  reverterImportacao,
} from '@barbearia/crm';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { importIdSchema, importacaoSchema, slugLegadoSchema } from './importacao.schemas.js';

/**
 * A importação de base — SPEC §5.8.
 *
 * **`customers.edit`, não `settings.manage`.** A importação cria e apaga
 * cliente em massa, e é essa a permissão que já governa mexer em cliente. Usar
 * a de configuração faria a rota dizer "mexe no cadastro da casa" enquanto
 * mexe na base de pessoas — a permissão declarada tem que descrever o que a
 * rota faz, que é a regra que a `/security-review` cobrou no bloco 21.
 *
 * O slug legado é o contrário e por isso está em `settings.manage`: ele não
 * toca cliente nenhum, muda o endereço público da barbearia.
 *
 * ## O dia e o ano vêm da unidade
 *
 * `07/09/05` é 2005 ou 1905 conforme o ano corrente, e o ano corrente é o **da
 * unidade** (defeito D2). Um servidor em UTC virando o ano seis horas antes de
 * Salvador decidiria diferente para o mesmo arquivo.
 */

const STATUS: Record<string, number> = {
  csv_invalido: 400,
  sem_coluna_de_nome: 400,
  sem_coluna_de_telefone: 400,
  arquivo_vazio: 400,
  nao_encontrada: 404,
  ja_aplicada: 409,
  nao_aplicada: 409,
  tem_movimento: 409,
  formato_invalido: 400,
  reservado: 400,
  ja_usado: 409,
  ja_e_seu: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof ImportacaoError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message, {
      ...(error.detalhe ? { detalhe: error.detalhe } : {}),
    });
  }
  if (error instanceof SlugError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class ImportacaoController {
  private async anoDaCasa(tenantId: string): Promise<number> {
    const local = await primaryLocation(tenantId);
    if (!local) throw notFound('unknown_location', 'Unidade não encontrada');
    return Number(diaNaUnidade(null, local.timezone, new Date()).dia.slice(0, 4));
  }

  @Exige('customers.edit')
  @Recurso('importacao')
  @Get('imports')
  async listar(@Staff() staff: AuthenticatedStaff) {
    return { imports: await listarImportacoes({ tenantId: staff.tenantId }) };
  }

  /** Uma importação e o que ela deixou para conferir, depois do redirecionamento. */
  @Exige('customers.edit')
  @Recurso('importacao')
  @Get('imports/:id')
  async ler(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(importIdSchema)) id: string,
  ) {
    try {
      return await lerImportacao({ tenantId: staff.tenantId, importId: id });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * O preview. Não grava cliente nenhum — só lê o arquivo e conta.
   *
   * `POST` apesar de não aplicar nada, porque o arquivo vai no corpo e não cabe
   * numa querystring. O que ele cria é o registro da importação, que é o
   * recurso que o passo seguinte aplica.
   */
  @Exige('customers.edit')
  @Recurso('importacao')
  @Post('imports')
  async analisar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(importacaoSchema))
    body: { fileName: string; conteudo: string; separador?: ',' | ';' | '\t' },
  ) {
    try {
      return await analisarImportacao({
        tenantId: staff.tenantId,
        staffId: staff.staffUserId,
        fileName: body.fileName,
        conteudo: body.conteudo,
        anoLimite: await this.anoDaCasa(staff.tenantId),
        ...(body.separador ? { separador: body.separador } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('customers.edit')
  @Recurso('importacao')
  @Post('imports/:id/apply')
  async aplicar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(importIdSchema)) id: string,
    @Req() req: Request,
  ) {
    try {
      return await aplicarImportacao({
        tenantId: staff.tenantId,
        importId: id,
        staffId: staff.staffUserId,
        staffName: staff.name,
        agora: new Date(),
        ...(req.ip ? { ip: req.ip } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('customers.edit')
  @Recurso('importacao')
  @Post('imports/:id/revert')
  async reverter(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(importIdSchema)) id: string,
    @Req() req: Request,
  ) {
    try {
      return await reverterImportacao({
        tenantId: staff.tenantId,
        importId: id,
        staffId: staff.staffUserId,
        staffName: staff.name,
        agora: new Date(),
        ...(req.ip ? { ip: req.ip } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Get('slugs')
  async slugs(@Staff() staff: AuthenticatedStaff) {
    return { slugs: await listarSlugs(staff.tenantId) };
  }

  @Exige('settings.manage')
  @Post('slugs')
  async adicionarSlug(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(slugLegadoSchema)) body: { slug: string },
    @Req() req: Request,
  ) {
    try {
      return await adicionarSlugLegado({
        tenantId: staff.tenantId,
        slug: body.slug,
        staffId: staff.staffUserId,
        staffName: staff.name,
        ...(req.ip ? { ip: req.ip } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }
}
