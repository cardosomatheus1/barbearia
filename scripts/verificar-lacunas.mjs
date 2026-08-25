#!/usr/bin/env node
/**
 * Guarda das lacunas declaradas.
 *
 * A tabela [Lacunas com dependência](ROADMAP.md) e a §7.1 da SPEC eram
 * **documento**, e documento apodrece. Nada no repositório lia nenhuma das
 * duas: dava para fechar o bloco 20 com quatro lacunas apontando para ele e
 * ninguém ficava sabendo.
 *
 * É o mesmo defeito que este projeto já encontrou seis vezes — janela de
 * cancelamento, `blocks`, tamanho de imagem, MFA para dinheiro, permissão que
 * não decidia nada, `schedule_exceptions`. Todas eram regra escrita e não
 * verificada, e todas só apareceram quando alguém foi olhar.
 *
 * A invariante que importa é a quarta: **bloco marcado ✅ não pode ter lacuna
 * apontando para ele**. Com ela, esquecer deixa de ser possível e passa a ser
 * uma suíte vermelha — para fechar o bloco 15 é preciso ou entregar a folga e o
 * bloqueio pontual, ou reapontar a lacuna com motivo escrito.
 *
 * Sem banco, sem rede. Roda no portão do `pnpm verify`.
 *
 * Também responde à pergunta que se faz **ao começar** um bloco:
 *
 *     node scripts/verificar-lacunas.mjs 15
 *
 * lista o que aponta para o bloco 15 antes de escrever a primeira linha. A
 * guarda sozinha só reprova no fim; sem esta consulta, descobrir a lacuna no
 * fechamento significa retrabalho ou uma decisão tomada com pressa.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const roadmap = readFileSync(join(raiz, 'ROADMAP.md'), 'utf8');
const spec = readFileSync(join(raiz, 'SPEC.md'), 'utf8');

const problemas = [];
const falhar = (mensagem) => problemas.push(mensagem);

/** Linhas de uma tabela markdown, já sem cabeçalho e sem a régua. */
function linhasDaTabela(fonte, cabecalho) {
  const inicio = fonte.indexOf(cabecalho);
  if (inicio === -1) return null;

  const linhas = [];
  for (const linha of fonte.slice(inicio).split('\n').slice(2)) {
    if (!linha.startsWith('|')) break;
    // `split('|')` devolve vazios nas pontas; o `slice` os descarta.
    linhas.push(linha.split('|').slice(1, -1).map((celula) => celula.trim()));
  }
  return linhas;
}

/**
 * **Todas** as tabelas de blocos, não a primeira.
 *
 * O ROADMAP tem três: o MVP com a coluna "Estado", e as dos releases
 * seguintes, que ainda não têm coluna de marcação. Ler só a primeira fez este
 * verificador acusar que o bloco 30 "não existe" — ele existe, na terceira
 * tabela. A primeira versão desta guarda tinha o mesmo defeito que ela existe
 * para pegar: olhava só uma parte e concluía sobre o todo.
 */
