import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeFiscalProvider, type ConfiguracaoFiscal } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import { salvarRegraDeComissao } from './comissao.js';
import { salvarProduto } from './estoque.js';
import {
  cancelarNota,
  conciliarNotas,
  configuracaoFiscal,
  enviarNota,
  notaDaVenda,
  notasDoPeriodo,
  entregarNotasAutorizadas,
  pedirNota,
  salvarConfiguracaoFiscal,
  salvarDocumentoDoCliente,
} from './fiscal.js';

/**
 * Fiscal contra Postgres real (bloco 53, SPEC §3.11).
 *
 * O que só o banco prova: que a nota nasce **dentro** da transação que fecha a
 * comanda sem nunca bloqueá-la, que a chave que vai ao emissor é a da linha e
 * não a da venda, e que o cancelamento passa pelo estado em voo.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '53535353-1111-1111-1111-111111111111';
const RIVAL = '53535353-2222-2222-2222-222222222222';
const LOCATION = 'a3535353-0000-0000-0000-000000000001';
const RUAN = 'b3535353-0000-0000-0000-000000000001';
const CORTE = 'e3535353-0000-0000-0000-000000000001';
const CARLOS = 'c3535353-0000-0000-0000-000000000001';
const STAFF = 'f3535353-0000-0000-0000-000000000001';

const HOJE = '2026-11-25';
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
const ator = { id: STAFF, name: 'Maria Recepção' };
const fecha = { ...operador, hojeNaUnidade: HOJE };

const CONFIG: ConfiguracaoFiscal = {
  cnpj: '11222333000181',
  regime: 'simples',
  codigoDeServico: '14.01',
  issBps: 200,
  municipioIbge: '2927408',
  emitirAutomaticamente: true,
};

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('fiscal', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 5000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 50_000, ...operador });
  });

  const cadastrar = (extra: Partial<typeof CONFIG> = {}) =>
    salvarConfiguracaoFiscal({
      tenantId: TENANT,
      locationId: LOCATION,
      config: { ...CONFIG, ...extra },
      ...operador,
    });

  async function venderCorte(comProduto = false): Promise<string> {
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'service',
      descricao: 'Corte',
      serviceId: CORTE,
      professionalId: RUAN,
      quantidade: 1,
      precoUnitarioCents: 5000,
      ...operador,
    });
    if (comProduto) {
      const produto = await salvarProduto({
        tenantId: TENANT,
        nome: 'Pomada',
        tipo: 'resale',
        custoCents: 1200,
        precoCents: 3000,
        minimo: 0,
        unidade: 'un',
        ativo: true,
        ator,
      });
      await adicionarItem({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: aberta.id,
        tipo: 'product',
        descricao: 'Pomada',
        productId: produto.id,
        professionalId: RUAN,
        quantidade: 1,
        precoUnitarioCents: 3000,
        ...operador,
      });
    }
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: comProduto ? 8000 : 5000 }],
      ...fecha,
    });
    return aberta.id;
  }

  // -------------------------------------------------------------------------
  // Cadastro
  // -------------------------------------------------------------------------

  it('o CNPJ é guardado só com os dígitos, como o emissor recebe', async () => {
    const salva = await cadastrar({ cnpj: '11.222.333/0001-81' });
    expect(salva.cnpj).toBe('11222333000181');
  });

  it('CNPJ com dígito verificador errado é recusado antes do banco', async () => {
    await expect(cadastrar({ cnpj: '11222333000182' })).rejects.toMatchObject({
      code: 'cnpj_invalido',
    });
  });

  it('ISS acima de 5% é recusado — é o teto da lei complementar', async () => {
    await expect(cadastrar({ issBps: 501 })).rejects.toMatchObject({ code: 'aliquota_invalida' });
  });

  it('a configuração de uma barbearia não é lida pela outra', async () => {
    await cadastrar();
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a3535353-0000-0000-0000-000000000009', '${RIVAL}', 'Deles', 'America/Bahia');
    `);
    expect(
      await configuracaoFiscal(TENANT, 'a3535353-0000-0000-0000-000000000009'),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Emissão
  // -------------------------------------------------------------------------

  it('a comanda fecha e a nota nasce pendente, com a tarefa junto', async () => {
    /**
     * A nota nasce **na transação** que fecha a venda, e a tarefa que a envia
     * nasce junto: enfileirar depois do commit abriria a janela em que a venda
     * foi fechada e nada está marcado para emitir.
     */
    await cadastrar();
    const orderId = await venderCorte();

    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    expect(nota?.estado).toBe('pendente');
    expect(nota?.servicoCents).toBe(5000);

    const tarefas = await admin.$queryRawUnsafe<{ kind: string; payload: unknown }[]>(
      `SELECT kind, payload FROM jobs WHERE kind = 'fiscal.emitir'`,
    );
    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]?.payload).toMatchObject({ invoiceId: nota?.id });
  });

  it('sem cadastro fiscal, a comanda fecha do mesmo jeito', async () => {
    /**
     * A emissão **nunca** bloqueia a venda — é a mesma frase do KYC no bloco 50.
     * O caminho óbvio, recusar o fechamento até o cadastro existir, produz a
     * barbearia descobrindo no balcão que não consegue cobrar.
     */
    const orderId = await venderCorte();
    expect(await notaDaVenda(TENANT, LOCATION, orderId)).toBeNull();

    const venda = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM orders WHERE id = '${orderId}'`,
    );
    expect(venda[0]?.status).toBe('paid');
  });

  it('com a emissão automática desligada, nada sai sozinho', async () => {
    await cadastrar({ emitirAutomaticamente: false });
    const orderId = await venderCorte();
    expect(await notaDaVenda(TENANT, LOCATION, orderId)).toBeNull();

    // Mas à mão sai: é o caminho da barbearia que emite só quando o cliente pede.
    const criada = await withTenant(TENANT, (tx) =>
      pedirNota(tx, {
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        staffId: STAFF,
        staffName: 'Maria Recepção',
        automatica: false,
      }),
    );
    expect(criada).not.toBeNull();
  });

  it('só o serviço entra na base — produto é outro documento', async () => {
    /**
     * Somar o shampoo na NFS-e recolheria ISS sobre mercadoria, que é imposto
     * errado sobre a base errada.
     */
    await cadastrar();
    const orderId = await venderCorte(true);
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    expect(nota?.servicoCents).toBe(5000);
  });

  it('a nota de outra barbearia não é encontrada por esta', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    // Mesma função, outro tenant: a RLS é quem filtra, e nenhuma consulta deste
    // arquivo repete `tenant_id` no `WHERE`.
    expect(await notaDaVenda(RIVAL, LOCATION, orderId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // O envio ao emissor
  // -------------------------------------------------------------------------

  it('a chave que vai ao emissor é a da nota, não a da comanda', async () => {
    /**
     * Achado da `/security-review` deste bloco. Uma venda pode ter mais de uma
     * nota de propósito: a rejeitada é justamente a que a barbearia corrige e
     * reenvia. Com a comanda na chave, a segunda submissão chegava como
     * repetição da primeira e o emissor devolvia a nota antiga — a tela mostrava
     * "autorizada" com um número que a prefeitura não tem do documento
     * corrigido.
     */
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    emissor.proximoEstado = 'rejeitada';
    emissor.proximaRecusa = 'Código de serviço não habilitado';

    const primeira = await notaDaVenda(TENANT, LOCATION, orderId);
    await enviarNota({ tenantId: TENANT, invoiceId: primeira!.id, provider: emissor });
    expect((await notaDaVenda(TENANT, LOCATION, orderId))?.estado).toBe('rejeitada');

    // A barbearia corrige o cadastro e emite de novo.
    await cadastrar({ codigoDeServico: '14.02' });
    const segunda = await withTenant(TENANT, (tx) =>
      pedirNota(tx, {
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        staffId: STAFF,
        staffName: 'Maria Recepção',
        automatica: false,
      }),
    );
    emissor.proximoEstado = 'autorizada';
    await enviarNota({ tenantId: TENANT, invoiceId: segunda!.id, provider: emissor });

    // Duas submissões de verdade, e a segunda com o código corrigido.
    expect(emissor.emitidas).toHaveLength(2);
    expect(emissor.emitidas[1]?.codigoDeServico).toBe('14.02');
    expect(emissor.emitidas.every((p) => p.orderId === orderId)).toBe(true);
  });

  it('a nota em curso é perguntada de novo, e é assim que ela sai de processando', async () => {
    /**
     * A prefeitura responde depois e sem webhook: perguntar é o **único**
     * caminho para fora de `processando`. A primeira versão parava aqui e
     * devolvia `processando` sem consultar nada — a nota ficava "na prefeitura"
     * para sempre, que é o indicador que nunca preenche do `CLAUDE.md` §6.
     */
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);

    await enviarNota({ tenantId: TENANT, invoiceId: nota!.id, provider: emissor });
    expect((await notaDaVenda(TENANT, LOCATION, orderId))?.estado).toBe('processando');

    emissor.proximoEstado = 'autorizada';
    const depois = await enviarNota({ tenantId: TENANT, invoiceId: nota!.id, provider: emissor });
    expect(depois).toBe('autorizada');

    const autorizada = await notaDaVenda(TENANT, LOCATION, orderId);
    expect(autorizada?.numero).not.toBeNull();
    expect(autorizada?.linkPdf).toContain('.pdf');
    // Uma submissão só: a segunda volta **consultou**, não reenviou.
    expect(emissor.emitidas).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Cancelamento
  // -------------------------------------------------------------------------

  async function autorizar(orderId: string, emissor: FakeFiscalProvider): Promise<string> {
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    emissor.proximoEstado = 'autorizada';
    await enviarNota({ tenantId: TENANT, invoiceId: nota!.id, provider: emissor });
    return nota!.id;
  }

  it('cancelar passa pelo estado em voo e mantém o número', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const invoiceId = await autorizar(orderId, emissor);

    await cancelarNota({
      tenantId: TENANT,
      locationId: LOCATION,
      invoiceId,
      motivo: 'Valor lançado errado',
      provider: emissor,
      ...operador,
    });

    const cancelada = await admin.$queryRawUnsafe<
      { status: string; number: string | null; cancel_reason: string }[]
    >(`SELECT status::text AS status, number, cancel_reason FROM fiscal_invoices
        WHERE id = '${invoiceId}'`);
    expect(cancelada[0]?.status).toBe('cancelada');
    // O número que foi à prefeitura fica: é ele que o contador procura.
    expect(cancelada[0]?.number).not.toBeNull();
    expect(cancelada[0]?.cancel_reason).toContain('errado');
    expect(emissor.canceladas).toHaveLength(1);
  });

  it('cancelar duas vezes só fala com a prefeitura uma', async () => {
    /**
     * Achado da revisão: a trava do `FOR UPDATE` cai no commit e a viagem à
     * prefeitura acontece fora da transação. Sem o estado `cancelando`, dois
     * toques mandavam o cancelamento duas vezes — o segundo batendo contra um
     * RPS já cancelado.
     */
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const invoiceId = await autorizar(orderId, emissor);

    const cancelar = () =>
      cancelarNota({
        tenantId: TENANT,
        locationId: LOCATION,
        invoiceId,
        motivo: 'Valor lançado errado',
        provider: emissor,
        ...operador,
      });

    await cancelar();
    await expect(cancelar()).rejects.toMatchObject({ code: 'nota_nao_cancelavel' });
    expect(emissor.canceladas).toHaveLength(1);
  });

  it('nota pendente não se cancela — não há o que cancelar na prefeitura', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    await expect(
      cancelarNota({
        tenantId: TENANT,
        locationId: LOCATION,
        invoiceId: nota!.id,
        motivo: 'Desisti',
        provider: new FakeFiscalProvider(),
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'nota_nao_cancelavel' });
  });

  it('com o cancelamento em voo, pedir nota é recusado pelo domínio e não pelo índice', async () => {
    /**
     * Achado ao percorrer o fluxo do balcão: `cancelando` estava no índice
     * parcial e faltava na lista que o domínio consulta. O pedido passava por
     * toda a validação e morria no `INSERT`, devolvendo violação de unicidade
     * ao balcão — e no caminho automático a exceção subiria **dentro** de
     * `fecharComanda`, que roda na transação do webhook do Pix.
     *
     * O que este teste prende é o **tipo** da recusa: `nao_emite`, do domínio.
     * Uma recusa de qualquer jeito não bastaria; o defeito era justamente o
     * caminho pelo qual ela chegava.
     */
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const invoiceId = await autorizar(orderId, emissor);

    // Trava o cancelamento no ar: o provedor não responde, então a nota fica
    // no estado reivindicado, que é a janela em questão.
    await exec(`UPDATE fiscal_invoices SET status = 'cancelando' WHERE id = '${invoiceId}'`);

    await expect(
      withTenant(TENANT, (tx) =>
        pedirNota(tx, {
          tenantId: TENANT,
          locationId: LOCATION,
          orderId,
          automatica: false,
          ...operador,
        }),
      ),
    ).rejects.toMatchObject({ code: 'nao_emite' });
  });

  it('recusada pela prefeitura, a venda volta a aceitar nota', async () => {
    // O outro lado da mesma lista: a tela diz "corrija e emita de novo", e o
    // domínio precisa aceitar — senão o botão que a leitura do fluxo pediu
    // levaria a um erro.
    await cadastrar();
    const orderId = await venderCorte();
    const primeira = await notaDaVenda(TENANT, LOCATION, orderId);
    await exec(
      `UPDATE fiscal_invoices SET status = 'rejeitada',
              rejection_reason = 'Código de serviço não habilitado'
        WHERE id = '${primeira!.id}'`,
    );

    const segunda = await withTenant(TENANT, (tx) =>
      pedirNota(tx, {
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        automatica: false,
        ...operador,
      }),
    );
    expect(segunda?.id).toBeTruthy();
    expect(segunda?.id).not.toBe(primeira!.id);
  });


  // -------------------------------------------------------------------------
  // O tomador e a entrega (bloco 54)
  // -------------------------------------------------------------------------

  it('o CPF do cadastro é congelado na nota, e corrigi-lo depois não a reescreve', async () => {
    await salvarDocumentoDoCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      documento: '529.982.247-25',
      ...operador,
    });
    await cadastrar();
    const orderId = await venderCorte();

    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    const gravado = await admin.$queryRawUnsafe<{ customer_document: string | null }[]>(
      `SELECT customer_document FROM fiscal_invoices WHERE id = '${nota!.id}'`,
    );
    // Só os dígitos, que é como o emissor recebe.
    expect(gravado[0]?.customer_document).toBe('52998224725');

    // O cliente corrige o próprio documento depois. A nota de ontem não muda:
    // ela é o documento que foi à prefeitura.
    await salvarDocumentoDoCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      documento: '11222333000181',
      ...operador,
    });
    const depois = await admin.$queryRawUnsafe<{ customer_document: string | null }[]>(
      `SELECT customer_document FROM fiscal_invoices WHERE id = '${nota!.id}'`,
    );
    expect(depois[0]?.customer_document).toBe('52998224725');
  });

  it('CPF com dígito verificador errado é recusado antes do banco', async () => {
    await expect(
      salvarDocumentoDoCliente({
        tenantId: TENANT,
        customerId: CARLOS,
        documento: '52998224726',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'documento_invalido' });
  });

  it('apagar o documento é operação legítima', async () => {
    await salvarDocumentoDoCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      documento: '52998224725',
      ...operador,
    });
    const limpo = await salvarDocumentoDoCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      documento: null,
      ...operador,
    });
    expect(limpo.documento).toBeNull();
  });

  it('a trilha registra que o documento mudou, e nunca qual é', async () => {
    /**
     * `audit_log` é append-only e legível por quem administra a barbearia. O CPF
     * ali seria uma segunda cópia do dado — numa tabela que a anonimização não
     * alcança, e que a exportação do titular deixa de fora por trazer nome de
     * terceiros.
     */
    await salvarDocumentoDoCliente({
      tenantId: TENANT,
      customerId: CARLOS,
      documento: '52998224725',
      ...operador,
    });
    const trilha = await admin.$queryRawUnsafe<{ before: unknown; after: unknown }[]>(
      `SELECT before, after FROM audit_log WHERE action = 'customers.tax_id_changed'`,
    );
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha[0])).not.toContain('52998224725');
    expect(trilha[0]?.after).toMatchObject({ tinha: true });
  });

  it('o cliente de outra barbearia não recebe documento por esta', async () => {
    const alheio = 'c3535353-0000-0000-0000-0000000000ff';
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${alheio}', '${RIVAL}', 'Cliente deles', '+5571900000099');
    `);
    await expect(
      salvarDocumentoDoCliente({
        tenantId: TENANT,
        customerId: alheio,
        documento: '52998224725',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cliente_nao_encontrado' });
  });

  it('a nota autorizada entra na fila de entrega, e sai dela quando é entregue', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    await autorizar(orderId, emissor);

    const enviadas: { phoneE164: string; link: string }[] = [];
    const primeira = await entregarNotasAutorizadas({
      tenantId: TENANT,
      // 14h em Salvador: dentro da janela.
      agora: new Date('2026-11-25T17:00:00Z'),
      enviar: async (m) => {
        enviadas.push({ phoneE164: m.phoneE164, link: m.link });
      },
    });
    expect(primeira.enviadas).toBe(1);
    expect(enviadas[0]?.phoneE164).toBe('+5571988887777');
    expect(enviadas[0]?.link).toContain('http');

    // A volta seguinte não remanda: o carimbo tirou a nota da fila.
    const segunda = await entregarNotasAutorizadas({
      tenantId: TENANT,
      agora: new Date('2026-11-25T18:00:00Z'),
      enviar: async () => {
        throw new Error('não deveria mandar de novo');
      },
    });
    expect(segunda.enviadas).toBe(0);
  });

  it('de madrugada a nota espera, e continua na fila', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    await autorizar(orderId, new FakeFiscalProvider());

    // 23h30 em Salvador.
    const noite = await entregarNotasAutorizadas({
      tenantId: TENANT,
      agora: new Date('2026-11-26T02:30:00Z'),
      enviar: async () => {
        throw new Error('nada sai entre 21h e 8h');
      },
    });
    expect(noite).toMatchObject({ enviadas: 0, adiadas: 1 });

    // De manhã ela sai — e é a **mesma** nota, que continuou na fila.
    const manha = await entregarNotasAutorizadas({
      tenantId: TENANT,
      agora: new Date('2026-11-26T12:00:00Z'),
      enviar: async () => {},
    });
    expect(manha.enviadas).toBe(1);
  });

  it('a nota de uma barbearia não é entregue pela varredura da outra', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    await autorizar(orderId, new FakeFiscalProvider());

    const doRival = await entregarNotasAutorizadas({
      tenantId: RIVAL,
      agora: new Date('2026-11-25T17:00:00Z'),
      enviar: async () => {
        throw new Error('a nota é da outra barbearia');
      },
    });
    expect(doRival.enviadas).toBe(0);
  });

  it('nota autorizada sem PDF não vira mensagem com link vazio', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    // O emissor confirma o número antes de o documento ficar disponível.
    await exec(
      `UPDATE fiscal_invoices
          SET status = 'autorizada', number = '2026/1', authorized_at = now(), pdf_url = NULL
        WHERE id = '${nota!.id}'`,
    );

    const resultado = await entregarNotasAutorizadas({
      tenantId: TENANT,
      agora: new Date('2026-11-25T17:00:00Z'),
      enviar: async () => {
        throw new Error('sem link não se manda nada');
      },
    });
    expect(resultado.enviadas).toBe(0);
  });

  it('mensagem que falha não é repetida na volta seguinte', async () => {
    /**
     * O carimbo é gravado **antes** de a mensagem sair, e é a decisão que este
     * teste prende. A alternativa — mandar e depois carimbar — perde o carimbo
     * se o processo cair no meio, e a volta seguinte remanda a mesma nota.
     *
     * Entre repetir e não mandar, o produto escolhe não mandar: o link continua
     * na comanda e a recepção manda quando o cliente pedir. A escolha inversa
     * transforma uma queda do worker em vinte mensagens iguais no celular do
     * cliente, pelo mesmo número que manda o lembrete que reduz falta.
     *
     * Provado com o provedor falhando, e não com duas voltas simultâneas: a
     * corrida entre duas transações não é determinística, e um teste que passa
     * com e sem o conserto não prova nada.
     */
    await cadastrar();
    const orderId = await venderCorte();
    await autorizar(orderId, new FakeFiscalProvider());

    const agora = new Date('2026-11-25T17:00:00Z');
    await expect(
      entregarNotasAutorizadas({
        tenantId: TENANT,
        agora,
        enviar: async () => {
          throw new Error('provedor fora do ar');
        },
      }),
    ).rejects.toThrow('provedor fora do ar');

    const segunda = await entregarNotasAutorizadas({
      tenantId: TENANT,
      agora,
      enviar: async () => {
        throw new Error('não deveria tentar de novo');
      },
    });
    expect(segunda.enviadas).toBe(0);

    const nota = await notaDaVenda(TENANT, LOCATION, orderId);
    const carimbo = await admin.$queryRawUnsafe<{ customer_notified_at: Date | null }[]>(
      `SELECT customer_notified_at FROM fiscal_invoices WHERE id = '${nota!.id}'`,
    );
    expect(carimbo[0]?.customer_notified_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Salão-Parceiro
  // -------------------------------------------------------------------------

  it('no Salão-Parceiro a nota separa a parte do profissional, e ela sai da comissão', async () => {
    /**
     * *"A nota separa a parcela do salão da parcela do profissional... é
     * exatamente o mesmo dado do split."* Não existe alíquota de parceiro no
     * schema: duas fontes de verdade para o número da nota dariam um documento
     * fiscal que não bate com o que o profissional declara.
     */
    await salvarRegraDeComissao({ tenantId: TENANT, modo: 'percent', valor: 4000, ...operador });
    await cadastrar({ regime: 'salao_parceiro' });
    const orderId = await venderCorte();

    const linhas = await admin.$queryRawUnsafe<{ partner_cents: number; regime: string }[]>(
      `SELECT partner_cents, regime::text AS regime FROM fiscal_invoices
        WHERE order_id = '${orderId}'`,
    );
    // 40% de R$ 50.
    expect(linhas[0]?.partner_cents).toBe(2000);
    expect(linhas[0]?.regime).toBe('salao_parceiro');
  });

  it('a comissão por faixa progressiva também entra na nota', async () => {
    /**
     * A primeira versão somava a comissão dentro da consulta com um `CASE`, e
     * `tiers` caía no `ELSE 0`: uma barbearia com faixa progressiva emitia toda
     * nota de Salão-Parceiro com a parcela do profissional zerada — número
     * errado num documento fiscal, sem nada ficar vermelho.
     */
    await salvarRegraDeComissao({
      tenantId: TENANT,
      modo: 'tiers',
      valor: 0,
      faixas: [
        { ateCents: 100_000, pontosBase: 3000 },
        { ateCents: null, pontosBase: 5000 },
      ],
      ...operador,
    });
    await cadastrar({ regime: 'salao_parceiro' });
    const orderId = await venderCorte();

    const linhas = await admin.$queryRawUnsafe<{ partner_cents: number }[]>(
      `SELECT partner_cents FROM fiscal_invoices WHERE order_id = '${orderId}'`,
    );
    // 30% de R$ 50 na primeira faixa.
    expect(linhas[0]?.partner_cents).toBe(1500);
  });

  it('fora do Salão-Parceiro, a nota não tem parcela de profissional', async () => {
    await salvarRegraDeComissao({ tenantId: TENANT, modo: 'percent', valor: 4000, ...operador });
    await cadastrar({ regime: 'simples' });
    const orderId = await venderCorte();

    const linhas = await admin.$queryRawUnsafe<{ partner_cents: number }[]>(
      `SELECT partner_cents FROM fiscal_invoices WHERE order_id = '${orderId}'`,
    );
    expect(linhas[0]?.partner_cents).toBe(0);
  });

  it('a listagem só devolve a repartição para quem pode ver comissão', async () => {
    /**
     * A parcela do profissional **é** a comissão dele naquela venda — o mesmo
     * dado que `commission.view_all` guarda. Sob `fiscal.view`, que a
     * recepcionista tem por padrão, ela entregava a folha inteira de quem
     * percorresse os ids das comandas do dia. Achado da revisão deste bloco.
     */
    await salvarRegraDeComissao({ tenantId: TENANT, modo: 'percent', valor: 4000, ...operador });
    await cadastrar({ regime: 'salao_parceiro' });
    await venderCorte();

    /**
     * O recorte é por `requested_at`, que é o instante real — não o
     * `hojeNaUnidade` do fechamento. Uma janela fixa aqui deixaria o teste
     * vermelho no dia em que o relógio do ambiente saísse dela.
     */
    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const paraRecepcao = await notasDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: ontem,
      ate: amanha,
      podeVerCliente: true,
    });
    expect(paraRecepcao[0]).not.toHaveProperty('parceiroCents');

    const paraQuemVeComissao = await notasDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: ontem,
      ate: amanha,
      comRepartição: true,
      podeVerCliente: true,
    });
    expect(paraQuemVeComissao[0]).toMatchObject({ parceiroCents: 2000, casaCents: 3000 });
  });

  it('a conciliação tira a nota presa em cancelando', async () => {
    /**
     * O processo cai entre gravar `cancelando` e a resposta da prefeitura. A
     * nota fica ali para sempre: `fiscal.emitir` acompanha só a emissão e já
     * morreu, e `ESTADOS_QUE_OCUPAM_A_VENDA` inclui `cancelando` — então a
     * comanda **nunca mais aceita nota nova**.
     *
     * A primeira versão da varredura colhia o estado e não fazia nada com ele:
     * `consultarNota` só perguntava por `processando`, e `gravarResposta`
     * escrevia com a lista curta, alcançando zero linhas em silêncio. O
     * contador subia mesmo assim. Achado da revisão de segurança do bloco 121.
     */
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const invoiceId = await autorizar(orderId, emissor);

    /**
     * O estado em voo sem o desfecho, que é o que o processo caído deixa.
     *
     * `cancelled_at` e `cancel_reason` preenchidos porque `cancelarNota` os
     * grava **antes** da viagem à prefeitura, e a `CHECK` da migração 0056 os
     * exige na linha cancelada: sem eles a gravação do desfecho estouraria a
     * constraint, o `catch` da conciliação engoliria, e o teste ficaria vermelho
     * pelo motivo errado — a semente precisa satisfazer tudo menos a regra sob
     * teste.
     */
    await admin.$executeRawUnsafe(
      `UPDATE fiscal_invoices
          SET status = 'cancelando', cancelled_at = now(),
              cancel_reason = 'Valor lançado errado'
        WHERE id = '${invoiceId}'`,
    );

    emissor.proximoEstado = 'cancelada';
    const conciliadas = await conciliarNotas({ tenantId: TENANT, provider: emissor });

    const [depois] = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM fiscal_invoices WHERE id = '${invoiceId}'`,
    );
    expect(depois?.status).toBe('cancelada');
    // Conta o que **mudou**, não o que foi visitado.
    expect(conciliadas).toBe(1);
  });

  it('a conciliação não conta a nota que continua onde estava', async () => {
    await cadastrar();
    const orderId = await venderCorte();
    const emissor = new FakeFiscalProvider();
    const nota = await notaDaVenda(TENANT, LOCATION, orderId);

    // Sem id no emissor: a nota nunca chegou lá, e não há o que perguntar.
    await admin.$executeRawUnsafe(
      `UPDATE fiscal_invoices SET status = 'cancelando', provider_invoice_id = NULL
        WHERE id = '${nota!.id}'`,
    );

    expect(await conciliarNotas({ tenantId: TENANT, provider: emissor })).toBe(0);
  });

});
