import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { normalizePhone, InvalidPhoneError } from '@barbearia/core';
import { emailKey, hashPassword, verifyPassword } from './password.js';
import { limparFalhasDeLogin, reservarTentativaDeLogin } from './forca-bruta.js';
import { seedRolePermissions } from './team.js';

/**
 * Identidade de quem administra a barbearia.
 *
 * Diferente do cliente final em tudo que importa: e-mail e senha em vez de
 * código no WhatsApp, sessão longa em vez de curta, e um vínculo com o tenant
 * que precisa existir **antes** de qualquer consulta — a RLS não devolve linha
 * sem `app.tenant_id` fixado.
 *
 * Daí as duas peças incomuns deste arquivo: o índice `staff_directory`, que
 * resolve e-mail para tenant sem expor endereço, e o token de sessão que carrega
 * o tenant em claro no prefixo.
 */

export type StaffFailure =
  | 'invalid_credentials'
  | 'invalid_session'
  | 'slug_taken'
  | 'invalid_phone'
  | 'weak_password'
  // Gestão de equipe: quem chama já está autenticado, então aqui a recusa pode
  // (e deve) ser específica — não há oráculo de existência a proteger, e o dono
  // precisa saber por que não funcionou.
  | 'email_taken'
  | 'email_unavailable'
  | 'invalid_role'
  // Bloco 30: a tela manda a lista inteira do papel, e uma permissão fora do
  // catálogo é recusada aqui para virar mensagem em vez de violação de `CHECK`.
  | 'unknown_permission'
  // Bloco 30: ninguém concede o que não tem. Hoje inalcançável — só o dono tem
  // `team.manage` e o dono tem tudo —, e é justamente por `role_permissions`
  // ser editável que a recusa precisa existir antes de alguém precisar dela.
  | 'cannot_grant'
  | 'staff_not_found'
  | 'owner_protected'
  // Convite do barbeiro: a cadeira precisa existir nesta barbearia, e não pode
  // já ter dono.
  | 'professional_not_found'
  | 'professional_already_invited';

export class StaffError extends Error {
  constructor(readonly code: StaffFailure, message: string) {
    super(message);
    this.name = 'StaffError';
  }
}

/** Sessão de gestor dura o expediente, não o mês: é acesso a dinheiro e a base. */
const SESSION_DAYS = 14;
const MIN_PASSWORD = 10;

