import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  confirmarCadastroMfa,
  definirExigenciaDeSegundoFator,
  desligarMfa,
  estadoDoMfa,
  exigeSegundoFator,
  iniciarCadastroMfa,
  segundoFatorValido,
  MfaError,
  verificarSegundoFator,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { tenantName } from '@barbearia/scheduling';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { codigoMfaSchema } from './caixa.schemas.js';
import { politicaDeMfaSchema } from './sinal.schemas.js';

const STATUS: Record<string, number> = {
  invalid_code: 400,
  already_enabled: 409,
  not_enabled: 409,
  // Falta de chave de ambiente é falha do servidor, não erro de quem digitou.
  mfa_key_missing: 500,
};

function toHttp(error: unknown): never {
  if (error instanceof MfaError) {
    const status = STATUS[error.code] ?? 400;
    throw new DomainError(
      error.code,
      status,
      status === 500 ? 'Não foi possível concluir agora.' : error.message,
    );
  }
  throw error;
}

/**
 * O segundo fator, do lado de quem o cadastra.
 *
 * **Nenhuma rota daqui exige `finance.*`**, e não é descuido: exigir seria o
 * laço fechado — quem precisa do segundo fator para chegar ao caixa não
 * conseguiria cadastrar o segundo fator. Elas pedem `[]`, a mesma fuga que a
 * troca de senha de primeiro acesso usa.
 *
 * O que as protege é a sessão: quem chega aqui já provou a senha, e cada
 * operação sensível pede o código atual.
 */
@Controller('v1/admin/mfa')
@UseGuards(StaffGuard, PermissaoGuard)
export class MfaController {
  @Exige()
  @Get()
  async estado(@Staff() staff: AuthenticatedStaff) {
    return {
      ...(await estadoDoMfa(staff.tenantId, staff.staffUserId)),
      // A tela precisa saber se pode oferecer "desligar": para quem mexe em
      // dinheiro, a resposta é não, e mostrar o botão só para recusar depois é
      // prometer o que não se cumpre.
      obrigatorio: exigeSegundoFator(
        staff.permissions,
        staff.exigeSegundoFatorNoDinheiro,
      ),
      /**
       * A decisão da barbearia, e quem pode mudá-la.
       *
       * As duas juntas porque a tela precisa das duas para não mentir: mostrar
       * o interruptor a quem não tem `team.manage` seria oferecer o que a API
       * recusa, e o estado sem a permissão faria a recepção achar que alguém
       * desligou a proteção dela.
       */
      exigidoNaBarbearia: staff.exigeSegundoFatorNoDinheiro,
      podeMudarAExigencia: staff.permissions.includes('team.manage'),
      // A mesma função que a guarda aplica, não uma segunda leitura do mesmo
      // campo: a tela precisa oferecer o campo do código de novo assim que a
      // janela vence, senão o caixa recusa e manda para uma tela que não tem
      // o que fazer.
      verificadoNestaSessao: segundoFatorValido(staff.mfaVerifiedAt, new Date()),
    };
  }

  /**
   * Começa o cadastro.
   *
   * Devolve o segredo em base32 além do `otpauth://` porque nem todo
   * autenticador lê QR Code — e quem está no balcão com o celular sem câmera
   * boa digita à mão.
   */
  @Exige()
  @Post('setup')
  async comecar(@Staff() staff: AuthenticatedStaff) {
    try {
      return await iniciarCadastroMfa({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        barbearia: (await tenantName(staff.tenantId)) ?? 'Barbearia',
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige()
  @Post('confirm')
  async confirmar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(codigoMfaSchema)) body: { codigo: string },
  ) {
    try {
      return await confirmarCadastroMfa({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        staffName: staff.name,
        codigo: body.codigo,
        now: new Date(),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /** Prova o segundo fator para esta sessão. É o que destranca o caixa. */
  @Exige()
  @Post('verify')
  async verificar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(codigoMfaSchema)) body: { codigo: string },
  ) {
    try {
      return await verificarSegundoFator({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        staffName: staff.name,
        sessionId: staff.sessionId,
        codigo: body.codigo,
        now: new Date(),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * A barbearia decide se o financeiro exige segundo fator (bloco 37).
   *
   * `team.manage` e não `settings.manage`: desligar afrouxa o acesso ao caixa
   * de **toda a equipe** de uma vez, e isso é da mesma natureza que conceder
   * permissão — não de quem administra o dia a dia. Por padrão só o dono a tem.
   *
   * Não declara permissão de dinheiro de propósito. Declarar seria o laço
   * fechado ao contrário: quem desligou o segundo fator e ficou sem código não
   * conseguiria religá-lo depois.
   */
  @Exige('team.manage')
  @Put('policy')
  async politica(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(politicaDeMfaSchema)) body: { exigir: boolean },
    @Req() req: Request,
  ) {
    const ip = req.ip;
    const agent = req.get('user-agent');
    return definirExigenciaDeSegundoFator({
      tenantId: staff.tenantId,
      staffUserId: staff.staffUserId,
      staffName: staff.name,
      exigir: body.exigir,
      ...(ip ? { ip } : {}),
      ...(agent ? { userAgent: agent } : {}),
    });
  }

  @Exige()
  @Post('disable')
  async desligar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(codigoMfaSchema)) body: { codigo: string },
  ) {
    try {
      await desligarMfa({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        staffName: staff.name,
        sessionId: staff.sessionId,
        permissoes: staff.permissions,
        exigidoNaBarbearia: staff.exigeSegundoFatorNoDinheiro,
        codigo: body.codigo,
        now: new Date(),
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