function todosOsBlocos(fonte) {
  const linhas = [];
  for (const marca of fonte.matchAll(/^\| # \| Bloco[^\n]*\n/gm)) {
    const daTabela = linhasDaTabela(fonte.slice(marca.index), marca[0].trimEnd());
    if (daTabela) linhas.push(...daTabela);
  }
  return linhas.length > 0 ? linhas : null;
}

// ---------------------------------------------------------------------------
// Os blocos
// ---------------------------------------------------------------------------

const blocos = todosOsBlocos(roadmap);

if (!blocos) {
  falhar('não achei a tabela de blocos no ROADMAP.md — o formato mudou?');
}

const feitos = new Set();
const conhecidos = new Set();

for (const [numero, nome, marca] of blocos ?? []) {
  if (!/^\d+$/.test(numero ?? '')) continue;
  conhecidos.add(numero);
  if ((marca ?? '').includes('✅')) feitos.add(numero);
  if (!nome) falhar(`bloco ${numero} está sem descrição`);
  // A coluna "Estado" só existe na tabela do MVP; nas outras, ausência de marca
  // é o normal e não significa nada.

}

// O contador global de blocos deixou de ser prontidão no R7. Os ✅ das tabelas
// continuam sendo histórico de execução e ainda são usados abaixo para impedir
// que uma lacuna aponte para um bloco já fechado. A leitura de prontidão agora
// fica em `scripts/verificar-prontidao.mjs`.

// ---------------------------------------------------------------------------
// As lacunas
// ---------------------------------------------------------------------------

const lacunas = linhasDaTabela(roadmap, '| Lacuna | Pronto | Falta | Bloco |');

if (!lacunas) {
  falhar('não achei a tabela de lacunas no ROADMAP.md — o formato mudou?');
} else if (lacunas.length === 0) {
  falhar('a tabela de lacunas está vazia; se todas fecharam, diga isso por escrito');
}

for (const [nome, pronto, falta, destino] of lacunas ?? []) {
  const onde = `lacuna "${(nome ?? '').slice(0, 48)}"`;

  // 2. As quatro colunas existem e dizem alguma coisa. "Falta: sim" não é
  //    declaração — é a lacuna sumindo dentro da própria tabela.
  if (!nome) falhar('há uma lacuna sem nome');
  if (!pronto || pronto.length < 10) falhar(`${onde}: coluna "Pronto" vazia ou vaga`);
  if (!falta || falta.length < 10) falhar(`${onde}: coluna "Falta" vazia ou vaga`);
  if (!destino) falhar(`${onde}: coluna "Bloco" vazia`);

  const bloco = /^(\d+)\b/.exec(destino ?? '');

  if (!bloco) {
    // 3. Sem bloco é resposta legítima — mas exige motivo, não silêncio.
    if (!/^sem bloco/.test(destino ?? '')) {
      falhar(`${onde}: "Bloco" não é um número nem "sem bloco: <motivo>" — está "${destino}"`);
    } else if ((destino ?? '').length < 40) {
      falhar(`${onde}: diz "sem bloco" sem explicar por quê`);
    }
    continue;
  }

  const numero = bloco[1];

  // 4. **A invariante que impede esquecer.**
  if (feitos.has(numero)) {
    falhar(
      `${onde} aponta para o bloco ${numero}, que já está marcado como concluído. `
        + 'Ou o bloco não fechou de verdade, ou a lacuna fechou e sai da tabela, '
        + 'ou ela passa para outro bloco — com o motivo escrito.',
    );
  }

  // 5. Bloco apontado tem que existir. Um número inventado é lacuna sem destino.
  if (!conhecidos.has(numero)) {
    falhar(`${onde} aponta para o bloco ${numero}, que não existe na tabela de blocos`);
  }
}

// ---------------------------------------------------------------------------
// A SPEC não pode perder a seção que conta a verdade
// ---------------------------------------------------------------------------

// 6. A §7.1 existe e continua apontando para o ROADMAP. Uma spec escrita
//    inteira no presente vira ficção assim que o código começa; a seção é o que
//    impede isso, e apagá-la em silêncio devolveria a spec à ficção.
if (!/# 7\.1 Distância entre esta spec e o que está construído/.test(spec)) {
  falhar('a SPEC perdeu a §7.1 — é ela que diz o que a spec descreve e ainda não existe');
}
if (!/ROADMAP\.md#lacunas-com-dependência-declarada/.test(spec)) {
  falhar('a §7.1 da SPEC não aponta mais para a tabela de lacunas do ROADMAP');
}

// ---------------------------------------------------------------------------
// Consulta: o que aponta para um bloco
// ---------------------------------------------------------------------------

const alvo = process.argv[2];
if (alvo) {
  if (!/^\d+$/.test(alvo)) {
    console.error(`uso: node scripts/verificar-lacunas.mjs [numero-do-bloco]`);
    process.exit(2);
  }

  const doBloco = (lacunas ?? []).filter(([, , , destino]) =>
    new RegExp(`^${alvo}\\b`).test(destino ?? ''),
  );

  const nome = (blocos ?? []).find(([numero]) => numero === alvo)?.[1] ?? '(bloco desconhecido)';
  console.log(`\nBloco ${alvo} — ${nome}`);

  if (doBloco.length === 0) {
    console.log('  nenhuma lacuna aponta para este bloco.\n');
  } else {
    console.log(`  ${doBloco.length} lacuna(s) apontam para este bloco:\n`);
    for (const [lacuna, pronto, falta] of doBloco) {
      console.log(`  • ${lacuna}`);
      console.log(`      já existe: ${pronto}`);
      console.log(`      falta:     ${falta}\n`);
    }
    console.log(
      '  Entregar junto, ou mover com o motivo escrito. O bloco não fecha ✅\n'
        + '  com lacuna apontando para ele.\n',
    );
  }
}

if (problemas.length === 0) {
  const total = (lacunas ?? []).length;
  console.log(`lacunas: ${total} declarada(s), todas com destino válido`);
  process.exit(0);
}

console.error('lacunas: %d problema(s)\n', problemas.length);
for (const problema of problemas) console.error(`  - ${problema}`);
process.exit(1);
