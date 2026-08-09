import { describe, expect, it } from 'vitest';
import {
  chaveDoAdquirente,
  chaveDoEstorno,
  FakePaymentProvider,
  type PedidoDePagamento,
} from './pagamento.js';

/**
 * O contrato da cobrança da comanda (bloco 34).
 *
 * O que se prova aqui é o que nenhum teste de integração alcançaria sem uma
 * conta de adquirente no ar: que a chave que sai daqui não colide entre
 * barbearias, e que o provedor de mentira se comporta como o de verdade nos
 * pontos em que a diferença custaria dinheiro.
 */

const PEDIDO: PedidoDePagamento = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  orderId: '22222222-2222-2222-2222-222222222222',
  meio: 'pix',
  valorCents: 4900,
  descricao: 'Corte + barba',
  idempotencyKey: '1',
};

describe('a chave que vai para o adquirente', () => {
  it('duas barbearias mandando "1" não colidem', () => {
    /**
     * O espaço de idempotência do adquirente é o da **conta**, que é uma só
     * para todas as barbearias — pior que o de dentro do produto. Sem escopo, a
     * segunda recepcionista receberia de volta o copia-e-cola da primeira, e o
     * cliente dela pagaria a conta de outra barbearia.
     */
    const outra = { ...PEDIDO, tenantId: '99999999-9999-9999-9999-999999999999' };
    expect(chaveDoAdquirente(PEDIDO)).not.toBe(chaveDoAdquirente(outra));
  });

  it('duas comandas da mesma barbearia também não colidem', () => {
    const outra = { ...PEDIDO, orderId: '33333333-3333-3333-3333-333333333333' };
    expect(chaveDoAdquirente(PEDIDO)).not.toBe(chaveDoAdquirente(outra));
  });

  it('o mesmo pedido produz sempre a mesma chave', () => {
    // É o ponto inteiro: a retentativa da rede precisa cair na cobrança que já
    // existe, não criar a segunda.
    expect(chaveDoAdquirente(PEDIDO)).toBe(chaveDoAdquirente({ ...PEDIDO }));
  });

  it('estorno total e estorno parcial são operações diferentes', () => {
    // Devolver R$ 15 depois de devolver tudo é legítimo. Uma chave só faria a
    // segunda ser engolida como repetição da primeira.
    expect(chaveDoEstorno('pi_1')).not.toBe(chaveDoEstorno('pi_1', 1500));
    expect(chaveDoEstorno('pi_1', 1500)).toBe(chaveDoEstorno('pi_1', 1500));
  });
});

describe('o provedor de mentira', () => {
  it('nasce aguardando, e não pago', () => {
    /**
     * É o estado real de um Pix recém-criado. Um fake que já nascesse pago
     * faria a cadeia de confirmação — fechar comanda, lançar no caixa, gerar
     * comissão — nunca ser exercida pelo caminho que ela percorre na vida real,
     * que é o webhook chegando depois.
     */
    expect(new FakePaymentProvider().proximoEstado).toBe('aguardando');
  });

  it('a repetição devolve a mesma cobrança, não a segunda', async () => {
    const fake = new FakePaymentProvider();
    const primeira = await fake.criarCobranca(PEDIDO);
    const segunda = await fake.criarCobranca(PEDIDO);

    expect(segunda.pagamentoId).toBe(primeira.pagamentoId);
    expect(fake.cobrancas).toHaveLength(1);
  });

  it('a mesma chave em barbearias diferentes gera duas cobranças', async () => {
    // O fake casa pela mesma função do provedor de verdade. Se casasse pela
    // chave nua, a colisão entre barbearias pareceria impossível justamente
    // onde ela é provada.
    const fake = new FakePaymentProvider();
    await fake.criarCobranca(PEDIDO);
    await fake.criarCobranca({ ...PEDIDO, tenantId: '99999999-9999-9999-9999-999999999999' });

    expect(fake.cobrancas).toHaveLength(2);
  });

  it('não inventa vencimento a partir do relógio do processo', async () => {
    /**
     * `core` é determinístico (CLAUDE.md §1), e o teste de arquitetura reprova
     * `Date.now()` aqui dentro. Não é formalismo: um fake que lesse o relógio
     * faria o teste de expiração depender do instante em que ele roda. Quem
     * quer exercer o vencimento diz qual é.
     */
    const fake = new FakePaymentProvider();
    expect((await fake.criarCobranca(PEDIDO)).expiraEm).toBeUndefined();

    fake.expiraEm = new Date('2026-08-09T12:00:00Z');
    const outra = await fake.criarCobranca({ ...PEDIDO, idempotencyKey: '2' });
    expect(outra.expiraEm?.toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  it('Pix devolve copia-e-cola; link devolve endereço', async () => {
    const fake = new FakePaymentProvider();
    const pix = await fake.criarCobranca(PEDIDO);
    const link = await fake.criarCobranca({ ...PEDIDO, meio: 'link', idempotencyKey: '2' });

    expect(pix.pixCopiaECola).toContain('fake');
    expect(pix.url).toBeUndefined();
    expect(link.url).toContain('pay.exemplo');
    expect(link.pixCopiaECola).toBeUndefined();
  });
});
