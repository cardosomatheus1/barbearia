import { sql, withTenant, type TransactionClient } from '@barbearia/db';
import {
  estadoDoPacote,
  fraseDoPacote,
  proximoAConsumir,
  reembolsoProporcional,
  restamNoPacote,
  valorDaUnidade,
  valorDoProximoConsumo,
  diferidoDoPacote,
  vencimentoDoPacote,
  type EstadoDoPacote,
  type PacoteDoCliente,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { lancarNoExtrato } from './comanda.js';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';

/**
 * Pacotes, do banco para a decisão (bloco 42, SPEC §4.7).
 *
 * A regra mora em `packages/core`. Aqui se carrega o estado, se chama o domínio
 * e se grava — dentro da transação que fecha a venda, como a comissão e a
 * fidelidade.
 *
 * ## O consumo é a receita
 *
 * A venda do pacote entra R$ 250 no caixa e não é receita de R$ 250. Cada
 * unidade consumida reconhece o valor congelado dela, e é `package_uses` que
 * carrega o **quando** — a informação que um contador `usados = 3` não tem.
 */

export type PacoteFailure =
  | 'pacote_nao_encontrado'
  | 'catalogo_nao_encontrado'
  | 'sem_cliente'
  | 'sem_saldo'
  | 'ja_reembolsado'
  | 'nada_a_devolver'
  | 'pacote_invalido'
  | 'estorno_da_venda_em_curso';

export class PacoteError extends Error {
  constructor(readonly code: PacoteFailure, message: string) {
    super(message);
    this.name = 'PacoteError';
  }
}

const MENSAGEM: Readonly<Record<PacoteFailure, string>> = {
  pacote_nao_encontrado: 'Este pacote não existe.',
  catalogo_nao_encontrado: 'Este pacote não está no catálogo.',
  sem_cliente: 'Identifique o cliente antes de vender ou usar um pacote.',
  sem_saldo: 'Este pacote não tem mais unidades disponíveis.',
  ja_reembolsado: 'Este pacote já foi reembolsado.',
  nada_a_devolver: 'Não há unidades para devolver.',
  pacote_invalido: 'Confira os números do pacote.',
  estorno_da_venda_em_curso: 'A venda que criou este pacote está em processo de estorno.',
};

function recusar(code: PacoteFailure): never {
  throw new PacoteError(code, MENSAGEM[code]);
}

// ---------------------------------------------------------------------------
// O catálogo
// ---------------------------------------------------------------------------

export interface PacoteNoCatalogo {
  readonly id: string;
  readonly nome: string;
  readonly serviceId: string;
  readonly servicoNome: string;
  readonly quantidade: number;
  readonly precoCents: number;
  readonly validadeDias: number | null;
  readonly transferivel: boolean;
  readonly ativo: boolean;
}

export async function catalogoDePacotes(
  tenantId: string,
  incluirInativos = false,
): Promise<readonly PacoteNoCatalogo[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        service_id: string;
        servico: string;
        quantity: number;
        price_cents: number;
        validity_days: number | null;
        transferable: boolean;
        active: boolean;
      }[]
    >(sql`
      SELECT p.id, p.name, p.service_id, s.name AS servico, p.quantity, p.price_cents,
             p.validity_days, p.transferable, p.active
        FROM packages p
        JOIN services s ON s.id = p.service_id
       WHERE (${incluirInativos}::boolean OR p.active)
       ORDER BY p.name
    `);

    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      serviceId: l.service_id,
      servicoNome: l.servico,
      quantidade: l.quantity,
      precoCents: l.price_cents,
      validadeDias: l.validity_days,
      transferivel: l.transferable,
      ativo: l.active,
    }));
  });
}

