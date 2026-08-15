import { describe, expect, it } from 'vitest';
import { O_QUE_FAZER_NA_META, oQueFazerNaMeta } from './whatsapp.js';

/**
 * A recusa da Meta vira caminho, e o caminho precisa apontar para o lugar certo.
 *
 * A frase dela chega à tela desde o bloco 87, e foi o que destravou três
 * diagnósticos seguidos depois de rodadas de dedução. Mas ela responde "o quê"
 * e não "onde se resolve", e a resposta mora num painel de terceiro.
 *
 * O que estes testes prendem é o que o casamento por trecho tem de frágil:
 * frase desconhecida tem que devolver `null` — e não a orientação da primeira
 * regra da lista, que é o erro que um `find` mal escrito produz e que manda a
 * pessoa mexer na conta errada.
 */
describe('o que fazer diante da recusa da Meta', () => {
  it('conta que não cria modelo manda olhar a conta, não o texto', () => {
    const faca = oQueFazerNaMeta('Essa conta do WhatsApp Business não pode criar um novo modelo');
    expect(faca).toContain('conta');
    expect(faca).toContain('teste');
  });

  it('vale na frase em inglês, que é como a Meta responde por padrão', () => {
    expect(oQueFazerNaMeta('This WhatsApp Business Account cannot create a new template')).toBe(
      oQueFazerNaMeta('Essa conta do WhatsApp Business não pode criar um novo modelo'),
    );
  });

  it('frase que ninguém previu devolve nulo, e não a primeira da lista', () => {
    // Sem isto, a tela mandaria mexer na conta do WhatsApp por causa de um erro
    // de rede — com cara de instrução, que é pior que instrução nenhuma.
    expect(oQueFazerNaMeta('Something went wrong')).toBeNull();
    expect(oQueFazerNaMeta('')).toBeNull();
  });

  it('nenhuma regra fica sem frase, e nenhuma frase fica sem gatilho', () => {
    for (const regra of O_QUE_FAZER_NA_META) {
      expect(regra.quando.length).toBeGreaterThan(0);
      expect(regra.faca.length).toBeGreaterThan(20);
      // Trecho em minúsculas, porque a comparação é feita em minúsculas: um
      // trecho com maiúscula nunca casaria, e a regra ficaria morta em silêncio.
      for (const trecho of regra.quando) expect(trecho).toBe(trecho.toLowerCase());
    }
  });
});