function pepper(): string {
  const value = process.env['STAFF_EMAIL_PEPPER'];
  if (!value) {
    throw new Error('STAFF_EMAIL_PEPPER é obrigatória — sem ela o índice de login fica em claro');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Token de sessão: `<tenantId>.<segredo>`.
 *
 * O tenant vai em claro de propósito. Resolver a sessão exige consultar
 * `staff_sessions`, que tem RLS — e fixar o tenant exige saber qual é antes de
 * ler qualquer linha. A alternativa seria um segundo índice entre tenants, mais
 * superfície para o mesmo resultado.
 *
 * Não enfraquece nada: o tenant já aparece na URL do admin, e quem autentica é
 * o segredo, que tem 256 bits e é guardado só como hash.
 */
function mintToken(tenantId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${tenantId}.${secret}`, hash: sha256(secret) };
}

function splitToken(token: string): { tenantId: string; hash: string } | null {
  const separador = token.indexOf('.');
  if (separador <= 0) return null;
  const tenantId = token.slice(0, separador);
  const secret = token.slice(separador + 1);
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || secret.length < 32) return null;
  return { tenantId, hash: sha256(secret) };
}

/**
 * Slug a partir do nome da barbearia.
 *
 * Permanente depois de publicado — o link na bio do Instagram não pode quebrar
 * (SPEC Parte 1 §1.5). Renomear adiciona em `tenant_slugs`, nunca substitui.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function freeSlug(tx: TransactionClient, base: string): Promise<string> {
  const raiz = base || 'barbearia';
  // Poucas tentativas com sufixo legível; depois disso, sufixo aleatório. Um
  // laço aberto sobre nomes muito comuns viraria varredura.
  for (let i = 0; i < 20; i += 1) {
    const candidato = i === 0 ? raiz : `${raiz}-${i + 1}`;
    const existe = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM tenant_slugs WHERE slug = ${candidato}
    `;
    if (existe.length === 0) return candidato;
  }
  return `${raiz}-${randomBytes(3).toString('hex')}`;
}

export interface SignUpRequest {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly phone: string;
  readonly businessName: string;
  readonly userAgent?: string;
  readonly ip?: string;
}

export interface StaffSession {
  readonly token: string;
  readonly expiresAt: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly staffUserId: string;
  readonly name: string;
  readonly role: string;
  /** Verdadeiro logo depois do primeiro acesso, até a pessoa escolher a dela. */
  readonly mustChangePassword?: boolean;
}

/**
 * Resultado do cadastro.
 *
 * `created: false` quando o e-mail já tem conta. **Não é erro** e o chamador não
 * deve tratá-lo como tal: responder diferente nos dois casos transformaria o
 * cadastro em oráculo de "este e-mail é dono de barbearia na plataforma" —
 * exatamente a lista que o HMAC em `staff_directory` existe para proteger.
 *
 * Quem já tem conta simplesmente entra com a senha que já tinha.
 */
export type SignUpResult =
  | { readonly created: true; readonly session: StaffSession }
  | { readonly created: false };

/**
 * Cria a conta e a barbearia, numa transação só.
 *
 * O tenant é gerado aqui e fixado em `app.tenant_id` antes do primeiro INSERT:
 * a política de `tenants` compara `id` com a configuração, então o próprio role
 * da aplicação cria o próprio tenant sem nenhum caminho privilegiado. Não existe
 * `BYPASSRLS` em lugar nenhum deste fluxo.
 *
 * A unidade nasce junto. Barbearia sem unidade não tem agenda, e deixar isso
 * para uma etapa seguinte criaria um estado em que o produto não funciona.
 */
export async function signUpOwner(request: SignUpRequest): Promise<SignUpResult> {
  if (request.password.length < MIN_PASSWORD) {
    throw new StaffError(
      'weak_password',
      `A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`,
    );
  }

  let phone: string;
  try {
    phone = normalizePhone(request.phone);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new StaffError('invalid_phone', 'Confira o celular: precisa ter DDD e nove dígitos.');
    }
    throw error;
  }

  const chave = emailKey(request.email, pepper());
  const tenantId = randomUUID();
  const { token, hash } = mintToken(tenantId);
  const senha = await hashPassword(request.password);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  return withTenant(tenantId, async (tx) => {
    // O índice é consultado antes de gravar qualquer coisa: e-mail já usado não
    // pode deixar meia barbearia criada para trás.
    const jaExiste = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM staff_directory WHERE email_key = ${chave}
    `;
    // O scrypt (~100 ms) já foi pago acima, **antes** deste desvio, e domina o
    // tempo dos dois caminhos. Derivar de novo aqui inverteria o oráculo em vez
    // de fechá-lo: o e-mail já cadastrado passaria a responder mais devagar.
    if (jaExiste.length > 0) return { created: false };

    const slug = await freeSlug(tx, slugify(request.businessName));

    await tx.$executeRaw`
      INSERT INTO tenants (id, name) VALUES (${tenantId}::uuid, ${request.businessName})
    `;
    await tx.$executeRaw`
      INSERT INTO tenant_slugs (slug, tenant_id, is_primary)
      VALUES (${slug}, ${tenantId}::uuid, true)
    `;
    await tx.$executeRaw`
      INSERT INTO locations (tenant_id, name) VALUES (${tenantId}::uuid, ${request.businessName})
    `;

    const criado = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO staff_users (tenant_id, name, email, phone_e164, password_hash, role)
      VALUES (${tenantId}::uuid, ${request.name}, ${request.email}, ${phone}, ${senha}, 'owner')
      RETURNING id
    `;
    const staffUserId = criado[0]?.id;
    if (!staffUserId) throw new Error('INSERT de staff_users não devolveu id');

    await tx.$executeRaw`
      INSERT INTO staff_directory (email_key, tenant_id, staff_user_id)
      VALUES (${chave}, ${tenantId}::uuid, ${staffUserId}::uuid)
    `;

    // Sem isto a barbearia nasce sem permissão nenhuma — inclusive o dono, que
    // não conseguiria nem abrir o próprio painel. O padrão nasce com o tenant.
    await seedRolePermissions(tx, tenantId);
    await tx.$executeRaw`
      INSERT INTO staff_sessions (tenant_id, staff_user_id, token_hash, user_agent, ip, expires_at)
      VALUES (${tenantId}::uuid, ${staffUserId}::uuid, ${hash},
              ${request.userAgent ?? null}, ${request.ip ?? null}::inet, ${expiresAt})
    `;

    return {
      created: true,
      session: {
        token,
        expiresAt: expiresAt.toISOString(),
        tenantId,
        slug,
        staffUserId,
        name: request.name,
        role: 'owner',
      },
    };
  });
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string;
  readonly ip?: string;
}

