import { randomInt } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  ehPermissao,
  InvalidPhoneError,
  maskPhone,
  normalizePhone,
  PAPEIS,
  permissoesPadrao,
  type Papel,
  type Permissao,
} from '@barbearia/core';
import { audit } from './audit.js';
import type { MessagingProvider } from './messaging.js';
import { emailKey, hashPassword, verifyPassword } from './password.js';
import { StaffError } from './staff.js';

/**
 * Contas de equipe.
 *
 * Até aqui só existia a conta do dono, e quem operava o balcão usava ela — o
 * que entrega junto o faturamento, o catálogo e a base de clientes. A SPEC
 * (Parte 1 §1.2) descreve quatro perfis; este arquivo é por onde os outros três
 * passam a existir.
 *
 * Toda operação daqui é auditada **na mesma transação** que muda o estado:
 * alteração de permissão é evento de registro obrigatório (SPEC §1.7), e
 * registrar depois cria a janela em que a mudança existe e o registro não.
 */

const UNIQUE_VIOLATION = '23505';

/** SQLSTATE do Postgres por trás do erro do Prisma (mesmo padrão de `booking.ts`). */
function pgUniqueViolation(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code === UNIQUE_VIOLATION;
  const message = error instanceof Error ? error.message : '';
  return /Code: `23505`/.test(message);
}

function pepper(): string {
  const value = process.env['STAFF_EMAIL_PEPPER'];
  if (!value) {
    throw new Error('STAFF_EMAIL_PEPPER é obrigatória — sem ela o índice de login fica em claro');
  }
  return value;
}

/**
 * Alfabeto sem `0`, `O`, `1`, `l` e `I`.
 *
 * A senha vai ser lida em voz alta ou copiada de um papel, com o barbeiro do
 * lado. Zero e letra O na mesma cadeia é chamado de suporte garantido.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TAMANHO_SENHA = 14;

/** Mesmo piso do cadastro do dono. */
const MIN_PASSWORD = 10;

/** O que aconteceu com a entrega da senha. A tela precisa saber qual dizer. */
export type EntregaDaSenha = 'enviada' | 'sem_telefone' | 'falhou';

/**
 * Entrega a senha de primeiro acesso por mensagem — lacuna aberta no bloco 13.
 *
 * Três decisões, todas contra o instinto de reaproveitar o resto do bloco 20:
 *
 * 1. **Não entra na fila.** `jobs.payload` é durável e a tabela não tem RLS, de
 *    propósito — enfileirar a senha em claro a deixaria legível para qualquer
 *    consulta à fila, por tempo indeterminado. Sai inline, como o OTP.
 * 2. **Depois do commit, e falhar aqui não desfaz a conta.** O provedor fora do
 *    ar não pode impedir a contratação; a senha continua voltando na resposta,
 *    que é o caminho que funcionava antes e segue sendo o de emergência.
 * 3. **O registro guarda que saiu, nunca o que saiu.** `notifications` fica com
 *    tipo, destinatário e telefone mascarado. É o que responde "mandaram minha
 *    senha?" sem se tornar mais um lugar de onde ela vaza.
 */
async function entregarSenha(params: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly senha: string;
  readonly messaging: MessagingProvider;
}): Promise<EntregaDaSenha> {
  const dados = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { name: string; phone_e164: string | null; tenant_name: string }[]
    >`
      SELECT s.name, s.phone_e164, t.name AS tenant_name
        FROM staff_users s
        JOIN tenants t ON t.id = s.tenant_id
       WHERE s.id = ${params.staffUserId}::uuid
    `;
    return linhas[0] ?? null;
  });

  if (!dados?.phone_e164) return 'sem_telefone';

  try {
    await params.messaging.sendStaffPassword({
      phoneE164: dados.phone_e164,
      name: dados.name,
      establishmentName: dados.tenant_name,
      password: params.senha,
    });
  } catch {
    // O detalhe do erro é do provedor e não acrescenta nada aqui: o que o dono
    // precisa saber é que a mensagem não saiu e a senha está na tela.
    await registrarEnvioDaSenha(params.tenantId, params.staffUserId, null, 'falhou');
    return 'falhou';
  }

  await registrarEnvioDaSenha(
    params.tenantId,
    params.staffUserId,
    maskPhone(dados.phone_e164),
    'sent',
  );
  return 'enviada';
}

