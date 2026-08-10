import { describe, expect, it } from 'vitest';
import { ACOES, STATUSES, allowedActions } from './attendance.js';
import {
  ACAO_PRINCIPAL,
  ACOES_PESADAS,
  ROTULO_DO_ESTADO,
  VERBO_CURTO,
  VERBO_DA_ACAO,
} from './vocabulario.js';

/**
 * O vocabulário das transições (correção de fluxo, depois do bloco 36).
 *
 * Estes testes existem por um defeito que nenhum teste de tela pegaria: cada
 * tela, sozinha, era coerente. O que estava errado era o produto ter três nomes
 * para a mesma coisa — e isso só aparece quando se olha as três juntas.
 */

describe('todo o vocabulário está preenchido', () => {
  it('toda ação do domínio tem verbo, longo e curto', () => {
    // Ação nova sem nome vira `undefined` no botão — e o defeito só aparece com
    // o cliente na frente, porque o caminho normal não passa por ela.
    for (const acao of ACOES) {
      expect(VERBO_DA_ACAO[acao], `verbo de ${acao}`).toBeTruthy();
      expect(VERBO_CURTO[acao], `verbo curto de ${acao}`).toBeTruthy();
    }
  });

  it('todo estado do domínio tem rótulo', () => {
    for (const estado of STATUSES) {
      expect(ROTULO_DO_ESTADO[estado], `rótulo de ${estado}`).toBeTruthy();
    }
  });

  it('o verbo curto nunca é mais longo que o inteiro', () => {
    // Ele existe para caber onde o outro não cabe. Um "curto" maior seria um
    // segundo nome disfarçado de abreviação — que é o defeito de origem.
    for (const acao of ACOES) {
      expect(VERBO_CURTO[acao].length, acao).toBeLessThanOrEqual(VERBO_DA_ACAO[acao].length);
    }
  });
});

describe('o destaque não oferece o que a máquina de estados recusa', () => {
  it('toda ação principal é permitida no estado dela', () => {
    /**
     * Sem isto, a tela mostraria um botão em destaque que o domínio recusa — e
     * o operador descobriria apertando, com o cliente esperando.
     */
    for (const [estado, acao] of Object.entries(ACAO_PRINCIPAL)) {
      const permitidas = allowedActions(estado as (typeof STATUSES)[number]);
      expect(permitidas, `${estado} → ${acao}`).toContain(acao);
    }
  });

  it('nenhuma ação pesada é destaque', () => {
    // Marcar falta e cancelar tiram dinheiro da casa: nunca podem ser o botão
    // mais fácil de acertar sem querer.
    for (const acao of Object.values(ACAO_PRINCIPAL)) {
      expect(ACOES_PESADAS.has(acao)).toBe(false);
    }
  });

  it('todo estado com ação disponível tem um destaque, ou só ações pesadas', () => {
    /**
     * A regra é "uma ação primária por tela" (CLAUDE.md §5). Estado que tem o
     * que fazer e não diz qual é o próximo passo empurra a decisão para quem
     * opera, num momento em que ele tem um cliente na frente.
     *
     * `no_show` é a exceção escrita: o que sobra ali é desfazer, que é conserto
     * de engano e não o próximo passo de ninguém.
     */
    for (const estado of STATUSES) {
      const permitidas = allowedActions(estado);
      const leves = permitidas.filter((a) => !ACOES_PESADAS.has(a));
      if (leves.length === 0) continue;
      if (estado === 'no_show') continue;
      expect(ACAO_PRINCIPAL[estado], `destaque de ${estado}`).toBeTruthy();
    }
  });
});

describe('o botão e o selo não se confundem', () => {
  it('nenhum verbo é igual ao rótulo de um estado', () => {
    /**
     * Era o caso de "Chegou": botão e selo com a mesma palavra. O operador
     * apertava uma afirmação e recebia a mesma palavra de volta, sem saber se
     * tinha funcionado ou se a tela só estava descrevendo o que já era.
     *
     * O verbo **curto** é exceção deliberada e conferida à parte: em espaço
     * apertado, "Chegou" é o que cabe, e ali o botão está sozinho no cartão.
     */
    const rotulos = new Set(Object.values(ROTULO_DO_ESTADO));
    for (const acao of ACOES) {
      expect(rotulos.has(VERBO_DA_ACAO[acao]), `${acao}: "${VERBO_DA_ACAO[acao]}"`).toBe(false);
    }
  });
});