/**
 * Entra com e-mail e senha.
 *
 * Recusa sempre com o mesmo código e a mesma mensagem, exista ou não a conta:
 * distinguir transformaria o login em oráculo de "este e-mail é cliente da
 * plataforma" — a mesma regra que vale para o OTP do cliente.
 */
export async function staffLogin(request: LoginRequest): Promise<StaffSession> {
  const chave = emailKey(request.email, pepper());

  /**
   * A escada de espera vem **antes** de qualquer derivação de senha (bloco 33).
   *
   * A ordem é a proteção: derivar primeiro gastaria um scrypt de propósito em
   * cima de quem já está bloqueado, que é justamente o custo que um atacante
   * quer impor ao servidor. E ela vale para conta inexistente também — a
   * contagem é pela chave do e-mail, não pelo cadastro, senão o bloqueio
   * responderia mais rápido para e-mail que não existe e viraria o oráculo que
   * o resto desta função paga caro para fechar.
   *
   * A tentativa é **reservada** aqui, não contada no fim: o acerto a desfaz
   * logo abaixo. Contar só o erro exigiria ler agora e escrever depois, e essa
   * janela deixava mil requisições simultâneas passarem todas juntas.
   */
  await reservarTentativaDeLogin(chave, request.ip ?? null);

  const destino = await withTenant(
    // Consulta ao índice, que não tem escopo de tenant. O UUID nulo deixa a
    // política das outras tabelas negando tudo enquanto isto roda.
    '00000000-0000-0000-0000-000000000000',
    async (tx) => {
      const linhas = await tx.$queryRaw<{ tenant_id: string; staff_user_id: string }[]>`
        SELECT tenant_id, staff_user_id FROM staff_directory WHERE email_key = ${chave}
      `;
      return linhas[0] ?? null;
    },
  );

  if (!destino) {
    // Deriva mesmo assim para não responder mais rápido quando a conta não
    // existe: a diferença de tempo denunciaria quais e-mails têm cadastro.
    await hashPassword(request.password);
    throw new StaffError('invalid_credentials', 'E-mail ou senha incorretos.');
  }

  return withTenant(destino.tenant_id, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        role: string;
        password_hash: string;
        active: boolean;
        must_change_password: boolean;
      }[]
    >`
      SELECT id, name, role, password_hash, active, must_change_password
      FROM staff_users WHERE id = ${destino.staff_user_id}::uuid
    `;
    const usuario = linhas[0];
    if (!usuario) throw new StaffError('invalid_credentials', 'E-mail ou senha incorretos.');

    const conferido = await verifyPassword(request.password, usuario.password_hash);
    if (!conferido.valid || !usuario.active) {
      // A reserva feita lá em cima permanece: conta desativada avança a escada
      // como qualquer erro, de propósito — quem varre senha não deve descobrir,
      // pela ausência de castigo, que achou uma conta real.
      throw new StaffError('invalid_credentials', 'E-mail ou senha incorretos.');
    }

    // Acertou: a escada zera. Sem isto, cinco enganos espalhados por meses
    // colocariam na espera quem nunca foi atacado.
    await limparFalhasDeLogin(chave);

    // Custo do hash subiu desde o cadastro: regrava agora, que é a única hora em
    // que a senha em claro está disponível.
    if (conferido.needsRehash) {
      const novo = await hashPassword(request.password);
      await tx.$executeRaw`
        UPDATE staff_users SET password_hash = ${novo}, updated_at = now()
        WHERE id = ${usuario.id}::uuid
      `;
    }

    const slugs = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM tenant_slugs
      WHERE tenant_id = ${destino.tenant_id}::uuid
      ORDER BY is_primary DESC, created_at
      LIMIT 1
    `;

    const { token, hash } = mintToken(destino.tenant_id);
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

    await tx.$executeRaw`
      INSERT INTO staff_sessions (tenant_id, staff_user_id, token_hash, user_agent, ip, expires_at)
      VALUES (${destino.tenant_id}::uuid, ${usuario.id}::uuid, ${hash},
              ${request.userAgent ?? null}, ${request.ip ?? null}::inet, ${expiresAt})
    `;
    await tx.$executeRaw`
      UPDATE staff_users SET last_login_at = now() WHERE id = ${usuario.id}::uuid
    `;

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      tenantId: destino.tenant_id,
      slug: slugs[0]?.slug ?? '',
      staffUserId: usuario.id,
      name: usuario.name,
      role: usuario.role,
      // A tela precisa saber já no login para onde mandar a pessoa: sem isto,
      // quem entra com a senha de primeiro acesso bate em 403 na primeira porta
      // e parece que o sistema quebrou.
      mustChangePassword: usuario.must_change_password,
    };
  });
}

export interface AuthenticatedStaff {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly role: string;
  /**
   * O que esta sessão pode fazer, resolvido do papel na mesma consulta.
   *
   * Vem daqui e não de um mapa no código porque `role_permissions` é editável
   * pelo dono (SPEC Parte 1 §1.3): permissão é dado. E vem junto da sessão, e
   * não numa segunda ida ao banco, porque toda requisição autenticada precisa
   * dela — seria N+1 na guarda.
   */
  readonly permissions: readonly string[];
  /**
   * A barbearia exige segundo fator para as rotas de dinheiro (bloco 37).
   *
   * Vem da sessão e não de uma consulta na guarda pelo mesmo motivo das
   * permissões: seria uma segunda ida ao banco por requisição, para ler um
   * booleano.
   *
   * Nasce **falso**. Ligado por decisão vale mais que ligado por imposição: a
   * barbearia que encontrava "ative o segundo fator antes de acessar o
   * financeiro" no primeiro dia, com o cliente na cadeira e sem aplicativo
   * autenticador instalado, não ganhava segurança — passava a operar o balcão
   * com a conta do dono, que é o que o segundo fator existia para impedir.
   */
  readonly exigeSegundoFatorNoDinheiro: boolean;
  /** Enquanto verdadeiro, a sessão só serve para trocar a própria senha. */
  readonly mustChangePassword: boolean;
  /**
   * A agenda desta pessoa, quando ela também atende.
   *
   * É o que permite recortar o dia para quem **não** tem
   * `appointments.view_all_professionals`: sem isto a permissão existiria no
   * catálogo, seria negada ao barbeiro e não decidiria nada — e a tela de
   * equipe promete "a própria agenda" para esse papel.
   */
  readonly professionalId: string | null;
  /** O segundo fator está confirmado nesta conta. */
  readonly mfaEnabled: boolean;
  /**
   * Quando **esta sessão** provou o segundo fator, se provou.
   *
   * Vem junto da sessão pelo mesmo motivo das permissões: a guarda do dinheiro
   * roda em toda rota de caixa, e buscar isto à parte seria uma segunda ida ao
   * banco por requisição.
   */
  readonly mfaVerifiedAt: Date | null;
  /**
   * O Super Admin que abriu esta sessão, quando ela é de suporte (bloco 26).
   *
   * Nulo em sessão de gestor de verdade — que é o caso de todas, menos as
   * trinta minutos de uma investigação. Fica **na sessão** porque a sessão é o
   * que toda rota do painel já lê: uma consulta à parte seria uma que alguém
   * acabaria pulando.
   */
  readonly impersonatedBy: string | null;
}

export async function resolveStaffSession(token: string): Promise<AuthenticatedStaff> {
  const partes = splitToken(token);
  if (!partes) throw new StaffError('invalid_session', 'Sessão inválida');

  return withTenant(partes.tenantId, async (tx) => {
    // Uma consulta só, com as permissões agregadas: buscá-las depois seria uma
    // segunda ida ao banco em **toda** requisição autenticada do painel.
    const linhas = await tx.$queryRaw<
      {
        id: string;
        staff_user_id: string;
        token_hash: string;
        name: string;
        role: string;
        must_change_password: boolean;
        professional_id: string | null;
        permissions: string[];
        mfa_enabled: boolean;
        mfa_verified_at: Date | null;
        require_mfa_for_money: boolean;
        impersonated_by: string | null;
      }[]
    >`
      SELECT s.id, s.staff_user_id, s.token_hash, u.name, u.role, s.impersonated_by,
             u.must_change_password, u.professional_id,
             u.totp_confirmed_at IS NOT NULL AS mfa_enabled,
             s.mfa_verified_at,
             -- A decisão da barbearia vem junto da sessão (bloco 37). Numa
             -- consulta à parte ela seria uma segunda ida ao banco em **toda**
             -- requisição do painel, para ler um booleano.
             t.require_mfa_for_money,
             COALESCE(
               array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL),
               '{}'
             ) AS permissions
      FROM staff_sessions s
      JOIN staff_users u ON u.id = s.staff_user_id
      JOIN tenants t ON t.id = u.tenant_id
      LEFT JOIN role_permissions rp ON rp.role = u.role
      WHERE s.token_hash = ${partes.hash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.active
      GROUP BY s.id, s.staff_user_id, s.token_hash, u.name, u.role,
               u.must_change_password, u.professional_id,
               u.totp_confirmed_at, s.mfa_verified_at, s.impersonated_by,
               t.require_mfa_for_money
    `;
    const sessao = linhas[0];
    if (!sessao) throw new StaffError('invalid_session', 'Sessão inválida');

    // A busca já foi por igualdade de hash; a comparação constante existe para
    // que o caminho não dependa de otimização do banco.
    const esperado = Buffer.from(sessao.token_hash, 'hex');
    const recebido = Buffer.from(partes.hash, 'hex');
    if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) {
      throw new StaffError('invalid_session', 'Sessão inválida');
    }

    return {
      tenantId: partes.tenantId,
      staffUserId: sessao.staff_user_id,
      sessionId: sessao.id,
      name: sessao.name,
      role: sessao.role,
      permissions: sessao.permissions,
      mustChangePassword: sessao.must_change_password,
      professionalId: sessao.professional_id,
      mfaEnabled: sessao.mfa_enabled,
      mfaVerifiedAt: sessao.mfa_verified_at,
      exigeSegundoFatorNoDinheiro: sessao.require_mfa_for_money,
      impersonatedBy: sessao.impersonated_by,
    };
  });
}

export async function revokeStaffSession(tenantId: string, sessionId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE staff_sessions SET revoked_at = now()
      WHERE id = ${sessionId}::uuid AND revoked_at IS NULL
    `;
  });
}