export async function salvarPacoteDoCatalogo(entrada: {
  readonly tenantId: string;
  readonly id?: string;
  readonly nome: string;
  readonly serviceId: string;
  readonly quantidade: number;
  readonly precoCents: number;
  readonly validadeDias: number | null;
  readonly transferivel: boolean;
  readonly ativo: boolean;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<{ readonly id: string }> {
  if (
    !Number.isInteger(entrada.quantidade) ||
    entrada.quantidade < 2 ||
    !Number.isInteger(entrada.precoCents) ||
    entrada.precoCents <= 0
  ) {
    recusar('pacote_invalido');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * O serviço vem do formulário, e é conferido **sob RLS**.
     *
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria de bom grado o id de um serviço de outra
     * barbearia, e o pacote nasceria cobrindo um corte que esta casa não vende.
     */
    const servicos = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM services WHERE id = ${entrada.serviceId}::uuid
    `;
    if (!servicos[0]) recusar('catalogo_nao_encontrado');

    if (entrada.id) {
      const afetados = await tx.$executeRaw`
        UPDATE packages
           SET name = ${entrada.nome}, service_id = ${entrada.serviceId}::uuid,
               quantity = ${entrada.quantidade}, price_cents = ${entrada.precoCents},
               validity_days = ${entrada.validadeDias},
               transferable = ${entrada.transferivel}, active = ${entrada.ativo},
               updated_at = now()
         WHERE id = ${entrada.id}::uuid
      `;
      if (afetados === 0) recusar('catalogo_nao_encontrado');

      await audit(tx, {
        actorId: entrada.ator.id,
        actorName: entrada.ator.name,
        action: 'package.changed',
        entity: 'packages',
        entityId: entrada.id,
        after: { nome: entrada.nome, precoCents: entrada.precoCents, ativo: entrada.ativo },
      });
      return { id: entrada.id };
    }

    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO packages
        (tenant_id, service_id, name, quantity, price_cents, validity_days, transferable, active)
      VALUES (
        ${entrada.tenantId}::uuid, ${entrada.serviceId}::uuid, ${entrada.nome},
        ${entrada.quantidade}, ${entrada.precoCents}, ${entrada.validadeDias},
        ${entrada.transferivel}, ${entrada.ativo}
      )
      RETURNING id
    `;
    const id = criados[0]?.id;
    if (id === undefined) recusar('catalogo_nao_encontrado');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'package.changed',
      entity: 'packages',
      entityId: id,
      after: { nome: entrada.nome, precoCents: entrada.precoCents, criado: true },
    });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// O pacote comprado
// ---------------------------------------------------------------------------

interface LinhaDoPacote {
  id: string;
  service_id: string;
  servico: string | null;
  quantity: number;
  usados: bigint;
  expires_at: Date | null;
  unit_value_cents: number;
  price_cents: number;
  purchased_at: Date;
  transferable: boolean;
  refunded_at: Date | null;
  refunded_cents: number | null;
}

const doBanco = (l: LinhaDoPacote): PacoteDoCliente => ({
  id: l.id,
  serviceId: l.service_id,
  total: l.quantity,
  usados: Number(l.usados),
  venceEm: l.expires_at,
  valorDaUnidadeCents: l.unit_value_cents,
  precoCents: l.price_cents,
  compradoEm: l.purchased_at,
  transferivel: l.transferable,
  reembolsadoEm: l.refunded_at,
});

const selectDoPacote = (comCliente = false) => comCliente
  ? sql`
      SELECT cp.id, cp.service_id, s.name AS servico, cp.quantity,
             (SELECT count(*) FROM package_uses u WHERE u.customer_package_id = cp.id) AS usados,
             cp.expires_at, cp.unit_value_cents, cp.price_cents, cp.purchased_at,
             cp.transferable, cp.refunded_at, cp.refunded_cents, cp.customer_id
        FROM customer_packages cp
        LEFT JOIN services s ON s.id = cp.service_id
    `
  : sql`
      SELECT cp.id, cp.service_id, s.name AS servico, cp.quantity,
             (SELECT count(*) FROM package_uses u WHERE u.customer_package_id = cp.id) AS usados,
             cp.expires_at, cp.unit_value_cents, cp.price_cents, cp.purchased_at,
             cp.transferable, cp.refunded_at, cp.refunded_cents
        FROM customer_packages cp
        LEFT JOIN services s ON s.id = cp.service_id
    `;

export interface PacoteNaTela {
  readonly id: string;
  /** O serviço que o pacote cobre. A tela casa por id, nunca pelo nome. */
  readonly serviceId: string;
  readonly servicoNome: string;
  readonly estado: EstadoDoPacote;
  readonly total: number;
  readonly usados: number;
  readonly restam: number;
  readonly venceEm: string | null;
  readonly frase: string;
  readonly valorDaUnidadeCents: number;
  readonly precoCents: number;
  readonly reembolsadoCents: number | null;
  /**
   * Congelado na compra (bloco 42), e por isso na projeção (bloco 52): a tela
   * só mostra "passar adiante" para o que **foi vendido** transferível. Ler o
   * catálogo aqui faria o botão aparecer num pacote comprado quando a opção
   * estava desligada.
   */
  readonly transferivel: boolean;
}

function paraTela(linha: LinhaDoPacote, agora: Date): PacoteNaTela {
  const pacote = doBanco(linha);
  return {
    id: pacote.id,
    serviceId: pacote.serviceId,
    servicoNome: linha.servico ?? 'Serviço removido',
    estado: estadoDoPacote(pacote, agora),
    total: pacote.total,
    usados: pacote.usados,
    restam: restamNoPacote(pacote),
    venceEm: pacote.venceEm?.toISOString() ?? null,
    frase: fraseDoPacote(pacote, agora),
    valorDaUnidadeCents: pacote.valorDaUnidadeCents,
    precoCents: linha.price_cents,
    reembolsadoCents: linha.refunded_cents,
    transferivel: pacote.transferivel,
  };
}

/**
 * Os pacotes de um cliente.
 *
 * Filtra por `customer_id` — a RLS separa barbearias e **não** separa clientes
 * dentro de uma.
 */
export async function pacotesDoCliente(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<readonly PacoteNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDoPacote[]>(sql`
      ${selectDoPacote()}
       WHERE cp.customer_id = ${customerId}::uuid
       ORDER BY cp.purchased_at DESC
    `);
    return linhas.map((l) => paraTela(l, agora));
  });
}

