import { describe, expect, it } from 'vitest';
import { lerCsv } from './csv.js';
import {
  CABECALHOS_ACEITOS,
  analisar,
  aplicaveis,
  cabecalhoDoModelo,
  csvDoModelo,
  detectarColunas,
  fraseDoPreview,
  lerNascimento,
  normalizarCabecalho,
} from './importacao.js';

const ANO = 2026;

const analisarTexto = (texto: string, jaExistem: readonly string[] = []) => {
  const csv = lerCsv(texto);
  return analisar({
    csv,
    colunas: detectarColunas(csv.cabecalho),
    jaExistem: new Set(jaExistem),
    anoLimite: ANO,
  });
};

describe('detecção de coluna', () => {
  it('acha nome e telefone no cabeçalho em português', () => {
    expect(detectarColunas(['Nome', 'Telefone'])).toMatchObject({ nome: 0, telefone: 1 });
  });

  it('ignora acento e caixa', () => {
    expect(detectarColunas(['NOME COMPLETO', 'Observações'])).toMatchObject({
      nome: 0,
      observacao: 1,
    });
  });

  it('prefere o celular ao fixo quando existem os dois', () => {
    // O fixo não recebe WhatsApp e não serve para nada neste produto.
    expect(detectarColunas(['Cliente', 'Telefone', 'Celular'])).toMatchObject({
      nome: 0,
      telefone: 2,
    });
  });

  it('casa cabeçalho decorado, do tipo que exportador gosta', () => {
    expect(detectarColunas(['Nome do Cliente (obrigatório)', 'Telefone (WhatsApp)'])).toMatchObject({
      nome: 0,
      telefone: 1,
    });
  });

  it('não deixa "nome" roubar a coluna do nome da mãe', () => {
    const colunas = detectarColunas(['Nome da mãe', 'Nome', 'Celular']);
    expect(colunas.nome).toBe(1);
  });

  it('"Observação do cliente" é observação, não nome', () => {
    // Contém `cliente`, que é alias de nome. Resolver nome antes faria a
    // anotação virar o nome de toda a base.
    const colunas = detectarColunas(['Nome', 'Celular', 'Observação do cliente']);
    expect(colunas.observacao).toBe(2);
    expect(colunas.nome).toBe(0);
  });

  it('uma coluna serve a um campo só', () => {
    // `Telefone do cliente` contém alias de telefone **e** de nome. Sem a
    // reserva, os dois campos apontariam para a mesma coluna e o nome de toda a
    // base viraria o número de telefone.
    const colunas = detectarColunas(['Telefone do cliente']);
    expect(colunas.telefone).toBe(0);
    expect(colunas.nome).toBeNull();
  });

  it('o que não existe volta nulo, não zero', () => {
    // Zero é uma coluna válida. Confundir os dois faria a coluna 0 virar o
    // telefone de todo arquivo que não tem telefone.
    expect(detectarColunas(['Nome'])).toEqual({
      nome: 0,
      telefone: null,
      nascimento: null,
      observacao: null,
    });
  });

  it('acha aniversário escrito de várias formas', () => {
    for (const titulo of ['Nascimento', 'Data de Nascimento', 'Aniversário', 'Birthday']) {
      expect(detectarColunas(['Nome', titulo]).nascimento).toBe(1);
    }
  });
});

describe('data de nascimento', () => {
  it('lê o formato brasileiro', () => {
    expect(lerNascimento('07/09/1985', ANO)).toBe('1985-09-07');
  });

  it('lê o formato de banco de dados', () => {
    expect(lerNascimento('1985-09-07', ANO)).toBe('1985-09-07');
  });

  it('aceita ponto e hífen como separador', () => {
    expect(lerNascimento('07.09.1985', ANO)).toBe('1985-09-07');
    expect(lerNascimento('07-09-1985', ANO)).toBe('1985-09-07');
  });

  it('ano de dois dígitos vira sempre passado', () => {
    // Cliente de barbearia não nasce no futuro.
    expect(lerNascimento('07/09/85', ANO)).toBe('1985-09-07');
    expect(lerNascimento('07/09/05', ANO)).toBe('2005-09-07');
  });

  it('recusa data que o calendário não tem', () => {
    expect(lerNascimento('31/02/1990', ANO)).toBeNull();
    expect(lerNascimento('29/02/1991', ANO)).toBeNull();
  });

  it('aceita 29 de fevereiro em ano bissexto', () => {
    expect(lerNascimento('29/02/1992', ANO)).toBe('1992-02-29');
  });

  it('recusa data no futuro e data anterior a 1900', () => {
    expect(lerNascimento('01/01/2030', ANO)).toBeNull();
    expect(lerNascimento('01/01/1899', ANO)).toBeNull();
  });

  it('recusa o formato americano em vez de adivinhar', () => {
    // 03/04/1990 é ambíguo e não há como perguntar. O que não é ambíguo é
    // 12/25/1990: dia 25 não existe como mês, então recusa.
    expect(lerNascimento('12/25/1990', ANO)).toBeNull();
  });

  it('vazio não é erro, é ausência', () => {
    expect(lerNascimento('', ANO)).toBeNull();
    expect(lerNascimento('   ', ANO)).toBeNull();
  });

  it('texto que não é data devolve nulo', () => {
    expect(lerNascimento('não informado', ANO)).toBeNull();
  });
});