/** Uma sessão aberta do gestor, do jeito que a tela dele mostra. */
export interface SessaoAberta {
  readonly id: string;
  /**
   * O aparelho, em palavras.
   *
   * Derivado do `user-agent` e não o `user-agent` cru: ninguém reconhece a
   * própria sessão numa linha de setenta caracteres com versões de motor de
   * renderização. "Celular Android" é o que a pessoa compara com o que tem na
   * mão.
   */
  readonly aparelho: string;
  readonly criadaEm: Date;
}

/**
 * O `user-agent` reduzido ao que a pessoa reconhece.
 *
 * Grosseiro de propósito. Identificar navegador com precisão exigiria uma
 * biblioteca e uma tabela que envelhece — e a pergunta aqui não é "qual versão
 * do Chrome?", é "este aparelho é meu?". Para isso, "Celular Android" resolve e
 * "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36…" não.
 */
export function aparelhoDoAgente(agente: string | null): string {
  if (!agente) return 'Aparelho desconhecido';
  const texto = agente.toLowerCase();

  // A ordem importa: todo iPad diz "safari", e quase todo Android diz "linux".
  if (texto.includes('iphone')) return 'iPhone';
  if (texto.includes('ipad')) return 'iPad';
  if (texto.includes('android')) return 'Celular Android';
  if (texto.includes('windows')) return 'Computador Windows';
  if (texto.includes('macintosh') || texto.includes('mac os')) return 'Mac';
  if (texto.includes('linux')) return 'Computador Linux';
  return 'Aparelho desconhecido';
}

