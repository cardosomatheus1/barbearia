import { semTenant } from '@barbearia/db';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * A assinatura da barbearia (bloco 27, SPEC §9).
 *
 * ## O que este arquivo decide e o que ele deixa para o banco
 *
 * O teto de cadeiras **não** está aqui, e é decisão. Cadeira nasce em três
 * caminhos — onboarding, cadastro do admin e religar quem estava desligado — e
 * uma regra escrita num caso de uso é uma regra que os outros dois furam. Ela é
 * gatilho na migração 0029, como a constraint anti-overbooking: garantia que o
 * produto inteiro herda sem ninguém pedir.
 *
 * O que está aqui é o que depende de decisão humana: mudar de plano, cancelar,
 * e responder em que pé a conta está.
 */

export type EstadoDaAssinatura = 'trialing' | 'active' | 'past_due' | 'canceled';

export interface Assinatura {
  readonly tenantId: string;
  readonly planoCode: string;
  readonly planoNome: string;
  readonly publico: string;
  readonly estado: EstadoDaAssinatura;
  /** Centavos contratados, congelados — não o preço de tabela de hoje. */
  readonly precoCents: number;
  readonly tetoDeCadeiras: number | null;
  readonly cadeirasEmUso: number;
  readonly testeAte: Date | null;
  readonly periodoAte: Date;
  readonly canceladaEm: Date | null;
}

interface LinhaDeAssinatura {
  tenant_id: string;
  plan_code: string;
  plan_name: string;
  audience: string;
  status: EstadoDaAssinatura;
  price_cents: number;
  max_chairs: number | null;
  cadeiras: number;
  trial_ends_at: Date | null;
  period_end: Date;
  canceled_at: Date | null;
}

const paraAssinatura = (l: LinhaDeAssinatura): Assinatura => ({
  tenantId: l.tenant_id,
  planoCode: l.plan_code,
  planoNome: l.plan_name,
  publico: l.audience,
  estado: l.status,
  precoCents: l.price_cents,
  tetoDeCadeiras: l.max_chairs,
  cadeirasEmUso: Number(l.cadeiras),
  testeAte: l.trial_ends_at,
  periodoAte: l.period_end,
  canceladaEm: l.canceled_at,
});

/**
 * A contagem de cadeiras vem de `subscriptions.chairs_in_use`, não de um
 * `count(*)` daqui.
 *
 * A primeira versão contava `professionals` numa subconsulta e devolvia zero
 * sempre: a tabela tem RLS e esta função roda sem tenant. Não dava erro — dava
 * "0 de 5 cadeiras" para uma barbearia lotada, que é o pior formato de defeito.
 * Quem mantém o número é o gatilho da migração 0029, na mesma transação que
 * mexe na cadeira.
 *
 * As duas consultas repetem as colunas, e a repetição é preferível.
 *
 * A alternativa era uma string base concatenada com o `WHERE`, montada por
 * `$queryRawUnsafe`. Ela seria segura aqui — o parâmetro continuaria ligado —,
 * mas seria a **primeira** ocorrência de raw-unsafe em código de produto neste
 * repositório, e essa ausência é uma propriedade que vale mais do que doze
 * linhas economizadas: enquanto ela vale, procurar SQL montado à mão é procurar
 * por uma string que não existe.
 */
export async function assinaturaDaBarbearia(tenantId: string): Promise<Assinatura | null> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeAssinatura[]>`
      SELECT s.tenant_id, s.plan_code, p.name AS plan_name, p.audience, s.status,
             s.price_cents, p.max_chairs, s.trial_ends_at, s.period_end, s.canceled_at,
             s.chairs_in_use AS cadeiras
      FROM subscriptions s
      JOIN plans p ON p.code = s.plan_code
      WHERE s.tenant_id = ${tenantId}::uuid
    `;
    const linha = linhas[0];
    return linha ? paraAssinatura(linha) : null;
  });
}

export async function assinaturas(): Promise<readonly Assinatura[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeAssinatura[]>`
      SELECT s.tenant_id, s.plan_code, p.name AS plan_name, p.audience, s.status,
             s.price_cents, p.max_chairs, s.trial_ends_at, s.period_end, s.canceled_at,
             s.chairs_in_use AS cadeiras
      FROM subscriptions s
      JOIN plans p ON p.code = s.plan_code
      ORDER BY s.period_end
    `;
    return linhas.map(paraAssinatura);
  });
}

