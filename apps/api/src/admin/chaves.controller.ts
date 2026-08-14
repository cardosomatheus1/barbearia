import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyError, chavesDaCasa, criarChave, revogarChave } from '@barbearia/identity';
import { ESCOPOS_DISPONIVEIS, type Permissao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { novaChaveSchema, revogacaoDaChaveSchema } from './chaves.schemas.js';

/**
 * Chaves de API da barbearia (bloco 78).
 *
 * ## `team.manage`, e não `settings.manage`
 *
 * Emitir uma chave é criar um **ator** com um conjunto de permissões — a mesma
 * coisa que criar uma conta de equipe, e não uma preferência da casa. Quem pode
 * dar permissão a uma pessoa é quem pode dar a uma máquina.
 *
 * E ninguém concede o que não tem: os escopos que o ator pode dar saem do
 * **banco**, nunca do formulário. Sem isso, criar uma chave seria o caminho
 * curto para se dar a permissão que o papel não tem — o defeito que o bloco 30
 * fechou para papéis, e que uma porta nova reabriria.
 *
 * ## O segredo aparece uma vez
 *
 * A criação devolve a chave inteira; a listagem devolve prefixo, escopo e datas.
 * Não há rota que releia o segredo, porque não existe segredo para reler — o
 * banco tem o HMAC. É a postura da senha de primeiro acesso do bloco 29, um
 * grau mais rígida: lá a senha ainda saía por mensagem.
 */

const STATUS: Record<string, number> = {
  pepper_ausente: 500,
  escopo_vazio: 400,
  escopo_desconhecido: 400,
  escopo_de_dinheiro: 403,
  escopo_irreversivel: 403,
  escopo_alem_do_ator: 403,
  chave_nao_encontrada: 404,
  motivo_obrigatorio: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof ApiKeyError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message, erro.detalhe);
  }
  throw erro;
}

@Controller('v1/admin/chaves')
@UseGuards(StaffGuard, PermissaoGuard)
export class ChavesController {
  @Exige('team.manage')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    return {
      chaves: await chavesDaCasa(staff.tenantId),
      /**
       * O catálogo já vem **recortado pelo que esta pessoa pode**.
       *
       * Mandar a lista inteira e esconder na tela seria permissão recalculada na
       * view — e diria a quem não tem uma permissão que ela existe, o que é
       * informação por si.
       */
      disponiveis: ESCOPOS_DISPONIVEIS.filter((e) => staff.permissions.includes(e)),
    };
  }

  @Exige('team.manage')
  @Post()
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(novaChaveSchema)) body: { nome: string; escopos: string[] },
  ) {
    try {
      return await criarChave({
        tenantId: staff.tenantId,
        staffId: staff.staffUserId,
        staffName: staff.name,
        nome: body.nome,
        escopos: body.escopos,
        escoposDoAtor: staff.permissions as Permissao[],
      });
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('team.manage')
  @Post(':chaveId/revogacao')
  async revogar(
    @Staff() staff: AuthenticatedStaff,
    // Id malformado é 400 com motivo, nunca 500.
    @Param('chaveId', new ZodValidationPipe(uuidSchema)) chaveId: string,
    @Body(new ZodValidationPipe(revogacaoDaChaveSchema)) body: { motivo: string },
  ) {
    try {
      await revogarChave({
        tenantId: staff.tenantId,
        staffId: staff.staffUserId,
        staffName: staff.name,
        chaveId,
        motivo: body.motivo,
      });
      return { ok: true };
    } catch (erro) {
      toHttp(erro);
    }
  }
}
