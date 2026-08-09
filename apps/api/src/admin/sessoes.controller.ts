import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { encerrarSuporteDaBarbearia, PlataformaError, suporteNaConta } from '@barbearia/platform';
import { audit, sessoesDoGestor, revogarSessaoDoGestor, type AuthenticatedStaff } from '@barbearia/identity';
import { withTenant } from '@barbearia/db';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';

/**
 * Quem está dentro da minha conta agora (bloco 33).
 *
 * ## Duas lacunas declaradas, e elas eram a mesma tela
 *
 * "Encerrar sessão nos outros aparelhos" estava sem bloco desde o 5, e "o dono
 * encerrar sozinho o suporte" apontava para este desde o 26. As duas pediam a
 * mesma coisa — uma lista do que está aberto, com um botão ao lado —, e
 * entregá-las separadas teria produzido duas telas que respondem à mesma
 * pergunta com metade da resposta.
 *
 * ## Por que a sessão de suporte aparece junto, e em destaque
 *
 * Porque a pergunta que o dono faz não é "quantos aparelhos meus estão
 * logados?", é **"quem está na minha conta?"**. Uma tela que listasse só os
 * aparelhos dele e escondesse o funcionário da plataforma responderia a
 * pergunta errada com precisão.
 *
 * ## A permissão
 *
 * `settings.manage`, e não `team.manage`: a lista é da **própria conta** de quem
 * está olhando mais o suporte na barbearia. Quem administra a casa responde por
 * quem entra nela.
 */
@Controller('v1/admin/sessoes')
@UseGuards(StaffGuard, PermissaoGuard)
export class SessoesController {
  @Exige('settings.manage')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    const [minhas, suporte] = await Promise.all([
      sessoesDoGestor(staff.tenantId, staff.staffUserId),
      suporteNaConta(staff.tenantId),
    ]);

    return {
      sessoes: minhas.map((s) => ({
        id: s.id,
        atual: s.id === staff.sessionId,
        // O IP inteiro não volta para a tela: ele é prova para quem audita o
        // banco, e circular menos é melhor. O aparelho é o que a pessoa
        // reconhece.
        aparelho: s.aparelho,
        criadaEm: s.criadaEm.toISOString(),
      })),
      suporte: suporte.map((s) => ({
        quem: s.adminNome,
        motivo: s.motivo,
        abertoEm: s.abertoEm.toISOString(),
        expiraEm: s.expiraEm.toISOString(),
      })),
    };
  }

  /**
   * Encerra uma sessão minha noutro aparelho.
   *
   * A do próprio pedido é recusada de propósito: "Sair" já faz isso, e encerrar
   * a sessão de quem está clicando dentro de uma tela de segurança produz um
   * 401 que parece defeito.
   */
  @Exige('settings.manage')
  @Delete(':id')
  async encerrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    if (id === staff.sessionId) {
      throw new DomainError('sessao_atual', 400, 'Para sair deste aparelho, use Sair.');
    }

    const encerradas = await revogarSessaoDoGestor(staff.tenantId, staff.staffUserId, id);
    if (encerradas === 0) {
      throw new DomainError('sessao_nao_encontrada', 404, 'Esta sessão já não está aberta.');
    }
    return { encerradas };
  }

  /**
   * Expulsa o suporte da plataforma.
   *
   * A capacidade já existia inteira desde o bloco 26 — derruba todas as sessões
   * abertas na conta e marca o registro de plataforma. O que faltava era esta
   * porta, do lado de quem é dono do dado.
   *
   * Auditado na trilha **da barbearia** e não só na da plataforma: é lá que o
   * dono procura, e a trilha da plataforma ele não lê.
   */
  @Exige('settings.manage')
  @Delete('suporte/tudo')
  async expulsarSuporte(@Staff() staff: AuthenticatedStaff) {
    try {
      const encerradas = await encerrarSuporteDaBarbearia({
        adminId: null,
        adminNome: staff.name,
        tenantId: staff.tenantId,
      });

      await withTenant(staff.tenantId, (tx) =>
        audit(tx, {
          actorId: staff.staffUserId,
          actorName: staff.name,
          action: 'support.ended',
          entity: 'support_sessions',
          after: { sessoes: encerradas, encerradoPelo: 'dono' },
        }),
      );

      return { encerradas };
    } catch (erro) {
      if (erro instanceof PlataformaError) {
        // 404 e não 400: não há suporte aberto para encerrar. A tela some com o
        // bloco quando isso acontece, então chegar aqui é corrida entre a
        // leitura e o clique.
        throw new DomainError('sem_suporte', 404, 'Não há suporte aberto nesta conta.');
      }
      throw erro;
    }
  }
}
