import { describe, expect, it } from 'vitest';
import {
  CONSENTIMENTOS_OPCIONAIS,
  TEXTO_DO_CONSENTIMENTO,
  VERSAO_DO_CONSENTIMENTO,
  versaoDoConsentimento,
} from './politica';

/**
 * O que estes testes seguram é a prova do consentimento.
 *
 * A versão gravada é o que responde "o que essa pessoa leu?" numa contestação.
 * Se ela vier do formulário, vier errada por finalidade, ou vier igual para
 * textos diferentes, a linha do histórico continua existindo e deixa de provar
 * qualquer coisa — que é pior do que não existir, porque tem cara de prova.
 */

describe('a versão do texto de consentimento', () => {
  it('é diferente para cada finalidade, porque o texto é diferente', () => {
    const versoes = CONSENTIMENTOS_OPCIONAIS.map((c) => c.versao);
    expect(new Set(versoes).size).toBe(versoes.length);
  });

  it('recusa finalidade que não está na lista, em vez de inventar uma versão', () => {
    // Devolver `null` é o que faz a ação falhar na borda. Um padrão silencioso
    // aqui gravaria consentimento com versão de outro texto.
    expect(versaoDoConsentimento('finance.tudo')).toBeNull();
    expect(versaoDoConsentimento('')).toBeNull();
  });

  it('não oferece "service": executar o serviço não depende de aceite', () => {
    // Pedir aceite para o tratamento necessário ao contrato confunde o cliente
    // sobre o que é opcional — e é essa distinção que a SPEC §1.8 protege.
    expect(versaoDoConsentimento('service')).toBeNull();
  });

  it('devolve a de marketing igual à que a página do cliente usa', () => {
    // As duas pontas gravam a mesma decisão. Versões diferentes fariam o
    // histórico dizer que a pessoa mudou de texto ao mudar de tela.
    expect(versaoDoConsentimento('marketing')).toBe(VERSAO_DO_CONSENTIMENTO);
  });

  it('mantém texto e versão juntos: nenhum aceite fica sem texto à vista', () => {
    for (const item of CONSENTIMENTOS_OPCIONAIS) {
      expect(item.texto.length).toBeGreaterThan(20);
      expect(item.versao.length).toBeGreaterThan(0);
    }
    expect(CONSENTIMENTOS_OPCIONAIS[0]?.texto).toBe(TEXTO_DO_CONSENTIMENTO);
  });
});
