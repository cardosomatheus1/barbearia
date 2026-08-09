import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { semTenant, withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';
import { provaDaSessao } from './mfa.js';

/**
 * Suporte assistido — entrar na conta da barbearia, com trilha (SPEC §1.2).
 *
 * > Impersonação sem trilha auditável é incidente de LGPD esperando acontecer.
 * > O registro deve gravar quem impersonou, quando, por quanto tempo e o que
 * > acessou — e **o tenant deve poder consultar esse log**.
 *
 * ## As quatro decisões que essa frase impõe
 *
 * **1. A trilha vai para os dois lados.** `platform_audit` registra o ato do
 * Super Admin; `audit_log` da barbearia registra que entraram na conta dela. Só
 * o primeiro seria uma trilha que o dono não pode consultar — exatamente o que
 * a SPEC recusa.
 *
 * **2. A sessão é curta e marcada.** Trinta minutos, e `impersonated_by` fica na
 * própria `staff_sessions`. Toda rota do painel já lê a sessão; pendurar a marca
 * ali significa que nenhuma consegue esquecer de perguntar.
 *
 * **3. É somente leitura.** Quem entra para investigar não cancela agendamento,
 * não fecha caixa e não muda preço. A regra vale na `PermissaoGuard`, que é
 * obrigatória em toda rota do painel — e não numa lista de rotas proibidas, que
 * é onde a próxima rota nasceria de fora.
 *
 * **4. Exige o segundo fator provado nesta sessão.** É a capacidade mais grave
 * do produto, e a exigência mora **aqui dentro**, na função que abre a sessão,
 * pelo mesmo motivo que a `PermissaoGuard` deriva o MFA da permissão em vez de
 * aceitar um decorador: o que se pode esquecer, esquece-se.
 */

const DURACAO_DO_SUPORTE_MS = 30 * 60 * 1000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

export interface SessaoDeSuporte {
  /** Token de gestor, no mesmo formato `<tenantId>.<segredo>` das sessões reais. */
  readonly token: string;
  readonly expiraEm: Date;
  readonly barbearia: string;
  readonly gestor: string;
}

/**
 * Abre uma sessão de suporte na conta de uma barbearia.
 *
 * A sessão é criada para o **dono** dela, e não para um usuário inventado: o
 * suporte precisa ver o que o dono vê, e criar uma conta fantasma dentro da
 * barbearia poluiria a equipe dela com gente que não trabalha lá.
 */
export async function abrirSuporte(entrada: {
  readonly adminId: string;
  readonly adminNome: string;
  readonly tokenDaPlataforma: string;
  readonly tenantId: string;
  readonly motivo: string;
  readonly agora?: Date;
}): Promise<SessaoDeSuporte> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new PlataformaError('reason_required', 'Escreva por que precisa entrar na conta');
  }

  if (!(await provaDaSessao(sha256(entrada.tokenDaPlataforma), entrada.agora ?? new Date()))) {
    throw new PlataformaError(
      'mfa_required',
      'Confirme o segundo fator antes de entrar numa conta',
    );
  }

  const contas = await semTenant(async (tx) =>
    tx.$queryRaw<{ name: string; blocked_at: Date | null }[]>`
      SELECT name, blocked_at FROM tenant_platform WHERE tenant_id = ${entrada.tenantId}::uuid
    `,
  );
  const barbearia = contas[0];
  if (!barbearia) throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');

  /**
   * Conta bloqueada não recebe suporte, e a recusa é aqui e não lá na frente.
   *
   * A `StaffGuard` já barra toda rota de uma barbearia bloqueada — então, sem
   * esta linha, abrir suporte numa conta bloqueada devolveria um token que
   * nenhuma tela aceita, e ainda gravaria na trilha do dono que entraram na
   * conta dele. Um registro de acesso que não corresponde a acesso nenhum é
   * pior do que registro nenhum: ele é o tipo de linha que ninguém consegue
   * explicar seis meses depois.
   */
  if (barbearia.blocked_at !== null) {
    throw new PlataformaError(
      'tenant_blocked',
      'Reative a conta antes de entrar nela — a barbearia bloqueada recusa toda rota do painel',
    );
  }

  const agora = entrada.agora ?? new Date();
  const segredo = randomBytes(32).toString('base64url');
  const expiraEm = new Date(agora.getTime() + DURACAO_DO_SUPORTE_MS);

  const suporteId = randomUUID();

  const gestor = await withTenant(entrada.tenantId, async (tx) => {
    const donos = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM staff_users
      WHERE role = 'owner' AND active
      ORDER BY created_at
      LIMIT 1
    `;
    const dono = donos[0];
    if (!dono) throw new PlataformaError('no_owner', 'Esta barbearia não tem dono ativo');

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO staff_sessions
        (tenant_id, staff_user_id, token_hash, expires_at, impersonated_by)
      VALUES (
        ${entrada.tenantId}::uuid, ${dono.id}::uuid, ${sha256(segredo)},
        ${expiraEm}, ${entrada.adminId}::uuid
      )
      RETURNING id
    `;

    // O espelho de plataforma, na **mesma** transação: um registro gravado
    // depois deixaria a janela em que a sessão existe e a plataforma não sabe.
    await tx.$executeRaw`
      INSERT INTO support_sessions
        (id, tenant_id, admin_id, staff_session_id, reason, started_at, expires_at)
      VALUES (
        ${suporteId}::uuid, ${entrada.tenantId}::uuid, ${entrada.adminId}::uuid,
        ${criadas[0]?.id ?? null}::uuid, ${motivo}, ${agora}, ${expiraEm}
      )
    `;

    // A metade que a SPEC exige: **o tenant** precisa poder consultar isto. Vai
    // na mesma transação que cria a sessão — trilha gravada depois é trilha que
    // some quando algo falha no meio.
    await audit(tx, {
      actorId: dono.id,
      actorName: `${entrada.adminNome} (suporte da plataforma)`,
      action: 'support.started',
      entity: 'tenant',
      entityId: entrada.tenantId,
      after: { motivo, ate: expiraEm.toISOString() },
    });

    return dono;
  });

  await semTenant(async (tx) => {
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.impersonated', {
      motivo,
      ate: expiraEm.toISOString(),
    });
  });

  return {
    token: `${entrada.tenantId}.${segredo}`,
    expiraEm,
    barbearia: barbearia.name,
    gestor: gestor.name,
  };
}

