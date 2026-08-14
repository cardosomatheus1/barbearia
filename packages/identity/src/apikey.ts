import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { semTenant, withTenant } from '@barbearia/db';
import {
  TETO_POR_MINUTO,
  escoposQueOAtorPodeDar,
  montarChave,
  partirChave,
  validarEscopos,
  type Permissao,
} from '@barbearia/core';
import { audit } from './audit.js';

/**
 * Chave de API pública: emitir, conferir e segurar (bloco 78).
 *
 * ## O segredo existe uma vez
 *
 * `criarChave` devolve a chave inteira, e é a única vez que ela existe fora da
 * cabeça de quem a copiou. No banco fica o prefixo em claro — é por ele que a
 * autenticação encontra a linha — e o HMAC-SHA256 do segredo com
 * `API_KEY_PEPPER`. Banco vazado não entrega credencial viva.
 *
 * HMAC e não `scrypt`, e a escolha é sobre o uso: senha é entropia baixa
 * digitada por gente e precisa ser cara de derivar; chave de API é 256 bits
 * sorteados, conferidos a **cada requisição** — um `scrypt` por chamada seria o
 * teto de vazão da integração inteira.
 *
 * ## A conferência acontece sem tenant
 *
 * Descobrir de quem é a chave é o que a autenticação faz, então ela roda
 * `semTenant`. A partir do momento em que o tenant é conhecido, tudo volta ao
 * caminho normal: `withTenant`, RLS, permissão declarada na rota.
 */

export type ApiKeyFailure =
  | 'pepper_ausente'
  | 'escopo_vazio'
  | 'escopo_desconhecido'
  | 'escopo_de_dinheiro'
  | 'escopo_irreversivel'
  | 'escopo_alem_do_ator'
  | 'chave_nao_encontrada'
  | 'motivo_obrigatorio';

