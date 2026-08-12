import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  WhatsAppError,
  cadastroDoWhatsApp,
  salvarCadastroDoWhatsApp,
  submeterTemplate,
  templatesDaUnidade,
} from '@barbearia/crm';
import { FakeWhatsAppProvider, type TipoDeNotificacao } from '@barbearia/core';
import { primaryLocation } from '@barbearia/scheduling';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { cadastroDoWhatsAppSchema, templateSchema } from './whatsapp.schemas.js';

/**
 * O canal de WhatsApp da casa (bloco 55, SPEC §4.12).
 *
 * ## Uma permissão, e ela não é de dinheiro
 *
 * `whatsapp.manage` cadastra o número e os textos. É configuração de como a casa
 * fala com o cliente — a mesma natureza de horário de funcionamento — e não move
 * centavo, então não deriva segundo fator.
 *
 * O que ela **não** dá é leitura de mensagem: quem chegou e quem leu é dado de
 * cliente, e sai por outra permissão quando essa tela existir.
 *
 * ## O provedor é um só, criado na montagem
 *
 * Como o emissor fiscal e o de mensagem do worker. Instanciar um dentro de cada
 * rota faria daquela rota a única que não troca junto quando a Cloud API de
 * verdade entrar — é a lição do bloco 39.
 */

const STATUS: Record<string, number> = {
  nao_configurado: 409,
  token_invalido: 400,
  template_nao_encontrado: 404,
  template_nao_aprovado: 409,
  numero_invalido: 400,
  nome_invalido: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof WhatsAppError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

/**
 * Enquanto não há conta contratada com a Meta, é o de mentira.
 *
 * Ele responde `pendente` ao submeter template — o estado real de um
 * recém-enviado, que a Meta leva de minutos a dias para mover. É o que faz a
 * cadeia de conciliação ser percorrida pelo caminho real em vez de pulada por
 * um fake otimista.
 */
const PROVEDOR = new FakeWhatsAppProvider();

@Controller('v1/admin/whatsapp')
@UseGuards(StaffGuard, PermissaoGuard)
export class WhatsAppController {
  private async unidade(tenantId: string) {
    const local = await primaryLocation(tenantId);
    if (!local) throw new DomainError('unknown_location', 404, 'Unidade não encontrada.');
    return local;
  }

  @Exige('whatsapp.manage')
  @Get('cadastro')
  async cadastro(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff.tenantId);
    return { cadastro: await cadastroDoWhatsApp(staff.tenantId, local.id) };
  }

  @Exige('whatsapp.manage')
  @Put('cadastro')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(cadastroDoWhatsAppSchema)) body: {
      phoneNumberId: string;
      wabaId: string;
      numeroVisivel?: string | null;
      token?: string;
    },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await salvarCadastroDoWhatsApp({
        tenantId: staff.tenantId,
        locationId: local.id,
        phoneNumberId: body.phoneNumberId,
        wabaId: body.wabaId,
        numeroVisivel: body.numeroVisivel ?? null,
        // Ausente é "não mexa": repassar `undefined` é o que preserva o token.
        ...(body.token ? { token: body.token } : {}),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('whatsapp.manage')
  @Get('templates')
  async templates(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff.tenantId);
    return { templates: await templatesDaUnidade(staff.tenantId, local.id) };
  }

  @Exige('whatsapp.manage')
  @Post('templates')
  async submeter(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(templateSchema)) body: {
      tipo: TipoDeNotificacao;
      nome: string;
      corpo: string;
    },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await submeterTemplate({
        tenantId: staff.tenantId,
        locationId: local.id,
        tipo: body.tipo,
        nome: body.nome,
        corpo: body.corpo,
        provider: PROVEDOR,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
