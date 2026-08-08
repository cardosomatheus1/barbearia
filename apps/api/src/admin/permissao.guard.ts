import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { podeTudo, PERMISSOES_DE_DINHEIRO, type Permissao } from '@barbearia/core';
import { segundoFatorValido } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import type { StaffRequest } from './staff.guard.js';

/**
 * Aplica a permissão que a rota declara.
 *
 * `staff_users.role` existia desde o bloco 10 e **nunca decidiu nada**: toda
 * conta de gestor tinha poder de dono. Esta guarda é o ponto em que o papel
 * passa a valer.
 *
 * Roda **depois** do `StaffGuard`, que preenche `request.staff` com as
 * permissões já resolvidas do papel. Sem sessão não há o que decidir, e a
 * ausência aqui é 401, não 403 — quem não se identificou não teve permissão
 * negada, só não se identificou.
 */

export const PERMISSAO_EXIGIDA = 'permissao_exigida';

/**
 * Declara o que a rota exige.
 *
 * Aceita mais de uma, e a exigência é conjuntiva: pedir duas significa as duas.
 * Uma rota que precisasse de "isto **ou** aquilo" seria sinal de que são duas
 * rotas — o `ou` esconde que os dois caminhos fazem coisas diferentes.
 */
export const Exige = (...permissoes: readonly Permissao[]) =>
  SetMetadata(PERMISSAO_EXIGIDA, permissoes);

@Injectable()
export class PermissaoGuard implements CanActivate {
  // `@Inject` explícito: `emitDecoratorMetadata` está desligado neste projeto,
  // então sem ele o Nest instancia a guarda com `reflector` indefinido — e toda
  // rota do painel responde 500. Quem pegou foi o e2e; o teste de unidade
  // constrói a guarda à mão e nunca veria isso.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const exigidas = this.reflector.getAllAndOverride<readonly Permissao[] | undefined>(
      PERMISSAO_EXIGIDA,
      [context.getHandler(), context.getClass()],
    );

    // Rota sem declaração não é rota liberada: é rota que esqueceu de declarar.
    // Recusar por padrão transforma o esquecimento em erro visível no primeiro
    // teste, em vez de em brecha silenciosa que ninguém procura.
    if (!exigidas) {
      throw new DomainError(
        'forbidden',
        403,
        'Esta ação não está disponível para o seu acesso.',
      );
    }

    const request = context.switchToHttp().getRequest<StaffRequest>();
    const staff = request.staff;
    if (!staff) throw new DomainError('unauthorized', 401, 'Sessão inválida');

    /**
     * Conta que ainda não trocou a senha de primeiro acesso não opera nada.
     *
     * A senha foi escolhida pelo sistema e entregue por outra pessoa — enquanto
     * ela valer, quem sabe a senha não é necessariamente quem deveria estar ali.
     * A única rota que escapa declara `[]`.
     */
    if (staff.mustChangePassword && exigidas.length > 0) {
      throw new DomainError(
        'must_change_password',
        403,
        'Troque a senha de primeiro acesso antes de continuar.',
      );
    }

    if (!podeTudo(staff.permissions, exigidas)) {
      // 403 e não 404: quem está do outro lado está autenticado e a rota
      // existe. Esconder isso não protege nada e transforma "sem permissão" em
      // "o sistema quebrou" para quem opera.
      throw new DomainError(
        'forbidden',
        403,
        'Esta ação não está disponível para o seu acesso.',
      );
    }

    exigirSegundoFator(staff, exigidas);
    return true;
  }
}

/**
 * O segundo fator do dinheiro, cobrado a partir da própria declaração da rota.
 *
 * A regra do `CLAUDE.md` é "MFA obrigatório para papéis com permissão
 * `finance.*`", e a tentação era um decorador `@ExigeSegundoFator()` à parte.
 * Seria a mesma classe de defeito que a rota sem `@Exige`: uma rota de dinheiro
 * nova, sem o segundo decorador, e a regra deixa de valer exatamente onde mais
 * importa — sem nada ficar vermelho.
 *
 * Derivar da permissão declarada elimina o esquecimento: quem escreve
 * `@Exige('finance.view')` já cobrou o segundo fator, queira ou não.
 *
 * Mora dentro da `PermissaoGuard`, e não numa guarda separada, pela mesma
 * razão: esta aqui é obrigatória em toda rota do painel (a ausência de `@Exige`
 * é recusa), então não existe caminho que passe ao lado dela.
 */
function exigirSegundoFator(
  staff: NonNullable<StaffRequest['staff']>,
  exigidas: readonly Permissao[],
): void {
  const mexeEmDinheiro = exigidas.some((p) => PERMISSOES_DE_DINHEIRO.includes(p));
  if (!mexeEmDinheiro) return;

  // Códigos próprios, e não 403 genérico: a tela precisa saber a diferença
  // entre "cadastre o segundo fator" e "digite o código". Com uma resposta só,
  // o operador do balcão vê "sem permissão" numa conta que tem permissão.
  if (!staff.mfaEnabled) {
    throw new DomainError(
      'mfa_setup_required',
      403,
      'Ative o segundo fator antes de acessar o financeiro.',
    );
  }

  if (!segundoFatorValido(staff.mfaVerifiedAt, new Date())) {
    throw new DomainError(
      'mfa_required',
      403,
      'Confirme o código do segundo fator para continuar.',
    );
  }
}
