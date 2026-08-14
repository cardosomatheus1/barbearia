import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "O que é público" é a mesma coisa em toda parte (bloco 80).
 *
 * O predicado da vitrine mora em **três** consultas SQL — a página pública, a
 * página do barbeiro e o card do marketplace —, e cada uma foi escrita no bloco
 * em que aquela tela nasceu. Isso já é uma cópia a mais do que se gostaria; o
 * que não pode acontecer é uma delas ficar para trás.
 *
 * Foi assim que a vitrine copiou o menor preço de todo serviço ativo enquanto a
 * página só mostrava o vendável online. Aqui a consequência seria pior: uma nota
 * contestada continuaria no ar num dos três lugares, e o dono veria a suspensão
 * funcionando na tela que ele abriu e falhando na que o cliente abre.
 *
 * A guarda varre o código e cobra `contested_at IS NULL` toda vez que alguém
 * escrever a regra dos 48 minutos — quer seja numa das três de hoje, quer seja
 * na quarta que o bloco 90 escrever.
 */

const RAIZES = ['scheduling', 'platform', 'crm', 'finance', 'catalog', 'identity'];

function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...arquivos(caminho));
    else if (entrada.name.endsWith('.ts') && !entrada.name.includes('.test.')) {
      achados.push(caminho);
    }
  }
  return achados;
}

describe('a suspensão da vitrine vale nos três lugares', () => {
  it('toda consulta que aplica a janela de 48h exclui a contestada', () => {
    const base = new URL('../../', import.meta.url).pathname;
    const encontradas: string[] = [];

    for (const pacote of RAIZES) {
      let lista: string[];
      try {
        lista = arquivos(join(base, pacote, 'src'));
      } catch {
        continue;
      }

      for (const arquivo of lista) {
        const texto = readFileSync(arquivo, 'utf8');
        const linhas = texto.split('\n');

        linhas.forEach((linha, i) => {
          // A assinatura da regra: a nota que publica na hora, ou a janela.
          if (!/r\.rating >= 4|rating >= 4 OR/.test(linha)) return;
          encontradas.push(`${pacote}:${i + 1}`);

          // A exclusão pode estar na mesma linha ou nas cinco de cima — as
          // consultas são escritas em várias linhas.
          const vizinhanca = linhas.slice(Math.max(0, i - 5), i + 2).join('\n');
          expect(
            vizinhanca.includes('contested_at IS NULL'),
            `${arquivo}:${i + 1} aplica a janela de 48h sem excluir a avaliação contestada`,
          ).toBe(true);
        });
      }
    }

    // A varredura tem que **achar** as três: um `rename` que mudasse a forma da
    // consulta faria este teste passar sem olhar nada.
    expect(encontradas.length).toBeGreaterThanOrEqual(3);
  });
});