async function registrarEnvioDaSenha(
  tenantId: string,
  staffUserId: string,
  telefoneMascarado: string | null,
  status: 'sent' | 'falhou',
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO notifications (tenant_id, kind, staff_user_id, status, reason, phone_masked)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        'senha_de_acesso', ${staffUserId}::uuid,
        ${status === 'sent' ? 'sent' : 'failed'}::notification_status,
        ${status === 'sent' ? null : 'provedor_indisponivel'},
        ${telefoneMascarado}
      )
    `;
  });
}

/**
 * Senha de primeiro acesso, gerada e não escolhida.
 *
 * Quem cria a conta é o dono, com a pessoa do lado. Deixá-lo escolher produz a
 * mesma senha para a equipe inteira — e ele não é quem vai usá-la. `randomInt`
 * do `node:crypto`, não `Math.random()`: senha previsível é senha vazada.
 *
 * Aparece uma vez na tela e nunca mais: o que fica no banco é o scrypt.
 */
export function gerarSenhaInicial(): string {
  let senha = '';
  for (let i = 0; i < TAMANHO_SENHA; i += 1) {
    senha += ALFABETO[randomInt(ALFABETO.length)];
  }
  return senha;
}

export interface StaffMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Papel;
  readonly active: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
  readonly professionalId: string | null;
}

export async function listStaff(tenantId: string): Promise<readonly StaffMember[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        email: string;
        role: Papel;
        active: boolean;
        must_change_password: boolean;
        last_login_at: Date | null;
        professional_id: string | null;
      }[]
    >`
      SELECT id, name, email, role, active, must_change_password,
             last_login_at, professional_id
      FROM staff_users
      ORDER BY active DESC, name
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      name: linha.name,
      email: linha.email,
      role: linha.role,
      active: linha.active,
      mustChangePassword: linha.must_change_password,
      lastLoginAt: linha.last_login_at?.toISOString() ?? null,
      professionalId: linha.professional_id,
    }));
  });
}

export interface CreateStaffRequest {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly name: string };
  readonly name: string;
  readonly email: string;
  readonly role: Papel;
  readonly phone?: string;
  readonly professionalId?: string;
  readonly messaging: MessagingProvider;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Cria a conta de alguém da equipe.
 *
 * Devolve a senha de primeiro acesso **uma vez**, e agora também a manda por
 * mensagem quando a pessoa tem celular cadastrado. As duas coisas, não uma: o
 * provedor pode estar fora do ar, e o dono precisa poder ler em voz alta para
 * quem está do lado dele. `must_change_password` garante que ela não sobreviva
 * ao primeiro uso.
 *
 * O e-mail é conferido no índice entre tenants **antes** de gravar: a mesma
 * pessoa não pode ter conta em duas barbearias com o mesmo endereço, porque o
 * login resolve e-mail para tenant e ficaria ambíguo. Recusa explícita aqui,
 * diferente do cadastro público — quem está criando já está autenticado, não há
 * oráculo a proteger, e o dono precisa saber por que não funcionou.
 */
