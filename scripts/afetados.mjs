#!/usr/bin/env node
/**
 * Quais pacotes precisam ser conferidos, dado o que mudou.
 *
 * Existe para o **laço interno**, não para o fechamento. Mudar um arquivo de
 * `packages/finance` e rodar os dez pacotes é o desperdício que mais se repete
 * dentro de um bloco: no bloco 18 foram cerca de trinta execuções, quase todas
 * conferindo pacote que ninguém tinha tocado.
 *
 * Duas decisões que fazem a diferença entre atalho e ilusão:
 *
 * 1. **O grafo sai dos `package.json`, não de uma lista escrita aqui.** Uma
 *    lista à mão envelhece calada: `packages/finance` nasceu no bloco 18 e
 *    ninguém lembraria de acrescentá-la. Aqui ela aparece sozinha.
 *
 * 2. **Na dúvida, roda tudo.** Mudança fora de um pacote — `scripts/`,
 *    `tsconfig.base.json`, `.github/` — não tem como ser mapeada com
 *    honestidade, e um atalho que erra para menos é pior que nenhum atalho:
 *    ele devolve verde para quem não conferiu.
 *
 * Ele **não** substitui o `pnpm verify`. O Definition of Done continua exigindo
 * o portão inteiro, e o modo rápido diz isso na cara a cada execução.
 *
 *   node scripts/afetados.mjs             # vs. o que está sem commit
 *   node scripts/afetados.mjs origin/main # vs. uma referência
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `{ '@barbearia/finance': { dir: 'packages/finance', deps: [...] } }` */
function lerPacotes() {
  const pacotes = new Map();

  for (const grupo of ['packages', 'apps']) {
    for (const nome of readdirSync(join(RAIZ, grupo))) {
      const manifesto = join(RAIZ, grupo, nome, 'package.json');
      if (!existsSync(manifesto)) continue;

      const json = JSON.parse(readFileSync(manifesto, 'utf8'));
      pacotes.set(json.name, {
        dir: `${grupo}/${nome}`,
        temTeste: Boolean(json.scripts?.test),
        deps: Object.keys(json.dependencies ?? {}).filter((d) => d.startsWith('@barbearia/')),
      });
    }
  }

  return pacotes;
}

/** Quem depende de quem, invertido: mudou `core`, quem precisa rodar? */
function dependentes(pacotes) {
  const invertido = new Map([...pacotes.keys()].map((nome) => [nome, new Set()]));
  for (const [nome, { deps }] of pacotes) {
    for (const dep of deps) invertido.get(dep)?.add(nome);
  }
  return invertido;
}

function mudancas(base) {
  const args = base
    ? ['diff', '--name-only', `${base}...HEAD`]
    : ['status', '--porcelain=v1', '--untracked-files=all'];

  const saida = execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8' });

  return saida
    .split('\n')
    .map((linha) => (base ? linha : linha.slice(3)))
    .map((linha) => linha.trim())
    .filter(Boolean);
}

/**
 * O núcleo da decisão, separado da leitura do git para poder ser testado.
 *
 * Uma coisa que decide **o que vai ser conferido** precisa ela mesma ser
 * conferida: se ela errar para menos, devolve verde sobre código que ninguém
 * rodou — que é pior do que não existir.
 */
export function afetadosPor(arquivos, pacotes = lerPacotes()) {
  const invertido = dependentes(pacotes);
  const comTeste = (n) => pacotes.get(n)?.temTeste;
  const tudo = () => [...pacotes.keys()].filter(comTeste).sort();

  if (arquivos.length === 0) return { todos: false, lista: [] };

  const raizes = new Set();

  for (const arquivo of arquivos) {
    const dono = [...pacotes].find(([, { dir }]) => arquivo.startsWith(`${dir}/`));
    if (dono) {
      raizes.add(dono[0]);
      continue;
    }
    // Mudou algo que não é de um pacote: raiz do repositório, `scripts/`,
    // configuração compartilhada. Não dá para mapear com honestidade.
    return { todos: true, lista: tudo() };
  }

  // Fecho transitivo: mexer em `core` obriga a rodar quem depende dele.
  const alcancados = new Set(raizes);
  const fila = [...raizes];
  while (fila.length > 0) {
    const atual = fila.shift();
    for (const quem of invertido.get(atual) ?? []) {
      if (!alcancados.has(quem)) {
        alcancados.add(quem);
        fila.push(quem);
      }
    }
  }

  return { todos: false, lista: [...alcancados].filter(comTeste).sort() };
}

export const afetados = (base) => afetadosPor(mudancas(base));

export { lerPacotes };

if (import.meta.url === `file://${process.argv[1]}`) {
  const { todos, lista } = afetados(process.argv[2]);
  if (todos) process.stderr.write('mudança fora de pacote: conferindo tudo\n');
  process.stdout.write(lista.join('\n') + (lista.length ? '\n' : ''));
}
