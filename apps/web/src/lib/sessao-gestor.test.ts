import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * O `sameSite` de cada cookie, que aqui não é detalhe de configuração.
 *
 * A sessão do gestor é `strict` de propósito (bloco 25): ela altera catálogo,
 * equipe e preço, e não acompanha navegação vinda de fora. A consequência
 * aparece na volta da Meta — o navegador não manda o cookie, porque quem
 * iniciou aquela navegação foi `facebook.com`. Em produção isso se pareceu com
 * o produto deslogando sozinho.
 *
 * Os dois cookies da conexão são `lax` pela razão inversa: eles **precisam**
 * atravessar aquela volta, e não autorizam nada — um é um número sorteado, o
 * outro é um código que a Meta expira em segundos e que só vale uma troca.
 *
 * As duas metades se sustentam uma na outra, e cada uma tem um jeito errado de
 * consertar a outra:
 *
 * - passar a sessão para `lax` faria a volta funcionar e abriria CSRF em todo
 *   o painel — trocar uma conexão de WhatsApp por catálogo, equipe e preço;
 * - passar os cookies da conexão para `strict` faria a conexão recusar sempre,
 *   com "estado inválido" numa tela em que a pessoa não errou nada.
 *
 * Nenhum dos dois falha em teste de comportamento, porque os dois produzem um
 * produto que responde. É por isso que a regra está escrita aqui.
 */

const fonte = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'sessao-gestor.ts'),
  'utf8',
);

/** O corpo de uma função de gravação, de onde se lê o `sameSite` que ela usa. */
function corpoDe(funcao: string): string {
  const inicio = fonte.indexOf('export async function ' + funcao);
  expect(inicio, funcao + ' não existe mais em sessao-gestor.ts').toBeGreaterThan(-1);
  const fim = fonte.indexOf('\n}', inicio);
  return fonte.slice(inicio, fim);
}

describe('cookies do painel', () => {
  it('a sessão do gestor é strict, e é ela que protege o painel', () => {
    expect(corpoDe('gravarSessaoGestor')).toContain("sameSite: 'strict'");
  });

  it('os cookies da volta da Meta são lax, senão a conexão recusa sempre', () => {
    for (const funcao of ['guardarEstadoDaMeta', 'guardarCodigoDaMeta']) {
      expect(corpoDe(funcao), funcao).toContain("sameSite: 'lax'");
    }
  });

  it('os dois da Meta valem uma vez: quem lê, apaga', () => {
    for (const funcao of ['tomarEstadoDaMeta', 'tomarCodigoDaMeta']) {
      expect(corpoDe(funcao), funcao).toContain('maxAge: 0');
    }
  });

  it('o código da Meta morre antes de um dia, porque é credencial', () => {
    // A Meta expira o código em segundos. Um cookie que sobrevivesse à sessão
    // do navegador guardaria um segredo já inútil — e um cookie de credencial
    // sem prazo é o que ninguém percebe estar lá.
    const segundos = /const SEGUNDOS_DO_CODIGO = (\d+);/.exec(fonte);
    expect(segundos?.[1]).toBeDefined();
    expect(Number(segundos?.[1])).toBeLessThanOrEqual(300);
  });
});
