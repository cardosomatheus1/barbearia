import { withTenant } from '@barbearia/db';
import {
  ESTADOS_EM_VOO,
  ESTADOS_NAO_TERMINAIS,
  type EstadoDaNota,
  type FiscalProvider,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { recusar } from './fiscal-erros.js';

export async function enviarNota(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly provider: FiscalProvider;
}): Promise<EstadoDaNota> {
  const pedido = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        order_id: string;
        status: EstadoDaNota;
        service_cents: number;
        partner_cents: number;
        iss_bps: number;
        service_code: string;
        municipality_ibge: string;
        customer_name: string | null;
        customer_document: string | null;
        provider_invoice_id: string | null;
      }[]
    >`
      SELECT order_id, status::text AS status, service_cents, partner_cents, iss_bps,
             service_code, municipality_ibge, customer_name, customer_document,
             provider_invoice_id
        FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
         AND status::text = ANY(${[...ESTADOS_NAO_TERMINAIS]}::text[])
       FOR UPDATE
    `;
    const nota = linhas[0];
    if (!nota) return null;

    // `processando` **com** id já saiu daqui: a próxima volta consulta o
    // emissor. `processando` **sem** id é a resposta perdida da emissão — a
    // única recuperação segura é reenviar a mesma nota com a mesma chave
    // idempotente (`tenantId:invoiceId`). Sem isso ela ficava presa para sempre.
    if (nota.status === 'processando' && nota.provider_invoice_id) return null;

    // `processando` antes da chamada, pelo mesmo motivo de `liquidando` no bloco
    // 50: a trava cai no commit e a chamada de rede acontece fora dela. Sem o
    // estado, a volta seguinte da fila reenviaria a mesma nota.
    if (nota.status === 'pendente') {
      await tx.$executeRaw`
        UPDATE fiscal_invoices SET status = 'processando' WHERE id = ${params.invoiceId}::uuid
      `;
    }

    const itens = await tx.$queryRaw<
      { description: string; quantity: number; unit_price_cents: number }[]
    >`
      SELECT description, quantity, unit_price_cents
        FROM order_items
       WHERE order_id = ${nota.order_id}::uuid AND kind = 'service'
       ORDER BY position
    `;

    return { nota, itens };
  });

  /**
   * Nada a enviar: ou a nota já saiu de `pendente`, ou ela está `processando`
   * desde a volta anterior. No segundo caso o que falta é **perguntar**, e é o
   * que este caminho faz.
   *
   * A primeira versão devolvia `processando` aqui e parava. O laço de
   * conciliação existia no papel — a tarefa se reprogramava — e nunca perguntava
   * nada à prefeitura: a nota ficava "na prefeitura" para sempre, que é o
   * indicador que nunca preenche do `CLAUDE.md` §6. Achado da revisão deste
   * bloco.
   */
  if (!pedido) return consultarNota(params);

  const resposta = await params.provider.emitir({
    invoiceId: params.invoiceId,
    orderId: pedido.nota.order_id,
    tenantId: params.tenantId,
    tomador: {
      nome: pedido.nota.customer_name ?? 'Consumidor',
      documento: pedido.nota.customer_document,
      email: null,
    },
    itens: pedido.itens.map((i) => ({
      descricao: i.description,
      quantidade: i.quantity,
      valorUnitarioCents: i.unit_price_cents,
    })),
    servicoCents: pedido.nota.service_cents,
    parceiroCents: pedido.nota.partner_cents,
    issBps: pedido.nota.iss_bps,
    codigoDeServico: pedido.nota.service_code,
    municipioIbge: pedido.nota.municipality_ibge,
  });

  return gravarResposta({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    estadoEsperado: 'processando',
    resposta,
  });
}

/**
 * Pergunta à prefeitura o que aconteceu com uma nota que já foi enviada.
 *
 * É a rede de segurança da conciliação, e o único caminho pelo qual uma nota
 * sai de `processando`: a resposta municipal chega minutos ou horas depois, sem
 * webhook.
 */
async function consultarNota(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly provider: FiscalProvider;
}): Promise<EstadoDaNota> {
  const linhas = await withTenant(params.tenantId, (tx) =>
    tx.$queryRaw<{ status: EstadoDaNota; provider_invoice_id: string | null }[]>`
      SELECT status::text AS status, provider_invoice_id FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
    `,
  );
  const nota = linhas[0];
  if (!nota) return 'cancelada';
  // Sem id no emissor a nota nunca chegou lá: nada a consultar, e a próxima
  // volta da fila a reenvia.
  if (!nota.provider_invoice_id) return nota.status;
  /**
   * `cancelando` também pergunta, e é o conserto da revisão do bloco 121.
   *
   * A varredura passou a **colher** o estado em voo do cancelamento e o caminho
   * continuava descartando-o aqui: a nota era encontrada, nada era perguntado à
   * prefeitura, e o contador de conciliadas subia mesmo assim. A linha ficava
   * presa para sempre com a venda sem aceitar nota nova, que é exatamente o que
   * o bloco existia para fechar.
   */
  if (nota.status !== 'processando' && nota.status !== 'cancelando') return nota.status;

  const resposta = await params.provider.consultar(nota.provider_invoice_id);
  return gravarResposta({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    estadoEsperado: nota.status,
    resposta,
  });
}

