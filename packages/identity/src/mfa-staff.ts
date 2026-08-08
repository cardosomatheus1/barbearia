import { withTenant } from '@barbearia/db';
import { audit } from './audit.js';
import { PERMISSOES_DE_DINHEIRO, type Permissao } from '@barbearia/core';
import {
  MfaError,
  acharCodigoDeRecuperacao,
  cifrarSegredo,
  conferirCodigo,
  decifrarSegredo,
  gerarCodigosDeRecuperacao,
  hashDosCodigos,
  novoSegredo,
  uriDoAutenticador,
} from './mfa.js';

/**
 * O segundo fator ligado ao gestor e à sessão dele.
 *
 * `mfa.ts` é o algoritmo — puro, sem banco. Este arquivo é o que o guarda, o
 * confirma e o cobra.
 *
 * A decisão que sustenta o resto: **a exigência é por sessão e tem validade
 * curta**, não por login. Conferir só na entrada protegeria o momento de abrir
 * o painel e nada depois — e o aparelho do balcão fica logado o dia inteiro,
 * ao alcance de quem passa. Quem vai dar uma sangria digita o código de novo.
 */

/**
 * Por quanto tempo a conferência vale dentro da sessão.
 *
 * Trinta minutos é o meio-termo que o balcão suporta: curto o bastante para que
 * a máquina esquecida não seja uma porta aberta, longo o bastante para não pedir
 * código entre uma comanda e a seguinte. Fosse por operação, a recepção
 * digitaria o código dez vezes por hora e o desfecho real seria colar o
 * autenticador de alguém na parede.
 */
export const VALIDADE_DO_SEGUNDO_FATOR_MINUTOS = 30;

/**
 * A prova ainda vale?
 *
 * Uma função só, usada pela guarda **e** pela tela. A regra do projeto é que a
 * permissão exibida sai da mesma função que a API aplica — e aqui o custo de
 * duas cópias foi concreto: a tela perguntava `mfaVerifiedAt !== null` e a
 * guarda aplicava a janela. Passados trinta minutos, `/admin/seguranca` dizia
 * "confirmado neste aparelho" e escondia o campo do código, enquanto o caixa
 * recusava e mandava de volta para lá. Um laço sem saída a não ser deslogar.
 */
export function segundoFatorValido(verificadoEm: Date | null, agora: Date): boolean {
  if (!verificadoEm) return false;
  return agora.getTime() - verificadoEm.getTime() <= VALIDADE_DO_SEGUNDO_FATOR_MINUTOS * 60_000;
}

export interface EstadoDoMfa {
  readonly ativo: boolean;
  readonly pendente: boolean;
}

/** Quem tem permissão de dinheiro é obrigado ao segundo fator. */
export const exigeSegundoFator = (permissoes: readonly string[]): boolean =>
  PERMISSOES_DE_DINHEIRO.some((p: Permissao) => permissoes.includes(p));

