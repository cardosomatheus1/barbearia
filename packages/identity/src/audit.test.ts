import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACOES_DE_DINHEIRO, ACOES_DE_GESTAO, type AuditAction } from './audit.js';

/**
 * A partição do vocabulário é a fronteira de permissão da trilha.
 *
 * A rota de gestão declara `settings.manage` e a de dinheiro declara
 * `finance.view` — e é do `@Exige` que sai a exigência de segundo fator. Uma
 * ação de dinheiro que caísse na lista errada, ou numa nova lista nenhuma,
 * voltaria a entregar caixa e folha sem MFA.
 *
 * Por isso o teste lê o **tipo**, e não uma cópia da lista: ação nova auditada
 * num bloco futuro reprova aqui até alguém decidir de que lado ela fica.
 */

const ESTE = fileURLToPath(new URL('./audit.ts', import.meta.url));

function declaradas(): readonly AuditAction[] {
  const fonte = readFileSync(ESTE, 'utf8')
    // Comentários fora antes de procurar o `;`: há ponto e vírgula no meio de
    // frase em português dentro do próprio union.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const bloco = /export type AuditAction =([\s\S]*?);/.exec(fonte);
  if (!bloco?.[1]) throw new Error('não achei o tipo AuditAction');
  return [...bloco[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] as AuditAction);
}

describe('partição do vocabulário da trilha', () => {
  it('lê o tipo de origem e encontra ações de verdade', () => {
    expect(declaradas().length).toBeGreaterThan(10);
    expect(declaradas()).toContain('cash.closed');
  });

  it('toda ação está em exatamente um dos dois lados', () => {
    const dinheiro = new Set(ACOES_DE_DINHEIRO);
    const gestao = new Set(ACOES_DE_GESTAO);

    const orfas = declaradas().filter((acao) => !dinheiro.has(acao) && !gestao.has(acao));
    expect(orfas).toEqual([]);

    const nosDois = declaradas().filter((acao) => dinheiro.has(acao) && gestao.has(acao));
    expect(nosDois).toEqual([]);
  });

  it('nenhum dos dois lados inventa ação que o tipo não declara', () => {
    const conhecidas = new Set<string>(declaradas());
    const inventadas = [...ACOES_DE_DINHEIRO, ...ACOES_DE_GESTAO].filter(
      (acao) => !conhecidas.has(acao),
    );
    expect(inventadas).toEqual([]);
  });

  it('a trilha de gestão não contém nenhuma ação de caixa, comanda, fiado, comissão ou sinal', () => {
    // O critério escrito, aplicado como teste: se o nome fala de dinheiro, o
    // lado de gestão não pode tê-lo. Sem isto, uma classificação errada passaria
    // pelos testes acima, que só conferem que cada ação está em algum lugar.
    //
    // `deposit.` entrou no bloco 37: o sinal é dinheiro que entra e sai fora da
    // comanda, e `before`/`after` carregam centavos — que é a pergunta única
    // que decide de que lado uma ação fica.
    // `loyalty.` entrou no bloco 41 pelos dois lados da mesma moeda: o ajuste
    // manual **cria** saldo gastável, e mudar o programa define a alíquota com
    // que a casa passa a imprimi-lo. "Quem virou o cashback para 50%?" é
    // pergunta de dinheiro.
    const deDinheiro = /^(cash|order|debt|commission|deposit|loyalty)\./;
    expect(ACOES_DE_GESTAO.filter((acao) => deDinheiro.test(acao))).toEqual([]);
    expect(ACOES_DE_DINHEIRO.filter((acao) => !deDinheiro.test(acao))).toEqual([]);
  });
});