/**
 * Grava o que o emissor respondeu.
 *
 * Separada porque a varredura de conciliação usa a mesma escrita: a prefeitura
 * responde depois, e é `consultar` que traz o desfecho. Duas gravações
 * diferentes para o mesmo fato acabariam divergindo no primeiro campo novo.
 */
export async function gravarResposta(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** Estado observado antes da chamada externa; funciona como fencing local. */
  readonly estadoEsperado: 'processando' | 'cancelando';
  readonly resposta: {
    readonly estado: EstadoDaNota;
    readonly notaId: string;
    readonly numero: string | null;
    readonly linkPdf: string | null;
    readonly motivoDaRecusa: string | null;
  };
}): Promise<EstadoDaNota> {
  return withTenant(params.tenantId, async (tx) => {
    const autorizada = params.resposta.estado === 'autorizada';
    const cancelamentoConcluido =
      params.estadoEsperado === 'cancelando' && params.resposta.estado === 'cancelada';

    const linhas = await tx.$queryRaw<{ status: EstadoDaNota }[]>`
      UPDATE fiscal_invoices
         SET status = CASE
               -- Uma consulta que começou enquanto a nota estava em cancelando
               -- não pode reabrir o documento com uma resposta autorizada
               -- atrasada. Durante o cancelamento só cancelada é avanço.
               WHEN ${params.estadoEsperado} = 'cancelando' AND NOT ${cancelamentoConcluido}
                 THEN status
               ELSE ${params.resposta.estado}::fiscal_invoice_status
             END,
             provider_invoice_id = ${params.resposta.notaId},
             number = COALESCE(${params.resposta.numero}, number),
             pdf_url = COALESCE(${params.resposta.linkPdf}, pdf_url),
             rejection_reason = CASE
               WHEN ${params.estadoEsperado} = 'cancelando' AND NOT ${cancelamentoConcluido}
                 THEN rejection_reason
               ELSE ${params.resposta.motivoDaRecusa}
             END,
             authorized_at = CASE
               WHEN ${params.estadoEsperado} = 'processando' AND ${autorizada} THEN now()
               ELSE authorized_at
             END,
             cancelled_at = CASE WHEN ${cancelamentoConcluido} THEN now() ELSE cancelled_at END
       WHERE id = ${params.invoiceId}::uuid
         AND status = ${params.estadoEsperado}::fiscal_invoice_status
      RETURNING status::text AS status
    `;
    if (linhas[0]) return linhas[0].status;

    // Outro caminho venceu a corrida. Devolvemos o estado persistido, nunca a
    // resposta velha do provedor, para o chamador não contar uma transição que
    // já não era aplicável.
    const atuais = await tx.$queryRaw<{ status: EstadoDaNota }[]>`
      SELECT status::text AS status FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
    `;
    return atuais[0]?.status ?? 'cancelada';
  });
}

/**
 * As notas que ainda esperam resposta da prefeitura — emissão **ou**
 * cancelamento.
 *
 * `ESTADOS_EM_VOO` e não `ESTADOS_NAO_TERMINAIS`: `cancelando` não sai sozinho
 * por `fiscal.emitir`, que acompanha só a emissão.
 */
export async function notasEmCurso(
  tenantId: string,
  limite = 50,
): Promise<
  readonly {
    readonly id: string;
    readonly estado: EstadoDaNota;
    readonly providerInvoiceId: string | null;
  }[]
> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; status: EstadoDaNota; provider_invoice_id: string | null }[]
    >`
      SELECT id, status, provider_invoice_id FROM fiscal_invoices
       WHERE status::text = ANY(${[...ESTADOS_EM_VOO]}::text[])
       ORDER BY requested_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      estado: l.status,
      providerInvoiceId: l.provider_invoice_id,
    }));
  });
}

/**
 * A conciliação das notas paradas em voo — o chamador que `notasEmCurso` não
 * tinha.
 *
 * `fiscal.emitir` acompanha **uma** nota e morre com ela: esgotadas as cinco
 * tentativas, nada mais a olha. A comanda ficava com "Na fila. Ela sai sozinha
 * em alguns minutos" para sempre, sem botão — a tela não desenha emissão em
 * estado em voo —, e a venda não aceitava nota nova, porque o estado a ocupa.
 * Saía por `UPDATE` no banco.
 *
 * Ela pergunta de novo ao emissor por cada nota parada. `enviarNota` é
 * idempotente do lado de lá pela chave da **linha da nota** (nunca a da venda),
 * então reperguntar sobre a mesma nota devolve o desfecho dela em vez de criar
 * uma segunda.
 *
 * `cancelando` entra porque `ESTADOS_EM_VOO` o inclui: era o estado que nem
 * varredura futura alcançaria, e o único do qual a venda não sai.
 *
 * O erro de uma nota não derruba as outras: a prefeitura fora do ar é o caso
 * normal desta integração, e uma exceção aqui pararia o laço no meio,
 * deixando as seguintes para a próxima volta sem que ninguém soubesse por quê.
 */
export async function conciliarNotas(params: {
  readonly tenantId: string;
  readonly provider: FiscalProvider;
  readonly limite?: number;
}): Promise<number> {
  const paradas = await notasEmCurso(params.tenantId, params.limite ?? 50);

  let conciliadas = 0;
  for (const nota of paradas) {
    try {
      const depois = await enviarNota({
        tenantId: params.tenantId,
        invoiceId: nota.id,
        provider: params.provider,
      });
      // Conta o que **mudou de estado**, não o que foi visitado. A primeira
      // versão somava toda linha colhida, e o log dizia "notas reperguntadas: 3"
      // sobre três notas que continuavam exatamente onde estavam — indicador que
      // não corresponde ao trabalho feito é o defeito da §6, pergunta 5.
      if (depois !== nota.estado) conciliadas += 1;
    } catch {
      // Segue para a próxima: o desfecho desta volta na hora seguinte. A
      // prefeitura fora do ar é o caso normal desta integração, e uma exceção
      // aqui pararia o laço no meio, deixando as seguintes sem explicação.
    }
  }
  return conciliadas;
}

export async function cancelarNota(params: {
  readonly tenantId: string;
  /**
   * A unidade da sessão. Cancelar é uma viagem à prefeitura sobre um documento
   * emitido: sem o recorte, o gerente da filial cancelava a nota da matriz
   * mandando o id, que `staff_locations` vazio deixa todo gerente enxergar.
   */
  readonly locationId: string;
  readonly invoiceId: string;
  readonly motivo: string;
  readonly provider: FiscalProvider;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  const motivo = params.motivo.trim();
  if (motivo.length < 3) recusar('motivo_obrigatorio');

  /**
   * O estado **em voo** vem antes da chamada, e é a lição do bloco 50.
   *
   * A trava do `FOR UPDATE` cai no commit, e a viagem à prefeitura acontece fora
   * da transação. Sem `cancelando`, dois toques em "Cancelar" leem `autorizada`
   * os dois e mandam o cancelamento duas vezes: o segundo bate contra um RPS já
   * cancelado, e o operador recebe "falhou" sobre uma nota que de fato foi
   * cancelada — com só uma das duas tentativas na trilha. Achado da
   * `/security-review` deste bloco.
   */
  const alvo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { status: EstadoDaNota; provider_invoice_id: string | null; number: string | null }[]
    >`
      SELECT status::text AS status, provider_invoice_id, number
        FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
         AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const nota = linhas[0];
    if (!nota) recusar('nota_nao_encontrada');
    if (nota.status !== 'autorizada') recusar('nota_nao_cancelavel');

    const tomadas = await tx.$executeRaw`
      UPDATE fiscal_invoices SET status = 'cancelando'
       WHERE id = ${params.invoiceId}::uuid AND status = 'autorizada'
    `;
    if (tomadas !== 1) recusar('nota_nao_cancelavel');
    return nota;
  });

  try {
    if (alvo.provider_invoice_id) {
      await params.provider.cancelar(alvo.provider_invoice_id, motivo);
    }
  } catch (erro) {
    /**
     * **Não** voltamos para `autorizada` aqui.
     *
     * Uma exceção de rede não prova que a prefeitura recusou o cancelamento: ela
     * pode ter cancelado e a resposta ter se perdido. Reabrir a nota nesse ponto
     * permitiria um segundo cancelamento e faria a UI afirmar "autorizada" sobre
     * um documento já cancelado do lado de fora.
     *
     * `cancelando` já é alcançado por `conciliarNotas`: na próxima varredura o
     * provider é consultado. Se a prefeitura mantiver a nota, `gravarResposta`
     * volta para `autorizada`; se tiver cancelado, fecha em `cancelada`.
     */
    throw erro;
  }

  await withTenant(params.tenantId, async (tx) => {
    const canceladas = await tx.$executeRaw`
      UPDATE fiscal_invoices
         SET status = 'cancelada', cancelled_at = now(), cancel_reason = ${motivo}
       WHERE id = ${params.invoiceId}::uuid AND status = 'cancelando'
    `;
    if (canceladas !== 1) recusar('nota_nao_cancelavel');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'fiscal.invoice_cancelled',
      entity: 'fiscal_invoice',
      entityId: params.invoiceId,
      before: { numero: alvo.number },
      after: { motivo },
    });
  });
}