/**
 * As sessões vivas desta pessoa.
 *
 * Só as dela: a tela responde "onde eu estou logado", e listar as dos colegas
 * seria dar a quem administra a casa um mapa de quando cada funcionário abre o
 * sistema — vigilância que ninguém pediu e que a permissão não cobre.
 */
/**
 * Sem "último uso", e é decisão de custo.
 *
 * `customer_sessions` tem a coluna desde o bloco 5; `staff_sessions` não, e
 * acrescentá-la significaria um `UPDATE` por requisição autenticada — no
 * caminho mais quente do painel, para responder uma pergunta que "entrou em
 * 12/08 num Celular Android" já responde bem o bastante.
 *
 * O que a tela precisa é que a pessoa reconheça a sessão, e ela reconhece pelo
 * aparelho e pela data de entrada.
 */
export async function sessoesDoGestor(
  tenantId: string,
  staffUserId: string,
  agora: Date = new Date(),
): Promise<readonly SessaoAberta[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; user_agent: string | null; created_at: Date }[]
    >`
      SELECT id, user_agent, created_at
        FROM staff_sessions
       WHERE staff_user_id = ${staffUserId}::uuid
         AND revoked_at IS NULL
         AND expires_at > ${agora}
       ORDER BY created_at DESC
       LIMIT 50
    `;

    return linhas.map((l) => ({
      id: l.id,
      aparelho: aparelhoDoAgente(l.user_agent),
      criadaEm: l.created_at,
    }));
  });
}

/**
 * Encerra uma sessão **desta** pessoa.
 *
 * O `staff_user_id` no `WHERE` não é redundância com a RLS: a política separa
 * barbearias, não separa pessoas dentro de uma. Sem ele, o id de uma sessão da
 * colega — que é UUID e portanto não se adivinha, mas aparece em log e em
 * suporte — derrubaria a sessão dela.
 */
export async function revogarSessaoDoGestor(
  tenantId: string,
  staffUserId: string,
  sessionId: string,
): Promise<number> {
  return withTenant(tenantId, async (tx) =>
    tx.$executeRaw`
      UPDATE staff_sessions SET revoked_at = now()
       WHERE id = ${sessionId}::uuid
         AND staff_user_id = ${staffUserId}::uuid
         AND revoked_at IS NULL
    `,
  );
}
