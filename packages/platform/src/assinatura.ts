import { semTenant, type TransactionClient } from '@barbearia/db';
import { ratear, type Rateio } from '@barbearia/core';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';
import { emitirRateio } from './cobranca.js';

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

    await aplicarTroca(tx, entrada.tenantId, plano.code, plano.price_cents);

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

/**
 * A troca em si, sem quem a pediu nem por quê.
 *
 * Uma função porque são dois caminhos — o suporte pelo painel e o dono pelo
 * autoatendimento — e eles têm que escrever exatamente o mesmo estado. Duas
 * cópias divergiriam na primeira mudança, e a divergência aqui é "o plano
 * mudou mas o espelho não", que é a discussão que ninguém encerra.
 *
 * O espelho do bloco 24 (`tenant_platform.plan_id`) continua existindo e agora
 * segue a assinatura em vez de competir com ela.
 */
async function aplicarTroca(
  tx: TransactionClient,
  tenantId: string,
  planoCode: string,
  precoCents: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE subscriptions
       SET plan_code = ${planoCode}, price_cents = ${precoCents}, updated_at = now()
     WHERE tenant_id = ${tenantId}::uuid
  `;
  await tx.$executeRaw`
    UPDATE tenant_platform
       SET plan_id = (SELECT id FROM plans WHERE code = ${planoCode}), updated_at = now()
     WHERE tenant_id = ${tenantId}::uuid
  `;
}

export interface PlanoOferecido {
  readonly code: string;
  readonly nome: string;
  readonly publico: string;
  readonly precoCents: number;
  readonly tetoDeCadeiras: number | null;
  /** É o plano em que a barbearia está agora? */
  readonly atual: boolean;
  /**
   * Por que este plano não pode ser escolhido agora, se não puder.
   *
   * Texto e não booleano: "não dá" sem motivo é o que faz o dono ligar para o
   * suporte. O único motivo hoje é equipe maior que o teto do plano.
   */
  readonly impedimento: string | null;
  /** O que a troca custaria agora, rateada pelos dias que faltam. */
  readonly rateio: Rateio;
}

/**
 * A vitrine de planos do lado de quem paga.
 *
 * Sai daqui e não da tela porque é a **mesma** conta que a troca aplica — é a
 * regra do projeto sobre permissão exibida na tela, pela mesma razão: um preço
 * calculado na view diverge do cobrado no primeiro ajuste, e a divergência
 * aparece como cobrança que ninguém sabe explicar.
 */
export async function planosParaODono(entrada: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<readonly PlanoOferecido[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        code: string;
        name: string;
        audience: string;
        price_cents: number;
        max_chairs: number | null;
        atual: boolean;
        preco_atual: number;
        cadeiras: number;
        period_start: Date;
        period_end: Date;
      }[]
    >`
      SELECT p.code, p.name, p.audience, p.price_cents, p.max_chairs,
             (p.code = s.plan_code) AS atual,
             s.price_cents AS preco_atual, s.chairs_in_use AS cadeiras,
             s.period_start, s.period_end
        FROM plans p
        CROSS JOIN subscriptions s
       WHERE s.tenant_id = ${entrada.tenantId}::uuid
         AND (p.active OR p.code = s.plan_code)
         -- O Enterprise não se contrata por autoatendimento: quem chega nele
         -- veio de uma conversa, e um botão o colocaria num plano sem preço.
         AND (p.price_cents > 0 OR p.code = s.plan_code)
       ORDER BY p.price_cents
    `;

    return linhas.map((l) => ({
      code: l.code,
      nome: l.name,
      publico: l.audience,
      precoCents: l.price_cents,
      tetoDeCadeiras: l.max_chairs,
      atual: l.atual,
      impedimento:
        l.max_chairs !== null && Number(l.cadeiras) > l.max_chairs
          ? `A barbearia tem ${Number(l.cadeiras)} cadeiras e este plano permite ${l.max_chairs}.`
          : null,
      rateio: ratear({
        precoAtualCents: l.preco_atual,
        precoNovoCents: l.price_cents,
        periodoInicio: l.period_start,
        periodoFim: l.period_end,
        agora: entrada.agora,
      }),
    }));
  });
}

/**
 * A troca de plano pelo autoatendimento — a lacuna que o bloco 27 declarou.
 *
 * O que faltava era exatamente o rateio: sem ele o botão cobraria mês cheio por
 * meio mês, e mostrar um botão antes da conta seria prometer o que não se
 * entrega. A conta está em `packages/core/src/cobranca.ts`, pura, e o que se
 * cobra vira **fatura** — a troca não debita nada em silêncio.
 *
 * ## Por que subir e descer não são simétricos
 *
 * Subir gera fatura na hora: a barbearia passa a usar o plano maior naquela
 * tarde, e o acerto do que falta do período vence em cinco dias. Descer gera
 * **crédito**, que abate a próxima mensalidade — devolver dinheiro exigiria
 * estorno no adquirente, que é o bloco 29, e emitir fatura negativa criaria um
 * documento que ninguém sabe pagar.
 */
export async function trocarPlanoPeloDono(entrada: {
  readonly tenantId: string;
  readonly planoCode: string;
  readonly agora: Date;
  readonly idempotencyKey?: string | undefined;
}): Promise<{ readonly rateio: Rateio; readonly faturaId: string | null }> {
  return semTenant(async (tx) => {
    /**
     * A repetição do mesmo POST devolve o mesmo acerto, sem cobrar de novo.
     *
     * Ela cobre o caminho que move dinheiro — a subida de plano, que emite
     * fatura. A descida não emite nada e por isso não tem o que repetir: o
     * segundo envio esbarra em `same_plan`, e é essa recusa que impede o
     * crédito em dobro. Duas defesas diferentes porque são dois efeitos
     * diferentes, e nenhuma delas depende de o cliente mandar a chave.
     */
    if (entrada.idempotencyKey) {
      const jaFeitas = await tx.$queryRaw<{ id: string; amount_cents: number }[]>`
        SELECT id, amount_cents FROM invoices
         WHERE tenant_id = ${entrada.tenantId}::uuid
           AND idempotency_key = ${entrada.idempotencyKey}
      `;
      const repetida = jaFeitas[0];
      if (repetida) {
        return {
          rateio: {
            cobrarCents: repetida.amount_cents,
            creditarCents: 0,
            diasRestantes: 0,
            diasDoPeriodo: 0,
          },
          faturaId: repetida.id,
        };
      }
    }

    const linhas = await tx.$queryRaw<
      {
        plan_code: string;
        preco_atual: number;
        period_start: Date;
        period_end: Date;
        cadeiras: number;
        novo_code: string | null;
        novo_preco: number | null;
        novo_teto: number | null;
        novo_ativo: boolean | null;
      }[]
    >`
      SELECT s.plan_code, s.price_cents AS preco_atual, s.period_start, s.period_end,
             s.chairs_in_use AS cadeiras,
             p.code AS novo_code, p.price_cents AS novo_preco,
             p.max_chairs AS novo_teto, p.active AS novo_ativo
        FROM subscriptions s
        LEFT JOIN plans p ON p.code = ${entrada.planoCode}
       WHERE s.tenant_id = ${entrada.tenantId}::uuid
    `;
    const atual = linhas[0];
    if (!atual) throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');
    if (!atual.novo_code || atual.novo_preco === null) {
      throw new PlataformaError('unknown_plan', 'Plano não encontrado');
    }
    if (!atual.novo_ativo) {
      throw new PlataformaError('inactive_plan', 'Este plano não é mais oferecido');
    }
    if (atual.novo_preco === 0) {
      throw new PlataformaError('plan_not_self_service', 'Este plano é contratado com a equipe comercial');
    }
    if (atual.novo_code === atual.plan_code) {
      throw new PlataformaError('same_plan', 'A barbearia já está neste plano');
    }
    if (atual.novo_teto !== null && Number(atual.cadeiras) > atual.novo_teto) {
      throw new PlataformaError(
        'chairs_exceed_plan',
        `A barbearia tem ${Number(atual.cadeiras)} cadeiras e este plano permite ${atual.novo_teto}. ` +
          'Desligue as que sobram antes de descer de plano.',
      );
    }

    const rateio = ratear({
      precoAtualCents: atual.preco_atual,
      precoNovoCents: atual.novo_preco,
      periodoInicio: atual.period_start,
      periodoFim: atual.period_end,
      agora: entrada.agora,
    });

    await aplicarTroca(tx, entrada.tenantId, atual.novo_code, atual.novo_preco);

    if (rateio.creditarCents > 0) {
      await tx.$executeRaw`
        UPDATE subscriptions SET credit_cents = credit_cents + ${rateio.creditarCents},
                                 updated_at = now()
         WHERE tenant_id = ${entrada.tenantId}::uuid
      `;
    }

    let faturaId: string | null = null;
    if (rateio.cobrarCents > 0) {
      const fatura = await emitirRateio({
        tx,
        tenantId: entrada.tenantId,
        planoCode: atual.novo_code,
        valorCents: rateio.cobrarCents,
        periodoInicio: atual.period_start,
        periodoFim: atual.period_end,
        agora: entrada.agora,
        idempotencyKey: entrada.idempotencyKey,
      });
      faturaId = fatura.id;
    }

    /**
     * A trilha da plataforma, com `admin_id` nulo — foi o dono, não o suporte.
     *
     * Ela é o que separa "o cliente subiu de plano" de "alguém aqui dentro
     * mudou o plano dele", e as duas coisas viram a mesma linha se o autor não
     * for registrado.
     */
    await registrarNaTrilha(tx, null, entrada.tenantId, 'tenant.plan_changed', {
      de: atual.plan_code,
      para: atual.novo_code,
      dePrecoCents: atual.preco_atual,
      paraPrecoCents: atual.novo_preco,
      cobrarCents: rateio.cobrarCents,
      creditarCents: rateio.creditarCents,
      por: 'dono',
    });

    return { rateio, faturaId };
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