export async function createStaffUser(request: CreateStaffRequest): Promise<{
  readonly member: StaffMember;
  readonly senhaInicial: string;
  readonly entrega: EntregaDaSenha;
}> {
  if (!PAPEIS.includes(request.role)) {
    throw new StaffError('invalid_role', 'Papel desconhecido');
  }
  // O dono é criado no cadastro da barbearia e é único: promover alguém a dono
  // é transferência de titularidade, não gestão de equipe.
  if (request.role === 'owner') {
    throw new StaffError('owner_protected', 'Não dá para criar um segundo dono.');
  }

  let phone: string | null = null;
  if (request.phone) {
    try {
      phone = normalizePhone(request.phone);
    } catch (error) {
      if (error instanceof InvalidPhoneError) {
        throw new StaffError('invalid_phone', 'Confira o celular: precisa ter DDD e nove dígitos.');
      }
      throw error;
    }
  }

  const chave = emailKey(request.email, pepper());
  const senhaInicial = gerarSenhaInicial();
  const hash = await hashPassword(senhaInicial);

  const criacao = await withTenant(request.tenantId, async (tx) => {
    /**
     * A conferência é **desta barbearia**, não da plataforma.
     *
     * `staff_directory` tem política `USING (true)` de propósito — o login
     * resolve e-mail para tenant antes de existir tenant no contexto. Consultar
     * sem filtro aqui devolvia "já existe" para conta de qualquer barbearia, e
     * isso é o oráculo que o cadastro público paga caro para fechar: ele
     * responde 202 igual para e-mail livre e ocupado, e o login ainda queima um
     * scrypt no caminho da conta inexistente só para não vazar pelo tempo.
     *
     * Bastava criar uma barbearia grátis e mandar uma lista de endereços aqui
     * para reconstruir quem é cliente da plataforma — a lista que o HMAC em
     * `staff_directory` existe para proteger.
     */
    const jaExiste = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM staff_directory
      WHERE email_key = ${chave}
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;
    if (jaExiste.length > 0) {
      throw new StaffError('email_taken', 'Este e-mail já tem conta nesta barbearia.');
    }

    const criado = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO staff_users
        (tenant_id, name, email, phone_e164, password_hash, role,
         professional_id, must_change_password, created_by)
      VALUES (
        ${request.tenantId}::uuid, ${request.name}, ${request.email}, ${phone},
        ${hash}, ${request.role}::staff_role,
        ${request.professionalId ?? null}::uuid, true, ${request.actor.id}::uuid
      )
      RETURNING id
    `;
    const id = criado[0]?.id;
    if (!id) throw new Error('INSERT de staff_users não devolveu id');

    try {
      await tx.$executeRaw`
        INSERT INTO staff_directory (email_key, tenant_id, staff_user_id)
        VALUES (${chave}, ${request.tenantId}::uuid, ${id}::uuid)
      `;
    } catch (error) {
      // Colisão com outra barbearia: `email_key` é chave primária do índice
      // entre tenants. A recusa é genérica de propósito — dizer "já existe"
      // confirmaria que o endereço é de alguém na plataforma, que é justamente
      // o que a consulta acima deixou de perguntar.
      if (pgUniqueViolation(error)) {
        throw new StaffError(
          'email_unavailable',
          'Não foi possível criar a conta com este e-mail. Use outro.',
        );
      }
      throw error;
    }

    await audit(tx, {
      actorId: request.actor.id,
      actorName: request.actor.name,
      action: 'staff.created',
      entity: 'staff_users',
      entityId: id,
      // Sem a senha e sem o hash: a trilha registra o que houve, não a
      // credencial de ninguém.
      after: { name: request.name, email: request.email, role: request.role },
      ip: request.ip,
      userAgent: request.userAgent,
    });

    return {
      member: {
        id,
        name: request.name,
        email: request.email,
        role: request.role,
        active: true,
        mustChangePassword: true,
        lastLoginAt: null,
        professionalId: request.professionalId ?? null,
      },
      senhaInicial,
    };
  });

  // Fora da transação: o envio é rede, e rede dentro de transação segura
  // conexão e cadeado enquanto o provedor pensa.
  const entrega = await entregarSenha({
    tenantId: request.tenantId,
    staffUserId: criacao.member.id,
    senha: senhaInicial,
    messaging: request.messaging,
  });

  return { ...criacao, entrega };
}

/**
 * O convite do barbeiro — lacuna aberta no bloco 12.
 *
 * `staff_users.professional_id` existia desde lá, com chave estrangeira e com o
 * recorte da agenda por profissional já implementado. Nada preenchia a coluna:
 * o profissional nascia no onboarding como **cadeira**, não como pessoa que
 * entra no sistema. Na prática o barbeiro usava a conta do dono — o incidente
 * exato que o bloco 12 existia para impedir.
 *
 * Três decisões:
 *
 * 1. **O papel é sempre `professional`.** Convidar não é escolher permissão: a
 *    tela de equipe faz isso, com `team.manage`. Deixar o papel entrar por aqui
 *    transformaria "convidar o Ruan" numa forma silenciosa de criar um gerente.
 * 2. **O telefone fica na cadeira, não só na conta.** Reenviar o convite depois
 *    não pode obrigar o dono a digitar o número de novo — e é `professionals`
 *    que ele edita no cadastro.
 * 3. **A cadeira é conferida sob RLS antes de gravar.** A chave estrangeira não
 *    protege: a checagem de integridade referencial do Postgres ignora row
 *    security, e sozinha aceitaria a cadeira de outra barbearia.
 */
export async function convidarProfissional(request: {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly name: string };
  readonly professionalId: string;
  readonly email: string;
  readonly phone?: string;
  readonly messaging: MessagingProvider;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}): Promise<{
  readonly member: StaffMember;
  readonly senhaInicial: string;
  readonly entrega: EntregaDaSenha;
}> {
  const cadeira = await withTenant(request.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { name: string; kind: string; phone_e164: string | null; convidado: string | null }[]
    >`
      SELECT p.name, p.kind::text AS kind, p.phone_e164,
             (SELECT s.id::text FROM staff_users s WHERE s.professional_id = p.id) AS convidado
        FROM professionals p WHERE p.id = ${request.professionalId}::uuid
    `;
    return linhas[0] ?? null;
  });

  if (!cadeira) {
    throw new StaffError('professional_not_found', 'Profissional não encontrado.');
  }
  if (cadeira.convidado) {
    // Uma cadeira, uma conta — o índice único do banco garante, mas a recusa
    // aqui diz *por quê*, em vez de devolver erro de banco ao dono.
    throw new StaffError(
      'professional_already_invited',
      'Este profissional já tem conta. Use "reemitir a senha" se ele perdeu o acesso.',
    );
  }
  /**
   * Agenda que não é gente não recebe convite.
   *
   * `kind` distingue a pessoa da cadeira compartilhada — foi o defeito D12 do
   * sistema analisado, em que duas das quatro "agendas" eram contas de balcão
   * com jornada 08:00–23:00. Mandar senha de acesso para "Cadeira 2" cria uma
   * conta que ninguém usa e que ninguém desliga.
   */
  if (cadeira.kind !== 'professional') {
    throw new StaffError(
      'professional_not_found',
      'Só profissional recebe convite; agenda de recurso não é pessoa.',
    );
  }

  const telefone = request.phone ?? cadeira.phone_e164 ?? undefined;

  const criado = await createStaffUser({
    tenantId: request.tenantId,
    actor: request.actor,
    name: cadeira.name,
    email: request.email,
    role: 'professional',
    professionalId: request.professionalId,
    messaging: request.messaging,
    ...(telefone ? { phone: telefone } : {}),
    ...(request.ip !== undefined ? { ip: request.ip } : {}),
    ...(request.userAgent !== undefined ? { userAgent: request.userAgent } : {}),
  });

  // O número fica na cadeira para o próximo reenvio. Depois da conta criada, de
  // propósito: se a criação falhar, o cadastro não guarda um telefone que
  // ninguém usou.
  if (telefone) {
    await withTenant(request.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE professionals SET phone_e164 = ${normalizePhone(telefone)}, updated_at = now()
         WHERE id = ${request.professionalId}::uuid
      `;
    });
  }

  return criado;
}

