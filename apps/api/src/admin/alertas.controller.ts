import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { lerPreferenciasDeAlerta, salvarPreferenciasDeAlerta } from '@barbearia/platform';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { preferenciasDeAlertaSchema } from './avisos.schemas.js';

/**
 * O que interrompe o dono (bloco 33).
 *
 * ## Controller próprio, e a `/security-review` é quem cobrou
 *
 * A primeira versão pendurou estas rotas no `AvisosController`, e as duas coisas
 * que pareciam economia eram defeitos:
 *
 * 1. **O caminho.** Aquele controller mora em `v1/admin/notifications`, e a tela
 *    chamava `/v1/admin/avisos/preferencias` — 404 em toda leitura e em toda
 *    gravação. A tela mostrava os padrões e o botão Salvar não salvava nada,
 *    silenciosamente, porque o código trata falha de leitura como "sem
 *    preferência".
 * 2. **O `@Recurso('avisos')`.** Aquele controller inteiro é gateado pelo
 *    recurso de aviso ao cliente — e desligá-lo, que é uma decisão sobre custo
 *    de mensagem para o cliente final, desligaria junto o alerta operacional
 *    para o dono. São dois assuntos, e um deles é sobre a barbearia estar de pé.
 *
 * Aqui não há `@Recurso`: alerta operacional não é recurso opcional de plano, é
 * a barbearia sendo avisada de que algo quebrou.
 */
@Controller('v1/admin/alertas')
@UseGuards(StaffGuard, PermissaoGuard)
export class AlertasController {
  @Exige('settings.manage')
  @Get('preferencias')
  async ler(@Staff() staff: AuthenticatedStaff) {
    return lerPreferenciasDeAlerta(staff.tenantId);
  }

  @Exige('settings.manage')
  @Put('preferencias')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(preferenciasDeAlertaSchema))
    corpo: { enviarCritico: boolean; enviarAviso: boolean; enviarRetencao: boolean },
  ) {
    await salvarPreferenciasDeAlerta(staff.tenantId, corpo);
    // Devolve o estado gravado, e não `{ saved: true }`: a tela redesenha com a
    // resposta, e um "salvo" sem dado a faria mostrar o que o navegador tinha.
    return lerPreferenciasDeAlerta(staff.tenantId);
  }
}
