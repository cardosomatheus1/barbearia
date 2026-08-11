import { describe, expect, it } from 'vitest';
import {
  ESTADOS_DO_RECADO,
  MAXIMO_DO_RECADO,
  MINIMO_DO_RECADO,
  ROTULO_DO_RECADO,
  ROTULO_DO_TIPO,
  TIPOS_DE_RECADO,
  diasEsperando,
  ordenarTriagem,
  podeRegistrarRecado,
  saidasDoRecado,
  transicaoDoRecado,
  type EstadoDoRecado,
  type RecadoNaFila,
  type TipoDeRecado,
} from './recado.js';

const AGORA = new Date('2026-09-10T12:00:00Z');

const recado = (
  id: string,
  tipo: TipoDeRecado,
  diasAtras: number,
  responsavelId: string | null = null,
): RecadoNaFila => ({
  id,
  tipo,
  estado: 'aberto',
  criadoEm: new Date(AGORA.getTime() - diasAtras * 86_400_000),
  responsavelId,
});

describe('o que o cliente pode mandar', () => {
  it('texto curto demais não vira recado', () => {
    // Três caracteres não dizem nada e ainda ocupam a fila de quem lê.
    expect(podeRegistrarRecado({ tipo: 'sugestao', texto: 'ruim' })).toMatchObject({
      recusa: 'texto_curto',
    });
  });

  it('o piso conta depois de tirar espaço em branco', () => {
    const espacos = ' '.repeat(MINIMO_DO_RECADO + 5);
    expect(podeRegistrarRecado({ tipo: 'sugestao', texto: `${espacos}oi` })).toMatchObject({
      recusa: 'texto_curto',
    });
  });

  it('texto sem teto vira depósito, e a borda recusa', () => {
    expect(
      podeRegistrarRecado({ tipo: 'reclamacao', texto: 'a'.repeat(MAXIMO_DO_RECADO + 1) }),
    ).toMatchObject({ recusa: 'texto_longo' });
  });

  it('tipo que não existe é recusado antes de chegar ao banco', () => {
    expect(podeRegistrarRecado({ tipo: 'processo', texto: 'a'.repeat(50) })).toMatchObject({
      recusa: 'tipo_invalido',
    });
  });

  it('reclamação com texto de verdade passa', () => {
    expect(
      podeRegistrarRecado({ tipo: 'reclamacao', texto: 'A cadeira do fundo está bamba.' }),
    ).toEqual({ aceito: true });
  });
});

describe('todo estado tem saída, menos o que encerra', () => {
  it('encerrado é o único terminal', () => {
    const terminais = ESTADOS_DO_RECADO.filter((e) => saidasDoRecado(e).length === 0);
    expect(terminais).toEqual(['encerrado']);
  });

  it('respondido volta para análise, porque o cliente responde de volta', () => {
    // Sem esta volta, a mesma conversa vira três recados na fila.
    expect(transicaoDoRecado('respondido', 'em_analise')).toBe(true);
  });

  it('encerrado não reabre — encerrar é decisão, não descuido', () => {
    expect(transicaoDoRecado('encerrado', 'aberto')).toBe(false);
    expect(transicaoDoRecado('encerrado', 'em_analise')).toBe(false);
  });

  it('toda saída declarada é um estado que existe', () => {
    for (const estado of ESTADOS_DO_RECADO) {
      for (const saida of saidasDoRecado(estado)) {
        expect(ESTADOS_DO_RECADO).toContain(saida);
      }
    }
  });
});

describe('a ordem da triagem', () => {
  it('reclamação vem antes de elogio mais antigo', () => {
    /**
     * A única decisão de produto desta ordenação. Quem reclamou está
     * insatisfeito **agora**; um elogio de ontem esperando na frente dele é a
     * fila trabalhando contra si mesma.
     */
    const fila = ordenarTriagem([
      recado('elogio-antigo', 'elogio', 9),
      recado('reclamacao-nova', 'reclamacao', 1),
      recado('sugestao', 'sugestao', 5),
    ]);
    expect(fila.map((r) => r.id)).toEqual(['reclamacao-nova', 'sugestao', 'elogio-antigo']);
  });

  it('entre duas reclamações, a mais antiga vem antes', () => {
    // Senão o recado de segunda-feira nunca é lido.
    const fila = ordenarTriagem([
      recado('hoje', 'reclamacao', 0),
      recado('semana-passada', 'reclamacao', 7),
    ]);
    expect(fila.map((r) => r.id)).toEqual(['semana-passada', 'hoje']);
  });

  it('o que já tem dono sai da frente da triagem', () => {
    // Ele não está esperando triagem: está esperando alguém que já sabe que ele
    // existe. Deixá-lo no topo esconde o que ninguém viu ainda.
    const fila = ordenarTriagem([
      recado('com-dono', 'reclamacao', 9, 'ruan'),
      recado('sem-dono', 'elogio', 0),
    ]);
    expect(fila.map((r) => r.id)).toEqual(['sem-dono', 'com-dono']);
  });

  it('ordenar não altera a lista recebida', () => {
    const original = [recado('b', 'elogio', 1), recado('a', 'reclamacao', 2)];
    ordenarTriagem(original);
    expect(original.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('o vocabulário mora aqui, e está completo', () => {
  it('todo tipo e todo estado têm rótulo', () => {
    // Mapa parcial devolve `undefined` no estado raro — e o raro é o que
    // ninguém exercita antes de produção.
    for (const tipo of TIPOS_DE_RECADO) expect(ROTULO_DO_TIPO[tipo]).toBeTruthy();
    for (const estado of ESTADOS_DO_RECADO) expect(ROTULO_DO_RECADO[estado]).toBeTruthy();
  });
});

describe('a espera aparece, mesmo sem prazo', () => {
  it('conta dias inteiros, e nunca negativo', () => {
    const criadoEm = new Date('2026-09-01T12:00:00Z');
    expect(diasEsperando(criadoEm, AGORA)).toBe(9);
    expect(diasEsperando(AGORA, criadoEm)).toBe(0);
  });

  it('recado de hoje aparece com zero, não com um', () => {
    const cedo = new Date('2026-09-10T08:00:00Z');
    expect(diasEsperando(cedo, AGORA)).toBe(0);
  });
});

describe('o produto não apaga reclamação', () => {
  it('não existe estado que signifique "sumiu"', () => {
    /**
     * O limite ético da SPEC §4.10 vale igual aqui, e a primeira guarda é o
     * vocabulário: nenhum estado se chama "descartado" ou "removido". A segunda
     * é o `REVOKE DELETE` da migração 0043, que é a que vale de verdade.
     */
    const proibidos: readonly string[] = ['apagado', 'removido', 'descartado', 'oculto'];
    for (const estado of ESTADOS_DO_RECADO as readonly EstadoDoRecado[]) {
      expect(proibidos).not.toContain(estado);
    }
  });
});
