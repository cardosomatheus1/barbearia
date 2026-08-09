import {
  createParamDecorator,
  Injectable,
  Inject,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  PlataformaError,
  resolverSessaoDaPlataforma,
  type AdminDaPlataforma,
} from '@barbearia/platform';
import { DomainError } from '../common/errors.js';

export interface RequisicaoDaPlataforma extends Request {
  admin?: AdminDaPlataforma;
}

const semSessao = (): DomainError => new DomainError('unauthorized', 401, 'Sessão inválida');

export const AGE_NA_CONTA = 'age_na_conta';

/**
 * Declara que a rota **age** sobre a conta de uma barbearia (bloco 33).
 *
 * Bloquear conta, ligar recurso, entrar por suporte assistido, cancelar
 * cobrança. Tudo que não tem este decorador é leitura, e leitura toda conta de
 * plataforma faz.
 *
 * A polaridade é o inverso da `@Exige` do painel da barbearia, e a diferença é
 * deliberada. Lá a ausência **recusa**, porque cada rota guarda um dado
 * diferente e esquecer a declaração seria abrir o dado. Aqui a ausência libera
 * a leitura, porque toda conta de plataforma já lê tudo por definição — o que
 * se separa não é o que se vê, é o que se **faz**. Esquecer o decorador numa
 * rota nova de ação é o risco, e é por isso que há teste que percorre o
 * controller e cobra o decorador em todo `@Post`, `@Put` e `@Delete`.
 */
export const AgeNaConta = () => SetMetadata(AGE_NA_CONTA, true);

/**
 * A porta do Super Admin.
 *
 * Separada da `StaffGuard` por completo, e não é preciosismo: as duas resolvem
 * token contra tabelas diferentes, e um bug que fizesse uma aceitar o token da
 * outra daria a um gestor de barbearia o painel de todas elas. Nenhum código é
 * compartilhado entre as duas justamente para que não exista esse caminho.
 */
@Injectable()
export class PlataformaGuard implements CanActivate {
  // `@Inject` explícito: `emitDecoratorMetadata` está desligado neste projeto,
  // e sem ele o Nest instancia a guarda com `reflector` indefinido — mesma
  // armadilha que a `PermissaoGuard` documenta desde o bloco 16.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requisicao = context.switchToHttp().getRequest<RequisicaoDaPlataforma>();

    const token = /^Bearer (.+)$/.exec(requisicao.headers.authorization ?? '')?.[1];
    if (!token) throw semSessao();

    try {
      requisicao.admin = await resolverSessaoDaPlataforma(token);
    } catch (erro) {
      // Só sessão inválida vira 401. Queda de banco é 500 e vai para o log —
      // senão uma indisponibilidade se disfarça de "expirou".
      if (erro instanceof PlataformaError) throw semSessao();
      throw erro;
    }

    const age = this.reflector.getAllAndOverride<boolean | undefined>(AGE_NA_CONTA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (age && requisicao.admin.papel !== 'operator') {
      // 403 e não 404: quem está do outro lado é da casa e a rota existe.
      // Esconder faria a pessoa abrir chamado achando que o painel quebrou.
      throw new DomainError(
        'forbidden',
        403,
        'Sua conta consulta a plataforma, mas não age sobre a conta de uma barbearia.',
      );
    }

    return true;
  }
}

export const Admin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminDaPlataforma => {
    const requisicao = context.switchToHttp().getRequest<RequisicaoDaPlataforma>();
    if (!requisicao.admin) throw semSessao();
    return requisicao.admin;
  },
);
