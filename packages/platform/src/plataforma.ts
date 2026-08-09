import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { semTenant, type TransactionClient } from '@barbearia/db';
import { emailKey, hashPassword, verifyPassword } from '@barbearia/identity';

/**
 * A camada de plataforma: quem administra o SaaS, não a barbearia.
 *
 * ## Por que ela usa `semTenant` e por que isso não é uma brecha
 *
 * Todo o resto do produto passa por `withTenant`, que fixa `app.tenant_id` e
 * deixa a RLS filtrar. Aqui não há tenant: a pergunta é sobre **todas** as
 * barbearias.
 *
 * O que torna isso seguro não é confiança no código — é o fato de que as
 * tabelas que este arquivo toca (`plans`, `tenant_platform`, `platform_admins`,
 * `platform_sessions`, `platform_audit`) foram criadas com política
 * `USING (true)` de propósito, e **nenhuma delas guarda dado de cliente**. A
 * migração 0026 explica a decisão em detalhe, e o teste de invariantes prova o
 * outro lado: com o mesmo role, uma consulta a `customers` continua devolvendo
 * só a barbearia fixada.
 *
 * Em uma frase: a plataforma não tem acesso a mais coisa, ela tem acesso a
 * **outras** coisas.
 *
 * ## O que ela deliberadamente não faz
 *
 * Não lê agendamento, cliente, comanda ou caixa. Se um dia precisar, o caminho
 * é impersonação auditada (bloco 26) — que deixa rastro e que o dono da
 * barbearia pode consultar —, nunca alargar uma política.
 */

const DURACAO_DA_SESSAO_MS = 8 * 60 * 60 * 1000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

function pepper(): string {
  const valor = process.env['STAFF_EMAIL_PEPPER'];
  if (!valor) {
    throw new Error('STAFF_EMAIL_PEPPER é obrigatória — sem ela o índice de login fica em claro');
  }
  return valor;
}

export class PlataformaError extends Error {
  constructor(readonly code: string, mensagem: string) {
    super(mensagem);
    this.name = 'PlataformaError';
  }
}

// ---------------------------------------------------------------------------
// Planos
// ---------------------------------------------------------------------------

export interface Plano {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly priceCents: number;
  readonly maxChairs: number | null;
  readonly active: boolean;
}

interface LinhaDePlano {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  max_chairs: number | null;
  active: boolean;
}

const paraPlano = (l: LinhaDePlano): Plano => ({
  id: l.id,
  code: l.code,
  name: l.name,
  priceCents: l.price_cents,
  maxChairs: l.max_chairs,
  active: l.active,
});

export async function listarPlanos(incluirInativos = false): Promise<readonly Plano[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDePlano[]>`
      SELECT id, code, name, price_cents, max_chairs, active
      FROM plans
      WHERE ${incluirInativos}::boolean OR active
      ORDER BY price_cents, code
    `;
    return linhas.map(paraPlano);
  });
}

// ---------------------------------------------------------------------------
// A lista de barbearias
// ---------------------------------------------------------------------------

export interface BarbeariaNaPlataforma {
  readonly tenantId: string;
  readonly nome: string;
  readonly slug: string | null;
  readonly plano: { readonly code: string; readonly name: string; readonly priceCents: number } | null;
  readonly bloqueada: boolean;
  readonly bloqueadaEm: Date | null;
  readonly motivoDoBloqueio: string | null;
  readonly criadaEm: Date;
}

interface LinhaDeBarbearia {
  tenant_id: string;
  name: string;
  slug: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_price_cents: number | null;
  blocked_at: Date | null;
  blocked_reason: string | null;
  created_at: Date;
}