async function carregar(
  tx: TransactionClient,
  staffUserId: string,
): Promise<{ id: string; name: string; role: Papel; active: boolean } | null> {
  const linhas = await tx.$queryRaw<
    { id: string; name: string; role: Papel; active: boolean }[]
  >`
    SELECT id, name, role, active FROM staff_users WHERE id = ${staffUserId}::uuid
  `;
  return linhas[0] ?? null;
}

/**
 * Troca o papel de alguém.
 *
 * O dono não pode ser rebaixado nem por ele mesmo: seria a única conta com
 * `team.manage` se trancando para fora da própria barbearia, sem caminho de
 * volta pela aplicação.
 */
export async function changeStaffRole(request: {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly name: string };
  readonly staffUserId: string;
  readonly role: Papel;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}): Promise<void> {
  if (request.role === 'owner') {
    throw new StaffError('owner_protected', 'Não dá para promover alguém a dono.');
  }

  await withTenant(request.tenantId, async (tx) => {
    const atual = await carregar(tx, request.staffUserId);
    if (!atual) throw new StaffError('staff_not_found', 'Conta não encontrada.');
    if (atual.role === 'owner') {
      throw new StaffError('owner_protected', 'O dono não muda de papel.');
    }

    await tx.$executeRaw`
      UPDATE staff_users SET role = ${request.role}::staff_role, updated_at = now()
      WHERE id = ${request.staffUserId}::uuid
    `;

    // Alteração de permissão é evento de registro obrigatório (SPEC §1.7).
    await audit(tx, {
      actorId: request.actor.id,
      actorName: request.actor.name,
      action: 'staff.role_changed',
      entity: 'staff_users',
      entityId: request.staffUserId,
      before: { role: atual.role },
      after: { role: request.role },
      ip: request.ip,
      userAgent: request.userAgent,
    });
  });
}

