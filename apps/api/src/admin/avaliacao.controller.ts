import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  AvaliacaoError,
  avaliacoesDoCliente,
  contestarAvaliacao,
  painelDeAvaliacoes,
  registrarRecuperacao,
  retirarContestacao,
} from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { atualizarVitrineDaCasa } from '@barbearia/platform';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { contestacaoSchema, recuperacaoSchema } from './avaliacao.schemas.js';

/**
 * Avaliações e recuperação de nota baixa (bloco 43, SPEC §4.10).
 *
 * ## O que este controller não tem
 *
 * Não há rota para apagar avaliação. A SPEC escreve o motivo — *"suprimir review
 * é o que destrói a credibilidade de plataforma de avaliação, e é risco
 * jurídico"* —, e a ausência aqui é acompanhada de duas garantias que não
 * dependem de ninguém lembrar: não existe permissão de apagar no catálogo, e o
 * `REVOKE DELETE` da migração 0046 fecha o caminho no banco. O gatilho de
 * imutabilidade fecha o terceiro: um `UPDATE SET rating = 5` é apagar a
 * avaliação ruim com outro nome.
 *
 * ## Duas permissões, e são coisas diferentes
 *
 * `reviews.view` lê; `reviews.recover` age dentro da janela. Mesma separação de
 * `feedback.view` e `feedback.manage`, e de ler e escrever anotação.
 *
 * `reviews.contest` é a terceira, e continua não sendo "apagar": ela suspende
 * da vitrine com motivo de lista fechada, deixa a nota imutável e deixa a média
 * do painel intacta. É a única operação do produto que decide o que o público
 * **não** vê, e por isso não vem no papel de recepção.
 *
 * A rota que traz as avaliações de um cliente declara `customers.view` junto:
 * ela devolve o histórico de uma pessoa, e rota que agrega declara **todas** as
 * permissões do que devolve.
 */

const STATUS: Record<string, number> = {
  atendimento_nao_concluido: 409,
  ja_avaliado: 409,
  prazo_vencido: 409,
  nota_invalida: 400,
  comentario_longo: 400,
  avaliacao_nao_encontrada: 404,
  ja_resolvida: 409,
  ja_contestada: 409,
  nao_contestada: 409,
  motivo_invalido: 400,
  motivo_curto: 400,
};

export function avaliacaoParaHttp(erro: unknown): never {
  if (erro instanceof AvaliacaoError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/avaliacoes')
@UseGuards(StaffGuard, PermissaoGuard)
export class AvaliacaoController {
  /**
   * O painel: a média, a fila de recuperação e as últimas.
   *
   * A média conta **tudo**, publicado ou não — a SPEC é explícita, e uma média
   * que só somasse o que está no ar seria o painel mentindo para quem decide.
   *
   * `customers.view` junto, e é achado da `/security-review`: a fila de
   * recuperação traz o **nome inteiro** do cliente, porque quem vai ligar
   * precisa dele. Com `reviews.view` sozinha, uma conta a quem o dono deu "ver
   * as avaliações" e negou "ver os clientes" leria a base de nomes, datas de
   * atendimento e comentários por uma rota chamada avaliações — o caminho mais
   * curto para a permissão que ele recusou. A página pública, que não tem
   * permissão nenhuma, mostra só o primeiro nome.
   */
  @Exige('reviews.view', 'customers.view')
  @Get()
  async painel(@Staff() staff: AuthenticatedStaff) {
    return painelDeAvaliacoes(staff.tenantId);
  }

  @Exige('reviews.view', 'customers.view')
  @Get('clientes/:id')
  async doCliente(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { avaliacoes: await avaliacoesDoCliente(staff.tenantId, id) };
  }

  /**
   * Registra o que a casa fez a respeito de uma nota baixa.
   *
   * **Isto não impede a publicação.** Passadas as 48 horas a avaliação vai ao ar
   * de qualquer forma, tratada ou não — é o limite ético da SPEC §4.10, e é o
   * que separa uma janela de recuperação de um filtro de censura.
   */
  @Exige('reviews.recover')
  @Post(':id/tratar')
  async tratar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(recuperacaoSchema))
    body: { desfecho: 'contato' | 'retrabalho' | 'credito' | 'sem_retorno'; nota: string },
  ) {
    try {
      return await registrarRecuperacao({
        tenantId: staff.tenantId,
        avaliacaoId: id,
        desfecho: body.desfecho,
        nota: body.nota,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return avaliacaoParaHttp(erro);
    }
  }

  /**
   * Contesta uma avaliação, suspendendo-a da vitrine.
   *
   * Não apaga: a nota e o comentário continuam imutáveis pelo gatilho do bloco
   * 43, e a média do painel continua contando esta avaliação. O que muda é só o
   * predicado do que é público — e é a distância entre as duas médias que diz ao
   * dono o tamanho do que ele suspendeu.
   */
  @Exige('reviews.contest')
  @Post(':id/contestar')
  async contestar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(contestacaoSchema))
    body: { motivo: string; nota: string },
  ) {
    try {
      const feito = await contestarAvaliacao({
        tenantId: staff.tenantId,
        avaliacaoId: id,
        motivo: body.motivo,
        nota: body.nota,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      // A cópia do marketplace guarda a nota, e ela é derivada de dado com RLS:
      // sem esta chamada o card continuaria contando a avaliação suspensa até a
      // varredura da madrugada — a suspensão funcionando na tela que o dono abre
      // e falhando na que o cliente abre.
      await atualizarVitrineDaCasa(staff.tenantId);
      return feito;
    } catch (erro) {
      return avaliacaoParaHttp(erro);
    }
  }

  /**
   * Retira a contestação e devolve a avaliação ao ar.
   *
   * A saída do estado, e é o que separa contestar de apagar: sem ela, a casa que
   * contestasse por engano deixaria a nota fora da vitrine para sempre. Mesma
   * permissão da entrada, porque a direção é a segura — quem retira devolve a
   * avaliação ao público.
   */
  @Exige('reviews.contest')
  @Post(':id/retirar-contestacao')
  async retirar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      const feito = await retirarContestacao({
        tenantId: staff.tenantId,
        avaliacaoId: id,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      await atualizarVitrineDaCasa(staff.tenantId);
      return feito;
    } catch (erro) {
      return avaliacaoParaHttp(erro);
    }
  }
}
