import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { autenticarChave, type ChaveAutenticada } from '@barbearia/identity';
import { TenantService } from '../tenant/tenant.service.js';
import type { Permissao } from '@barbearia/core';
import type { Request } from 'express';
import { DomainError } from '../common/errors.js';

/**
 * A porta da API pública (bloco 78).
 *
 * ## Uma guarda, e ela faz três coisas na ordem certa
 *
 * Confere a chave, gasta uma da cota do minuto e aplica o escopo declarado pela
 * rota. A cota é conferida **depois** do segredo, de propósito: contar chamada
 * de chave inválida deixaria qualquer um esgotar a cota de uma chave alheia
 * mandando o prefixo dela com segredo errado.
 *
 * ## O escopo é uma permissão
 *
 * `@Escopo('appointments.view')` cita o mesmo catálogo que a `PermissaoGuard`
 * aplica no painel. Não há vocabulário paralelo a manter, e a permissão nova do
 * bloco 90 nasce disponível aqui sem ninguém lembrar dela.
 *
 * E, como no painel, **rota sem declaração é recusada**, nunca liberada: uma
 * rota nova que alguém esquecer de anotar responde 403, não 200.
 */

export const ESCOPO_EXIGIDO = 'escopo_exigido';

export const Escopo = (...escopos: readonly Permissao[]) =>
  SetMetadata(ESCOPO_EXIGIDO, escopos);

export interface ChaveRequest extends Request {
  chave?: ChaveAutenticada;
}

@Injectable()
export class ChaveGuard implements CanActivate {
  /**
   * `@Inject` explícito, como na `PermissaoGuard`.
   *
   * O tipo sozinho não basta: o `Reflector` só aparece como anotação, e o
   * `design:paramtypes` chega vazio — a guarda subia com `this.reflector`
   * indefinido e toda rota da API pública respondia 500.
   */
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TenantService) private readonly tenants: TenantService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const pedido = contexto.switchToHttp().getRequest<ChaveRequest>();

    const cabecalho = pedido.headers.authorization ?? '';
    const bruta = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
    if (!bruta) {
      throw new DomainError('sem_chave', 401, 'Apresente a chave em Authorization: Bearer');
    }

    const resultado = await autenticarChave(bruta, new Date());
    if (!resultado.ok) {
      if (resultado.recusa === 'excedeu') {
        throw new DomainError('cota_excedida', 429, 'Esta chave já usou a cota do minuto');
      }
      if (resultado.recusa === 'revogada') {
        /**
         * "Revogada" e não "inválida": quem apresenta uma chave que já foi dele
         * merece saber por que ela parou. A mensagem não confirma nada que o
         * portador já não saiba — e a alternativa manda o integrador procurar
         * erro de digitação por horas.
         */
        throw new DomainError('chave_revogada', 401, 'Esta chave foi revogada');
      }
      throw new DomainError('chave_invalida', 401, 'Chave inválida');
    }

    /**
     * A conta bloqueada não opera por esta porta tampouco.
     *
     * O `StaffGuard` confere o bloqueio a **cada** requisição, e a página
     * pública some porque `TenantService.resolve` devolve nulo para conta
     * bloqueada. Esta rota descobre o tenant pela chave e não passava por
     * nenhum dos dois: uma barbearia bloqueada continuaria vendendo agenda pela
     * integração, e revogar a chave exige o painel — que o bloqueio trancou.
     *
     * Achado da `/security-review` do bloco 78, e é exatamente o que o
     * comentário do `TenantService` previa: *"a décima rota pública nasce
     * furada, e ninguém veria, porque nada dá erro"*.
     */
    const bloqueio = await this.tenants.bloqueio(resultado.chave.tenantId);
    if (bloqueio.bloqueada) {
      throw new DomainError('conta_bloqueada', 403, bloqueio.motivo ?? 'Conta bloqueada');
    }

    const exigidos =
      this.reflector.getAllAndOverride<readonly Permissao[]>(ESCOPO_EXIGIDO, [
        contexto.getHandler(),
        contexto.getClass(),
      ]) ?? null;

    /**
     * Rota sem escopo declarado é **recusada**, não liberada.
     *
     * A mesma polaridade do `@Exige`: a rota nova que alguém esquecer de anotar
     * responde 403 em vez de entregar tudo. É o contrário de `@AgeNaConta`, e a
     * diferença está escrita lá — aqui não há leitura que já seja permitida a
     * todo mundo.
     */
    if (!exigidos || exigidos.length === 0) {
      throw new DomainError('rota_sem_escopo', 403, 'Rota sem escopo declarado');
    }

    const faltando = exigidos.find((e) => !resultado.chave.escopos.includes(e));
    if (faltando) {
      throw new DomainError('escopo_insuficiente', 403, `A chave não tem o escopo ${faltando}`);
    }

    pedido.chave = resultado.chave;
    return true;
  }
}