const paraBarbearia = (l: LinhaDeBarbearia): BarbeariaNaPlataforma => ({
  tenantId: l.tenant_id,
  nome: l.name,
  slug: l.slug,
  plano:
    l.plan_code && l.plan_name && l.plan_price_cents !== null
      ? { code: l.plan_code, name: l.plan_name, priceCents: l.plan_price_cents }
      : null,
  bloqueada: l.blocked_at !== null,
  bloqueadaEm: l.blocked_at,
  motivoDoBloqueio: l.blocked_reason,
  criadaEm: l.created_at,
});

/**
 * As barbearias da plataforma.
 *
 * O slug vem de `tenant_slugs`, que já é de leitura pública — é o mesmo dado
 * que qualquer visitante lê na URL. Só o primário: os antigos existem para
 * redirecionar, e listá-los faria a mesma barbearia aparecer várias vezes.
 */
export async function listarBarbearias(): Promise<readonly BarbeariaNaPlataforma[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeBarbearia[]>`
      SELECT tp.tenant_id, tp.name, ts.slug,
             p.code AS plan_code, p.name AS plan_name, p.price_cents AS plan_price_cents,
             tp.blocked_at, tp.blocked_reason, tp.created_at
      FROM tenant_platform tp
      LEFT JOIN plans p ON p.id = tp.plan_id
      LEFT JOIN tenant_slugs ts ON ts.tenant_id = tp.tenant_id AND ts.is_primary
      ORDER BY tp.created_at DESC
    `;
    return linhas.map(paraBarbearia);
  });
}

// ---------------------------------------------------------------------------
// Plano e bloqueio
// ---------------------------------------------------------------------------

/**
 * Exportada desde que ganhou o segundo usuário (`recursos.ts`).
 *
 * Continua recebendo `tx`: a trilha é gravada **dentro** da transação que muda
 * o estado, e uma versão que abrisse a própria conexão perderia exatamente isso.
 *
 * `adminId` nulo é a régua de cobrança (bloco 28) — o único autor sem gente por
 * trás. A coluna já era anulável desde o bloco 24; o tipo é que insistia em
 * exigir alguém, e o bloqueio automático é justamente o evento que mais precisa
 * de linha na trilha e menos tem a quem atribuir.
 */
export async function registrarNaTrilha(
  tx: TransactionClient,
  adminId: string | null,
  tenantId: string | null,
  acao: string,
  detalhe: Record<string, unknown>,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO platform_audit (admin_id, tenant_id, action, detail)
    VALUES (${adminId}::uuid, ${tenantId}::uuid, ${acao}, ${JSON.stringify(detalhe)}::jsonb)
  `;
}

/**
 * O ciclo de vida da conta, que é de onde sai o churn.
 *
 * Escrito **na mesma transação** que muda o estado, como a trilha — e separado
 * dela de propósito: `platform_audit` é lida por gente, e renomear uma ação lá
 * é decisão de texto que não pode mexer num número de negócio em silêncio.
 */
export async function marcarCiclo(
  tx: TransactionClient,
  tenantId: string,
  evento: 'blocked' | 'unblocked',
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tenant_lifecycle (tenant_id, event)
    VALUES (${tenantId}::uuid, ${evento}::tenant_lifecycle_event)
  `;
}

/**
 * A troca de plano vivia aqui, e mudou de lugar no bloco 27.
 *
 * Ela escrevia `tenant_platform.plan_id` — uma coluna que existia antes de
 * haver assinatura e que não sabia dizer preço contratado, prazo nem estado.
 * Com `subscriptions`, manter as duas seria manter duas respostas para "em que
 * plano esta barbearia está", e a divergência entre elas é a discussão que
 * ninguém consegue encerrar.
 *
 * O que existe agora é `mudarPlanoDaAssinatura` (`assinatura.ts`), que muda a
 * assinatura **e** acerta o espelho na mesma transação.
 */

