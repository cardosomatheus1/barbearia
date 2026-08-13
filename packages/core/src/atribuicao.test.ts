import { describe, expect, it } from 'vitest';
import {
  comissaoDoMarketplace,
  decidirAtribuicao,
  JANELA_DE_ATRIBUICAO_DIAS,
  TETO_DA_COMISSAO_BPS,
  type CandidataAAtribuicao,
} from './atribuicao.js';

const HOJE = new Date('2026-08-20T12:00:00Z');
const dias = (n: number) => new Date(HOJE.getTime() - n * 86_400_000);

const candidata = (parcial: Partial<CandidataAAtribuicao> = {}): CandidataAAtribuicao => ({
  criadoEm: HOJE,
  cadastradoEm: HOJE,
  veioPelaBusca: true,
  primeiroAgendamento: true,
  comandaAnterior: false,
  ...parcial,
});

describe('a comissão do marketplace', () => {
  it('sai da base e da alíquota, em centavos inteiros', () => {
    // 20% de R$ 55,00 é R$ 11,00 — o exemplo da SPEC §5.2.
    expect(comissaoDoMarketplace({ baseCents: 5500, feeBps: 2000 })).toBe(1100);
  });

  it('arredonda, e nunca vira float', () => {
    // 15% de R$ 33,33 é 499,95 centavos. Meio centavo não existe.
    expect(comissaoDoMarketplace({ baseCents: 3333, feeBps: 1500 })).toBe(500);
  });

  it('alíquota zero é zero, e é como toda barbearia começa', () => {
    // "Padrão de configuração que mexe em dinheiro é o comportamento anterior."
    expect(comissaoDoMarketplace({ baseCents: 9900, feeBps: 0 })).toBe(0);
  });

  it('não passa do teto nem quando pedem', () => {
    const acima = comissaoDoMarketplace({ baseCents: 10_000, feeBps: 9000 });
    expect(acima).toBe(comissaoDoMarketplace({ baseCents: 10_000, feeBps: TETO_DA_COMISSAO_BPS }));
  });
});

describe('quem gera comissão', () => {
  it('cliente novo que veio pela busca gera', () => {
    expect(decidirAtribuicao(candidata())).toEqual({ atribui: true });
  });

  it('quem já agendava na casa nunca gera, nem agendando pelo marketplace', () => {
    /**
     * É a promessa comercial do produto, e ela é uma promessa negativa:
     * *"cliente que a barbearia já tinha na base nunca gera comissão, mesmo que
     * agende pelo app do marketplace"*.
     */
    expect(decidirAtribuicao(candidata({ primeiroAgendamento: false }))).toEqual({
      atribui: false,
      motivo: 'ja_era_da_base',
    });
  });

  it('quem já tinha comanda também é da base, mesmo sem nunca ter agendado', () => {
    // O cliente que entra sem hora marcada é atendido pelo balcão e nunca teve
    // agendamento. Ele é da casa desde antes, e cobrar por ele seria cobrar
    // sobre base própria.
    expect(decidirAtribuicao(candidata({ comandaAnterior: true }))).toEqual({
      atribui: false,
      motivo: 'ja_era_da_base',
    });
  });

  it('ficha antiga sem histórico não vira cliente novo', () => {
    /**
     * O caso que as duas condições anteriores deixam passar: a base importada
     * do sistema antigo. Nunca agendou, nunca abriu comanda — e mesmo assim
     * aquela pessoa já era da barbearia, porque veio na planilha.
     */
    expect(
      decidirAtribuicao(candidata({ cadastradoEm: dias(JANELA_DE_ATRIBUICAO_DIAS + 1) })),
    ).toEqual({ atribui: false, motivo: 'cadastro_anterior' });
  });

  it('a janela tem as duas pontas', () => {
    // Dentro do prazo, atribui.
    expect(decidirAtribuicao(candidata({ cadastradoEm: dias(JANELA_DE_ATRIBUICAO_DIAS) })).atribui)
      .toBe(true);
    // Agendamento anterior ao próprio cadastro é dado inconsistente, e
    // creditá-lo seria inventar aquisição a partir de um defeito.
    expect(decidirAtribuicao(candidata({ cadastradoEm: dias(-1) }))).toEqual({
      atribui: false,
      motivo: 'cadastro_anterior',
    });
  });

  it('sem passagem pela busca não há o que atribuir', () => {
    expect(decidirAtribuicao(candidata({ veioPelaBusca: false }))).toEqual({
      atribui: false,
      motivo: 'nao_veio_pela_busca',
    });
  });

  it('"já era da base" vence os outros motivos, e a ordem é a promessa', () => {
    /**
     * Um cliente antigo, com comanda, que clicou no marketplace e agendou por
     * lá: o resultado seria o mesmo por qualquer caminho, mas o **motivo** é o
     * que a barbearia lê para conferir se a plataforma cumpre o que vendeu.
     */
    expect(
      decidirAtribuicao(
        candidata({ primeiroAgendamento: false, cadastradoEm: dias(400), veioPelaBusca: true }),
      ),
    ).toEqual({ atribui: false, motivo: 'ja_era_da_base' });
  });
});
