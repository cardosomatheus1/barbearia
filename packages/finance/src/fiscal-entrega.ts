import { withTenant } from '@barbearia/db';
import {
  decisaoDaEntregaDaNota,
  documentoDoTomadorValido,
  normalizarDocumento,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { recusar } from './fiscal-erros.js';

export async function salvarDocumentoDoCliente(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly documento: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly documento: string | null }> {
  const documento = normalizarDocumento(params.documento);
  if (!documentoDoTomadorValido(documento)) recusar('documento_invalido');

  return withTenant(params.tenantId, async (tx) => {
    const antes = await tx.$queryRaw<{ tax_id: string | null }[]>`
      SELECT tax_id FROM customers WHERE id = ${params.customerId}::uuid FOR UPDATE
    `;
    if (!antes[0]) recusar('cliente_nao_encontrado');

    await tx.$executeRaw`
      UPDATE customers
         SET tax_id = ${documento}, updated_at = now()
       WHERE id = ${params.customerId}::uuid
    `;

    /**
     * A trilha guarda **se** havia documento, nunca qual era.
     *
     * `audit_log` é append-only e legível por quem administra a barbearia: pôr
     * o CPF ali criaria uma segunda cópia do dado que a anonimização não
     * alcança — e a trilha é justamente a tabela que a exportação do titular
     * deixa de fora por trazer nome de terceiros.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'customers.tax_id_changed',
      entity: 'customers',
      entityId: params.customerId,
      before: { tinha: antes[0].tax_id !== null },
      after: { tinha: documento !== null },
    });

    return { documento };
  });
}

export interface NotaAEntregar {
  readonly id: string;
  readonly linkPdf: string;
  readonly numero: string | null;
  readonly telefone: string;
  readonly clienteNome: string;
  readonly timeZone: string;
  /** O nome da casa, que é como a mensagem se apresenta. */
  readonly barbearia: string;
}

/**
 * As notas autorizadas que ainda não chegaram ao cliente.
 *
 * O filtro diz a mesma coisa que o índice parcial `fiscal_invoices_a_entregar`:
 * autorizada, com link, sem carimbo de entrega. Escritos separados, os dois
 * divergiriam — é o defeito que o bloco 53 teve entre a lista da aplicação e o
 * índice de nota viva.
 *
 * O telefone entra no `JOIN` e não numa segunda consulta: sem ele não há
 * entrega, e uma ida ao banco por nota dentro do laço é o N+1 que a regra
 * proíbe.
 */
export async function notasAEntregar(
  tenantId: string,
  limite = 50,
): Promise<readonly NotaAEntregar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        pdf_url: string;
        number: string | null;
        phone_e164: string;
        name: string;
        timezone: string;
        barbearia: string;
      }[]
    >`
      SELECT f.id, f.pdf_url, f.number, c.phone_e164, c.name, l.timezone,
             t.name AS barbearia
        FROM fiscal_invoices f
        JOIN orders o ON o.id = f.order_id
        JOIN customers c ON c.id = o.customer_id
        JOIN locations l ON l.id = f.location_id
        JOIN tenants t ON t.id = f.tenant_id
       WHERE f.status = 'autorizada'
         AND f.customer_notified_at IS NULL
         AND f.pdf_url IS NOT NULL
         AND c.phone_e164 IS NOT NULL
       ORDER BY f.authorized_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      linkPdf: l.pdf_url,
      numero: l.number,
      telefone: l.phone_e164,
      clienteNome: l.name,
      timeZone: l.timezone,
      barbearia: l.barbearia,
    }));
  });
}

/**
 * Carimba a entrega, e devolve se **esta** chamada foi quem entregou.
 *
 * O carimbo é gravado antes de a mensagem sair, e a ordem é deliberada: a
 * alternativa — mandar e depois carimbar — perde o carimbo se o processo cair
 * no meio, e a volta seguinte da fila remanda a mesma nota. Entre repetir a
 * mensagem e não mandá-la, o produto escolhe não mandar: o link continua na
 * tela da comanda, e a recepção manda quando o cliente pedir.
 *
 * `customer_notified_at IS NULL` no `WHERE` é o que impede a segunda entrega
 * quando dois workers pegam a mesma nota — e a contagem é conferida, porque um
 * `UPDATE` que não pegou ninguém significa que outro já mandou.
 */
export async function marcarNotaEntregue(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const carimbadas = await tx.$executeRaw`
      UPDATE fiscal_invoices
         SET customer_notified_at = now()
       WHERE id = ${params.invoiceId}::uuid
         AND status = 'autorizada'
         AND customer_notified_at IS NULL
    `;
    return carimbadas === 1;
  });
}

/**
 * Entrega as notas autorizadas de uma barbearia (bloco 54).
 *
 * Roda **pela fila**, uma volta por barbearia por hora. Cada nota decide
 * sozinha em `packages/core` — a janela de silêncio é do fuso da unidade, e o
 * horário do laço é UTC.
 *
 * Uma consulta para o conjunto e nenhuma dentro do laço: o telefone, o nome e o
 * fuso já vêm no `JOIN`. O laço só carimba e manda.
 *
 * O carimbo vem **antes** da mensagem, e é a decisão que importa aqui: mandar e
 * depois carimbar perde o carimbo se o processo cair, e a volta seguinte
 * remanda a mesma nota. Entre repetir e não mandar, o produto escolhe não
 * mandar — o link continua na comanda, e a recepção manda quando o cliente
 * pedir. A escolha inversa transformaria uma queda do worker em vinte
 * mensagens iguais no celular do cliente.
 */
export async function entregarNotasAutorizadas(params: {
  readonly tenantId: string;
  readonly agora: Date;
  readonly enviar: (mensagem: {
    readonly phoneE164: string;
    readonly barbearia: string;
    readonly numero: string | null;
    readonly link: string;
  }) => Promise<void>;
}): Promise<{ readonly enviadas: number; readonly adiadas: number }> {
  const notas = await notasAEntregar(params.tenantId);
  let enviadas = 0;
  let adiadas = 0;

  for (const nota of notas) {
    const decisao = decisaoDaEntregaDaNota({
      estado: 'autorizada',
      linkPdf: nota.linkPdf,
      entregueEm: null,
      telefone: nota.telefone,
      agora: params.agora,
      timeZone: nota.timeZone,
    });

    /**
     * Fora da janela de silêncio, a nota fica para a volta seguinte.
     *
     * Sem carimbo: ela precisa continuar na fila. `quando` é o instante em que
     * ela poderia sair, e compará-lo com agora é o mesmo que perguntar "estamos
     * dentro da janela?" — só que a resposta sai de `core`, onde o teste
     * alcança e onde o fuso da unidade é lido.
     */
    if (!decisao.entregar || !decisao.quando || decisao.quando.getTime() > params.agora.getTime()) {
      adiadas += 1;
      continue;
    }

    const nossa = await marcarNotaEntregue({ tenantId: params.tenantId, invoiceId: nota.id });
    if (!nossa) continue;

    await params.enviar({
      phoneE164: nota.telefone,
      barbearia: nota.barbearia,
      numero: nota.numero,
      link: nota.linkPdf,
    });
    enviadas += 1;
  }

  return { enviadas, adiadas };
}

export interface TomadorDaVenda {
  readonly customerId: string | null;
  readonly nome: string | null;
  readonly documento: string | null;
}

/**
 * Quem é o tomador desta venda, e qual documento ele tem hoje.
 *
 * A tela da comanda precisa disto para mostrar o campo de CPF preenchido — e
 * `notaDaVenda` não serve: ela devolve o que foi **congelado** numa nota que
 * pode nem existir ainda, e o que o balcão edita é o cadastro.
 *
 * Comanda avulsa devolve tudo nulo, e é estado legítimo: não há cliente, então
 * não há onde guardar CPF, e a tela diz isso em vez de mostrar um campo que não
 * salva em lugar nenhum.
 */
export async function tomadorDaVenda(
  tenantId: string,
  locationId: string,
  orderId: string,
): Promise<TomadorDaVenda | null> {
  return withTenant(tenantId, async (tx) => {
    // Devolve **nome e CPF** do cliente: sem o recorte de unidade, o gerente da
    // filial os colhia mandando o id de uma comanda da matriz.
    const linhas = await tx.$queryRaw<
      { customer_id: string | null; name: string | null; tax_id: string | null }[]
    >`
      SELECT o.customer_id, c.name, c.tax_id
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ${orderId}::uuid
         AND o.location_id = ${locationId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return { customerId: linha.customer_id, nome: linha.name, documento: linha.tax_id };
  });
}
