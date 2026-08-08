import { describe, expect, it } from 'vitest';
import { CsvInvalidoError, celula, detectarSeparador, lerCsv } from './csv.js';

describe('separador', () => {
  it('acha a vírgula do exportador em inglês', () => {
    expect(detectarSeparador('nome,telefone\nZé,71988887777')).toBe(',');
  });

  it('acha o ponto e vírgula do Excel em português', () => {
    expect(detectarSeparador('nome;telefone\nZé;71988887777')).toBe(';');
  });

  it('acha a tabulação de quem colou de uma planilha', () => {
    expect(detectarSeparador('nome\ttelefone\nZé\t71988887777')).toBe('\t');
  });

  it('vírgula dentro de aspas não conta como separador', () => {
    // Este é o caso que quebrava: o cabeçalho tem duas vírgulas dentro de um
    // campo só e um `;` de verdade. Contar cru escolheria a vírgula.
    expect(detectarSeparador('"Nome, com, vírgulas";Telefone')).toBe(';');
  });

  it('arquivo de uma coluna só cai no padrão do Excel brasileiro', () => {
    expect(detectarSeparador('telefone\n71988887777')).toBe(';');
  });
});

describe('leitura', () => {
  it('lê cabeçalho e linhas', () => {
    const csv = lerCsv('nome;telefone\nZé;71988887777\nAna;71977776666');
    expect(csv.cabecalho).toEqual(['nome', 'telefone']);
    expect(csv.linhas).toEqual([
      ['Zé', '71988887777'],
      ['Ana', '71977776666'],
    ]);
  });

  it('come o BOM que o Excel do Windows escreve', () => {
    // O cabeçalho **entre aspas** é o caso que prova a remoção do BOM. Sem
    // aspas, `trim()` já engole o U+FEFF sozinho — a primeira versão deste teste
    // passava com e sem a remoção, e portanto não provava nada.
    //
    // Com aspas o estrago é real: o BOM entra no campo antes da aspa de
    // abertura, ela deixa de abrir campo e o cabeçalho vira `"Nome"` com as
    // aspas dentro — que não casa com alias nenhum.
    const csv = lerCsv('﻿"Nome";"Telefone"\nZé;71988887777');
    expect(csv.cabecalho).toEqual(['Nome', 'Telefone']);
  });

  it('aceita CRLF, LF e CR sozinho', () => {
    for (const quebra of ['\r\n', '\n', '\r']) {
      const csv = lerCsv(`nome;telefone${quebra}Zé;71988887777${quebra}Ana;71977776666`);
      expect(csv.linhas).toHaveLength(2);
    }
  });

  it('campo entre aspas guarda o separador dentro', () => {
    const csv = lerCsv('nome;obs\nZé;"corta curto; sem máquina"');
    expect(csv.linhas[0]?.[1]).toBe('corta curto; sem máquina');
  });

  it('campo entre aspas guarda quebra de linha dentro', () => {
    const csv = lerCsv('nome;obs\nZé;"mora longe\nvem de moto"');
    expect(csv.linhas).toHaveLength(1);
    expect(csv.linhas[0]?.[1]).toBe('mora longe\nvem de moto');
  });

  it('aspas dobradas viram uma aspa', () => {
    const csv = lerCsv('nome;obs\nZé;"chama de ""Zezinho"""');
    expect(csv.linhas[0]?.[1]).toBe('chama de "Zezinho"');
  });

  it('linha em branco no meio é separador visual, não registro', () => {
    const csv = lerCsv('nome;telefone\nZé;71988887777\n\n;\nAna;71977776666\n');
    expect(csv.linhas).toHaveLength(2);
  });

  it('linha curta devolve vazio na coluna que faltou, não estoura', () => {
    // Numa base de mil clientes existe sempre a linha estragada. Derrubar o
    // arquivo inteiro por causa dela é o que faz a barbearia desistir.
    const csv = lerCsv('nome;telefone;nascimento\nZé;71988887777');
    expect(celula(csv.linhas[0] ?? [], 2)).toBe('');
  });

  it('linha longa preserva o excedente para quem chamou decidir', () => {
    const csv = lerCsv('nome;telefone\nZé;71988887777;sobra');
    expect(csv.linhas[0]).toHaveLength(3);
  });

  it('espaço em volta do cabeçalho não conta', () => {
    const csv = lerCsv(' nome ; telefone \nZé;71988887777');
    expect(csv.cabecalho).toEqual(['nome', 'telefone']);
  });

  it('respeita o separador pedido quando a detecção erraria', () => {
    const csv = lerCsv('nome,sobrenome;telefone', ';');
    expect(csv.cabecalho).toEqual(['nome,sobrenome', 'telefone']);
  });

  it('arquivo vazio e só-espaços são recusados', () => {
    for (const entrada of ['', '   ', '\n\n']) {
      expect(() => lerCsv(entrada)).toThrow(CsvInvalidoError);
    }
  });

  it('só cabeçalho é arquivo válido com zero linhas', () => {
    const csv = lerCsv('nome;telefone');
    expect(csv.cabecalho).toHaveLength(2);
    expect(csv.linhas).toEqual([]);
  });

  it('aspas que nunca fecham são recusadas em vez de engolir o resto', () => {
    // Engolir o resto do arquivo transformaria oitocentos clientes num campo só,
    // e a importação diria "1 linha lida" sem explicar nada.
    const erro = (() => {
      try {
        lerCsv('nome;obs\nZé;"começou e não fechou\nAna;71977776666');
      } catch (e) {
        return e as CsvInvalidoError;
      }
      return null;
    })();
    expect(erro?.code).toBe('aspas_abertas');
  });
});

describe('célula', () => {
  it('apara o valor', () => {
    expect(celula(['  Zé  '], 0)).toBe('Zé');
  });

  it('coluna não mapeada devolve vazio', () => {
    expect(celula(['Zé'], null)).toBe('');
  });
});
