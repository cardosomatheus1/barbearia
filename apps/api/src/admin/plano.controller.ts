import { Controller, Get, UseGuards } from '@nestjs/common';
import { assinaturaDaBarbearia, recursosDaBarbearia } from '@barbearia/platform';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { notFound } from '../common/errors.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';

/**
 * O plano, visto pela barbearia que paga por ele.
 *
 * A assinatura nasceu no bloco 27 dentro do painel da plataforma, e ficar só
 * lá seria o defeito de sempre pelo avesso: o dado existe, é cobrado, e a
 * pessoa de quem se cobra não consegue vê-lo. Quando a régua do bloco 28
 * começar a mandar aviso de vencimento, é para esta tela que ela vai apontar.
 *
 * **Só leitura, e é decisão.** Trocar de plano por autoatendimento é o bloco
 * 28, junto com o rateio proporcional — mudar de faixa no meio do período muda
 * quanto se cobra, e mostrar um botão que ainda não sabe fazer essa conta seria
 * prometer o que não se entrega.
 *
 * `settings.manage` e não `finance.view`: o que está aqui é o contrato do
 * software, não o dinheiro da barbearia. Exigir a permissão de finanças
 * obrigaria o segundo fator para ler o próprio plano, e o dono que ainda não
 * cadastrou o autenticador ficaria sem saber por que a conta dele vai vencer.
 */
@Controller('v1/admin/plano')
@UseGuards(StaffGuard, PermissaoGuard)
export class PlanoController {
  @Exige('settings.manage')
  @Get()
  async plano(@Staff() staff: AuthenticatedStaff) {
    const assinatura = await assinaturaDaBarbearia(staff.tenantId);
    if (!assinatura) throw notFound('unknown_subscription', 'Assinatura não encontrada');

    const recursos = await recursosDaBarbearia(staff.tenantId);

    return {
      plano: {
        code: assinatura.planoCode,
        nome: assinatura.planoNome,
        publico: assinatura.publico,
        precoCents: assinatura.precoCents,
      },
      estado: assinatura.estado,
      testeAte: assinatura.testeAte?.toISOString() ?? null,
      periodoAte: assinatura.periodoAte.toISOString(),
      cadeiras: { emUso: assinatura.cadeirasEmUso, teto: assinatura.tetoDeCadeiras },
      /**
       * Os recursos com a origem de cada resposta.
       *
       * `noPlano` é o que separa "você tem isto porque paga por ele" de "você
       * tem isto de cortesia". Sem a distinção, a tela deixaria o dono do
       * Starter achar que fila de espera veio no pacote — e reclamar quando a
       * cortesia acabar.
       */
      recursos: recursos.map((r) => ({
        code: r.code,
        nome: r.nome,
        descricao: r.descricao,
        ligado: r.ligado,
        noPlano: r.noPlano,
      })),
    };
  }
}
