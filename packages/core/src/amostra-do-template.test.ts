import { describe, expect, it } from 'vitest';
import {
  EXEMPLO_DA_VARIAVEL,
  VARIAVEIS_DO_AVISO,
  categoriaDoAviso,
  corpoComExemplos,
  exemplosDoCorpo,
  naturezaDe,
  nomeDoAviso,
} from './notificacao.js';
import { BOTOES_DO_AVISO } from './whatsapp.js';
import { TIPOS_DE_NOTIFICACAO } from './notificacao.js';

/**
 * A amostra que acompanha cada variável, sem a qual a Meta recusa o texto.
 *
 * A recusa vem com o nome da política — *"Variáveis de modelo sem texto de
 * amostra"* — e o texto fica rejeitado sem nunca ter sido lido: ela não tem como
 * saber se `{{1}}` é um nome, um valor em reais ou um link.
 *
 * Nada do nosso lado apontava para isso. A submissão respondia sucesso, o estado
 * virava `pendente`, e a rejeição chegava depois pelo painel dela — foi o que
 * aconteceu com o primeiro texto de verdade deste produto.
 */
describe('a amostra que vai para a Meta', () => {
  it('uma por variável do corpo, e nenhuma quando o texto não tem variável', () => {
    expect(exemplosDoCorpo('retorno', 'Seu agendamento está confirmado!')).toEqual([]);
    expect(exemplosDoCorpo('retorno', 'Olá {{1}}!')).toEqual(['Carlos']);
    expect(exemplosDoCorpo('retorno', 'Olá {{1}}, da {{2}}.')).toEqual([
      'Carlos',
      'Barbearia Domari',
    ]);
  });

  it('a mesma posição vale coisas diferentes em avisos diferentes', () => {
    /**
     * `{{2}}` é a hora num lembrete e o nome da casa numa campanha. Uma amostra
     * genérica faria a Meta analisar um texto que não se parece com o que sai —
     * e é pela verossimilhança que ela decide.
     */
    const noLembrete = exemplosDoCorpo('lembrete_24h', 'Oi {{1}}, às {{2}}.');
    const naCampanha = exemplosDoCorpo('retorno', 'Oi {{1}}, na {{2}}.');
    expect(noLembrete[1]).not.toBe(naCampanha[1]);
  });

  it('conta por posição, não por ocorrência', () => {
    // Um texto que usa `{{1}}` duas vezes pede **uma** variável; um que usa só
    // `{{2}}` pede duas, porque a Meta preenche por índice.
    expect(exemplosDoCorpo('retorno', '{{1}}, oi {{1}}!')).toHaveLength(1);
    expect(exemplosDoCorpo('retorno', 'oi {{2}}')).toHaveLength(2);
  });

  it('todo significado declarado tem amostra', () => {
    /**
     * Sem esta guarda, uma variável nova em `VARIAVEIS_DO_AVISO` sairia com a
     * amostra `exemplo` — que é plausível para nada e que a Meta analisa como
     * conteúdo de verdade.
     */
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      for (const qual of VARIAVEIS_DO_AVISO[tipo]) {
        expect(EXEMPLO_DA_VARIAVEL[qual], qual).toBeTruthy();
      }
    }
  });
});

/**
 * O corpo como o cliente vai ler (bloco 96).
 *
 * A tela mostrava a frase crua — "Oi {{1}}, sentimos sua falta na {{2}}" — e
 * pedia que o balcão decidisse, em cima daquilo, se ela estava boa. As chaves
 * duplas são vocabulário da Meta: quem lê "{{1}}" entende que falta alguma
 * coisa, e a decisão que a tela pede é justamente sobre o que **não** falta.
 */
describe('o nome do aviso', () => {
  it('os seis avisos do produto têm nome escrito', () => {
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      expect(nomeDoAviso(tipo), tipo).not.toContain('_');
    }
  });

  it('o que o produto não conhece vira frase, nunca identificador', () => {
    /**
     * `notification_kind` é enum do banco e é mais largo que a união deste
     * pacote: `pedido_de_avaliacao` está lá desde o bloco 46 e nenhum código o
     * usa. O painel mostrava "manda pedido_de_avaliacao" no balcão.
     */
    expect(nomeDoAviso('pedido_de_avaliacao')).toBe('Pedido de avaliacao');
  });
});