/**
 * Registra, na trilha **da barbearia**, o que a sessão de suporte acessou.
 *
 * É a parte de "o que acessou" da SPEC, e é a única do produto que grava uma
 * linha de auditoria por requisição. O custo é aceito porque a janela é de
 * trinta minutos e somente leitura: alguns milhares de linhas no pior caso, e a
 * alternativa é o dono ter que confiar na nossa palavra.
 *
 * A rota entra **genérica** (`/v1/admin/cliente/:id`), nunca com o id dentro. O
 * que o dono precisa saber é "o suporte abriu fichas de cliente", e gravar qual
 * ficha faria a trilha de auditoria virar mais uma cópia de dado pessoal.
 */
export async function registrarAcesso(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly adminId: string;
  readonly rota: string;
}): Promise<void> {
  const nome = await nomeDoAdmin(params.adminId);
  await withTenant(params.tenantId, (tx) =>
    audit(tx, {
      actorId: params.staffUserId,
      actorName: `${nome} (suporte da plataforma)`,
      action: 'support.accessed',
      entity: 'rota',
      after: { rota: params.rota },
    }),
  );
}

/**
 * O nome de quem está dando suporte, guardado por processo.
 *
 * A sessão carrega o **id** do Super Admin, e a trilha da barbearia precisa de
 * um nome — "quem entrou na minha conta" não se responde com um UUID. Buscar a
 * cada requisição seria uma consulta a mais no caminho que já grava uma linha
 * por requisição.
 *
 * O mapa é pequeno por construção: ele só cresce com o número de pessoas do
 * suporte, não com o de barbearias. Um nome trocado no meio de uma sessão de
 * trinta minutos aparece na trilha com o nome antigo, e isso é aceitável —
 * `admin_id` em `support_sessions` continua sendo a identidade de verdade.
 */
const nomes = new Map<string, string>();