describe('análise da base', () => {
  it('cliente com telefone válido e nome entra como novo', () => {
    const a = analisarTexto('Nome;Celular\nZé da Silva;(71) 98888-7777');
    expect(a.linhas[0]).toMatchObject({ veredito: 'novo', telefone: '+5571988887777' });
  });

  it('os três formatos do mesmo número são a mesma pessoa', () => {
    // É assim que a base do sistema antigo chega: digitada por gente diferente
    // ao longo de seis anos.
    const a = analisarTexto(
      [
        'Nome;Celular',
        'Zé da Silva;(71) 98888-7777',
        'Zé da Silva;71988887777',
        'Zé da Silva;+55 71 98888-7777',
      ].join('\n'),
    );
    expect(a.resumo.novo).toBe(1);
    expect(a.resumo.repetido_no_arquivo).toBe(2);
  });

  it('mesmo telefone com nome diferente vira conflito, não some', () => {
    // Marido e mulher no mesmo celular é caso real. Escolher sozinho apagaria um.
    const a = analisarTexto(
      ['Nome;Celular', 'Zé da Silva;71988887777', 'Ana Paula;71988887777'].join('\n'),
    );
    expect(a.linhas[1]).toMatchObject({ veredito: 'conflito', conflitaCom: 'Zé da Silva' });
  });

  it('acento e caixa não fazem a mesma pessoa virar conflito', () => {
    const a = analisarTexto(
      ['Nome;Celular', 'José Antônio;71988887777', 'JOSE ANTONIO;71988887777'].join('\n'),
    );
    expect(a.resumo.conflito).toBe(0);
    expect(a.resumo.repetido_no_arquivo).toBe(1);
  });

  it('quem já está na base é atualização, não duplicata', () => {
    const a = analisarTexto('Nome;Celular\nZé;71988887777', ['+5571988887777']);
    expect(a.linhas[0]?.veredito).toBe('ja_existe');
  });

  it('telefone inválido não entra, e diz por quê', () => {
    const a = analisarTexto('Nome;Celular\nZé;1234');
    expect(a.linhas[0]).toMatchObject({ veredito: 'telefone_invalido', motivo: 'too_short' });
  });

  it('DDD que não existe é recusado', () => {
    const a = analisarTexto('Nome;Celular\nZé;(20) 98888-7777');
    expect(a.linhas[0]?.motivo).toBe('invalid_br_area_code');
  });

  it('número antigo de oito dígitos ganha o nono e entra', () => {
    // É o caso que mais aparece em base velha, e recusar perderia cliente real.
    const a = analisarTexto('Nome;Celular\nZé;(71) 8888-7777');
    expect(a.linhas[0]).toMatchObject({ veredito: 'novo', telefone: '+5571988887777' });
  });

  it('linha sem nome fica de fora, mesmo com telefone bom', () => {
    // "Cliente" na agenda do barbeiro é mentira, e mentira em agenda é pior que
    // linha faltando.
    const a = analisarTexto('Nome;Celular\n;71988887777');
    expect(a.linhas[0]?.veredito).toBe('sem_nome');
  });

  it('telefone inválido vence a falta de nome no relatório', () => {
    // A ordem existe para a tela: sem telefone a linha é irrecuperável, e é isso
    // que a pessoa precisa ler primeiro.
    const a = analisarTexto('Nome;Celular\n;abc');
    expect(a.linhas[0]?.veredito).toBe('telefone_invalido');
  });

  it('o resumo soma exatamente o total de linhas', () => {
    const a = analisarTexto(
      [
        'Nome;Celular;Nascimento',
        'Zé;71988887777;07/09/1985',
        'Zé;71988887777;',
        'Ana;71977776666;',
        ';71966665555;',
        'Bill;123;',
      ].join('\n'),
    );
    const soma = Object.values(a.resumo).reduce((t, n) => t + n, 0);
    expect(soma).toBe(a.total);
    expect(a.total).toBe(5);
  });

  it('só novo e já-existe são gravados', () => {
    const a = analisarTexto(
      ['Nome;Celular', 'Zé;71988887777', 'Zé;71988887777', 'Ana;abc'].join('\n'),
    );
    expect(aplicaveis(a).map((l) => l.veredito)).toEqual(['novo']);
  });

  it('a observação longa é cortada, não recusada', () => {
    const longa = 'x'.repeat(900);
    const a = analisarTexto(`Nome;Celular;Obs\nZé;71988887777;${longa}`);
    expect(a.linhas[0]?.observacao).toHaveLength(500);
  });

  it('a linha citada é a do arquivo, contando o cabeçalho', () => {
    // A pessoa vai abrir o CSV no Excel para corrigir. Se a tela disser "linha
    // 1" para o primeiro cliente, ela corrige o cabeçalho.
    const a = analisarTexto('Nome;Celular\nZé;abc');
    expect(a.linhas[0]?.linha).toBe(2);
  });

  it('arquivo só com cabeçalho analisa zero linhas sem estourar', () => {
    const a = analisarTexto('Nome;Celular');
    expect(a.total).toBe(0);
    expect(fraseDoPreview(a)).toBe('0 clientes novos');
  });
});

