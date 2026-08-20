import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  MultiunidadeError,
  saldosPorUnidade,
  transferenciasDaCasa,
  transferirEstoque,
} from '@barbearia/finance';
import {
  StaffError,
  definirUnidadesDoOperador,
  escolherUnidadeDaSessao,
  listStaff,
  unidadesPorOperador,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { produtos } from '@barbearia/finance';
import { CatalogError, criarUnidade, definirUnidadeAtiva, unidadesDoCadastro } from '@barbearia/catalog';
import { diaNaUnidade } from '@barbearia/core';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { selecaoDoBalcao, unidadeDoBalcao } from './unidade.js';
import { uuidSchema } from './caixa.schemas.js';
import {
  criarUnidadeSchema,
  escolherUnidadeSchema,
  transferenciaSchema,
  unidadeAtivaSchema,
  unidadesDoOperadorSchema,
} from './multiunidade.schemas.js';

/**
 * Multiunidade (bloco 58, SPEC §1.1 e §1.3).
 *
 * ## As três permissões, e por que não são a mesma
 *
 * - **Escolher em qual loja estou** é `@Exige()` — sessão e mais nada. Toda
 *   pessoa da equipe precisa disso para trabalhar, e exigir permissão faria a
 *   recepcionista da filial depender do dono para poder abrir o próprio caixa.
 *   O que a escolha *não* faz é ampliar acesso: ela é conferida contra
 *   `staff_locations` no `UPDATE`, e o que a pessoa pode fazer continua saindo
 *   de `role_permissions`.
 * - **Dizer quem opera qual loja** é `team.manage`, junto de `settings.manage`:
 *   a rota devolve a equipe inteira com papel e vínculo, e uma rota que agrega
 *   declara **todas** as permissões do que devolve.
 * - **Transferir estoque** é `inventory.adjust`, e não `inventory.view`: a
 *   transferência move saldo entre lojas sem venda nem compra, que é
 *   exatamente o que `adjust` separa desde o bloco 44.
 *
 * ## Por que a transferência não é `finance.*`
 *
 * Porque não move dinheiro: o custo unitário viaja congelado, e a soma dos dois
 * movimentos é zero. Cobrar segundo fator para mandar dez shampoos para a
 * filial seriam trinta confirmações por semana — o mesmo raciocínio que deixou
 * a nota fiscal fora do grupo derivado no bloco 54.
 */

const STATUS: Record<string, number> = {
  mesma_unidade: 400,
  quantidade_invalida: 400,
  saldo_insuficiente: 409,
  unidade_fechada: 409,
  produto_nao_encontrado: 404,
  unidade_nao_encontrada: 404,
  unknown_location: 404,
  staff_not_found: 404,
  owner_protected: 409,
  cannot_grant: 403,
  invalid_location: 400,
  location_not_found: 404,
  ultima_unidade: 409,
};

const contexto = (request: Request) => ({
  ...(request.ip ? { ip: request.ip } : {}),
  ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
});

function toHttp(erro: unknown): never {
  if (
    erro instanceof MultiunidadeError ||
    erro instanceof StaffError ||
    erro instanceof CatalogError
  ) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class MultiunidadeController {
  /**
   * Em qual loja estou, e quais posso escolher.
   *
   * Não recusa quando não há unidade legível: esta é a tela que conserta esse
   * problema, e quebrá-la por causa dele deixaria a pessoa sem caminho.
   */
  @Exige()
  @Get('unidades')
  async selecao(@Staff() staff: AuthenticatedStaff) {
    return selecaoDoBalcao(staff);
  }

  @Exige()
  @Post('unidades/escolher')
  async escolher(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(escolherUnidadeSchema)) body: { unidadeId: string },
  ) {
    try {
      await escolherUnidadeDaSessao({
        tenantId: staff.tenantId,
        sessionId: staff.sessionId,
        staffUserId: staff.staffUserId,
        locationId: body.unidadeId,
      });
    } catch (erro) {
      toHttp(erro);
    }
    return { ok: true };
  }

  /**
   * Abrir a segunda loja.
   *
   * `settings.manage`, e não `team.manage`: é cadastro do negócio, como serviço
   * e recurso. Sem esta rota o bloco inteiro seria inalcançável — `active`,
   * `staff_locations` e a transferência só existem a partir da segunda unidade,
   * e nada no produto criava uma.
   */
  @Exige('settings.manage')
  @Get('unidades/cadastro')
  async cadastro(@Staff() staff: AuthenticatedStaff) {
    return { unidades: await unidadesDoCadastro(staff.tenantId) };
  }

  @Exige('settings.manage')
  @Post('unidades/cadastro')
  async abrirUnidade(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(criarUnidadeSchema))
    body: { nome: string; timezone: string; cidade?: string | null },
  ) {
    try {
      return await criarUnidade({
        tenantId: staff.tenantId,
        nome: body.nome,
        timezone: body.timezone,
        cidade: body.cidade ?? null,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      toHttp(erro);
    }
  }

  @Exige('settings.manage')
  @Post('unidades/cadastro/:id')
  async abrirOuFechar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) locationId: string,
    @Body(new ZodValidationPipe(unidadeAtivaSchema)) body: { ativa: boolean },
  ) {
    try {
      await definirUnidadeAtiva({
        tenantId: staff.tenantId,
        locationId,
        ativa: body.ativa,
        // A lista do seletor decide o que a tela **oferece**; ela não guarda o
        // `POST`, que recebe o id do corpo. Mesmo achado do bloco 58, na
        // terceira porta — aqui o estrago é fechar a loja alheia e derrubar a
        // equipe dela.
        autorizadas: staff.unidadesAutorizadas,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      toHttp(erro);
    }
    return { ok: true };
  }

  /** A equipe com o vínculo de unidade, para a tela de quem administra o quê. */
  @Exige('team.manage', 'settings.manage')
  @Get('unidades/equipe')
  async equipe(@Staff() staff: AuthenticatedStaff) {
    const [pessoas, vinculos, unidades] = await Promise.all([
      listStaff(staff.tenantId),
      unidadesPorOperador(staff.tenantId),
      selecaoDoBalcao(staff),
    ]);
    return {
      unidades: unidades.disponiveis,
      equipe: pessoas.map((p) => ({
        id: p.id,
        nome: p.name,
        papel: p.role,
        // Vazio significa "todas", e a tela precisa dizer isso em letras.
        unidades: vinculos[p.id] ?? [],
      })),
    };
  }

  @Exige('team.manage', 'settings.manage')
  @Post('unidades/equipe/:id')
  async definirUnidades(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) staffUserId: string,
    @Body(new ZodValidationPipe(unidadesDoOperadorSchema)) body: { unidades: string[] },
    @Req() request: Request,
  ) {
    try {
      await definirUnidadesDoOperador({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        staffUserId,
        unidades: body.unidades,
        ...contexto(request),
      });
    } catch (erro) {
      toHttp(erro);
    }
    return { ok: true };
  }

  @Exige('inventory.adjust')
  @Get('estoque/transferencias')
  async transferencias(@Staff() staff: AuthenticatedStaff) {
    const [lista, catalogo, saldos, selecao] = await Promise.all([
      transferenciasDaCasa(staff.tenantId, staff.unidadesAutorizadas),
      // Aqui o saldo da rede é o certo, e a tela escreve "na rede" ao lado:
      // é a transferência que decide de qual loja o produto sai.
      produtos(staff.tenantId, false, new Date(), null),
      saldosPorUnidade(staff.tenantId, staff.unidadesAutorizadas),
      selecaoDoBalcao(staff),
    ]);
    return {
      transferencias: lista,
      /**
       * Sem `custoCents` nem `precoCents`.
       *
       * `ProdutoNaTela` traz o custo, e custo é `finance.view_profit` desde o
       * bloco 44 — esta rota é `inventory.adjust`. Uma rota devolve **o que a
       * permissão que ela declara cobre**, e a tela da transferência precisa de
       * nome e saldo.
       */
      produtos: catalogo.map((p) => ({ id: p.id, nome: p.nome, saldo: p.saldo })),
      saldos,
      unidades: selecao.disponiveis.filter((u) => u.ativa),
    };
  }

  @Exige('inventory.adjust')
  @Post('estoque/transferencias')
  async transferir(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(transferenciaSchema))
    body: {
      produtoId: string;
      origemId: string;
      destinoId: string;
      quantidade: number;
      nota?: string | null;
    },
  ) {
    const local = await unidadeDoBalcao(staff);
    try {
      return await transferirEstoque({
        tenantId: staff.tenantId,
        produtoId: body.produtoId,
        origemId: body.origemId,
        destinoId: body.destinoId,
        quantidade: body.quantidade,
        nota: body.nota ?? null,
        // A lista do seletor decide o que a tela **oferece**; ela não guarda o
        // `POST`, que recebe o id do corpo. Achado da revisão do bloco 58.
        autorizadas: staff.unidadesAutorizadas,
        // O dia da unidade, nunca o do aparelho: às 22h de Salvador o UTC já
        // virou, e o movimento cairia no dia seguinte do relatório.
        diaDaUnidade: diaNaUnidade(null, local.timezone, new Date()).dia,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      toHttp(erro);
    }
  }
}