async function nomeDoAdmin(adminId: string): Promise<string> {
  const guardado = nomes.get(adminId);
  if (guardado) return guardado;

  const linhas = await semTenant(async (tx) =>
    tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM platform_admins WHERE id = ${adminId}::uuid
    `,
  );
  const nome = linhas[0]?.name ?? 'Suporte';
  nomes.set(adminId, nome);
  return nome;
}

/**
 * Encerra, pela plataforma, o suporte aberto numa barbearia.
 *
 * **Todas** as sessões abertas, não a mais recente. Duas pessoas do suporte
 * podem estar dentro da mesma conta, e a pergunta que este botão responde é
 * "saiam da conta do meu cliente" — encerrar uma e deixar a outra seria dar uma
 * resposta que não é a que foi pedida.
 *
 * Resolve as sessões a partir de `support_sessions` em vez de receber ids: quem
 * chama é o painel da plataforma, que conhece a barbearia e não a sessão de
 * gestor. Sem isto, a única saída seria esperar os trinta minutos.
 */
export async function encerrarSuporteDaBarbearia(entrada: {
  readonly adminId: string;
  readonly adminNome: string;
  readonly tenantId: string;
}): Promise<number> {
  const abertas = await semTenant(async (tx) =>
    tx.$queryRaw<{ staff_session_id: string | null }[]>`
      SELECT staff_session_id FROM support_sessions
       WHERE tenant_id = ${entrada.tenantId}::uuid AND ended_at IS NULL
       ORDER BY started_at DESC
    `,
  );

  const ids = abertas.map((a) => a.staff_session_id).filter((id): id is string => id !== null);
  if (ids.length === 0) {
    throw new PlataformaError('no_support', 'Não há suporte aberto nesta conta');
  }

  // Uma consulta para os donos das sessões, não uma por sessão: são poucas, mas
  // "poucas" é o argumento que produz N+1 em toda parte.
  const donos = await withTenant(entrada.tenantId, async (tx) =>
    tx.$queryRaw<{ id: string; staff_user_id: string }[]>`
      SELECT id, staff_user_id FROM staff_sessions WHERE id = ANY(${ids}::uuid[])
    `,
  );

  for (const dono of donos) {
    await encerrarSuporte({
      tenantId: entrada.tenantId,
      sessionId: dono.id,
      staffUserId: dono.staff_user_id,
      adminNome: entrada.adminNome,
    });
  }

  await semTenant(async (tx) => {
    // Sessão sem linha em `staff_sessions` já foi limpa; marcar o registro de
    // plataforma mesmo assim é o que impede o botão de ficar preso num suporte
    // que não existe mais.
    await tx.$executeRaw`
      UPDATE support_sessions SET ended_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND ended_at IS NULL
    `;
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.support_ended', {
      sessoes: ids.length,
    });
  });

  return ids.length;
}

/** Encerra a sessão de suporte antes da hora. */
export async function encerrarSuporte(params: {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly staffUserId: string;
  readonly adminNome: string;
}): Promise<void> {
  const fechou = await withTenant(params.tenantId, async (tx) => {
    const fechadas = await tx.$executeRaw`
      UPDATE staff_sessions SET revoked_at = now()
       WHERE id = ${params.sessionId}::uuid
         AND revoked_at IS NULL
         AND impersonated_by IS NOT NULL
    `;
    if (fechadas === 0) return false;

    await audit(tx, {
      actorId: params.staffUserId,
      actorName: `${params.adminNome} (suporte da plataforma)`,
      action: 'support.ended',
      entity: 'tenant',
      entityId: params.tenantId,
    });
    return true;
  });

  if (!fechou) return;

  // Fora da transação do tenant porque `support_sessions` é de plataforma e a
  // conexão com tenant fixado não a governa. A ordem importa: a sessão já foi
  // revogada, então a pior falha aqui é uma linha sem `ended_at` — visível — e
  // não uma sessão viva que a plataforma acha encerrada.
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE support_sessions SET ended_at = now()
       WHERE staff_session_id = ${params.sessionId}::uuid AND ended_at IS NULL
    `;
  });
}

export interface SuporteAberto {
  readonly tenantId: string;
  readonly barbearia: string;
  readonly adminNome: string | null;
  readonly motivo: string;
  readonly abertoEm: Date;
  readonly expiraEm: Date;
}

/**
 * As sessões de suporte ainda válidas.
 *
 * Lê `support_sessions`, e não `staff_sessions`: a política daquela é o
 * isolamento clássico por `app.tenant_id`, então esta pergunta — que é sobre
 * todas as barbearias — devolveria zero linhas de dentro de `semTenant`.
 */
export async function suportesAbertos(
  agora: Date = new Date(),
): Promise<readonly SuporteAberto[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        tenant_id: string;
        barbearia: string;
        admin_nome: string | null;
        reason: string;
        started_at: Date;
        expires_at: Date;
      }[]
    >`
      SELECT ss.tenant_id, tp.name AS barbearia, a.name AS admin_nome,
             ss.reason, ss.started_at, ss.expires_at
      FROM support_sessions ss
      JOIN tenant_platform tp ON tp.tenant_id = ss.tenant_id
      LEFT JOIN platform_admins a ON a.id = ss.admin_id
      WHERE ss.ended_at IS NULL AND ss.expires_at > ${agora}
      ORDER BY ss.started_at DESC
    `;
    return linhas.map((l) => ({
      tenantId: l.tenant_id,
      barbearia: l.barbearia,
      adminNome: l.admin_nome,
      motivo: l.reason,
      abertoEm: l.started_at,
      expiraEm: l.expires_at,
    }));
  });
}