describe('o corpo com as variáveis preenchidas', () => {
  it('preenche por posição, com as mesmas amostras que vão para a Meta', () => {
    expect(corpoComExemplos('retorno', 'Oi {{1}}, sentimos sua falta na {{2}}!')).toBe(
      'Oi Carlos, sentimos sua falta na Barbearia Domari!',
    );
  });

  it('a mesma posição vale coisas diferentes em avisos diferentes', () => {
    // `{{2}}` é a hora num lembrete e o nome da casa numa campanha. Uma prévia
    // que ignorasse o tipo mostraria "às Barbearia Domari".
    expect(corpoComExemplos('lembrete_24h', 'Oi {{1}}, às {{2}}.')).toBe(
      'Oi Carlos, às terça-feira, 19 de agosto às 15:30.',
    );
  });

  it('a mesma posição repetida vira o mesmo valor', () => {
    // A Meta preenche por índice, então `{{1}}` duas vezes é uma variável só —
    // e a prévia precisa dizer a mesma coisa, senão ela mente sobre o envio.
    expect(corpoComExemplos('retorno', '{{1}}, oi {{1}}!')).toBe('Carlos, oi Carlos!');
  });

  it('posição sem significado declarado vira "exemplo", e não fica em chaves', () => {
    /**
     * Deixar `{{4}}` na frase seria a tela dizendo que sabe menos do que sabe —
     * e é exatamente a metade do texto sobre a qual quem lê não consegue
     * decidir nada.
     */
    expect(corpoComExemplos('retorno', 'Oi {{1}}, {{4}}.')).toBe('Oi Carlos, exemplo.');
  });

  it('texto sem variável nenhuma atravessa inteiro', () => {
    expect(corpoComExemplos('retorno', 'Seu agendamento está confirmado!')).toBe(
      'Seu agendamento está confirmado!',
    );
  });

  it('a prévia e a amostra submetida saem do mesmo lugar', () => {
    /**
     * Se a tela e a submissão tivessem conjuntos diferentes, o texto conferido
     * aqui não seria o texto aprovado lá — e a divergência apareceria como uma
     * mensagem que sai diferente do que o balcão leu.
     */
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      const corpo = 'a {{1}} b {{2}} c';
      const preenchido = corpoComExemplos(tipo, corpo);
      for (const amostra of exemplosDoCorpo(tipo, corpo)) {
        expect(preenchido, tipo).toContain(amostra);
      }
    }
  });
});

describe('a categoria que vai para a Meta', () => {
  /**
   * `sua_vez` não tem botão e é a mensagem mais transacional que existe aqui.
   *
   * Enquanto a categoria saía do conjunto de botões, ela ia declarada como
   * marketing — que aprova menos, custa mais por mensagem e é a primeira que a
   * Meta limita quando o número é novo. Botão era um palpite bom para quase
   * tudo e errado justamente para ela.
   */
  it('aviso sem botão continua sendo utilidade quando é transacional', () => {
    expect(BOTOES_DO_AVISO['sua_vez']).toHaveLength(0);
    expect(categoriaDoAviso('sua_vez')).toBe('UTILITY');
  });

  it('só o convite de retorno é marketing', () => {
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      expect(categoriaDoAviso(tipo), tipo).toBe(tipo === 'retorno' ? 'MARKETING' : 'UTILITY');
    }
  });

  it('a categoria acompanha a natureza, que é quem decide opt-out e teto', () => {
    // Duas fontes para a mesma pergunta divergiriam no primeiro aviso novo, e a
    // divergência apareceria como texto reprovado sem explicação.
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      const esperada = naturezaDe(tipo) === 'promocional' ? 'MARKETING' : 'UTILITY';
      expect(categoriaDoAviso(tipo), tipo).toBe(esperada);
    }
  });
});
