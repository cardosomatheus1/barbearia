import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { lacunasDaRecepcao, resolverLacuna } from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';

/**
 * As perguntas que a recepção digital não soube responder (bloco 66, SPEC §4.17).
 *
 * ## Por que `feedback.*`, e não uma permissão nova
 *
 * É o mesmo assunto do recado: o que o cliente disse e a casa não resolveu. Ler
 * a lista e **marcar como resolvida** são tarefas diferentes pela mesma razão
 * que separam `feedback.view` de `feedback.manage` — e reaproveitar o par evita
 * criar uma permissão que nenhum papel tem, que é como `feedback.view` e
 * `feedback.manage` ficaram três blocos invisíveis na tela de permissões.
 *
 * ## E por que **não** `customers.view`
 *
 * A rota que agrega declara todas as permissões do que devolve — e o que esta
 * devolve é texto de pergunta, sem nome, sem telefone e sem id de cliente. A
 * tabela não tem `customer_id` de propósito (a pergunta mais valiosa é a de quem
 * ainda não é cliente), então não há cadastro para proteger aqui. Se um dia a
 * lista passar a dizer **quem** perguntou, esta linha muda junto.
 */
@Controller('v1/admin/recepcao')
@UseGuards(StaffGuard, PermissaoGuard)
export class RecepcaoController {
  @Exige('feedback.view')
  @Get('lacunas')
  async lacunas(@Staff() staff: AuthenticatedStaff) {
    const lacunas = await lacunasDaRecepcao(staff.tenantId);
    return { lacunas };
  }

  /**
   * O dono marca como resolvida depois de cadastrar o que faltava.
   *
   * O 409 é o toque duplo, e ele é informação: a segunda pessoa que clicou
   * precisa saber que a primeira já resolveu, não ver "pronto" sobre nada. Quem
   * decide é a contagem de linhas afetadas, no domínio.
   *
   * Não existe rota de apagar. `REVOKE DELETE` está na tabela, e a razão é a
   * mesma do recado: apagar a pergunta que ninguém soube responder é apagar
   * exatamente o dado que esta lista existe para produzir.
   */
  @Exige('feedback.manage')
  @Post('lacunas/:id/resolver')
  async resolver(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const resolvida = await resolverLacuna({
      tenantId: staff.tenantId,
      lacunaId: id,
      staffUserId: staff.staffUserId,
    });
    if (!resolvida) {
      throw new DomainError(
        'lacuna_ja_resolvida',
        409,
        'Esta pergunta já foi marcada como resolvida.',
      );
    }
    return { resolvida: true };
  }
}