export async function estadoDoMfa(
  tenantId: string,
  staffUserId: string,
): Promise<EstadoDoMfa> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ tem: boolean; confirmado: Date | null }[]>`
      SELECT totp_secret IS NOT NULL AS tem, totp_confirmed_at AS confirmado
        FROM staff_users WHERE id = ${staffUserId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) throw new MfaError('not_enabled', 'Conta não encontrada.');
    return { ativo: linha.confirmado !== null, pendente: linha.tem && linha.confirmado === null };
  });
}

/**
 * Começa o cadastro: gera o segredo e devolve o que o autenticador lê.
 *
 * O segredo é gravado **antes** da confirmação, mas sem `totp_confirmed_at` —
 * e é essa coluna, não a presença do segredo, que liga o segundo fator. Sem os
 * dois estados, um cadastro interrompido no meio (a pessoa fechou a tela antes
 * de digitar o primeiro código) deixaria a conta exigindo um código que ninguém
 * consegue gerar, e a saída seria mexer no banco.
 *
 * Recomeçar sobrescreve o segredo pendente. Quem já confirmou não recomeça por
 * aqui: trocar o autenticador sem provar o atual seria o caminho mais curto para
 * anular o segundo fator a partir de uma sessão roubada.
 */
export async function iniciarCadastroMfa(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly barbearia: string;
}): Promise<{ readonly segredoBase32: string; readonly uri: string }> {
  const segredo = novoSegredo();
  // Cifra antes de abrir transação: se `MFA_SECRET_KEY` faltar, falha sem ter
  // escrito nada.
  const cifrado = cifrarSegredo(segredo);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ email: string; confirmado: Date | null }[]>`
      SELECT email, totp_confirmed_at AS confirmado
        FROM staff_users WHERE id = ${params.staffUserId}::uuid
    `;
    const usuario = linhas[0];
    if (!usuario) throw new MfaError('not_enabled', 'Conta não encontrada.');
    if (usuario.confirmado) {
      throw new MfaError('already_enabled', 'O segundo fator já está ativo nesta conta.');
    }

    await tx.$executeRaw`
      UPDATE staff_users
         SET totp_secret = ${cifrado}, totp_last_step = NULL, updated_at = now()
       WHERE id = ${params.staffUserId}::uuid
    `;

    return {
      segredoBase32: segredo,
      uri: uriDoAutenticador({
        segredoBase32: segredo,
        email: usuario.email,
        barbearia: params.barbearia,
      }),
    };
  });
}

/**
 * Confirma o cadastro com o primeiro código e entrega os códigos de recuperação.
 *
 * Os códigos aparecem **uma vez**, aqui. Guardados em claro para poder mostrar
 * de novo, deixariam de ser credencial e virariam uma segunda cópia da chave do
 * caixa dentro do próprio banco.
 */
export async function confirmarCadastroMfa(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly staffName: string;
  readonly codigo: string;
  readonly now: Date;
}): Promise<{ readonly codigosDeRecuperacao: readonly string[] }> {
  const codigos = gerarCodigosDeRecuperacao();
  const hashes = await hashDosCodigos(codigos);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ secret: string | null; confirmado: Date | null }[]>`
      SELECT totp_secret AS secret, totp_confirmed_at AS confirmado
        FROM staff_users WHERE id = ${params.staffUserId}::uuid FOR UPDATE
    `;
    const usuario = linhas[0];
    if (!usuario?.secret) {
      throw new MfaError('not_enabled', 'Comece o cadastro do segundo fator antes.');
    }
    if (usuario.confirmado) {
      throw new MfaError('already_enabled', 'O segundo fator já está ativo nesta conta.');
    }

    const conferido = conferirCodigo({
      segredoBase32: decifrarSegredo(usuario.secret),
      codigo: params.codigo,
      now: params.now,
    });
    if (!conferido.valido) {
      throw new MfaError('invalid_code', 'Código incorreto. Confira o aplicativo e tente de novo.');
    }

    await tx.$executeRaw`
      UPDATE staff_users
         SET totp_confirmed_at = now(),
             totp_last_step = ${conferido.passo},
             recovery_codes = ${hashes},
             updated_at = now()
       WHERE id = ${params.staffUserId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffUserId,
      actorName: params.staffName,
      action: 'mfa.enabled',
      entity: 'staff_user',
      entityId: params.staffUserId,
      after: { codigosDeRecuperacao: codigos.length },
    });

    return { codigosDeRecuperacao: codigos };
  });
}

/**
 * Prova o segundo fator para **esta sessão**.
 *
 * Aceita o código do aplicativo ou um de recuperação. Os dois caminhos gravam
 * a mesma coisa na sessão; o que muda é o que é queimado depois:
 *
 * - TOTP: grava o passo consumido, e aquele código não vale mais na janela.
 * - Recuperação: o hash sai do array, e aquele papel não serve duas vezes.
 */