/**
 * Desliga (ou religa) uma conta.
 *
 * Desligar **revoga as sessões abertas na mesma transação**. Sem isso, quem
 * acabou de ser demitido continua com o balcão aberto no navegador até o token
 * expirar — que é justamente a hora em que ele não deveria mais estar lá.
 */
export async function setStaffActive(request: {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly name: string };
  readonly staffUserId: string;
  readonly active: boolean;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}): Promise<void> {
  await withTenant(request.tenantId, async (tx) => {
    const atual = await carregar(tx, request.staffUserId);
    if (!atual) throw new StaffError('staff_not_found', 'Conta não encontrada.');
    if (atual.role === 'owner') {
      throw new StaffError('owner_protected', 'A conta do dono não se desliga.');
    }

    await tx.$executeRaw`
      UPDATE staff_users SET active = ${request.active}, updated_at = now()
      WHERE id = ${request.staffUserId}::uuid
    `;

    if (!request.active) {
      await tx.$executeRaw`
        UPDATE staff_sessions SET revoked_at = now()
        WHERE staff_user_id = ${request.staffUserId}::uuid AND revoked_at IS NULL
      `;
    }

    await audit(tx, {
      actorId: request.actor.id,
      actorName: request.actor.name,
      action: request.active ? 'staff.reactivated' : 'staff.deactivated',
      entity: 'staff_users',
      entityId: request.staffUserId,
      before: { active: atual.active },
      after: { active: request.active },
      ip: request.ip,
      userAgent: request.userAgent,
    });
  });
}

/**
 * Gera nova senha de primeiro acesso para quem esqueceu a dele.
 *
 * Vai pelo mesmo caminho da criação: mensagem quando há celular, e a senha na
 * resposta de qualquer jeito. Revoga as sessões abertas — senha trocada com
 * sessão viva não tira ninguém de lugar nenhum.
 */
export async function resetStaffPassword(request: {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly name: string };
  readonly staffUserId: string;
  readonly messaging: MessagingProvider;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}): Promise<{ readonly senhaInicial: string; readonly entrega: EntregaDaSenha }> {
  const senhaInicial = gerarSenhaInicial();
  const hash = await hashPassword(senhaInicial);

  await withTenant(request.tenantId, async (tx) => {
    const atual = await carregar(tx, request.staffUserId);
    if (!atual) throw new StaffError('staff_not_found', 'Conta não encontrada.');
    // Mesma proteção de `changeStaffRole` e `setStaffActive`, que faltava aqui.
    // Hoje só o dono tem `team.manage` e isto é inalcançável — mas a premissa
    // do bloco é que `role_permissions` é editável, e no dia em que um gerente
    // receber `team.manage` esta rota vira tomada de conta numa requisição:
    // ela devolve a senha nova em claro e derruba as sessões do dono junto.
    if (atual.role === 'owner') {
      throw new StaffError('owner_protected', 'A senha do dono não se reemite por aqui.');
    }

    await tx.$executeRaw`
      UPDATE staff_users
      SET password_hash = ${hash}, must_change_password = true, updated_at = now()
      WHERE id = ${request.staffUserId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE staff_sessions SET revoked_at = now()
      WHERE staff_user_id = ${request.staffUserId}::uuid AND revoked_at IS NULL
    `;

    await audit(tx, {
      actorId: request.actor.id,
      actorName: request.actor.name,
      action: 'staff.password_reset',
      entity: 'staff_users',
      entityId: request.staffUserId,
      ip: request.ip,
      userAgent: request.userAgent,
    });
  });

  const entrega = await entregarSenha({
    tenantId: request.tenantId,
    staffUserId: request.staffUserId,
    senha: senhaInicial,
    messaging: request.messaging,
  });

  return { senhaInicial, entrega };
}

// -- Permissões ---------------------------------------------------------------

/**
 * Semeia o padrão de fábrica de uma barbearia nova.
 *
 * Roda dentro da transação do cadastro. Uma barbearia sem linhas em
 * `role_permissions` é uma barbearia em que nem o dono consegue fazer nada — o
 * padrão precisa nascer junto com o tenant, não depois.
 */
