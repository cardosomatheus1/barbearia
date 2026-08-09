import { semTenant } from '@barbearia/db';
import {
  acharCodigoDeRecuperacao,
  cifrarSegredo,
  conferirCodigo,
  decifrarSegredo,
  gerarCodigosDeRecuperacao,
  hashDosCodigos,
  novoSegredo,
  segundoFatorValido,
  uriDoAutenticador,
} from '@barbearia/identity';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * Segundo fator da conta de plataforma — a lacuna que o bloco 24 declarou.
 *
 * ## Por que ele é do bloco 26 e não de um bloco de segurança qualquer
 *
 * Porque a impersonação está aqui. A regra do `CLAUDE.md` deriva a exigência de
 * segundo fator da **permissão declarada**, justamente para que não exista um
 * decorador separado a esquecer. Aqui vale o mesmo princípio por outro caminho:
 * a prova de segundo fator é pré-requisito de entrar na conta de uma barbearia,
 * e essa exigência mora dentro da própria função que abre a sessão de suporte —
 * não numa guarda que uma rota nova possa não usar.
 *
 * ## O que **não** foi reescrito
 *
 * Nada da criptografia. Cifra, conferência de código, tolerância de passo,
 * consumo do passo e códigos de recuperação vêm inteiros de
 * `@barbearia/identity`. Reescrever TOTP porque "é a plataforma, não a equipe"
 * produziria uma segunda implementação com os mesmos erros esperando —
 * começando pela proteção contra reuso do código dentro da janela de trinta
 * segundos, que é a que se esquece.
 */

export interface CadastroDoSegundoFator {
  readonly segredoBase32: string;
  readonly uri: string;
  readonly codigosDeRecuperacao: readonly string[];
}

interface LinhaDeAdmin {
  id: string;
  name: string;
  totp_secret: string | null;
  totp_confirmed_at: Date | null;
  totp_last_step: bigint | null;
  recovery_codes: string[];
}

async function carregar(adminId: string): Promise<LinhaDeAdmin> {
  const linhas = await semTenant(async (tx) =>
    tx.$queryRaw<LinhaDeAdmin[]>`
      SELECT id, name, totp_secret, totp_confirmed_at, totp_last_step, recovery_codes
      FROM platform_admins WHERE id = ${adminId}::uuid
    `,
  );
  const linha = linhas[0];
  if (!linha) throw new PlataformaError('unknown_admin', 'Conta não encontrada');
  return linha;
}

export async function segundoFatorLigado(adminId: string): Promise<boolean> {
  return (await carregar(adminId)).totp_confirmed_at !== null;
}

/**
 * Gera o segredo e devolve o que a tela mostra uma vez só.
 *
 * O segredo entra cifrado e **ainda não confirmado**: enquanto
 * `totp_confirmed_at` for nulo, o segundo fator não está ligado. Sem essa
 * separação, quem começa o cadastro e fecha a aba antes de ler o QR Code fica
 * com uma conta que exige um código que ninguém tem.
 */