export class ApiKeyError extends Error {
  constructor(
    readonly code: ApiKeyFailure,
    message: string,
    readonly detalhe?: string,
  ) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

/**
 * A chave de ambiente que protege os segredos das chaves.
 *
 * **Própria**, e não a do segundo fator nem a do WhatsApp: com uma chave só,
 * girar a de uma finalidade — operação normal de segurança — quebraria as
 * outras ao mesmo tempo, e o defeito apareceria dias depois como "a integração
 * parou". Falha alto quando ausente, como manda a regra: cair num padrão fraco
 * em silêncio é pior que não subir.
 */
function pepper(): Buffer {
  const bruto = process.env['API_KEY_PEPPER'];
  if (!bruto || bruto.length < 16) {
    throw new ApiKeyError(
      'pepper_ausente',
      'API_KEY_PEPPER é obrigatória e precisa de pelo menos 16 caracteres',
    );
  }
  return Buffer.from(bruto, 'utf8');
}

function hmacDoSegredo(segredo: string): string {
  return createHmac('sha256', pepper()).update(segredo).digest('hex');
}

export interface ChaveNaTela {
  readonly id: string;
  readonly nome: string;
  readonly prefixo: string;
  readonly escopos: readonly Permissao[];
  readonly criadaEm: Date;
  readonly usadaEm: Date | null;
  readonly revogadaEm: Date | null;
  readonly motivoDaRevogacao: string | null;
}

/** As chaves da barbearia. O segredo não está aqui, e nunca estará. */
export async function chavesDaCasa(tenantId: string): Promise<readonly ChaveNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
        revoke_reason: string | null;
      }[]
    >`
      SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at, revoke_reason
        FROM api_keys
       ORDER BY revoked_at NULLS FIRST, created_at DESC
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      prefixo: l.prefix,
      escopos: l.scopes as Permissao[],
      criadaEm: l.created_at,
      usadaEm: l.last_used_at,
      revogadaEm: l.revoked_at,
      motivoDaRevogacao: l.revoke_reason,
    }));
  });
}

/**
 * Emite uma chave, e devolve o segredo **uma vez**.
 *
 * `escoposDoAtor` vem do banco, nunca do formulário: ninguém concede o que não
 * tem, e sem isso criar uma chave seria o caminho curto para se dar a permissão
 * que o papel não tem — o mesmo defeito que o bloco 30 fechou para papéis.
 */
export async function criarChave(entrada: {
  readonly tenantId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly nome: string;
  readonly escopos: readonly string[];
  readonly escoposDoAtor: readonly Permissao[];
}): Promise<{ readonly id: string; readonly chave: string; readonly prefixo: string }> {
  const validado = validarEscopos(entrada.escopos);
  if (!validado.ok) {
    throw new ApiKeyError(
      validado.recusa.motivo,
      'Escopo inválido para uma chave de API',
      validado.recusa.escopo,
    );
  }

  const podeDar = escoposQueOAtorPodeDar(validado.escopos, entrada.escoposDoAtor);
  if (!podeDar.ok) {
    throw new ApiKeyError(
      'escopo_alem_do_ator',
      'Você não pode dar a uma chave uma permissão que não tem',
      podeDar.faltando,
    );
  }

  const nome = entrada.nome.trim();
  if (nome.length < 2) {
    throw new ApiKeyError('motivo_obrigatorio', 'A chave precisa de um nome');
  }

  const prefixo = randomBytes(6).toString('hex');
  const segredo = randomBytes(32).toString('base64url');
  const hmac = hmacDoSegredo(segredo);
  const escopos = [...validado.escopos];

  const id = await withTenant(entrada.tenantId, async (tx) => {
    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes, created_by)
      VALUES (${entrada.tenantId}::uuid, ${nome}, ${prefixo}, ${hmac}, ${escopos}, ${entrada.staffId}::uuid)
      RETURNING id
    `;
    const chave = criadas[0];
    if (!chave) throw new ApiKeyError('chave_nao_encontrada', 'Não foi possível criar a chave');

    /**
     * A trilha registra **que** a chave nasceu e com que escopo — nunca o
     * segredo, nem o HMAC. É a mesma regra do CPF: a trilha guarda que mudou,
     * não o valor. `audit_log` é append-only e a anonimização não a alcança.
     */
    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'api_key.created',
      entity: 'api_key',
      entityId: chave.id,
      after: { prefixo, escopos },
    });

    return chave.id;
  });

  return { id, chave: montarChave(prefixo, segredo), prefixo };
}

/** Revoga uma chave. Estado, com motivo — nunca `DELETE`. */
export async function revogarChave(entrada: {
  readonly tenantId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly chaveId: string;
  readonly motivo: string;
}): Promise<void> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 5) {
    throw new ApiKeyError('motivo_obrigatorio', 'Escreva o motivo da revogação');
  }

  await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; prefix: string }[]>`
      UPDATE api_keys
         SET revoked_at = now(), revoke_reason = ${motivo}
       WHERE id = ${entrada.chaveId}::uuid AND revoked_at IS NULL
      RETURNING id, prefix
    `;
    const chave = linhas[0];
    if (!chave) throw new ApiKeyError('chave_nao_encontrada', 'Chave não encontrada ou já revogada');

    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'api_key.revoked',
      entity: 'api_key',
      entityId: chave.id,
      after: { prefixo: chave.prefix, motivo },
    });
  });
}

export interface ChaveAutenticada {
  readonly id: string;
  readonly tenantId: string;
  readonly escopos: readonly Permissao[];
}

export type RecusaDaChave = 'invalida' | 'revogada' | 'excedeu';

/**
 * Confere a chave apresentada e gasta uma da cota.
 *
 * ## As três recusas, e a ordem delas
 *
 * 1. **Forma** — recusada sem ir ao banco. Lixo não merece consulta.
 * 2. **Segredo** — comparação em tempo constante contra o HMAC, e a linha é
 *    encontrada pelo prefixo. Um índice único sobre o HMAC obrigaria a calcular
 *    o HMAC de toda chave da base a cada requisição.
 * 3. **Cota** — conferida **depois** do segredo, de propósito: contar chamada
 *    de chave inválida deixaria qualquer um esgotar a cota de uma chave alheia
 *    mandando o prefixo dela com segredo errado.
 *
 * A conferência roda `semTenant` porque descobrir de quem é a chave é o que ela
 * faz. Daí em diante tudo volta ao caminho normal.
 */
