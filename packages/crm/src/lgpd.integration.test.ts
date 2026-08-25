import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import {
  abrirPedidoDoTitular,
  consentimentosDoCliente,
  encerrarPedidoDoTitular,
  exportarDadosDoTitular,
  LgpdError,
  pedidosDoTitular,
  PRAZO_DO_PEDIDO_DIAS,
  registrarConsentimento,
} from './lgpd.js';

/**
 * Os direitos do titular contra Postgres real (bloco 31).
 *
 * O que só o banco responde: que o histórico não some, que o espelho que o
 * disparo de campanha lê acompanha a decisão, que a exportação de uma barbearia
 * não alcança a outra, e que uma tabela nova com dado de cliente não entra em
 * produção sem entrar na exportação junto.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '31313131-1111-1111-1111-111111111111';
const RIVAL = '31313131-2222-2222-2222-222222222222';
const LOCAL = 'a1313131-0000-0000-0000-000000000001';
const CARLOS = 'c1313131-0000-0000-0000-000000000001';
const DELA = 'c1313131-0000-0000-0000-000000000002';
const DONO = 'd1313131-0000-0000-0000-000000000001';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const ator = { id: DONO, name: 'Matheus' };

describeIfDb('direitos do titular', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name, dpo_name, dpo_email)
      VALUES ('${TENANT}', 'Domari', 'Matheus Cardoso', 'dpo@domari.com.br');
      INSERT INTO tenants (id, name) VALUES ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${DELA}', '${RIVAL}', 'Cliente da vizinha', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  // -- consentimento ----------------------------------------------------------

  it('a decisão vira histórico, e o disparo de campanha lê o espelho', async () => {
    await registrarConsentimento({
      tenantId: TENANT,
      customerId: CARLOS,
      finalidade: 'marketing',
      concedido: true,
      versaoDoTexto: 'promo-2026-01',
      ip: '200.1.2.3',
    });

    const espelho = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ accepts_marketing: boolean; marketing_consent_version: string }[]>`
        SELECT accepts_marketing, marketing_consent_version FROM customers
         WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(espelho[0]).toMatchObject({
      accepts_marketing: true,
      marketing_consent_version: 'promo-2026-01',
    });
  });

  it('revogar não apaga a concessão — as duas ficam', async () => {
    // É o par de datas que responde a uma contestação. Uma tabela com uma linha
    // por finalidade só responde a primeira, e mal.
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'v1',
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: false, versaoDoTexto: 'v1',
    });

    const { atuais, historico } = await consentimentosDoCliente(TENANT, CARLOS);
    expect(historico).toHaveLength(2);
    expect(atuais.marketing?.concedido).toBe(false);
    expect(historico.some((d) => d.concedido)).toBe(true);
  });

  it('as quatro finalidades são independentes', async () => {
    // Agendar não autoriza campanha, e consentir foto não autoriza publicá-la.
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'service',
      concedido: true, versaoDoTexto: 'v1',
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'photos',
      concedido: true, versaoDoTexto: 'v1',
    });

    const { atuais } = await consentimentosDoCliente(TENANT, CARLOS);
    expect(atuais.service?.concedido).toBe(true);
    expect(atuais.photos?.concedido).toBe(true);
    expect(atuais.marketing).toBeUndefined();
    expect(atuais.photos_public).toBeUndefined();

    const espelho = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ accepts_marketing: boolean }[]>`
        SELECT accepts_marketing FROM customers WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(espelho[0]?.accepts_marketing).toBe(false);
  });

  it('consentimento sem versão do texto é recusado', async () => {
    // "Ele aceitou" sem dizer o que ele leu não responde nada numa contestação.
    await expect(
      registrarConsentimento({
        tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
        concedido: true, versaoDoTexto: '   ',
      }),
    ).rejects.toMatchObject({ code: 'version_required' });
  });

  it('o cliente da vizinha não recebe consentimento por esta barbearia', async () => {
    await expect(
      registrarConsentimento({
        tenantId: TENANT, customerId: DELA, finalidade: 'marketing',
        concedido: true, versaoDoTexto: 'v1',
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });

  it('registrar pelo balcão deixa trilha; pelo titular, não', async () => {
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'v1', registradoPor: ator,
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'photos',
      concedido: true, versaoDoTexto: 'v1',
    });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_log WHERE action = 'customer.consent_recorded'
      `,
    );
    // Uma linha, não duas: `audit_log` é a trilha de quem **da casa** mexeu em
    // quê, e a decisão do próprio titular não é isso.
    expect(Number(trilha[0]?.n)).toBe(1);
  });

  // -- exportação -------------------------------------------------------------

  it('a exportação traz o cadastro, o histórico e o encarregado da barbearia', async () => {
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'promo-2026-01',
    });

    const dados = await exportarDadosDoTitular(TENANT, CARLOS);

    expect(dados.cadastro['nome']).toBe('Carlos Souza');
    expect(dados.cadastro['telefone']).toBe('+5571988887777');
    expect(dados.consentimentos).toHaveLength(1);
    expect(dados.barbearia).toEqual({
      nome: 'Domari',
      encarregado: 'Matheus Cardoso <dpo@domari.com.br>',
    });
  });

  it('a exportação não alcança o cliente de outra barbearia', async () => {
    await expect(exportarDadosDoTitular(TENANT, DELA)).rejects.toMatchObject({
      code: 'customer_not_found',
    });
  });

  /**
   * A guarda contra a tabela nova que ninguém lembra de exportar.
   *
   * A lista de nove consultas em `exportarDadosDoTitular` é escrita à mão de
   * propósito — varrer o catálogo pareceria mais completo e traria dado de
   * outra pessoa que só menciona esta. O custo é envelhecer, e este teste é
   * quem cobra: toda tabela com `customer_id` ou entra na exportação, ou entra
   * na lista de exceções **com o motivo escrito aqui**.
   */
  it('toda tabela com dado do cliente está na exportação ou na exceção escrita', async () => {
    const NA_EXPORTACAO = new Set([
      'customers',
      // A nota fiscal em que a pessoa é o tomador (bloco 123). Ela guarda o
      // nome e o CPF congelados na emissão, e não tem `customer_id` — por isso
      // esteve fora da varredura e fora do arquivo.
      'fiscal_invoices',
      'customer_consents',
      'customer_preferences',
      'appointments',
      'orders',
      'customer_ledger',
      'notifications',
      'queue_entries',
      // A lista de espera (bloco 38). "Eu pedi para ser avisado do sábado de
      // manhã e nunca me avisaram" é exatamente o que a exportação responde.
      'waitlist_entries',
      // Os recados (bloco 40). "Eu reclamei da espera e vocês nunca me
      // responderam" é exatamente o que a exportação existe para responder.
      'feedbacks',
      // O saldo de fidelidade (bloco 41). "Quantos pontos eu tinha?" é dado do
      // titular tanto quanto o saldo de fiado.
      'loyalty_entries',
      // Os pacotes (bloco 42). "Eu comprei cinco cortes e vocês dizem que só
      // restam dois" é a pergunta, e o consumo unidade a unidade é a resposta.
      'customer_packages',
      // As avaliações (bloco 43). O texto que a pessoa escreveu sobre um
      // atendimento é dado dela tanto quanto a anotação da ficha.
      'reviews',
      // O clube (bloco 45). "Quanto eu pago por mês e desde quando" é dado do
      // titular — e `club_uses` fica de fora porque ele não tem `customer_id`:
      // o vínculo é pela assinatura, que já entra.
      'club_subscriptions',
      // O uso do plano (bloco 46): "quando eu usei" é dado do titular tanto
      // quanto o extrato de fidelidade.
      'club_uses',
      // Quem é dependente do plano de outra pessoa tem direito a saber que está
      // coberto e desde quando. O **nome de quem banca** não entra: é terceiro
      // num arquivo que o titular leva embora, como a trilha.
      'club_dependents',
      // A conversa pelo WhatsApp (bloco 55). As duas pontas são dado do
      // titular: "o que vocês têm de mim" inclui o que eu digitei para vocês, e
      // inclui saber se a mensagem que vocês mandaram chegou.
      'whatsapp_inbound',
      'whatsapp_messages',
      // A recusa de marcação online (bloco 60). É decisão sobre o titular,
      // tomada a partir do histórico dele: o fato sai, o score e o limiar não —
      // eles são internos por regra da SPEC §2.13.
      'online_blocks',
      // Bloco 74: a foto do rosto da pessoa é dado dela, e sai no arquivo com
      // o endereço, o momento e se estava no portfólio.
      'customer_photos',
    ]);

    const EXCECOES = new Map([
      /**
       * O disparo de automação é registro **da casa**, não do titular (bloco 56).
       *
       * Ele responde "esta automação funciona?" — quantas saíram e quantas
       * trouxeram alguém de volta —, e o que ele guarda sobre a pessoa é o
       * vínculo e a hora. O conteúdo que ela recebeu já entra na exportação por
       * `whatsapp_messages`, que é onde a mensagem de verdade está.
       *
       * O vínculo some na anonimização pela chave estrangeira `SET NULL`, que é
       * o que separa esta linha de uma cópia de dado pessoal.
       */
      ['automation_sends', 'registro de desempenho da casa; a mensagem entra por whatsapp_messages'],
      /**
       * O alvo de campanha, pela mesma razão do disparo de automação (bloco 57).
       *
       * Ele responde "esta campanha valeu o que custou" — público, enviados,
       * receita atribuída —, e o que guarda sobre a pessoa é o vínculo e a
       * hora. A mensagem que ela recebeu entra na exportação por
       * `whatsapp_messages`, que é onde a mensagem de verdade está, e o vínculo
       * some na anonimização pela chave estrangeira `SET NULL`.
       */
      ['campaign_targets', 'registro de desempenho da casa; a mensagem entra por whatsapp_messages'],
      // Token de sessão é credencial, não dado pessoal: exportá-lo entregaria um
      // acesso vivo num arquivo que o titular recebe por e-mail.
      ['customer_sessions', 'credencial, não dado do titular'],
      // A que barbearia o pedido pertence e quando vence. É registro do
      // processo, e vai na resposta do pedido, não dentro do pacote de dados.
      ['data_requests', 'registro do processo, não conteúdo'],
      /**
       * A comissão do marketplace é contrato entre **duas empresas** (bloco 72).
       *
       * O que a linha guarda sobre a pessoa é o vínculo e a hora; o resto —
       * base, alíquota e fatura — é o termo comercial entre a plataforma e a
       * barbearia, e é nome de terceiro num arquivo que o titular leva embora.
       * É a mesma razão de a trilha ficar de fora e de o vínculo de dependente
       * entrar sem o nome de quem banca.
       *
       * O que interessa ao titular já sai: o canal que o trouxe está em
       * `customers.acquired_via`, e `customers` é a primeira consulta da
       * exportação.
       */
      ['marketplace_attributions', 'termo comercial entre plataforma e barbearia; o canal sai por customers.acquired_via'],
      /**
       * As quatro que a varredura ampliada passou a enxergar por `phone_e164`
       * e que **não** são do titular.
       *
       * Três guardam o telefone de quem trabalha na casa ou da própria loja —
       * dado da barbearia, não do cliente que pede o arquivo dele. A quarta é o
       * desafio de OTP: credencial viva, com cinco minutos de validade, e é a
       * mesma razão pela qual `customer_sessions` fica de fora desde o bloco 31.
       */
      ['locations', 'telefone da loja, não do cliente'],
      ['professionals', 'telefone de quem trabalha na casa'],
      ['staff_users', 'telefone de quem trabalha na casa'],
      ['otp_challenges', 'credencial viva de 5 minutos, como customer_sessions — e apagada por anonimizar_cliente'],
      // Estado operacional de deduplicação: guardam o vínculo e o estado do
      // envio, nunca o texto nem o telefone. O que o titular levaria daqui é
      // "uma mensagem foi tentada", que já está no que a exportação traz do
      // atendimento. E as duas somem em `anonimizar_cliente` (migração 0117).
      ['whatsapp_manual_send_intents', 'intenção de envio: vínculo e estado, sem conteúdo — apagada por anonimizar_cliente'],
      ['notification_send_intents', 'idem: idempotência do aviso automático, sem conteúdo'],
    ]);

    /**
     * As tabelas com `customer_id` **e** as que guardam dado pessoal por outro
     * nome de coluna.
     *
     * Só `customer_id` era o recorte, e ele tem um furo: `fiscal_invoices`
     * guarda `customer_name` e `customer_document` — o CPF congelado no momento
     * da emissão — e **não** tem a coluna que a varredura procura. Ficou fora do
     * arquivo do titular, e `anonimizar_cliente` só a alcança porque alguém
     * escreveu a linha à mão.
     *
     * As colunas desta segunda lista são as que carregam pessoa: nome,
     * documento e telefone. Uma tabela nova que guarde qualquer uma delas passa
     * a ser cobrada aqui mesmo sem `customer_id` — que é o caso que a próxima
     * vez pode não ter quem lembre.
     */
    const tabelas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ table_name: string }[]>`
        SELECT DISTINCT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_name = c.table_name AND t.table_schema = c.table_schema
         WHERE c.table_schema = 'public'
           AND t.table_type = 'BASE TABLE'
           AND c.column_name IN (
             'customer_id',
             'customer_name', 'customer_document', 'customer_phone',
             'phone_e164', 'pending_name'
           )
      `,
    );

    const esquecidas = tabelas
      .map((t) => t.table_name)
      .filter((nome) => !NA_EXPORTACAO.has(nome) && !EXCECOES.has(nome));

    expect(
      esquecidas,
      `tabela com dado de cliente fora da exportação: ${esquecidas.join(', ')}`,
    ).toEqual([]);
  });

  it('nenhuma coluna de customers fica de fora da exportação', async () => {
    /**
     * A rede que faltava, e a que deixou o CPF e o nascimento passarem.
     *
     * A varredura acima compara **tabelas**; esta compara **colunas de
     * `customers`**, que é onde mora o cadastro do titular. `birth_date` entrou
     * no bloco 25 e `tax_id` no 54, e nenhum dos dois estava no arquivo que a
     * pessoa recebe — enquanto `anonimizar_cliente` apaga os dois, justamente
     * por serem dado pessoal dela.
     *
     * O silêncio é o defeito: o arquivo afirmava, por omissão, que a barbearia
     * não guardava o CPF — enquanto ele estava no cadastro e tinha sido impresso
     * na nota que foi à prefeitura. Resposta incompleta com cara de completa é o
     * pior desfecho de um pedido do titular.
     *
     * É o espelho da varredura de catálogo que a 0034 já faz para a
     * anonimização, e a assimetria entre as duas era o buraco.
     */
    const FORA: ReadonlyMap<string, string> = new Map([
      ['id', 'chave técnica; o titular não pede o uuid dele'],
      ['tenant_id', 'de quem é o cadastro, não do cadastro'],
      ['import_id', 'de qual importação veio — operação, não dado da pessoa'],
      ['anonymized_at', 'carimbo da própria exclusão'],
      ['retention_notified_at', 'quando o aviso de retenção saiu; operação da casa'],
      [
        'reliability_override',
        'score interno, e a SPEC §2.13 proíbe mostrá-lo ao cliente — nem ao dono',
      ],
      ['reliability_override_reason', 'anotação interna do balcão sobre a pessoa, não dela'],
      ['reliability_override_by', 'quem do balcão decidiu; nome de terceiro'],
      ['reliability_override_at', 'idem'],
      ['marketing_consent_ip', 'sai por customer_consents, com data e versão do texto'],
      ['marketing_consent_at', 'idem'],
      ['marketing_consent_version', 'idem'],
      ['acquired_via', 'termo comercial entre plataforma e barbearia'],
      ['acquired_at', 'idem'],
      ['notes_updated_at', 'carimbo da anotação interna, que não sai'],
      ['created_at', 'sai como criadoEm'],
      ['updated_at', 'sai como atualizadoEm'],
    ]);

    /**
     * O que a exportação pede, **lido do fonte** e não escrito aqui.
     *
     * Uma lista escrita ao lado seria a que ninguém atualiza — o defeito que
     * esta varredura existe para pegar, cometido dentro dela. A consulta real é
     * a fonte da verdade, e o `c.<coluna>` do `SELECT` é o que se extrai.
     */
    const fonte = readFileSync(
      join(import.meta.dirname, 'lgpd.ts'),
      'utf8',
    );
    const consulta = fonte.slice(
      fonte.indexOf('SELECT c.id, c.name'),
      fonte.indexOf('FROM customers c'),
    );
    const NO_ARQUIVO = new Set(
      // Dígitos entram: `phone_e164` é o nome da coluna, e a primeira versão
      // desta regex não o via — a varredura acusou o telefone como esquecido
      // sobre uma exportação que sempre o levou.
      [...consulta.matchAll(/\bc\.([a-z_0-9]+)/g)].map((m) => m[1] as string),
    );
    expect(NO_ARQUIVO.size, 'não achei a consulta do cadastro em lgpd.ts').toBeGreaterThan(5);

    const colunas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'customers'
      `,
    );

    const esquecidas = colunas
      .map((c) => c.column_name)
      .filter((nome) => !NO_ARQUIVO.has(nome) && !FORA.has(nome));

    expect(
      esquecidas,
      `coluna de customers fora da exportação do titular: ${esquecidas.join(', ')}. ` +
        'Ou ela entra no arquivo, ou entra em FORA com o motivo escrito.',
    ).toEqual([]);
  });

  // -- o pedido do titular ----------------------------------------------------

  it('o pedido nasce com prazo gravado, não calculado na leitura', async () => {
    const agora = new Date('2026-05-01T12:00:00Z');
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export', agora,
    });

    expect(pedido.venceEm.toISOString()).toBe(
      new Date(agora.getTime() + PRAZO_DO_PEDIDO_DIAS * 86_400_000).toISOString(),
    );
    expect(pedido.estado).toBe('open');
  });

  it('pedir duas vezes devolve o mesmo pedido, com o mesmo vencimento', async () => {
    /**
     * O caso real: o titular manda no WhatsApp, a recepção registra pela ficha,
     * e ele clica no botão da tela dele achando que o primeiro não passou.
     *
     * Duas linhas fariam o mesmo prazo ter duas respostas — e o segundo
     * vencimento seria mais tarde, o que **atrasa** a obrigação em vez de
     * duplicá-la.
     */
    const primeiro = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
      agora: new Date('2026-05-01T12:00:00Z'),
    });
    const segundo = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
      agora: new Date('2026-05-09T12:00:00Z'),
    });

    expect(segundo.id).toBe(primeiro.id);
    expect(segundo.venceEm.toISOString()).toBe(primeiro.venceEm.toISOString());
    expect(await pedidosDoTitular(TENANT)).toHaveLength(1);

    // Tipo diferente é direito diferente, e abre pedido próprio.
    const exclusao = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'deletion',
    });
    expect(exclusao.id).not.toBe(primeiro.id);
  });

  it('pedir para cliente que não existe é recusado, não vira pedido órfão', async () => {
    await expect(
      abrirPedidoDoTitular({
        tenantId: TENANT,
        customerId: '31313131-9999-9999-9999-999999999999',
        tipo: 'export',
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });

  it('atender encerra o pedido e deixa trilha', async () => {
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
    });
    await encerrarPedidoDoTitular({
      tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
    });

    const abertos = await pedidosDoTitular(TENANT);
    expect(abertos).toHaveLength(0);

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log WHERE action LIKE 'lgpd.%'
      `,
    );
    expect(trilha[0]?.action).toBe('lgpd.request_fulfilled');
  });

  it('recusar exige motivo escrito', async () => {
    // A LGPD admite recusa; recusa sem motivo registrado é a que não se defende.
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'deletion',
    });

    await expect(
      encerrarPedidoDoTitular({
        tenantId: TENANT, pedidoId: pedido.id, atendido: false, nota: ' ', ator,
      }),
    ).rejects.toBeInstanceOf(LgpdError);

    await encerrarPedidoDoTitular({
      tenantId: TENANT,
      pedidoId: pedido.id,
      atendido: false,
      nota: 'obrigação fiscal de guarda por cinco anos',
      ator,
    });
    const todos = await pedidosDoTitular(TENANT, true);
    expect(todos[0]).toMatchObject({ estado: 'refused' });
  });

  it('pedido já encerrado não encerra de novo', async () => {
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
    });
    await encerrarPedidoDoTitular({
      tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
    });

    await expect(
      encerrarPedidoDoTitular({
        tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });
});
