import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { JANELA_DE_RECUPERACAO_HORAS } from '@barbearia/core';
import {
  atendimentosAAvaliar,
  avaliacoesDoCliente,
  avaliacoesPublicas,
  avaliarAtendimento,
  contestarAvaliacao,
  mediaDoProfissional,
  painelDeAvaliacoes,
  registrarRecuperacao,
  retirarContestacao,
} from './avaliacao.js';
import { anonimizarCliente } from './anonimizacao.js';

/**
 * Avaliações contra Postgres real (bloco 43).
 *
 * O que só o banco prova: que a nota não se reescreve, que ninguém a apaga, que
 * a janela de 48 horas vence sozinha, e que a anonimização solta a pessoa sem
 * levar a média do barbeiro junto.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '43434343-1111-1111-1111-111111111111';
const RIVAL = '43434343-2222-2222-2222-222222222222';
const LOCAL = 'a4343434-0000-0000-0000-000000000001';
const CARLOS = 'c4343434-0000-0000-0000-000000000001';
const BRUNO = 'c4343434-0000-0000-0000-000000000002';
const DONO = 'd4343434-0000-0000-0000-000000000001';
const RUAN = 'e4343434-0000-0000-0000-000000000001';
const CORTE = 'f4343434-0000-0000-0000-000000000001';

const AGORA = new Date('2026-09-20T15:00:00Z');
const ator = { id: DONO, name: 'Matheus' };

const horas = (n: number) => new Date(AGORA.getTime() + n * 3_600_000);

let admin: PrismaClient;
let contador = 0;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/**
 * Um atendimento concluído, que é a única coisa que se pode avaliar.
 *
 * Cada chamada anda uma hora para trás porque a constraint anti-overbooking é
 * de verdade: dois atendimentos do mesmo barbeiro no mesmo intervalo são
 * recusados pelo banco, e é assim que se quer.
 */
async function atendimento(
  cliente = CARLOS,
  status = 'completed',
  quandoFim?: Date,
): Promise<string> {
  contador += 1;
  const id = `0b434343-0000-0000-0000-${String(contador).padStart(12, '0')}`;
  const fim = quandoFim ?? new Date(AGORA.getTime() - contador * 3_600_000);
  const inicio = new Date(fim.getTime() - 1_800_000);
  await exec(`
    INSERT INTO appointments
      (id, tenant_id, location_id, customer_id, professional_id,
       starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
    VALUES ('${id}', '${TENANT}', '${LOCAL}', '${cliente}', '${RUAN}',
            '${inicio.toISOString()}', '${fim.toISOString()}',
            '${inicio.toISOString()}', '${fim.toISOString()}', 5000, '${status}');
    INSERT INTO appointment_services
      (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
    VALUES ('${id}', '${CORTE}', '${TENANT}', 0, 5000, 30);
  `);
  return id;
}