export async function bloquearBarbearia(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly motivo: string;
}): Promise<void> {
  const motivo = entrada.motivo.trim();
  // A checagem do banco existe e é a que vale; esta é para o erro chegar ao
  // painel como mensagem, não como violação de constraint.
  if (motivo.length === 0) {
    throw new PlataformaError('reason_required', 'Escreva o motivo do bloqueio');
  }

  await semTenant(async (tx) => {
    const alteradas = await tx.$executeRaw`
      UPDATE tenant_platform
         SET blocked_at = now(), blocked_reason = ${motivo}, updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND blocked_at IS NULL
    `;
    // Zero linhas é uma de duas coisas, e as duas são "não faça nada": a
    // barbearia não existe, ou já estava bloqueada. Bloquear de novo trocaria a
    // data original do bloqueio, que é o que o suporte usa para contar prazo.
    if (alteradas === 0) {
      throw new PlataformaError('not_blockable', 'Barbearia inexistente ou já bloqueada');
    }
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.blocked', { motivo });
    await marcarCiclo(tx, entrada.tenantId, 'blocked');
  });
}

export async function desbloquearBarbearia(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
}): Promise<void> {
  await semTenant(async (tx) => {
    const alteradas = await tx.$executeRaw`
      UPDATE tenant_platform
         SET blocked_at = NULL, blocked_reason = NULL, updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND blocked_at IS NOT NULL
    `;
    if (alteradas === 0) {
      throw new PlataformaError('not_blocked', 'Barbearia inexistente ou já ativa');
    }
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.unblocked', {});
    await marcarCiclo(tx, entrada.tenantId, 'unblocked');
  });
}

/**
 * A barbearia está bloqueada?
 *
 * Consultada pelo login da equipe e pela página pública. Existe separada e
 * mínima porque roda em **todo** login e em toda carga da página: devolver a
 * linha inteira aqui seria trabalho jogado fora no caminho mais quente.
 */
export async function bloqueioDaBarbearia(
  tenantId: string,
): Promise<{ readonly bloqueada: boolean; readonly motivo: string | null }> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ blocked_reason: string | null }[]>`
      SELECT blocked_reason FROM tenant_platform
      WHERE tenant_id = ${tenantId}::uuid AND blocked_at IS NOT NULL
    `;
    const linha = linhas[0];
    return linha ? { bloqueada: true, motivo: linha.blocked_reason } : { bloqueada: false, motivo: null };
  });
}

// ---------------------------------------------------------------------------
// A porta
// ---------------------------------------------------------------------------

export interface AdminDaPlataforma {
  readonly id: string;
  readonly nome: string;
}