export async function seedRolePermissions(
  tx: TransactionClient,
  tenantId: string,
): Promise<void> {
  for (const papel of PAPEIS) {
    for (const permissao of permissoesPadrao(papel)) {
      await tx.$executeRaw`
        INSERT INTO role_permissions (tenant_id, role, permission)
        VALUES (${tenantId}::uuid, ${papel}::staff_role, ${permissao})
        ON CONFLICT DO NOTHING
      `;
    }
  }
}

/** O que cada papel pode, nesta barbearia. */
export async function permissionsByRole(
  tenantId: string,
): Promise<Readonly<Record<string, readonly Permissao[]>>> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ role: Papel; permission: string }[]>`
      SELECT role, permission FROM role_permissions ORDER BY role, permission
    `;

    const mapa: Record<string, Permissao[]> = {};
    for (const papel of PAPEIS) mapa[papel] = [];
    for (const linha of linhas) {
      if (ehPermissao(linha.permission)) (mapa[linha.role] ??= []).push(linha.permission);
    }
    return mapa;
  });
}

/**
 * Redefine o conjunto de permissões de um papel (bloco 30).
 *
 * A SPEC §1.3 pede isto desde o começo — "papel é conjunto nomeado de
 * permissões, editável pelo proprietário" — e `role_permissions` foi desenhada
 * por barbearia no bloco 16 justamente para que hoje bastasse a tela. Bastou.
 *
 * ## As três recusas, e por que cada uma existe
 *
 * 1. **O papel `owner` não se edita.** É a única conta que não pode ser
 *    trancada para fora do próprio negócio. Sem esta recusa, um clique tira
 *    `team.manage` do dono e a barbearia fica sem ninguém capaz de devolvê-la —
 *    um estado que só sai com acesso ao banco de produção.
 *
 * 2. **Permissão fora do catálogo é recusada aqui e no banco.** O `CHECK` de
 *    `role_permissions` é a garantia; esta é a que transforma o erro em
 *    mensagem em vez de violação de constraint na tela.
 *
 * 3. **Só quem tem `team.manage`**, o que hoje é o dono — e a guarda da rota
 *    cobra isso. Aqui a função assume que a autorização já passou, como todo o
 *    resto deste arquivo.
 *
 * 4. **Ninguém concede o que não tem.** Hoje é inalcançável: só o dono tem
 *    `team.manage`, e o dono já tem tudo. Mas a premissa deste bloco é que
 *    `role_permissions` é editável — no dia em que o dono delegar `team.manage`
 *    a um gerente, esse gerente se concederia `finance.view_profit` e
 *    `customers.export` num clique, e a rota que existe para dividir poder
 *    viraria a que o concentra.
 *
 *    É o mesmo raciocínio que já protege `resetStaffPassword`,
 *    `changeStaffRole` e `setStaffActive` desde o bloco 21 — e que faltava
 *    justamente na mais poderosa das quatro. A `/security-review` do bloco 30
 *    apontou, julgou não explorável hoje, e estava certa sobre hoje.
 *
 *    O que o ator pode sai do **banco**, não do parâmetro: a sessão já carrega
 *    a lista, mas confiar nela aqui faria a garantia depender de todo chamador
 *    futuro passar a lista certa.
 *
 * ## Substitui o conjunto, e é decisão
 *
 * A tela manda a lista inteira do papel, não um diff. Diff exigiria que cliente
 * e servidor concordassem sobre o estado anterior, e duas abas abertas
 * produziriam uma concessão que ninguém pediu. Substituir é idempotente: mandar
 * duas vezes a mesma lista dá o mesmo resultado.
 */