describe('frase do preview', () => {
  it('diz o que a SPEC pede: quantos, quantos duplicados, quantos inválidos', () => {
    const a = analisarTexto(
      [
        'Nome;Celular',
        'Zé;71988887777',
        'Ana;71977776666',
        'Ana;71977776666',
        'Bill;123',
      ].join('\n'),
    );
    expect(fraseDoPreview(a)).toBe('2 clientes novos, 1 duplicado, 1 linha inválida');
  });

  it('não cita o que é zero', () => {
    const a = analisarTexto('Nome;Celular\nZé;71988887777');
    expect(fraseDoPreview(a)).toBe('1 cliente novo');
  });
});

describe('normalização de cabeçalho', () => {
  it('tira acento, caixa e pontuação', () => {
    expect(normalizarCabecalho('Observações:')).toBe('observacoes');
    expect(normalizarCabecalho('  DATA_DE_NASCIMENTO  ')).toBe('data de nascimento');
  });
});

describe('a planilha modelo', () => {
  /**
   * O modelo é gerado do **mesmo** mapa de aliases que a detecção usa, e este
   * teste é o que amarra os dois. Um modelo escrito à mão poderia divergir do
   * parser — e aí o produto entregaria à barbearia um arquivo que ele próprio
   * recusa, que é o pior desfecho possível para uma tela feita para tirar
   * dúvida.
   */
  it('o cabeçalho do modelo é detectado pelo próprio parser', () => {
    const colunas = detectarColunas(cabecalhoDoModelo());
    expect(colunas.nome).not.toBeNull();
    expect(colunas.telefone).not.toBeNull();
    expect(colunas.nascimento).not.toBeNull();
    expect(colunas.observacao).not.toBeNull();
  });

  it('cada coluna do modelo cai num campo diferente', () => {
    // Sem isto, dois campos poderiam disputar a mesma coluna e o modelo teria
    // uma coluna que ninguém lê.
    const colunas = detectarColunas(cabecalhoDoModelo());
    const usados = [colunas.nome, colunas.telefone, colunas.nascimento, colunas.observacao];
    expect(new Set(usados).size).toBe(usados.length);
  });

  it('as linhas de exemplo são conteúdo real, não preenchimento', () => {
    /**
     * Telefone com máscara e sem, nome composto, e uma linha com campo
     * opcional vazio: é o que revela se a importação entende o que a pessoa
     * tem de verdade na planilha antiga. `João da Silva / 11111111111` passa
     * em qualquer parser e não prova nada.
     */
    const csv = csvDoModelo();
    expect(csv).toContain('(71) 98888-7777');
    expect(csv).toContain('+55 71 97777-6666');
    expect(csv.trimEnd().split('\n')).toHaveLength(3);
  });

  it('todo campo do catálogo aparece no modelo', () => {
    // Alias novo entra na tela e no modelo sem ninguém lembrar dos dois.
    expect(cabecalhoDoModelo()).toHaveLength(Object.keys(CABECALHOS_ACEITOS).length);
  });
});
