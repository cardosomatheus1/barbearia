import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  CatalogError,
  adotarItemDoPadrao,
  despublicarItemDoPadrao,
  franquiaDaCasa,
  padraoDaFranquia,
  publicarItemDoPadrao,
} from '@barbearia/catalog';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { adocaoSchema, itemDoPadraoSchema } from './franquia.schemas.js';

/**
 * Cardápio padrão da franquia (bloco 76).
 *
 * ## Duas permissões, e a divisão é a do bloco inteiro
 *
 * **Publicar** o padrão é `franchise.manage`, e só a franqueadora tem — a
 * plataforma concede quando marca a barbearia como franqueadora, porque é o
 * único instante em que se sabe que ela é uma.
 *
 * **Adotar** um item é `settings.manage`, a mesma permissão que edita o
 * catálogo — porque é exatamente isso que adotar faz: cria um serviço no
 * catálogo desta barbearia. Uma permissão nova aqui diria que adotar é outra
 * coisa, e a franqueada descobriria que quem edita o catálogo dela não pode
 * pegar o item padrão.
 *
 * ## O preço da franqueadora nunca chega aqui como ordem
 *
 * Não existe rota que escreva `services.price_cents` a partir do padrão sem
 * alguém da franqueada mandar. A franqueada é outra empresa, e impor preço de
 * revenda a um distribuidor independente é infração à ordem econômica — Lei
 * 12.529/2011, art. 36 §3º IX. O produto não oferece o caminho.
 *
 * ## Sem segundo fator, e a decisão é escrita
 *
 * `franchise.` fica fora de `PERMISSOES_DE_DINHEIRO` pela mesma razão de
 * `fiscal.`: o preço de referência não é cobrado de ninguém. O que a franqueada
 * cobra continua saindo do catálogo dela, sob `settings.manage`.
 */

const STATUS: Record<string, number> = {
  invalid_catalog: 400,
  service_not_found: 404,
  name_taken: 409,
};

function toHttp(erro: unknown): never {
  if (erro instanceof CatalogError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message, erro.detail);
  }
  throw erro;
}

@Controller('v1/admin/franquia')
@UseGuards(StaffGuard, PermissaoGuard)
export class FranquiaController {
  /**
   * A franquia da casa e o cardápio padrão, já casado com o que ela adotou.
   *
   * `settings.manage` e não `franchise.manage`: a franqueada precisa ler o
   * padrão para decidir o que vender, e ela não publica nada. Cobrar a
   * permissão da franqueadora aqui deixaria a tela vazia justamente para quem
   * ela existe.
   */
  @Exige('settings.manage')
  @Get('padrao')
  async padrao(@Staff() staff: AuthenticatedStaff) {
    const franquia = await franquiaDaCasa(staff.tenantId);
    if (!franquia) return { franquia: null, itens: [] };
    return { franquia, itens: await padraoDaFranquia(staff.tenantId) };
  }

  @Exige('franchise.manage')
  @Post('padrao')
  async publicar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(itemDoPadraoSchema)) body: {
      id?: string;
      nome: string;
      descricao: string | null;
      referenciaCents: number;
      duracaoMinutos: number;
      categoria: string | null;
      posicao: number;
    },
  ) {
    try {
      const id = await publicarItemDoPadrao(staff.tenantId, {
        ...(body.id === undefined ? {} : { id: body.id }),
        nome: body.nome,
        descricao: body.descricao,
        referenciaCents: body.referenciaCents,
        duracaoMinutos: body.duracaoMinutos,
        categoria: body.categoria,
        posicao: body.posicao,
      });
      return { id };
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('franchise.manage')
  @Delete('padrao/:itemId')
  async despublicar(@Staff() staff: AuthenticatedStaff, @Param('itemId') itemId: string) {
    try {
      await despublicarItemDoPadrao(staff.tenantId, itemId);
      return { ok: true };
    } catch (erro) {
      toHttp(erro);
    }
  }

  /**
   * Adotar é criar serviço no catálogo desta barbearia — daí `settings.manage`.
   *
   * O `itemId` vem do corpo e é conferido **sob RLS antes de gravar**: a
   * checagem de integridade referencial do Postgres ignora row security, e a
   * chave estrangeira aceitaria o item de outra franquia sem reclamar.
   */
  @Exige('settings.manage')
  @Post('adocao')
  async adotar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(adocaoSchema)) body: { itemId: string },
  ) {
    try {
      return await adotarItemDoPadrao(staff.tenantId, body.itemId);
    } catch (erro) {
      toHttp(erro);
    }
  }
}
