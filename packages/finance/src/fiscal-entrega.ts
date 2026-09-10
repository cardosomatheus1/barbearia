import { withTenant } from '@barbearia/db';
import {
  decisaoDaEntregaDaNota,
  documentoDoTomadorValido,
  normalizarDocumento,
} from '@barbearia/core';
import { executarEntregaDuravel, type MensagemDeNota } from '@barbearia/jobs';
import { audit } from '@barbearia/identity';
import { recusar } from './fiscal-erros.js';
import { urlDoDocumento } from './nfse/link.js';

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
  readonly locationId: string;
  readonly customerId: string;
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
  agora = new Date(),
): Promise<readonly NotaAEntregar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        pdf_url: string;
        number: string | null;
        phone_e164: string;
        name: string;
        timezone: string;
        barbearia: string;
        location_id: string;
        pdf_nativo: boolean;
      }[]
    >`
      SELECT f.id, c.id AS customer_id, f.pdf_url, f.number, c.phone_e164, c.name, l.timezone,
             t.name AS barbearia, f.location_id, (d.pdf_cipher IS NOT NULL OR m.nfse_cipher IS NOT NULL) AS pdf_nativo
        FROM fiscal_invoices f
        LEFT JOIN fiscal_native_documents d ON d.invoice_id = f.id
        LEFT JOIN fiscal_municipal_documents m ON m.invoice_id = f.id
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
      locationId: l.location_id, customerId: l.customer_id,
      // O prazo começa na tentativa de entrega, mesmo após semanas sem canal.
      linkPdf: l.pdf_nativo ? urlDoDocumento({ tenantId, locationId: l.location_id, invoiceId: l.id }, agora) : l.pdf_url,
      numero: l.number,
      telefone: l.phone_e164,
      clienteNome: l.name,
      timeZone: l.timezone,
      barbearia: l.barbearia,
    }));
  });
}

/** Carimba somente depois de confirmar o envio ou reencontrar uma intenção confirmada. */
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

/** A fila de entrega reserva cada nota antes da rede e respeita o horário da unidade. */
export async function entregarNotasAutorizadas(params: {
  readonly tenantId: string;
  readonly agora: Date;
  readonly enviar: (mensagem: MensagemDeNota) => Promise<void>;
}): Promise<{ readonly enviadas: number; readonly adiadas: number }> {
  const notas = await notasAEntregar(params.tenantId, 50, params.agora);
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

    const intentKey = `nota:${nota.id}`;
    const enviada = await executarEntregaDuravel({ tenantId: params.tenantId, intentKey,
      customerId: nota.customerId, tipo: 'nota_fiscal', telefone: nota.telefone, agora: params.agora,
      enviar: () => params.enviar({ tenantId: params.tenantId, locationId: nota.locationId,
        intentKey, customerId: nota.customerId, phoneE164: nota.telefone,
        barbearia: nota.barbearia, numero: nota.numero, link: nota.linkPdf }) });
    if (!enviada) { adiadas += 1; continue; }
    await marcarNotaEntregue({ tenantId: params.tenantId, invoiceId: nota.id });
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