export async function autenticarChave(
  bruta: string,
  agora: Date,
): Promise<{ readonly ok: true; readonly chave: ChaveAutenticada } | { readonly ok: false; readonly recusa: RecusaDaChave }> {
  const partida = partirChave(bruta);
  if (!partida) return { ok: false, recusa: 'invalida' };

  const esperado = hmacDoSegredo(partida.segredo);
  const minuto = new Date(Math.floor(agora.getTime() / 60_000) * 60_000);

  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; tenant_id: string; secret_hmac: string; scopes: string[]; revoked_at: Date | null }[]
    >`
      SELECT id, tenant_id, secret_hmac, scopes, revoked_at
        FROM api_keys WHERE prefix = ${partida.prefixo}
    `;
    const linha = linhas[0];
    if (!linha) return { ok: false as const, recusa: 'invalida' as const };

    const a = Buffer.from(linha.secret_hmac, 'utf8');
    const b = Buffer.from(esperado, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false as const, recusa: 'invalida' as const };
    }
    /**
     * Revogada responde **revogada**, e não "inválida".
     *
     * Quem apresenta uma chave que já foi dela merece saber que ela foi
     * revogada — a mensagem não confirma nada que o portador já não saiba, e a
     * alternativa manda o integrador procurar erro de digitação por horas.
     */
    if (linha.revoked_at) return { ok: false as const, recusa: 'revogada' as const };

    /**
     * A cota numa instrução só, e o `RETURNING` diz quanto já foi gasto.
     *
     * `ON CONFLICT DO UPDATE` com `+ 1`: dois processos chegando ao mesmo tempo
     * serializam na linha, e não existe janela em que os dois leiam o mesmo
     * contador. Um `SELECT` seguido de `UPDATE` teria essa janela — e é a
     * janela que um integrador em laço encontra na primeira hora.
     */
    const uso = await tx.$queryRaw<{ chamadas: number }[]>`
      INSERT INTO api_key_usage (api_key_id, minuto, chamadas)
      VALUES (${linha.id}::uuid, ${minuto}, 1)
      ON CONFLICT (api_key_id, minuto)
      DO UPDATE SET chamadas = api_key_usage.chamadas + 1
      RETURNING chamadas
    `;
    if ((uso[0]?.chamadas ?? 0) > TETO_POR_MINUTO) {
      return { ok: false as const, recusa: 'excedeu' as const };
    }

    /**
     * O carimbo sai por função, e a contagem é conferida.
     *
     * O `UPDATE` direto aqui alcançava **zero linhas** em silêncio: esta
     * transação roda sem tenant, e a política de escrita de `api_keys` exige um.
     * O resultado era descartado, nada falhava, e `last_used_at` ficava nula
     * para sempre — com a tela dizendo "nunca usada" sobre a chave que estava
     * sendo usada naquele instante. Achado da `/security-review` do bloco 78.
     */
    const carimbo = await tx.$queryRaw<{ carimbar_uso_da_chave: number }[]>`
      SELECT carimbar_uso_da_chave(${linha.id}::uuid, ${agora})
    `;
    if ((carimbo[0]?.carimbar_uso_da_chave ?? 0) !== 1) {
      return { ok: false as const, recusa: 'invalida' as const };
    }

    return {
      ok: true as const,
      chave: {
        id: linha.id,
        tenantId: linha.tenant_id,
        escopos: linha.scopes as Permissao[],
      },
    };
  });
}

/** Limpa o contador do que já passou. Roda na varredura, como `login_attempts`. */
export async function limparUsoAntigo(antesDe: Date): Promise<number> {
  return semTenant(async (tx) => {
    return tx.$executeRaw`DELETE FROM api_key_usage WHERE minuto < ${antesDe}`;
  });
}