/**
 * Vende um pacote, **dentro da transação que fecha a comanda**.
 *
 * Os termos não são relidos do catálogo aqui. Eles foram congelados no
 * `order_item` quando a recepção adicionou o pacote à comanda. Isso evita que
 * uma edição do catálogo entre "adicionar" e "receber" mude serviço,
 * quantidade, validade ou transferibilidade depois que o preço já foi aceito.
 */
export async function venderPacote(
  tx: TransactionClient,
  params: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly packageId: string;
    readonly orderId: string;
    readonly serviceId: string;
    readonly quantidade: number;
    readonly precoCents: number;
    readonly validadeDias: number | null;
    readonly transferivel: boolean;
    readonly agora: Date;
  },
): Promise<{ readonly id: string }> {
  if (params.quantidade < 1 || params.precoCents <= 0) recusar('pacote_invalido');

  const criados = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO customer_packages
      (tenant_id, customer_id, package_id, order_id, service_id, quantity,
       price_cents, unit_value_cents, transferable, purchased_at, expires_at)
    VALUES (
      ${params.tenantId}::uuid, ${params.customerId}::uuid, ${params.packageId}::uuid,
      ${params.orderId}::uuid, ${params.serviceId}::uuid, ${params.quantidade},
      ${params.precoCents}, ${valorDaUnidade(params.precoCents, params.quantidade)},
      ${params.transferivel}, ${params.agora},
      ${vencimentoDoPacote(params.validadeDias, params.agora)}
    )
    RETURNING id
  `;
  const id = criados[0]?.id;
  if (id === undefined) recusar('pacote_nao_encontrado');
  return { id };
}

/**
 * Os pacotes vivos de um cliente, para decidir o consumo.
 *
 * `travar` é o que separa mostrar de gravar. Sem a trava, duas comandas do
 * mesmo cliente fechando ao mesmo tempo leem `usados = 4` as duas, as duas
 * concluem que resta uma unidade e as duas gravam: cinco compradas, seis
 * consumidas. O índice único de `package_uses` não pega — ele é por comanda, e
 * são duas comandas diferentes.
 *
 * É o mesmo defeito que o resgate de fidelidade teria sem `saldoTravado`, e a
 * primeira versão daqui tinha copiado o comentário sem copiar a trava.
 *
 * `FOR UPDATE OF cp` e não `FOR UPDATE`: `services` entra por `LEFT JOIN`, e o
 * Postgres recusa travar o lado que pode ser nulo.
 */
async function vivosDoCliente(
  tx: TransactionClient,
  customerId: string,
  travar: boolean,
): Promise<readonly PacoteDoCliente[]> {
  if (travar) {
    /**
     * Trave **antes** de contar usos ou consultar `refund_pending_at`.
     *
     * Em READ COMMITTED, uma única `SELECT ... FOR UPDATE` pode começar com um
     * snapshot anterior, esperar outra transação soltar `customer_packages` e
     * ainda carregar subqueries que não viram o `package_uses`/lease recém
     * confirmado. Duas instruções transformam a trava em barreira de verdade:
     * depois que este SELECT termina, a consulta seguinte abre snapshot novo.
     */
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_packages
       WHERE customer_id = ${customerId}::uuid AND refunded_at IS NULL
       ORDER BY purchased_at
       FOR UPDATE
    `;
  }

  const linhas = await tx.$queryRaw<LinhaDoPacote[]>(sql`
    ${selectDoPacote()}
     WHERE cp.customer_id = ${customerId}::uuid AND cp.refunded_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM order_charges oc
          WHERE oc.order_id = cp.order_id AND oc.refund_pending_at IS NOT NULL
       )
     ORDER BY cp.purchased_at
  `);
  return linhas.map(doBanco);
}

