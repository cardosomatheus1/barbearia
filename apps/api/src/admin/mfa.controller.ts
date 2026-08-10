import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  confirmarCadastroMfa,
  definirPoliticaDeSegundoFator,
  desligarMfa,
  estadoDoMfa,
  exigeSegundoFator,
  iniciarCadastroMfa,
  segundoFatorValido,
  MfaError,
  verificarSegundoFator,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { pode } from '@barbearia/core';
import { tenantName } from '@barbearia/scheduling';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { codigoMfaSchema, politicaDeMfaSchema } from './caixa.schemas.js';

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
 * **Nenhuma rota de cadastro daqui exige `finance.*`**, e não é descuido:
 * exigir seria o laço fechado — quem precisa do segundo fator para chegar ao
 * caixa não conseguiria cadastrar o segundo fator. Elas pedem `[]`, a mesma
 * fuga que a troca de senha de primeiro acesso usa.
 *
 * O que as protege é a sessão: quem chega aqui já provou a senha, e cada
 * operação sensível pede o código atual.
 *
 * A exceção é `PUT policy`, e ela é a única que **precisa** ser cobrada: quem
 * consegue desligar a política primeiro abre a gaveta depois. Ela não fecha
 * laço nenhum porque a cobrança só existe quando a política está ligada — para
 * **ligar**, a guarda não pede nada, que é o estado de quem ainda não tem
 * autenticador. E para desligar sem ter um, o caminho está na mesma tela: o
 * cadastro, que continua aberto.
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
      // dinheiro numa barbearia que exige, a resposta é não, e mostrar o botão
      // só para recusar depois é prometer o que não se cumpre.
      obrigatorio: exigeSegundoFator(staff.permissions, staff.mfaRequired),
      /** O interruptor da barbearia, e quem pode mexer nele. */
      obrigatorioNaBarbearia: staff.mfaRequired,
      // Da mesma função que a guarda aplica, nunca recalculada na view: é assim
      // que a tela deixa de oferecer o botão que o servidor recusa.
      podeMudarPolitica: pode(staff.permissions, 'security.mfa_policy'),
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
        obrigatorioNaBarbearia: staff.mfaRequired,
        codigo: body.codigo,
        now: new Date(),
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * O interruptor da barbearia.
   *
   * `PUT` e não `POST`: o corpo diz o estado desejado, não uma transição, então
   * mandar duas vezes o mesmo valor termina no mesmo lugar. Não leva
   * `Idempotency-Key` porque não cria agendamento nem move dinheiro — a regra
   * do `CLAUDE.md` é sobre efeito que se duplica, e este não tem.
   */
  @Exige('security.mfa_policy')
  @Put('policy')
  async politica(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(politicaDeMfaSchema)) body: { obrigatorio: boolean },
  ) {
    try {
      return await definirPoliticaDeSegundoFator({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        staffName: staff.name,
        obrigatorio: body.obrigatorio,
      });
    } catch (error) {
      return toHttp(error);
    }
  }
}