export async function definirPermissoesDoPapel(request: {
  readonly tenantId: string;
  readonly papel: Papel;
  readonly permissoes: readonly string[];
  readonly actor: { readonly id: string; readonly name: string };
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}): Promise<readonly Permissao[]> {
  if (request.papel === 'owner') {
    throw new StaffError(
      'owner_protected',
      'O dono tem todas as permissões por definição, e isso não se edita.',
    );
  }
  if (!PAPEIS.includes(request.papel)) {
    throw new StaffError('invalid_role', 'Papel desconhecido.');
  }

  const desconhecida = request.permissoes.find((p) => !ehPermissao(p));
  if (desconhecida !== undefined) {
    throw new StaffError('unknown_permission', `Permissão desconhecida: ${desconhecida}`);
  }

  // Sem duplicata: a chave primária recusaria, e a mensagem não diria nada útil.
  const novas = [...new Set(request.permissoes)].filter(ehPermissao).sort();

  return withTenant(request.tenantId, async (tx) => {
    const doAtor = await tx.$queryRaw<{ permission: string }[]>`
      SELECT rp.permission
        FROM staff_users u
        JOIN role_permissions rp ON rp.role = u.role
       WHERE u.id = ${request.actor.id}::uuid AND u.active
    `;
    const tem = new Set(doAtor.map((l) => l.permission));
    const excedente = novas.find((p) => !tem.has(p));
    if (excedente !== undefined) {
      throw new StaffError(
        'cannot_grant',
        `Você não tem "${excedente}", então não pode conceder essa permissão.`,
      );
    }

    const antes = await tx.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM role_permissions
       WHERE role = ${request.papel}::staff_role
       ORDER BY permission
    `;

    await tx.$executeRaw`
      DELETE FROM role_permissions WHERE role = ${request.papel}::staff_role
    `;
    for (const permissao of novas) {
      await tx.$executeRaw`
        INSERT INTO role_permissions (tenant_id, role, permission)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${request.papel}::staff_role,
          ${permissao}
        )
      `;
    }

    /**
     * Auditado com antes e depois, dentro da mesma transação.
     *
     * A SPEC §1.2 lista alteração de permissão entre os eventos de auditoria
     * obrigatória, e é a que mais precisa: "quem deu acesso ao caixa para essa
     * pessoa?" é a primeira pergunta depois de um incidente, e a resposta não
     * pode ser o estado atual da tabela — ele já mudou.
     */
    await audit(tx, {
      actorId: request.actor.id,
      actorName: request.actor.name,
      // O vocabulário já existia desde o bloco 16, esperando por esta tela.
      action: 'permissions.changed',
      entity: 'role_permissions',
      // Sem `entityId`: a coluna é uuid e o papel é um enum. O papel entra no
      // detalhe, que é onde ele responde "de quem foi a mudança".
      before: { papel: request.papel, permissoes: antes.map((l) => l.permission) },
      after: { papel: request.papel, permissoes: novas },
      ...(request.ip === undefined ? {} : { ip: request.ip }),
      ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
    });

    return novas;
  });
}

/**
 * Troca a própria senha.
 *
 * É o que destranca uma conta recém-criada: enquanto `must_change_password`
 * for verdadeiro, a guarda deixa passar só esta rota. A senha atual é exigida
 * mesmo assim — quem chegou ao navegador aberto de outra pessoa não deve poder
 * trocar a senha dela e ficar com a conta.
 *
 * As outras sessões da pessoa são revogadas, e a atual não: trocar senha por
 * suspeita de acesso indevido só serve se derrubar quem está do outro lado, e
 * derrubar a si mesmo obrigaria a entrar de novo sem motivo.
 */
export async function changeOwnPassword(request: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<void> {
  if (request.newPassword.length < MIN_PASSWORD) {
    throw new StaffError(
      'weak_password',
      `A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`,
    );
  }
  if (request.newPassword === request.currentPassword) {
    throw new StaffError('weak_password', 'A nova senha precisa ser diferente da atual.');
  }

  const novo = await hashPassword(request.newPassword);

  await withTenant(request.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ password_hash: string }[]>`
      SELECT password_hash FROM staff_users WHERE id = ${request.staffUserId}::uuid
    `;
    const atual = linhas[0];
    if (!atual) throw new StaffError('staff_not_found', 'Conta não encontrada.');

    const conferido = await verifyPassword(request.currentPassword, atual.password_hash);
    if (!conferido.valid) {
      throw new StaffError('invalid_credentials', 'A senha atual não confere.');
    }

    await tx.$executeRaw`
      UPDATE staff_users
      SET password_hash = ${novo}, must_change_password = false, updated_at = now()
      WHERE id = ${request.staffUserId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE staff_sessions SET revoked_at = now()
      WHERE staff_user_id = ${request.staffUserId}::uuid
        AND id <> ${request.sessionId}::uuid
        AND revoked_at IS NULL
    `;
  });
}