export async function criarAdminDaPlataforma(entrada: {
  readonly nome: string;
  readonly email: string;
  readonly senha: string;
}): Promise<AdminDaPlataforma> {
  if (entrada.senha.length < 12) {
    throw new PlataformaError('weak_password', 'A senha precisa de pelo menos 12 caracteres');
  }

  const chave = emailKey(entrada.email, pepper());
  const hash = await hashPassword(entrada.senha);

  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO platform_admins (email_key, name, password_hash)
      VALUES (${chave}, ${entrada.nome}, ${hash})
      ON CONFLICT (email_key) DO NOTHING
      RETURNING id
    `;
    const linha = linhas[0];
    if (!linha) throw new PlataformaError('email_taken', 'Já existe uma conta com este e-mail');
    return { id: linha.id, nome: entrada.nome };
  });
}

export interface SessaoDaPlataforma {
  readonly token: string;
  readonly admin: AdminDaPlataforma;
  readonly expiraEm: Date;
}

/**
 * Entrar.
 *
 * A resposta é a mesma para e-mail inexistente, senha errada e conta desligada
 * — e o custo de tempo também: a verificação de senha roda mesmo sem conta,
 * contra um hash descartável. Sem isso, o tempo de resposta responde "este
 * e-mail existe", que é enumeração de base pela porta dos fundos.
 */
export async function entrarNaPlataforma(entrada: {
  readonly email: string;
  readonly senha: string;
  readonly agora?: Date;
}): Promise<SessaoDaPlataforma> {
  const agora = entrada.agora ?? new Date();
  const chave = emailKey(entrada.email, pepper());

  const contas = await semTenant(async (tx) =>
    tx.$queryRaw<{ id: string; name: string; password_hash: string; disabled_at: Date | null }[]>`
      SELECT id, name, password_hash, disabled_at FROM platform_admins WHERE email_key = ${chave}
    `,
  );

  const conta = contas[0];
  if (!conta) {
    // **Uma** derivação, igual à do caminho com conta — é o mesmo desenho de
    // `staffLogin`, e a primeira versão daqui errava justamente nisto: ela
    // fabricava um hash descartável e **depois** o conferia, gastando dois
    // scrypt onde o outro caminho gasta um. O efeito era o oráculo ao
    // contrário, com o dobro do tempo denunciando o e-mail que **não** existe.
    await hashPassword(entrada.senha);
    throw new PlataformaError('invalid_credentials', 'E-mail ou senha inválidos');
  }

  const confere = await verifyPassword(entrada.senha, conta.password_hash);
  if (!confere.valid || conta.disabled_at !== null) {
    throw new PlataformaError('invalid_credentials', 'E-mail ou senha inválidos');
  }

  const token = randomBytes(32).toString('base64url');
  const expiraEm = new Date(agora.getTime() + DURACAO_DA_SESSAO_MS);

  await semTenant(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO platform_sessions (token_hash, admin_id, expires_at)
      VALUES (${sha256(token)}, ${conta.id}::uuid, ${expiraEm})
    `;
    await registrarNaTrilha(tx, conta.id, null, 'platform.login', {});
  });

  return { token, admin: { id: conta.id, nome: conta.name }, expiraEm };
}

export async function resolverSessaoDaPlataforma(
  token: string,
  agora: Date = new Date(),
): Promise<AdminDaPlataforma> {
  // Comparação por hash, e o hash é a chave primária: o token em claro nunca
  // toca o banco. Um dump de `platform_sessions` não dá sessão a ninguém.
  const linhas = await semTenant(async (tx) =>
    tx.$queryRaw<{ id: string; name: string; expires_at: Date; disabled_at: Date | null }[]>`
      SELECT a.id, a.name, s.expires_at, a.disabled_at
      FROM platform_sessions s
      JOIN platform_admins a ON a.id = s.admin_id
      WHERE s.token_hash = ${sha256(token)}
    `,
  );

  const linha = linhas[0];
  if (!linha || linha.expires_at <= agora || linha.disabled_at !== null) {
    throw new PlataformaError('unauthorized', 'Sessão inválida');
  }

  return { id: linha.id, nome: linha.name };
}

export async function sairDaPlataforma(token: string): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`DELETE FROM platform_sessions WHERE token_hash = ${sha256(token)}`;
  });
}

/** Usado só pelo teste de tempo constante; exportado para não duplicar o hash. */
export function mesmoToken(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// A trilha
// ---------------------------------------------------------------------------

export interface EventoDaPlataforma {
  readonly acao: string;
  readonly tenantId: string | null;
  readonly detalhe: Record<string, unknown>;
  readonly quando: Date;
  readonly adminNome: string | null;
}

export async function trilhaDaPlataforma(limite = 100): Promise<readonly EventoDaPlataforma[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { action: string; tenant_id: string | null; detail: Record<string, unknown>; created_at: Date; admin_nome: string | null }[]
    >`
      SELECT pa.action, pa.tenant_id, pa.detail, pa.created_at, a.name AS admin_nome
      FROM platform_audit pa
      LEFT JOIN platform_admins a ON a.id = pa.admin_id
      ORDER BY pa.created_at DESC, pa.id DESC
      LIMIT ${Math.min(Math.max(limite, 1), 500)}
    `;
    return linhas.map((l) => ({
      acao: l.action,
      tenantId: l.tenant_id,
      detalhe: l.detail,
      quando: l.created_at,
      adminNome: l.admin_nome,
    }));
  });
}