export interface ConsumoDisponivel {
  readonly customerPackageId: string;
  readonly valorCents: number;
  readonly restamDepois: number;
}

/**
 * Qual pacote cobre este serviço, e por quanto.
 *
 * Chamada antes de fechar a comanda, para a tela mostrar; e **de novo** dentro
 * da transação, sob a trava, porque entre uma coisa e outra pode ter entrado
 * outro consumo do mesmo pacote.
 */
export async function consumoDisponivel(params: {
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly serviceId: string;
  readonly agora?: Date;
  readonly tx?: TransactionClient;
}): Promise<ConsumoDisponivel | null> {
  const agora = params.agora ?? new Date();

  const dentro = async (tx: TransactionClient): Promise<ConsumoDisponivel | null> => {
    if (!params.customerId) return null;
    // Dentro da transação do fechamento a leitura é para **gravar**, e trava.
    // Na tela ela é para mostrar, e travar ali seguraria linhas por uma pergunta.
    const vivos = await vivosDoCliente(tx, params.customerId, params.tx !== undefined);
    const escolhido = proximoAConsumir(vivos, params.serviceId, agora);
    if (!escolhido) return null;

    return {
      customerPackageId: escolhido.id,
      valorCents: valorDoProximoConsumo(escolhido),
      restamDepois: restamNoPacote(escolhido) - 1,
    };
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/**
 * Consome uma unidade, **dentro da transação que fecha a comanda**.
 *
 * Fora dela, a comanda fecharia com o corte quitado pelo pacote e o pacote
 * continuaria cheio — crédito infinito, um corte por comanda. É o mesmo defeito
 * que o resgate de fidelidade teria, e a mesma solução.
 *
 * `ON CONFLICT DO NOTHING` fecha a reentrada: o webhook do Pix pode chamar a
 * cadeia de fechamento por outro caminho, e sem o índice único a reentrega
 * consumiria duas unidades pelo mesmo corte — tirando do cliente um serviço que
 * ele não recebeu.
 */
export async function consumirPacote(
  tx: TransactionClient,
  params: {
    readonly customerPackageId: string;
    readonly orderId: string;
    readonly valorCents: number;
    readonly diaDaUnidade: string;
    readonly appointmentId?: string | null;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO package_uses
      (tenant_id, customer_package_id, order_id, appointment_id, value_cents, business_day)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerPackageId}::uuid, ${params.orderId}::uuid,
      ${params.appointmentId ?? null}::uuid, ${params.valorCents},
      ${params.diaDaUnidade}::date
    )
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Reembolso proporcional (SPEC §4.7).
 *
 * Devolve o que não foi usado, ao valor congelado da unidade. O pacote **não
 * some**: fica com a data e o valor devolvido, porque "quanto foi devolvido a
 * quem" é a pergunta que o dono faz depois.
 *
 * O dinheiro sai pelo razão do cliente, como crédito: devolver em espécie exige
 * caixa aberto e sangria, e é decisão do balcão — não deste caminho.
 */
export async function reembolsarPacote(entrada: {
  readonly tenantId: string;
  readonly customerPackageId: string;
  /**
   * A loja do balcão onde o reembolso é feito (bloco 59).
   *
   * Obrigatória, e não opcional. Um crédito **positivo** sem loja é somado ao
   * bolso de **cada** unidade: com fiado por unidade, um reembolso de R$ 250
   * daria R$ 250 de crédito na matriz e outros R$ 250 na filial, e o cliente
   * gastaria o mesmo dinheiro duas vezes. Opcional, ela seria esquecida no
   * primeiro chamador novo e o defeito voltaria sem nada ficar vermelho.
   *
   * Achado da `/security-review` do bloco 59.
   */
  readonly locationId: string;
  readonly ator: { readonly id: string; readonly name: string };
  readonly agora?: Date;
}): Promise<{ readonly valorCents: number }> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    // Primeiro adquira a linha do pacote; só depois releia o lease em snapshot
    // novo. Assim `reembolsar × estornar` tem uma ordem total mesmo quando uma
    // das transações precisou esperar a outra.
    const travado = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_packages
       WHERE id = ${entrada.customerPackageId}::uuid
       FOR UPDATE
    `;
    if (!travado[0]) recusar('pacote_nao_encontrado');

    const pendente = await tx.$queryRaw<{ id: string }[]>`
      SELECT cp.id FROM customer_packages cp
      JOIN order_charges oc ON oc.order_id = cp.order_id
       WHERE cp.id = ${entrada.customerPackageId}::uuid
         AND oc.refund_pending_at IS NOT NULL
       LIMIT 1
    `;
    if (pendente[0]) recusar('estorno_da_venda_em_curso');

    const linhas = await tx.$queryRaw<(LinhaDoPacote & { customer_id: string })[]>(sql`
      ${selectDoPacote(true)}
       WHERE cp.id = ${entrada.customerPackageId}::uuid
    `);
    const linha = linhas[0];
    if (!linha) recusar('pacote_nao_encontrado');

    const decisao = reembolsoProporcional(doBanco(linha), agora);
    if ('recusa' in decisao) recusar(decisao.recusa);

    /**
     * O `WHERE refunded_at IS NULL` só vale se alguém olhar quantas linhas ele
     * pegou.
     *
     * A trava acima é quem impede o segundo reembolso hoje, e ela basta. Mas
     * descartar a contagem deixa a segunda camada inerte: uma reescrita que
     * enfraqueça o `FOR UPDATE` transforma um UPDATE que não pegou ninguém em
     * crédito lançado no razão, sem nada ficar vermelho. É a mesma conferência
     * que `salvarPacoteDoCatalogo` faz trezentas linhas acima.
     */
    const atualizados = await tx.$executeRaw`
      UPDATE customer_packages
         SET refunded_at = ${agora}, refunded_cents = ${decisao.valorCents}, updated_at = now()
       WHERE id = ${entrada.customerPackageId}::uuid AND refunded_at IS NULL
    `;
    if (atualizados === 0) recusar('ja_reembolsado');

    // Pelo helper da comanda, e não por SQL próprio: ele calcula
    // `balance_after_cents`, que é o que faz o extrato ser conferível linha a
    // linha. A primeira versão daqui escrevia o INSERT à mão e esquecia a
    // coluna — o teste do reembolso pegou.
    await lancarNoExtrato(tx, {
      customerId: linha.customer_id,
      kind: 'credit',
      amountCents: decisao.valorCents,
      note: 'Reembolso de pacote',
      staffId: entrada.ator.id,
      staffName: entrada.ator.name,
      locationId: entrada.locationId,
    });

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'package.refunded',
      entity: 'customer_packages',
      entityId: entrada.customerPackageId,
      after: { valorCents: decisao.valorCents },
    });

    return { valorCents: decisao.valorCents };
  });
}

// ---------------------------------------------------------------------------
// A receita diferida
// ---------------------------------------------------------------------------

export interface ReceitaDePacotes {
  /** Vendido no dia. Entrou no caixa e **não** é receita ainda. */
  readonly vendidoCents: number;
  /** Consumido no dia. É a receita que a venda de antes prometeu. */
  readonly reconhecidoCents: number;
  /** Saldo que virou receita porque o pacote venceu no dia. */
  readonly vencidoCents: number;
  /** O passivo: tudo que foi pago e ainda não foi entregue. */
  readonly diferidoCents: number;
}

/**
 * O número que este bloco existe para dar.
 *
 * A SPEC §4.7 diz por quê em uma linha: *"Sem isso, o DRE mostra um mês
 * excelente seguido de meses falsamente ruins."* A barbearia que vende trinta
 * pacotes em janeiro fecha o mês parecendo espetacular e passa fevereiro
 * atendendo de graça.
 *
 * O diferido é calculado sobre o estado **de hoje**, não sobre um contador: o
 * pacote que venceu ontem já não é passivo, e nenhuma varredura precisou rodar
 * para isso ser verdade.
 */
export async function receitaDePacotes(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly dia: string;
  readonly agora?: Date;
}): Promise<ReceitaDePacotes> {
  const agora = params.agora ?? new Date();
  return withTenant(params.tenantId, async (tx) => {
    const vendas = await tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(cp.price_cents)::bigint AS total
        FROM customer_packages cp
        JOIN orders o ON o.id = cp.order_id
       WHERE o.location_id = ${params.locationId}::uuid
         AND o.business_day = ${params.dia}::date AND o.status = 'paid'
    `;

    const usos = await tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(u.value_cents)::bigint AS total
        FROM package_uses u
        JOIN orders o ON o.id = u.order_id
       WHERE o.location_id = ${params.locationId}::uuid
         AND u.business_day = ${params.dia}::date
    `;

    const vencidos = await tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(
               GREATEST(
                 cp.price_cents - COALESCE((
                   SELECT sum(u.value_cents)::bigint FROM package_uses u
                    WHERE u.customer_package_id = cp.id
                 ), 0),
                 0
               )
             )::bigint AS total
        FROM customer_packages cp
        JOIN orders venda ON venda.id = cp.order_id
        JOIN locations l ON l.id = venda.location_id
       WHERE venda.location_id = ${params.locationId}::uuid
         AND cp.refunded_at IS NULL
         AND cp.expires_at IS NOT NULL
         -- Evita reconhecer breakage antes do horário real do vencimento quando
         -- o relatório é aberto no próprio dia. Enquanto expires_at > agora,
         -- o mesmo saldo ainda aparece em diferidoCents.
         AND cp.expires_at <= ${agora}
         AND (cp.expires_at AT TIME ZONE l.timezone)::date = ${params.dia}::date
    `;

    const abertos = await tx.$queryRaw<LinhaDoPacote[]>(sql`
      ${selectDoPacote()}
      JOIN orders venda ON venda.id = cp.order_id
       WHERE cp.refunded_at IS NULL AND venda.location_id = ${params.locationId}::uuid
    `);
    const diferidoBig = abertos
      .map(doBanco)
      .reduce((soma, p) => soma + BigInt(diferidoDoPacote(p, agora)), 0n);
    const diferidoCents = inteiroSeguroDoBanco(diferidoBig, 'saldo diferido de pacotes');

    return {
      vendidoCents: inteiroSeguroDoBanco(vendas[0]?.total, 'venda de pacotes do dia'),
      reconhecidoCents: inteiroSeguroDoBanco(usos[0]?.total, 'uso de pacotes do dia'),
      vencidoCents: inteiroSeguroDoBanco(vencidos[0]?.total, 'saldo vencido de pacotes do dia'),
      diferidoCents,
    };
  });
}
