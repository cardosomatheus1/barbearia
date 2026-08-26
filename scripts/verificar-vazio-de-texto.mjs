#!/usr/bin/env node
/**
 * O estado vazio que não distingue dois zeros.
 *
 * Três telas ofereciam texto de WhatsApp — a ficha do cliente, Campanhas e
 * Automações — e as três escreviam a mesma frase, *"Nenhum texto aprovado"*,
 * para dois fatos diferentes: a Meta não aprovou nada, ou aprovou e nenhum é do
 * tipo que aquela tela manda. A barbearia tinha dois aprovados (`sua_vez` e o
 * lembrete de 2h), leu a frase, foi ao painel da Meta, viu os dois lá e concluiu
 * que o produto estava quebrado.
 *
 * As três eram internamente coerentes, e por isso nada ficava vermelho: cada
 * uma listava exatamente o que sabia listar. O que faltava era a **diferença**
 * entre o que ela recebeu e o que existe, e o filtro que a apagava era o mesmo
 * nas três — `TIPOS_DE_CAMPANHA` somado ao recorte por estado.
 *
 * Daí a guarda ser derivada da constante e não de uma lista de arquivos: a
 * quarta tela que recortar por `TIPOS_DE_CAMPANHA` nasce cobrada de dizer qual
 * dos dois zeros é o dela. `faltaDeTexto` devolve união, então o `Record` da
 * frase é quem cobra o caso novo — a guarda só cobra que ela seja chamada.
 *
 * Ela lê o fonte, e portanto vê o que está **escrito**, nunca o que é desenhado:
 * uma tela que importasse a frase de um componente compartilhado passaria sem
 * ser conferida. Não existe hoje, e o limite fica escrito aqui — guarda em que
 * se confia mais do que ela alcança é pior que guarda nenhuma.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env['VAZIO_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tira comentário antes de casar: guarda que reprova a frase que a explica é guarda que alguém apaga. */
const semComentario = (texto) =>
  texto
    .replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_todo, antes) => antes);

function telas(dir, achados = []) {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) telas(caminho, achados);
    else if (/\.tsx$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

export function falhasDoVazioDeTexto(raiz = RAIZ) {
  const problemas = [];
  const base = join(raiz, 'apps/web/src/app');

  for (const caminho of telas(base)) {
    const fonte = semComentario(readFileSync(caminho, 'utf8'));
    if (!/TIPOS_DE_CAMPANHA/.test(fonte)) continue;
    if (/faltaDeTexto\s*\(/.test(fonte)) continue;
    problemas.push(
      `${relative(raiz, caminho)} recorta por TIPOS_DE_CAMPANHA e não chama faltaDeTexto: ` +
        'o vazio dela não distingue "a Meta não aprovou nada" de "aprovou, e nenhum é deste tipo"',
    );
  }

  // A frase antiga não pode sobreviver fora do ramo `nada_aprovado`. Escrita
  // solta, ela é exatamente o defeito — e é a forma que ela tinha nas três.
  for (const caminho of telas(base)) {
    const fonte = semComentario(readFileSync(caminho, 'utf8'));
    const solta = /Nenhum texto aprovado/.test(fonte) && !/'nada_aprovado'/.test(fonte);
    if (solta) {
      problemas.push(
        `${relative(raiz, caminho)} escreve "Nenhum texto aprovado" sem passar por ` +
          '`faltaDeTexto(...) === \'nada_aprovado\'`',
      );
    }
  }

  return [...new Set(problemas)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problemas = falhasDoVazioDeTexto();
  if (problemas.length > 0) {
    console.error(`vazio de texto: ${problemas.length} problema(s)\n`);
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('vazio de texto: toda tela que recorta por tipo diz qual dos dois zeros é o dela');
}
