import { describe, expect, it } from 'vitest';
import { EXEMPLO_DA_VARIAVEL, VARIAVEIS_DO_AVISO, exemplosDoCorpo } from './notificacao.js';
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