export async function iniciarCadastroDoSegundoFator(params: {
  readonly adminId: string;
  readonly email: string;
}): Promise<CadastroDoSegundoFator> {
  const admin = await carregar(params.adminId);
  if (admin.totp_confirmed_at) {
    throw new PlataformaError('mfa_already_on', 'O segundo fator já está ligado');
  }

  const segredo = novoSegredo();
  const codigos = gerarCodigosDeRecuperacao();
  const hashes = await hashDosCodigos(codigos);

  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE platform_admins
         SET totp_secret = ${cifrarSegredo(segredo)},
             totp_confirmed_at = NULL,
             totp_last_step = NULL,
             recovery_codes = ${hashes}
       WHERE id = ${params.adminId}::uuid
    `;
  });

  return {
    segredoBase32: segredo,
    uri: uriDoAutenticador({
      segredoBase32: segredo,
      email: params.email,
      barbearia: 'Barber Dock — plataforma',
    }),
    codigosDeRecuperacao: codigos,
  };
}

export async function confirmarCadastroDoSegundoFator(params: {
  readonly adminId: string;
  readonly codigo: string;
  readonly agora?: Date;
}): Promise<void> {
  const agora = params.agora ?? new Date();
  const admin = await carregar(params.adminId);
  if (!admin.totp_secret) {
    throw new PlataformaError('mfa_not_started', 'Comece o cadastro do segundo fator');
  }
  if (admin.totp_confirmed_at) {
    throw new PlataformaError('mfa_already_on', 'O segundo fator já está ligado');
  }

  const veredicto = conferirCodigo({
    segredoBase32: decifrarSegredo(admin.totp_secret),
    codigo: params.codigo,
    now: agora,
    ultimoPasso: admin.totp_last_step === null ? null : Number(admin.totp_last_step),
  });
  if (!veredicto.valido) throw new PlataformaError('invalid_code', 'Código inválido');

  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE platform_admins
         SET totp_confirmed_at = now(), totp_last_step = ${veredicto.passo}
       WHERE id = ${params.adminId}::uuid
    `;
    await registrarNaTrilha(tx, params.adminId, null, 'platform.mfa_enabled', {});
  });
}

/**
 * Prova o segundo fator **nesta sessão**.
 *
 * A validade é por sessão e curta, igual à da equipe e pelo mesmo motivo: a
 * sessão da plataforma dura oito horas, e quem conferiu o código às nove da
 * manhã não é necessariamente quem está no teclado às quatro da tarde.
 */
export async function provarSegundoFator(params: {
  readonly adminId: string;
  readonly tokenHash: string;
  readonly codigo: string;
  readonly agora?: Date;
}): Promise<{ readonly usouRecuperacao: boolean }> {
  const agora = params.agora ?? new Date();
  const admin = await carregar(params.adminId);
  if (!admin.totp_confirmed_at || !admin.totp_secret) {
    throw new PlataformaError('mfa_setup_required', 'Ative o segundo fator primeiro');
  }

  const veredicto = conferirCodigo({
    segredoBase32: decifrarSegredo(admin.totp_secret),
    codigo: params.codigo,
    now: agora,
    ultimoPasso: admin.totp_last_step === null ? null : Number(admin.totp_last_step),
  });

  if (veredicto.valido) {
    await semTenant(async (tx) => {
      await tx.$executeRaw`
        UPDATE platform_admins SET totp_last_step = ${veredicto.passo}
         WHERE id = ${params.adminId}::uuid
      `;
      await tx.$executeRaw`
        UPDATE platform_sessions SET mfa_verified_at = now()
         WHERE token_hash = ${params.tokenHash}
      `;
    });
    return { usouRecuperacao: false };
  }

  // O código de recuperação é a saída de quem perdeu o celular, e ele **some**
  // ao ser usado: um código que continua valendo é uma segunda senha permanente
  // anotada num papel.
  const achado = await acharCodigoDeRecuperacao(params.codigo, admin.recovery_codes);
  if (achado === null) throw new PlataformaError('invalid_code', 'Código inválido');

  const restantes = admin.recovery_codes.filter((_, i) => i !== achado);
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE platform_admins SET recovery_codes = ${restantes}
       WHERE id = ${params.adminId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE platform_sessions SET mfa_verified_at = now()
       WHERE token_hash = ${params.tokenHash}
    `;
    await registrarNaTrilha(tx, params.adminId, null, 'platform.mfa_recovery_used', {
      restantes: restantes.length,
    });
  });

  return { usouRecuperacao: true };
}

/** A prova desta sessão ainda vale? Mesma janela de 30 minutos da equipe. */
export async function provaDaSessao(
  tokenHash: string,
  agora: Date = new Date(),
): Promise<boolean> {
  const linhas = await semTenant(async (tx) =>
    tx.$queryRaw<{ mfa_verified_at: Date | null }[]>`
      SELECT mfa_verified_at FROM platform_sessions WHERE token_hash = ${tokenHash}
    `,
  );
  return segundoFatorValido(linhas[0]?.mfa_verified_at ?? null, agora);
}
