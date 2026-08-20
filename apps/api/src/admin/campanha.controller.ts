import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  CampanhaError,
  campanhasDaCasa,
  criarCampanha,
  puladosDaCampanha,
  marcarParaEnvio,
  type FiltroDeCampanha,
} from '@barbearia/crm';
import { gradeDeOcupacao } from '@barbearia/scheduling';
import type { TipoDeNotificacao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { campanhaIdSchema, campanhaSchema } from './campanha.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Campanhas e o heatmap (bloco 57, SPEC §4.13 e §5.9).
 *
 * As duas coisas na mesma rota porque são o mesmo fluxo: *"célula fria é
 * clicável e vira campanha direcionada — o heatmap não é relatório, é ponto de
 * partida de ação"*. Separá-las faria a tela pedir dois carregamentos para
 * desenhar uma decisão só.
 *
 * `marketing.send` guarda as duas. A grade é ocupação — não é dinheiro, não
 * revela cadastro, e é o insumo de quem decide a campanha.
 *
 * ## A **listagem** é outra coisa, e declara `finance.view` junto
 *
 * `CampanhaNaTela` traz `receitaCents` — a receita atribuída, congelada na
 * janela. `marketing.send` não tem prefixo `finance.`, então não está em
 * `PERMISSOES_DE_DINHEIRO`, e o segundo fator que a `PermissaoGuard` deriva do
 * prefixo não era cobrado: um papel "Marketing" lia a receita de cada campanha
 * numa barbearia em que `GET /dashboard/revenue` respondia
 * `mfa_setup_required`.
 *
 * É o defeito do bloco 62 — `reports.finance` na rota de crescimento — repetido
 * num pacote que a varredura de receita não lia. Esta corrige a rota; a
 * varredura ampliada é o que impede a terceira.
 */

const STATUS: Record<string, number> = { nao_encontrada: 404, invalida: 400, ja_enviada: 409 };

function toHttp(erro: unknown): never {
  if (erro instanceof CampanhaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/campanhas')
@UseGuards(StaffGuard, PermissaoGuard)
export class CampanhaController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('marketing.send', 'finance.view')
  @Get()
  async listar(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    const [campanhas, grade] = await Promise.all([
      campanhasDaCasa(staff.tenantId),
      gradeDeOcupacao({ tenantId: staff.tenantId, locationId: local.id, agora: new Date() }),
    ]);
    return { campanhas, grade };
  }

  @Exige('marketing.send')
  @Post()
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(campanhaSchema)) body: {
      nome: string;
      filtro: FiltroDeCampanha;
      valorDoFiltro: number | null;
      diaDaSemana: number | null;
      tipo?: TipoDeNotificacao;
      templateId?: string;
      janelaDias: number;
    },
  ) {
    try {
      return await criarCampanha({
        tenantId: staff.tenantId,
        nome: body.nome,
        filtro: body.filtro,
        valorDoFiltro: body.valorDoFiltro,
        diaDaSemana: body.diaDaSemana,
        ...(body.tipo === undefined ? {} : { tipo: body.tipo }),
        ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
        janelaDias: body.janelaDias,
        agora: new Date(),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * O botão "Enviar".
   *
   * A rota **não manda mensagem**: ela põe a campanha em `enviando` e enfileira
   * o despacho, dentro da mesma transação. Um público de trezentas pessoas são
   * trezentas idas ao provedor, e numa requisição isso é a tela girando no
   * balcão com um `timeout` no meio deixando metade enviada sem ninguém saber
   * qual metade.
   *
   * Sem `Idempotency-Key`: quem barra o segundo toque é o **estado**, e ele é
   * mais forte que a chave — segura o toque de outro aparelho, de outra sessão
   * e com chave nova. É a mesma decisão do registro de sinal do bloco 38.
   *
   * `marketing.send` e nada mais: o despacho não move centavo e não devolve
   * cadastro nenhum — a resposta é o estado da campanha.
   */
  @Exige('marketing.send')
  @Post(':id/enviar')
  async enviar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(campanhaIdSchema)) id: string,
  ) {
    const marcada = await marcarParaEnvio({
      tenantId: staff.tenantId,
      campanhaId: id,
      staffId: staff.staffUserId,
      staffName: staff.name,
    });

    /**
     * A recusa tem **uma** mensagem para os dois casos.
     *
     * "Já foi enviada" e "não existe" são a mesma frase de propósito: a
     * segunda confirmaria o id para quem o adivinhou. É o precedente do OTP e
     * o da unidade que não é sua.
     */
    if (!marcada) {
      throw new DomainError(
        'ja_enviada',
        409,
        'Esta campanha não está mais em rascunho. Só um rascunho pode ser enviado.',
      );
    }
    return { estado: 'enviando' as const };
  }

  /**
   * Quem não recebeu, com nome e motivo (bloco 97).
   *
   * `customers.view` junto de `marketing.send`, pela regra da rota que agrega:
   * a resposta traz **nome de cliente**, e é a nona vez que este produto
   * precisa lembrar disso. Sem ela, quem pode disparar campanha colhia a base
   * nominal pela porta dos fundos, uma campanha por vez.
   */
  @Exige('marketing.send', 'customers.view')
  @Get(':id/pulados')
  async pulados(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(campanhaIdSchema)) id: string,
  ) {
    return { pulados: await puladosDaCampanha(staff.tenantId, id) };
  }
}