/**
 * Muda o plano da assinatura.
 *
 * Substitui a troca de plano do bloco 24, que mexia em `tenant_platform.plan_id`
 * — uma coluna que existia antes de haver assinatura e que não sabia dizer
 * preço contratado, prazo nem estado. As duas apontarem para plano diferente
 * seria a pior das saídas, então a antiga passa a ser espelho desta.
 *
 * **O preço é recopiado na troca**, e só na troca: é o instante em que alguém
 * decidiu o que a barbearia passa a pagar. Reajuste de tabela continua sem
 * alcançar quem já está dentro.
 */
export async function mudarPlanoDaAssinatura(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly planoCode: string;
}): Promise<void> {
  await semTenant(async (tx) => {
    const planos = await tx.$queryRaw<{ code: string; price_cents: number; active: boolean }[]>`
      SELECT code, price_cents, active FROM plans WHERE code = ${entrada.planoCode}
    `;
    const plano = planos[0];
    if (!plano) throw new PlataformaError('unknown_plan', 'Plano não encontrado');
    if (!plano.active) throw new PlataformaError('inactive_plan', 'Este plano não é mais oferecido');

    const atuais = await tx.$queryRaw<{ plan_code: string; price_cents: number }[]>`
      SELECT plan_code, price_cents FROM subscriptions WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    const atual = atuais[0];
    if (!atual) throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');

    /**
     * O teto do plano novo é conferido **antes** de trocar.
     *
     * O gatilho do banco guarda a porta de entrada de cadeira, não a de saída
     * de plano: descer para um plano menor do que a equipe atual não viola
     * nenhum INSERT e deixaria a barbearia com oito cadeiras num plano de
     * cinco — exatamente o estado que o bloco existe para tornar impossível.
     */
    const cadeiras = await tx.$queryRaw<{ n: bigint; teto: number | null }[]>`
      SELECT (SELECT chairs_in_use FROM subscriptions
               WHERE tenant_id = ${entrada.tenantId}::uuid)::bigint AS n,
             (SELECT max_chairs FROM plans WHERE code = ${entrada.planoCode}) AS teto
    `;
    const linha = cadeiras[0];
    if (linha && linha.teto !== null && Number(linha.n) > linha.teto) {
      throw new PlataformaError(
        'chairs_exceed_plan',
        `A barbearia tem ${Number(linha.n)} cadeiras e este plano permite ${linha.teto}. ` +
          'Desligue as que sobram antes de descer de plano.',
      );
    }

    await tx.$executeRaw`
      UPDATE subscriptions
         SET plan_code = ${plano.code}, price_cents = ${plano.price_cents}, updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid
    `;

    // O espelho do bloco 24 continua existindo, e agora segue a assinatura em
    // vez de competir com ela. Duas fontes discordando sobre o plano de uma
    // barbearia é a discussão que ninguém consegue encerrar.
    await tx.$executeRaw`
      UPDATE tenant_platform
         SET plan_id = (SELECT id FROM plans WHERE code = ${plano.code}), updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid
    `;

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.plan_changed', {
      de: atual.plan_code,
      para: plano.code,
      dePrecoCents: atual.price_cents,
      paraPrecoCents: plano.price_cents,
    });
  });
}

/**
 * Encerra a assinatura.
 *
 * Cancelar **não** bloqueia. A barbearia que cancelou continua no ar até o fim
 * do período que ela já pagou — cortar no dia do pedido é cobrar por um mês e
 * entregar meio, e é o motivo pelo qual se odeia cancelar assinatura de coisa
 * nenhuma. Quem tira do ar é a régua do bloco 28, no vencimento.
 */
export async function cancelarAssinatura(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly motivo: string;
}): Promise<void> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new PlataformaError('reason_required', 'Escreva o motivo do cancelamento');
  }

  await semTenant(async (tx) => {
    const alteradas = await tx.$executeRaw`
      UPDATE subscriptions
         SET status = 'canceled', canceled_at = now(), cancel_reason = ${motivo}, updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND status <> 'canceled'
    `;
    if (alteradas === 0) {
      throw new PlataformaError('not_cancelable', 'Barbearia inexistente ou já cancelada');
    }
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.subscription_canceled', {
      motivo,
    });
  });
}

/** Reabre uma assinatura cancelada, no plano padrão do catálogo. */
export async function reativarAssinatura(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
}): Promise<void> {
  await semTenant(async (tx) => {
    const alteradas = await tx.$executeRaw`
      UPDATE subscriptions
         SET status = 'active', canceled_at = NULL, cancel_reason = NULL,
             period_start = now(), period_end = now() + interval '30 days', updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND status = 'canceled'
    `;
    if (alteradas === 0) {
      throw new PlataformaError('not_canceled', 'Esta assinatura não está cancelada');
    }
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.subscription_resumed', {});
  });
}