describeIfDb('avaliações', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    contador = 0;
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 5000, 30);
    `);
  });

  // -- a avaliação nasce de um atendimento que aconteceu ------------------------

  it('o cliente avalia o atendimento dele', async () => {
    const id = await atendimento();
    const criada = await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 5, comentario: 'Melhor corte da rua', agora: AGORA,
    });

    expect(criada.publicada).toBe(true);
    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.total).toBe(1);
    expect(painel.ultimas[0]).toMatchObject({ nota: 5, profissionalNome: 'Ruan', servicoNome: 'Corte' });
  });

  it('ninguém avalia o atendimento de outra pessoa', async () => {
    /**
     * A RLS separa barbearias e **não** separa clientes dentro de uma. Sem o
     * filtro por `customer_id`, um id de agendamento vazado bastaria para
     * carimbar uma nota 1 no barbeiro de quem foi atendido — e a média dele
     * cairia por uma pessoa que nunca sentou na cadeira.
     */
    const doCarlos = await atendimento(CARLOS);
    await expect(
      avaliarAtendimento({
        tenantId: TENANT, customerId: BRUNO, appointmentId: doCarlos, nota: 1, agora: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'atendimento_nao_concluido' });

    expect((await painelDeAvaliacoes(TENANT, AGORA)).total).toBe(0);
  });

  it('atendimento cancelado ou faltado não gera nota', async () => {
    for (const status of ['cancelled_customer', 'no_show', 'confirmed']) {
      const id = await atendimento(CARLOS, status);
      await expect(
        avaliarAtendimento({
          tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 5, agora: AGORA,
        }),
      ).rejects.toMatchObject({ code: 'atendimento_nao_concluido' });
    }
  });

  it('o mesmo atendimento não é avaliado duas vezes', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 4, agora: AGORA,
    });
    await expect(
      avaliarAtendimento({
        tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'ja_avaliado' });
  });

  // -- a janela é de recuperação, não de censura --------------------------------

  it('nota baixa não vai para a página pública na hora', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 2, comentario: 'Esperei quarenta minutos', agora: AGORA,
    });

    const publica = await avaliacoesPublicas(TENANT, AGORA);
    expect(publica.avaliacoes).toEqual([]);

    // Mas o gestor vê desde o primeiro segundo, e a média dele já conta.
    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.media).toBe(2);
    expect(painel.aRecuperar).toHaveLength(1);
  });

  it('passadas as 48 horas ela publica sozinha, sem ninguém fazer nada', async () => {
    /**
     * É a regra que torna a janela honesta. Sem ela, deixar o alerta parado no
     * painel seria o jeito de nunca publicar — e o produto viria com um filtro
     * de censura embutido, que é o que a SPEC §4.10 proíbe.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });

    const depois = horas(JANELA_DE_RECUPERACAO_HORAS);
    const publica = await avaliacoesPublicas(TENANT, depois);
    expect(publica.avaliacoes).toHaveLength(1);
    expect(publica.avaliacoes[0]?.nota).toBe(1);
  });

  it('tratar a avaliação não impede a publicação', async () => {
    // O limite ético inteiro: a casa ligou, pediu desculpa e deu crédito — e a
    // nota vai para o ar mesmo assim.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 2, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await registrarRecuperacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, desfecho: 'retrabalho',
      nota: 'Liguei, refiz o corte de graça na quinta.', ator, agora: horas(2),
    });

    const publica = await avaliacoesPublicas(TENANT, horas(JANELA_DE_RECUPERACAO_HORAS));
    expect(publica.avaliacoes).toHaveLength(1);
  });

  it('a média do gestor conta a nota não publicada', async () => {
    /**
     * "A nota interna e a média real **sempre** contam para o gestor", diz a
     * SPEC. Uma média que só somasse o que está no ar seria o painel mentindo
     * para quem decide contratar e demitir.
     */
    for (const nota of [5, 5, 1]) {
      const id = await atendimento();
      await avaliarAtendimento({
        tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota, agora: AGORA,
      });
    }
    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.media).toBe(3.7);
    // A pública ainda não tem o mínimo, porque a nota 1 está segurada.
    expect(painel.mediaPublica).toBeNull();
  });

  it('tratar duas vezes é recusado, e não grava trilha do segundo', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 3, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    const tratar = () =>
      registrarRecuperacao({
        tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, desfecho: 'contato',
        nota: 'Liguei e conversei com ele.', ator, agora: horas(1),
      });

    await tratar();
    await expect(tratar()).rejects.toMatchObject({ code: 'ja_resolvida' });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_log WHERE action = 'review.recovered'
      `,
    );
    expect(Number(trilha[0]!.n)).toBe(1);
  });

  it('tratar sem dizer o que foi feito é recusado', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 2, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await expect(
      registrarRecuperacao({
        tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, desfecho: 'contato', nota: 'ok', ator,
      }),
    ).rejects.toMatchObject({ code: 'motivo_curto' });
  });

  // -- o que não existe --------------------------------------------------------

  it('a aplicação não apaga avaliação', async () => {
    /**
     * A SPEC §4.10 escreve o limite: suprimir review destrói a credibilidade da
     * plataforma e é risco jurídico. Aqui isso não depende de ninguém lembrar —
     * não há permissão, não há rota, e não há privilégio no banco.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });

    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM reviews`),
    ).rejects.toThrow();
    expect((await painelDeAvaliacoes(TENANT, AGORA)).total).toBe(1);
  });

  it('a nota não se reescreve', async () => {
    // `REVOKE DELETE` sozinho não bastaria: `UPDATE SET rating = 5` é apagar a
    // avaliação ruim com outro nome.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 1, comentario: 'Péssimo', agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`UPDATE reviews SET rating = 5 WHERE id = ${alvo.id}::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`UPDATE reviews SET comment = 'Ótimo' WHERE id = ${alvo.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  // -- isolamento ---------------------------------------------------------------

  it('a vizinha não lê as avaliações desta casa', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 5, agora: AGORA,
    });

    expect((await painelDeAvaliacoes(RIVAL, AGORA)).total).toBe(0);
    expect((await avaliacoesPublicas(RIVAL, AGORA)).avaliacoes).toEqual([]);
  });

  it('a ficha do cliente só mostra as avaliações dele', async () => {
    const doCarlos = await atendimento(CARLOS);
    const doBruno = await atendimento(BRUNO);
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: doCarlos, nota: 5, agora: AGORA,
    });
    await avaliarAtendimento({
      tenantId: TENANT, customerId: BRUNO, appointmentId: doBruno, nota: 4, agora: AGORA,
    });

    const dele = await avaliacoesDoCliente(TENANT, CARLOS, AGORA);
    expect(dele).toHaveLength(1);
    expect(dele[0]?.nota).toBe(5);
  });

  // -- a lista de quem ainda pode avaliar ---------------------------------------

  it('só o atendimento concluído e ainda não avaliado aparece para avaliar', async () => {
    const concluido = await atendimento(CARLOS);
    await atendimento(CARLOS, 'cancelled_customer');
    const jaAvaliado = await atendimento(CARLOS);
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: jaAvaliado, nota: 5, agora: AGORA,
    });

    const pendentes = await atendimentosAAvaliar(TENANT, CARLOS, AGORA);
    expect(pendentes.map((p) => p.id)).toEqual([concluido]);
    expect(pendentes[0]).toMatchObject({ servico: 'Corte', profissional: 'Ruan' });
  });

  // -- o indicador do barbeiro --------------------------------------------------

  it('a média do barbeiro é a dele, no período pedido', async () => {
    for (const nota of [5, 3]) {
      const id = await atendimento();
      await avaliarAtendimento({
        tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota, agora: AGORA,
      });
    }
    const resultado = await mediaDoProfissional(
      TENANT, RUAN, new Date(AGORA.getTime() - 86_400_000), horas(1),
    );
    expect(resultado).toEqual({ media: 4, total: 2 });
  });

  // -- LGPD ---------------------------------------------------------------------

  it('anonimizar solta a pessoa e deixa a nota', async () => {
    /**
     * As duas coisas são verdadeiras ao mesmo tempo: a pessoa tem direito a
     * sair, e a média do barbeiro foi calculada com aquela nota — apagá-la
     * reescreveria a história do trabalho de outra pessoa, que não pediu nada.
     *
     * O comentário sai junto do vínculo porque é texto livre, e é onde a pessoa
     * pode ter escrito o próprio nome.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 5, comentario: 'Sou o Carlos e adorei', agora: AGORA,
    });

    await anonimizarCliente({
      tenantId: TENANT, customerId: CARLOS, ator,
      motivo: 'Pedido de exclusão do titular por e-mail.',
    });

    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.total).toBe(1);
    expect(painel.media).toBe(5);
    expect(painel.ultimas[0]).toMatchObject({
      clienteNome: 'Cliente anonimizado',
      comentario: null,
    });
  });

  it('o gatilho de imutabilidade continua ligado depois da anonimização', async () => {
    /**
     * `anonimizar_cliente` desliga o gatilho para poder limpar o comentário, e
     * desligar gatilho é operação **de tabela**, não de sessão. Se ela deixasse
     * o gatilho desligado, a garantia mais importante do bloco — a nota não se
     * reescreve — cairia em silêncio para todo mundo, para sempre.
     */
    const doBruno = await atendimento(BRUNO);
    await avaliarAtendimento({
      tenantId: TENANT, customerId: BRUNO, appointmentId: doBruno, nota: 2, agora: AGORA,
    });

    const dele = await atendimento(CARLOS);
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: dele, nota: 5, agora: AGORA,
    });
    await anonimizarCliente({
      tenantId: TENANT, customerId: CARLOS, ator,
      motivo: 'Pedido de exclusão do titular por e-mail.',
    });

    const doOutro = (await avaliacoesDoCliente(TENANT, BRUNO, AGORA))[0]!;
    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`UPDATE reviews SET rating = 5 WHERE id = ${doOutro.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  // -- o que a revisão de segurança do bloco 43 achou ---------------------------

  it('apagar o cadastro do cliente não leva as avaliações junto', async () => {
    /**
     * Achado da `/security-review`. A ação referencial roda com os direitos do
     * dono da tabela e **não passa** pelo `REVOKE DELETE`: com `ON DELETE
     * CASCADE`, apagar um cadastro destruiria as avaliações em silêncio — o
     * único desfecho que o bloco inteiro existe para impedir, por um caminho
     * que ninguém chamaria de "apagar avaliação".
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });

    // Pelo dono do banco, que é quem uma rotina de manutenção usaria.
    await exec(`DELETE FROM appointments WHERE customer_id = '${CARLOS}'`);
    await exec(`DELETE FROM customers WHERE id = '${CARLOS}'`);

    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.total).toBe(1);
    expect(painel.media).toBe(1);
    expect(painel.ultimas[0]?.clienteNome).toBe('Cliente anonimizado');
  });

  it('a nota não muda de barbeiro', async () => {
    /**
     * Achado da `/security-review`: o gatilho não cobria `professional_id`, que
     * é a coluna que decide **de quem** é a nota 1. Uma correção de atribuição
     * moveria as notas ruins para quem saiu e limparia a média de quem ficou —
     * apagar a avaliação ruim com outro nome, aplicado ao indicador da pessoa.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    const OUTRO = 'e4343434-0000-0000-0000-000000000002';
    await exec(`
      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${OUTRO}', '${TENANT}', '${LOCAL}', 'João');
    `);

    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`
          UPDATE reviews SET professional_id = ${OUTRO}::uuid WHERE id = ${alvo.id}::uuid
        `,
      ),
    ).rejects.toThrow();
  });

  it('apagar o barbeiro solta a nota em vez de travar o cadastro', async () => {
    /**
     * A outra metade da mesma regra: desatar é legítimo — é o que a própria
     * chave estrangeira faz —, e um gatilho que recusasse tornaria impossível
     * apagar um profissional que já foi avaliado.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 5, agora: AGORA,
    });

    await exec(`DELETE FROM appointments WHERE professional_id = '${RUAN}'`);
    await exec(`DELETE FROM professionals WHERE id = '${RUAN}'`);

    const painel = await painelDeAvaliacoes(TENANT, AGORA);
    expect(painel.total).toBe(1);
    expect(painel.ultimas[0]?.profissionalNome).toBeNull();
  });

  it('limpar o comentário continua recusado', async () => {
    // Limpar "o barbeiro me cortou" mantendo a estrela vermelha é censura pela
    // metade, que é censura. Só `anonimizar_cliente` faz isso, e por LGPD.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 1, comentario: 'O barbeiro me cortou', agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`UPDATE reviews SET comment = NULL WHERE id = ${alvo.id}::uuid`,
      ),
    ).rejects.toThrow();
  });


  // -- a contestação (bloco 80) ------------------------------------------------

  it('contestada sai da vitrine e continua na média do gestor', async () => {
    /**
     * A frase do bloco inteiro, provada nos dois lados de uma vez. Uma nota 1
     * junto de três 5 dá média 4,0 — e ela **continua** 4,0 depois de
     * contestada, enquanto a pública sobe para 5,0. Se a suspensão mexesse na
     * média interna, o dono cegaria o próprio termômetro com o botão que o
     * produto lhe deu.
     *
     * Quatro avaliações e não três: com três, tirar uma derrubaria a pública
     * abaixo do mínimo de exibição e o número sumiria — o teste passaria
     * medindo o mínimo do bloco 43, e não a média recalculada.
     */
    for (const nota of [5, 5, 5, 1]) {
      const id = await atendimento();
      await avaliarAtendimento({
        tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota, agora: AGORA,
      });
    }
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;
    expect(alvo.nota).toBe(1);

    // Depois da janela, sem contestar: as quatro estão no ar, e a nota 1 junto.
    const depois = horas(JANELA_DE_RECUPERACAO_HORAS);
    const antes = await avaliacoesPublicas(TENANT, depois);
    expect(antes.total).toBe(4);
    expect(antes.media).toBe(4);

    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'nunca_foi_cliente',
      nota: 'Não temos atendimento no nome dela, e o telefone não é de cliente nosso.',
      ator, agora: horas(2),
    });

    const publica = await avaliacoesPublicas(TENANT, depois);
    expect(publica.total).toBe(3);
    expect(publica.media).toBe(5);

    const painel = await painelDeAvaliacoes(TENANT, depois);
    expect(painel.total).toBe(4);
    expect(painel.media).toBe(4);
    // E as duas médias se afastaram: é essa distância que diz ao dono o tamanho
    // do que ele suspendeu.
    expect(painel.mediaPublica).toBe(5);
    // E o cartão diz por quê — um selo mudo obrigaria a abrir a documentação.
    const contestada = painel.ultimas.find((a) => a.id === alvo.id)!;
    expect(contestada.contestacaoMotivo).toBe('nunca_foi_cliente');
    expect(contestada.publicada).toBe(false);
  });

  it('a nota cinco estrelas de spam sai igual', async () => {
    // `estaPublicada` olha a contestação **antes** da nota alta: elogio comprado
    // publica na hora, e é justamente por isso que ele precisa de saída.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 5, comentario: 'Compre seguidores no site tal', agora: AGORA,
    });
    expect((await avaliacoesPublicas(TENANT, AGORA)).total).toBe(1);

    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).ultimas[0]!;
    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'spam',
      nota: 'Texto de propaganda, o mesmo que apareceu em três barbearias da rua.',
      ator, agora: horas(1),
    });

    expect((await avaliacoesPublicas(TENANT, horas(1))).total).toBe(0);
  });

  it('contestar não afrouxa a imutabilidade da nota nem do texto', async () => {
    // O risco de virar "apagar com outro nome" mora aqui: se a contestação
    // tivesse aberto a linha para reescrita, ela teria trocado um problema por
    // um maior.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id,
      nota: 1, comentario: 'Esperei quarenta minutos', agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;
    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'ofensa',
      nota: 'O comentário completo tem xingamento que não cabe na tela.',
      ator, agora: horas(1),
    });

    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`UPDATE reviews SET rating = 5 WHERE id = ${alvo.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`DELETE FROM reviews WHERE id = ${alvo.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('contestar duas vezes é recusado, e não grava a segunda trilha', async () => {
    // O gatilho do banco recusaria a reescrita com erro de banco no balcão. A
    // guarda de estado é quem transforma isso na frase que o gestor entende.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 2, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    const contestar = (motivo: 'spam' | 'duplicada') =>
      contestarAvaliacao({
        tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo,
        nota: 'A mesma avaliação já tinha entrado no dia anterior.',
        ator, agora: horas(1),
      });

    await contestar('spam');
    await expect(contestar('duplicada')).rejects.toMatchObject({ code: 'ja_contestada' });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint; after: unknown }[]>`
        SELECT count(*) AS n, min(after::text) AS after
          FROM audit_log WHERE action = 'review.contested'
      `,
    );
    expect(Number(trilha[0]!.n)).toBe(1);
    // A trilha guarda o motivo e o tamanho — nunca o texto, que costuma nomear
    // o cliente e que `audit_log` não sabe anonimizar.
    expect(String(trilha[0]!.after)).toContain('spam');
    expect(String(trilha[0]!.after)).not.toContain('avaliação já tinha entrado');
  });

  it('contestar sem motivo da lista, ou sem justificativa, é recusado', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 2, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await expect(
      contestarAvaliacao({
        tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'nao_gostei',
        nota: 'Não gostei desta avaliação.', ator, agora: horas(1),
      }),
    ).rejects.toMatchObject({ code: 'motivo_invalido' });

    await expect(
      contestarAvaliacao({
        tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'spam',
        nota: 'spam', ator, agora: horas(1),
      }),
    ).rejects.toMatchObject({ code: 'motivo_curto' });

    // E nada disso encostou na avaliação.
    expect((await painelDeAvaliacoes(TENANT, AGORA)).ultimas[0]?.contestadaEm).toBeNull();
  });

  it('a vizinha não contesta a avaliação desta casa', async () => {
    // A RLS separa barbearias, e o `UPDATE` sem filtro de tenant no `WHERE` é o
    // que a política precisa barrar sozinha.
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await expect(
      contestarAvaliacao({
        tenantId: RIVAL, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'spam',
        nota: 'Isto não é da minha barbearia, e mesmo assim tentei.',
        ator, agora: horas(1),
      }),
    ).rejects.toMatchObject({ code: 'avaliacao_nao_encontrada' });

    expect((await painelDeAvaliacoes(TENANT, AGORA)).ultimas[0]?.contestadaEm).toBeNull();
  });


  it('retirar a contestação devolve a avaliação ao ar', async () => {
    /**
     * A saída do estado, e é ela que separa contestar de apagar. Sem este
     * caminho a casa que contestasse por engano deixaria a nota fora da vitrine
     * para sempre — e o botão seria "apagar" com um carimbo diferente.
     */
    for (const nota of [5, 5, 5, 1]) {
      const id = await atendimento();
      await avaliarAtendimento({
        tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota, agora: AGORA,
      });
    }
    const depois = horas(JANELA_DE_RECUPERACAO_HORAS);
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;

    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'duplicada',
      nota: 'A mesma avaliação já tinha entrado no dia anterior.', ator, agora: horas(1),
    });
    expect((await avaliacoesPublicas(TENANT, depois)).total).toBe(3);

    await retirarContestacao({ tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, ator });

    const voltou = await avaliacoesPublicas(TENANT, depois);
    expect(voltou.total).toBe(4);
    expect(voltou.media).toBe(4);
    expect((await painelDeAvaliacoes(TENANT, depois)).ultimas.find((a) => a.id === alvo.id)
      ?.contestadaEm).toBeNull();

    // As duas pontas ficam na trilha: "esta nota sumiu por três semanas" tem
    // começo e fim encontráveis.
    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log
         WHERE action IN ('review.contested', 'review.uncontested')
         ORDER BY created_at
      `,
    );
    expect(trilha.map((t) => t.action)).toEqual(['review.contested', 'review.uncontested']);
  });

  it('retirar o que não está contestado é recusado', async () => {
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 5, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).ultimas[0]!;

    await expect(
      retirarContestacao({ tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, ator }),
    ).rejects.toMatchObject({ code: 'nao_contestada' });
    await expect(
      retirarContestacao({ tenantId: RIVAL, locationId: LOCAL, avaliacaoId: alvo.id, ator }),
    ).rejects.toMatchObject({ code: 'avaliacao_nao_encontrada' });
  });

  it('anonimizar tira o nome de dentro da justificativa e deixa o motivo', async () => {
    /**
     * `contest_note` é texto do balcão **sobre quem avaliou**, e a tela sugere
     * uma frase que nomeia a pessoa. Sem o gatilho, quem exerce o direito à
     * exclusão sairia do cadastro e continuaria nomeado ali — numa linha que a
     * imutabilidade da contestação tinha acabado de tornar incorrigível, fora da
     * exportação do titular e fora do alcance de qualquer varredura.
     */
    const id = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: id, nota: 1, agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).aRecuperar[0]!;
    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'nunca_foi_cliente',
      nota: 'O Carlos Souza nunca foi atendido aqui, e o telefone não é de cliente nosso.',
      ator, agora: horas(1),
    });

    await anonimizarCliente({
      tenantId: TENANT, customerId: CARLOS, motivo: 'Pedido de exclusão do titular', ator,
    });

    const depois = (await painelDeAvaliacoes(TENANT, horas(2))).ultimas[0]!;
    expect(depois.contestacaoNota).not.toContain('Carlos Souza');
    // O motivo fica: ele é de lista fechada, não nomeia ninguém, e é o que
    // continua explicando por que a nota está fora do ar.
    expect(depois.contestacaoMotivo).toBe('nunca_foi_cliente');
    expect(depois.contestadaEm).not.toBeNull();
  });


  it('a contestada continua no painel depois de trinta avaliações novas', async () => {
    /**
     * "Retirar a contestação" só existe dentro do cartão da avaliação, e o
     * painel montava as **trinta últimas**. Passadas trinta avaliações novas, a
     * contestada não tinha mais tela nenhuma — a ficha do cliente lista notas e
     * não desenha nem contestar nem retirar.
     *
     * Contestar por engano tirava a nota do perfil público **para sempre**, que
     * é o "apagar com mais passos" que a decisão do bloco 74 existe para
     * impedir. E o dono não percebe pelo número: a média interna continua
     * contando a nota suspensa.
     */
    const primeiro = await atendimento();
    await avaliarAtendimento({
      tenantId: TENANT, customerId: CARLOS, appointmentId: primeiro,
      nota: 1, comentario: 'nunca fui atendido aqui', agora: AGORA,
    });
    const alvo = (await painelDeAvaliacoes(TENANT, AGORA)).ultimas[0]!;

    await contestarAvaliacao({
      tenantId: TENANT, locationId: LOCAL, avaliacaoId: alvo.id, motivo: 'nunca_foi_cliente',
      nota: 'Não temos atendimento no nome dela.', ator, agora: AGORA,
    });

    /**
     * Trinta e cinco avaliações novas, cada uma **um minuto depois da
     * anterior**.
     *
     * O relógio distinto é o que faz a semente produzir o cenário: com todas em
     * `AGORA`, `ORDER BY created_at DESC LIMIT 30` escolhe trinta quaisquer das
     * trinta e seis, e a contestada entrava por sorte — o teste passava com e
     * sem o conserto.
     */
    for (let i = 0; i < 35; i += 1) {
      const id = await atendimento();
      await avaliarAtendimento({
        tenantId: TENANT,
        customerId: CARLOS,
        appointmentId: id,
        nota: 5,
        agora: new Date(AGORA.getTime() + (i + 1) * 60_000),
      });
    }

    const painel = await painelDeAvaliacoes(TENANT, new Date(AGORA.getTime() + 60 * 60_000));
    expect(painel.ultimas.map((a) => a.id)).toContain(alvo.id);
    expect(painel.ultimas.find((a) => a.id === alvo.id)?.contestadaEm).not.toBeNull();
  });

});
