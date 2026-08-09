import { describe, expect, it } from 'vitest';
import {
  apelidoAnonimo,
  AVISO_DE_RETENCAO_DIAS,
  decidirRetencao,
  RETENCAO_ANOS,
} from './retencao.js';

/**
 * A regra que apaga cadastro sozinha precisa de prova nos dois sentidos.
 *
 * Errar para mais — anonimizar quem ainda vem — destrói a base do cliente e é
 * irreversível. Errar para menos deixa a barbearia guardando dado pessoal sem
 * finalidade, que é o que a lei pune. Nenhum dos dois lados pode ficar sem
 * teste.
 */

const HOJE = new Date('2026-08-09T12:00:00Z');
const DIA = 86_400_000;
const diasAtras = (n: number) => new Date(HOJE.getTime() - n * DIA);

const parado = (dias: number) => ({
  ultimaInteracao: diasAtras(dias),
  avisadoEm: null,
  anonimizadoEm: null,
});

describe('retenção de cadastro sem interação', () => {
  it('não mexe em quem interagiu dentro dos cinco anos', () => {
    expect(decidirRetencao(parado(RETENCAO_ANOS * 365 - 1), HOJE)).toBe('nada');
    expect(decidirRetencao(parado(30), HOJE)).toBe('nada');
  });

  it('avisa o dono ao completar cinco anos, e não anonimiza no mesmo instante', () => {
    // O aviso prévio é a regra 6 da SPEC. Anonimizar direto seria a perda
    // silenciosa que o aviso existe para impedir.
    expect(decidirRetencao(parado(RETENCAO_ANOS * 365), HOJE)).toBe('avisar');
  });

  it('só anonimiza depois dos trinta dias do aviso', () => {
    const base = { ultimaInteracao: diasAtras(2000), anonimizadoEm: null };

    expect(decidirRetencao({ ...base, avisadoEm: diasAtras(1) }, HOJE)).toBe('nada');
    expect(
      decidirRetencao({ ...base, avisadoEm: diasAtras(AVISO_DE_RETENCAO_DIAS - 1) }, HOJE),
    ).toBe('nada');
    expect(
      decidirRetencao({ ...base, avisadoEm: diasAtras(AVISO_DE_RETENCAO_DIAS) }, HOJE),
    ).toBe('anonimizar');
  });

  it('quem voltou depois do aviso não é anonimizado', () => {
    /**
     * O caso que a ordem das perguntas protege, e o pior resultado possível: o
     * dono é avisado, corre atrás, traz o cliente de volta — e o sistema apaga
     * o cadastro assim mesmo porque o aviso venceu.
     */
    expect(
      decidirRetencao(
        {
          ultimaInteracao: diasAtras(2),
          avisadoEm: diasAtras(AVISO_DE_RETENCAO_DIAS + 10),
          anonimizadoEm: null,
        },
        HOJE,
      ),
    ).toBe('nada');
  });

  it('não anonimiza duas vezes', () => {
    expect(
      decidirRetencao(
        { ultimaInteracao: diasAtras(4000), avisadoEm: diasAtras(100), anonimizadoEm: diasAtras(60) },
        HOJE,
      ),
    ).toBe('nada');
  });

  it('a decisão não depende do fuso do processo', () => {
    // A suíte de `core` roda sob `TZ=UTC` e `TZ=Asia/Tokyo`, e este teste é o
    // que quebraria se a contagem passasse por data local em algum ponto.
    const situacao = parado(RETENCAO_ANOS * 365);
    expect(decidirRetencao(situacao, HOJE)).toBe('avisar');
    expect(decidirRetencao(situacao, new Date(HOJE.getTime() + 12 * 3_600_000))).toBe('avisar');
  });
});

describe('o apelido que substitui o nome', () => {
  it('tem o formato que a SPEC escreve', () => {
    expect(apelidoAnonimo('a1b2c3d4-0000-0000-0000-000000000001')).toBe(
      'cliente_anonimizado_a1b2',
    );
  });

  it('é o mesmo toda vez, para o mesmo cadastro', () => {
    // Anonimizar de novo — retentativa da fila, reprocessamento — não pode
    // produzir um segundo nome para a mesma linha.
    const id = '9f8e7d6c-1111-2222-3333-444444444444';
    expect(apelidoAnonimo(id)).toBe(apelidoAnonimo(id));
  });

  it('não deixa nada do nome verdadeiro passar', () => {
    // A prova negativa: o apelido é função do id e só do id. Se alguém um dia
    // passar o nome aqui para "ficar mais legível", este teste não pega — mas o
    // de integração, que confere a linha no banco, pega.
    expect(apelidoAnonimo('00000000-0000-0000-0000-000000000000')).toBe(
      'cliente_anonimizado_0000',
    );
  });
});
