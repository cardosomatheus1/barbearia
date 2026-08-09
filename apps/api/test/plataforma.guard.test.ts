import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A guarda dos papéis da plataforma, lida no código-fonte (bloco 33).
 *
 * ## Por que este teste lê o arquivo em vez de chamar a rota
 *
 * A `PlataformaGuard` tem a polaridade **invertida** em relação à
 * `PermissaoGuard` do painel da barbearia: lá a ausência de `@Exige` recusa,
 * aqui a ausência de `@AgeNaConta` libera a leitura. A escolha está justificada
 * na guarda, e tem um custo: **esquecer o decorador numa rota de ação nova é
 * silencioso**. Nenhum teste de comportamento pegaria — a rota funcionaria
 * perfeitamente, só que para quem não deveria.
 *
 * Então a cobrança é sobre o código: toda rota que muda alguma coisa na conta
 * de uma barbearia declara. É o mesmo remédio que `audit.test.ts` usa para o
 * vocabulário da trilha, e pelo mesmo motivo — a lista precisa reprovar quando
 * alguém acrescenta, não quando alguém lembra.
 */

const CONTROLLER = fileURLToPath(
  new URL('../src/plataforma/plataforma.controller.ts', import.meta.url),
);

/** Rotas que mudam estado, com o decorador que as precede (se houver). */
function rotasQueMudam(): readonly { metodo: string; caminho: string; declara: boolean }[] {
  const linhas = readFileSync(CONTROLLER, 'utf8').split('\n');
  const achadas: { metodo: string; caminho: string; declara: boolean }[] = [];

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i] ?? '';
    const rota = /@(Post|Put|Delete|Patch)\('([^']*)'\)/.exec(linha);
    if (!rota) continue;

    // O decorador pode estar em qualquer linha do bloco acima, entre outros
    // decoradores. Duas linhas para trás cobrem o formato que o arquivo usa.
    const acima = `${linhas[i - 1] ?? ''}\n${linhas[i - 2] ?? ''}`;
    achadas.push({
      metodo: rota[1] ?? '',
      caminho: rota[2] ?? '',
      declara: acima.includes('@AgeNaConta()'),
    });
  }

  return achadas;
}

describe('papéis dentro da plataforma', () => {
  it('encontra as rotas de verdade, e não uma lista vazia', () => {
    // A guarda da guarda: uma expressão regular que parasse de casar deixaria
    // todos os testes abaixo verdes sobre nada.
    const rotas = rotasQueMudam();
    expect(rotas.length).toBeGreaterThan(10);
    expect(rotas.some((r) => r.caminho.includes('bloqueio'))).toBe(true);
  });

  it('toda rota que age sobre a conta de uma barbearia exige o papel de operador', () => {
    /**
     * O critério é o caminho: `barbearias/…` e `faturas/…` são as duas famílias
     * que tocam a conta de um cliente. Bloquear, ligar recurso, entrar por
     * suporte, cancelar cobrança — nada disso é trabalho de quem foi contratado
     * para responder chamado e olhar métrica.
     */
    const semDeclarar = rotasQueMudam()
      .filter((r) => r.caminho.includes('barbearias/') || r.caminho.includes('faturas/'))
      .filter((r) => !r.declara)
      .map((r) => `${r.metodo} ${r.caminho}`);

    expect(
      semDeclarar,
      `rota de ação sem @AgeNaConta(): ${semDeclarar.join(', ')}`,
    ).toEqual([]);
  });

  it('o que é da própria conta do admin não exige operador', () => {
    /**
     * Login, logout e o segundo fator **dele** não agem sobre barbearia
     * nenhuma. Exigir `operator` ali trancaria a conta de leitura fora do
     * próprio autenticador — que é o oposto de endurecer.
     */
    const daPropriaConta = rotasQueMudam().filter(
      (r) => !r.caminho.includes('barbearias/') && !r.caminho.includes('faturas/'),
    );

    expect(daPropriaConta.length).toBeGreaterThan(0);
    expect(daPropriaConta.filter((r) => r.declara).map((r) => r.caminho)).toEqual([]);
  });
});