export async function verificarSegundoFator(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly staffName: string;
  readonly sessionId: string;
  readonly codigo: string;
  readonly now: Date;
}): Promise<{ readonly usouRecuperacao: boolean; readonly restantes: number }> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        secret: string | null;
        confirmado: Date | null;
        last_step: bigint | null;
        recovery_codes: string[];
      }[]
    >`
      SELECT totp_secret AS secret, totp_confirmed_at AS confirmado,
             totp_last_step AS last_step, recovery_codes
        FROM staff_users WHERE id = ${params.staffUserId}::uuid FOR UPDATE
    `;
    const usuario = linhas[0];
    if (!usuario?.secret || !usuario.confirmado) {
      throw new MfaError('not_enabled', 'Ative o segundo fator antes.');
    }

    const conferido = conferirCodigo({
      segredoBase32: decifrarSegredo(usuario.secret),
      codigo: params.codigo,
      now: params.now,
      ultimoPasso: usuario.last_step === null ? null : Number(usuario.last_step),
    });

    let usouRecuperacao = false;
    let restantes = usuario.recovery_codes.length;

    if (conferido.valido) {
      await tx.$executeRaw`
        UPDATE staff_users SET totp_last_step = ${conferido.passo}
         WHERE id = ${params.staffUserId}::uuid
      `;
    } else {
      const indice = await acharCodigoDeRecuperacao(params.codigo, usuario.recovery_codes);
      if (indice === null) {
        throw new MfaError('invalid_code', 'Código incorreto.');
      }
      const sobraram = usuario.recovery_codes.filter((_, i) => i !== indice);
      await tx.$executeRaw`
        UPDATE staff_users SET recovery_codes = ${sobraram}
         WHERE id = ${params.staffUserId}::uuid
      `;
      /**
       * O uso de código de recuperação é o evento mais importante desta trilha.
       *
       * Os dois caminhos entram pelo mesmo endpoint e a única diferença visível
       * de fora é um booleano na resposta — que vai para quem acabou de usar o
       * código, e para mais ninguém. Sem esta linha, um código de recuperação
       * encontrado numa gaveta destranca o caixa por trinta minutos e o único
       * rastro no sistema é um contador que nenhuma tela mostra caindo de 8
       * para 7.
       */
      await audit(tx, {
        actorId: params.staffUserId,
        actorName: params.staffName,
        action: 'mfa.recovery_used',
        entity: 'staff_user',
        entityId: params.staffUserId,
        after: { restantes: sobraram.length },
      });

      usouRecuperacao = true;
      restantes = sobraram.length;
    }

    await tx.$executeRaw`
      UPDATE staff_sessions SET mfa_verified_at = now()
       WHERE id = ${params.sessionId}::uuid AND revoked_at IS NULL
    `;

    return { usouRecuperacao, restantes };
  });
}

/**
 * Desliga o segundo fator.
 *
 * Pede o código atual — desligar a partir de uma sessão roubada seria o caminho
 * mais curto para anular a proteção inteira. E **quem tem permissão de dinheiro
 * não desliga**: a regra do `CLAUDE.md` é sobre o papel, não sobre a vontade de
 * quem o ocupa. Para essa pessoa, o caminho é perder a permissão primeiro.
 */
export async function desligarMfa(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly staffName: string;
  readonly sessionId: string;
  readonly permissoes: readonly string[];
  readonly codigo: string;
  readonly now: Date;
}): Promise<void> {
  if (exigeSegundoFator(params.permissoes)) {
    throw new MfaError(
      'already_enabled',
      'Contas com acesso ao financeiro não podem desligar o segundo fator.',
    );
  }

  await verificarSegundoFator({
    tenantId: params.tenantId,
    staffUserId: params.staffUserId,
    staffName: params.staffName,
    sessionId: params.sessionId,
    codigo: params.codigo,
    now: params.now,
  });

  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE staff_users
         SET totp_secret = NULL, totp_confirmed_at = NULL,
             totp_last_step = NULL, recovery_codes = '{}', updated_at = now()
       WHERE id = ${params.staffUserId}::uuid
    `;

    /**
     * Derruba a prova em **todas** as sessões desta pessoa, não só na atual.
     *
     * Hoje limpar só a atual seria inofensivo — sem `totp_confirmed_at` a
     * guarda já recusa. Mas basta a pessoa cadastrar um autenticador novo para
     * as outras sessões voltarem a valer carregando uma prova feita contra o
     * fator **antigo**, que é exatamente o que desligar deveria ter anulado.
     */
    await tx.$executeRaw`
      UPDATE staff_sessions SET mfa_verified_at = NULL
       WHERE staff_user_id = ${params.staffUserId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffUserId,
      actorName: params.staffName,
      action: 'mfa.disabled',
      entity: 'staff_user',
      entityId: params.staffUserId,
    });
  });
}
