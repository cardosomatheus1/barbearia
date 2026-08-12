import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  estadoDoPacote,
  fraseDoPacote,
  proximoAConsumir,
  reembolsoProporcional,
  restamNoPacote,
  valorDaUnidade,
  vencimentoDoPacote,
  type EstadoDoPacote,
  type PacoteDoCliente,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { lancarNoExtrato } from './comanda.js';

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
  | 'pacote_invalido';

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
    const linhas = await tx.$queryRawUnsafe<
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
    >(
      `SELECT p.id, p.name, p.service_id, s.name AS servico, p.quantity, p.price_cents,
              p.validity_days, p.transferable, p.active
         FROM packages p
         JOIN services s ON s.id = p.service_id
        WHERE ($1::boolean OR p.active)
        ORDER BY p.name`,
      incluirInativos,
    );

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
  compradoEm: l.purchased_at,
  transferivel: l.transferable,
  reembolsadoEm: l.refunded_at,
});

const SELECT_DO_PACOTE = `
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
    const linhas = await tx.$queryRawUnsafe<LinhaDoPacote[]>(
      `${SELECT_DO_PACOTE} WHERE cp.customer_id = $1::uuid ORDER BY cp.purchased_at DESC`,
      customerId,
    );
    return linhas.map((l) => paraTela(l, agora));
  });
}

/**
 * Vende um pacote, **dentro da transação que fecha a comanda**.
 *
 * Tudo congelado aqui: serviço, quantidade, preço, valor da unidade e validade.
 * O corte avulso sobe em março e as unidades compradas em janeiro continuam
 * valendo o que valiam.
 */
export async function venderPacote(
  tx: TransactionClient,
  params: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly packageId: string;
    readonly orderId: string;
    readonly agora: Date;
  },
): Promise<{ readonly id: string }> {
  const catalogo = await tx.$queryRaw<
    {
      service_id: string;
      quantity: number;
      price_cents: number;
      validity_days: number | null;
      transferable: boolean;
    }[]
  >`
    SELECT service_id, quantity, price_cents, validity_days, transferable
      FROM packages WHERE id = ${params.packageId}::uuid AND active
  `;
  const item = catalogo[0];
  if (!item) recusar('catalogo_nao_encontrado');

  const criados = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO customer_packages
      (tenant_id, customer_id, package_id, order_id, service_id, quantity,
       price_cents, unit_value_cents, transferable, purchased_at, expires_at)
    VALUES (
      ${params.tenantId}::uuid, ${params.customerId}::uuid, ${params.packageId}::uuid,
      ${params.orderId}::uuid, ${item.service_id}::uuid, ${item.quantity},
      ${item.price_cents}, ${valorDaUnidade(item.price_cents, item.quantity)},
      ${item.transferable}, ${params.agora},
      ${vencimentoDoPacote(item.validity_days, params.agora)}
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
  const linhas = await tx.$queryRawUnsafe<LinhaDoPacote[]>(
    `${SELECT_DO_PACOTE} WHERE cp.customer_id = $1::uuid AND cp.refunded_at IS NULL
       ORDER BY cp.purchased_at${travar ? ' FOR UPDATE OF cp' : ''}`,
    customerId,
  );
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
      valorCents: escolhido.valorDaUnidadeCents,
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
  readonly ator: { readonly id: string; readonly name: string };
  readonly agora?: Date;
}): Promise<{ readonly valorCents: number }> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<(LinhaDoPacote & { customer_id: string })[]>(
      `${SELECT_DO_PACOTE.replace('cp.refunded_cents', 'cp.refunded_cents, cp.customer_id')}
        WHERE cp.id = $1::uuid FOR UPDATE OF cp`,
      entrada.customerPackageId,
    );
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
export async function receitaDePacotes(
  tenantId: string,
  dia: string,
  agora: Date = new Date(),
): Promise<ReceitaDePacotes> {
  return withTenant(tenantId, async (tx) => {
    const vendas = await tx.$queryRaw<{ total: number | null }[]>`
      SELECT sum(cp.price_cents)::int AS total
        FROM customer_packages cp
        JOIN orders o ON o.id = cp.order_id
       WHERE o.business_day = ${dia}::date AND o.status = 'paid'
    `;

    const usos = await tx.$queryRaw<{ total: number | null }[]>`
      SELECT sum(value_cents)::int AS total
        FROM package_uses WHERE business_day = ${dia}::date
    `;

    const abertos = await tx.$queryRawUnsafe<LinhaDoPacote[]>(
      `${SELECT_DO_PACOTE} WHERE cp.refunded_at IS NULL`,
    );
    const diferidoCents = abertos
      .map(doBanco)
      .filter((p) => estadoDoPacote(p, agora) === 'ativo')
      .reduce((soma, p) => soma + restamNoPacote(p) * p.valorDaUnidadeCents, 0);

    return {
      vendidoCents: vendas[0]?.total ?? 0,
      reconhecidoCents: usos[0]?.total ?? 0,
      diferidoCents,
    };
  });
}
