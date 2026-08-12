import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { MetaError, desempenhoDoProfissional, metasDoMes, salvarMeta } from '@barbearia/finance';
import { primaryLocation } from '@barbearia/scheduling';
import { mediaDoProfissional } from '@barbearia/crm';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { metaSchema } from './ficha.schemas.js';

const STATUS: Record<string, number> = {
  profissional_nao_encontrado: 404,
  mes_invalido: 400,
};

function toHttp(error: unknown): never {
  if (error instanceof MetaError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

/**
 * Os números do barbeiro, e as metas da casa.
 *
 * **Duas rotas, duas permissões, e a separação não é cosmética.**
 *
 * `GET /pro/me` declara `commission.view_own` — é o próprio holerite de quem
 * pergunta, e o recorte sai de `staff.professionalId`, **nunca** de um
 * parâmetro. Foi exatamente o defeito que a `/security-review` do bloco 19
 * encontrou: uma rota que decide por dentro quanto devolve faz a permissão
 * declarada deixar de descrevê-la, e toda garantia derivada dela para de valer
 * junto — inclusive a exigência de segundo fator.
 *
 * `PUT /goals` declara `settings.manage`. Definir meta não move dinheiro e não
 * revela o de ninguém: é configuração da casa, do mesmo tipo que a janela de
 * cancelamento. Pôr aqui `commission.edit_rules` — que é do grupo de dinheiro e
 * exige segundo fator — obrigaria o dono a digitar um código de seis dígitos
 * para escrever um número que ele acabou de combinar em voz alta com o
 * barbeiro.
 */
@Controller('v1/admin/pro')
@UseGuards(StaffGuard, PermissaoGuard)
export class ProController {
  /**
   * O dia da unidade, nunca o do aparelho.
   *
   * O mês da meta vira do dia 1 ao 30 no fuso da barbearia. Vindo do
   * dispositivo, quem abrisse a tela às 21h de 30 de setembro em outro fuso
   * veria outubro — que é o defeito D2 aplicado a dinheiro.
   */
  private async hoje(tenantId: string): Promise<string> {
    const local = await primaryLocation(tenantId);
    if (!local) throw notFound('unknown_location', 'Unidade não encontrada');
    return diaNaUnidade(null, local.timezone, new Date()).dia;
  }

  @Exige('commission.view_own')
  @Get('me')
  async meusNumeros(@Staff() staff: AuthenticatedStaff) {
    /**
     * Sem cadeira, um id que não casa com nada — e não `null`, que significaria
     * "todo mundo". É o padrão seguro do bloco 19: sem vínculo, sem números,
     * em vez de sem vínculo, vê tudo.
     */
    const eu = staff.professionalId;
    if (!eu) {
      throw new DomainError(
        'sem_cadeira',
        409,
        'Sua conta não está ligada a uma cadeira. Peça para o dono te convidar pelo cadastro.',
      );
    }

    try {
      const hoje = await this.hoje(staff.tenantId);
      const numeros = await desempenhoDoProfissional({
        tenantId: staff.tenantId,
        professionalId: eu,
        hoje,
      });

      /**
       * A nota do barbeiro entra aqui, e não numa rota de avaliações (bloco 43).
       *
       * `commission.view_own` é a permissão que já significa "os **meus**
       * números", e é a única que cabe: `reviews.view` dá as avaliações da casa
       * inteira, e a nota de um colega na tela do outro é a briga que
       * `commission.view_own` existe para evitar. A SPEC §4.21 manda comparar
       * com o próprio passado, nunca com o colega — daí os dois meses, e nenhum
       * ranking.
       */
      const mes = new Date(`${hoje.slice(0, 7)}-01T00:00:00Z`);
      const mesQueVem = new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth() + 1, 1));
      const mesPassado = new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth() - 1, 1));

      const [nota, notaAnterior] = await Promise.all([
        mediaDoProfissional(staff.tenantId, eu, mes, mesQueVem),
        mediaDoProfissional(staff.tenantId, eu, mesPassado, mes),
      ]);

      return { ...numeros, nota, notaAnterior };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Get('goals')
  async metas(@Staff() staff: AuthenticatedStaff) {
    const hoje = await this.hoje(staff.tenantId);
    return { mes: `${hoje.slice(0, 7)}-01`, metas: await metasDoMes({ tenantId: staff.tenantId, mes: hoje }) };
  }

  @Exige('settings.manage')
  @Put('goals')
  async salvarMeta(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(metaSchema))
    body: { professionalId: string; mes: string; metaCents: number | null },
  ) {
    try {
      await salvarMeta({
        tenantId: staff.tenantId,
        professionalId: body.professionalId,
        mes: body.mes,
        metaCents: body.metaCents,
        staffUserId: staff.staffUserId,
      });
      return { saved: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
