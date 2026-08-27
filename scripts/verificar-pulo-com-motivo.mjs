#!/usr/bin/env node
/**
 * Porteiro de handler que não diz por que pulou.
 *
 * Seis handlers do worker começavam com `if (!recursoLigado(...)) return;` — um
 * `return` puro. A tarefa era marcada como concluída, o log dizia
 * `tarefa.concluida`, e nada em lugar nenhum registrava que o envio tinha sido
 * cortado por um recurso desligado.
 *
 * O efeito para quem opera é o pior possível, e aconteceu em produção: o balcão
 * apertou "Chamar", a mensagem não chegou ao cliente, e não havia **onde
 * olhar** — nem `notifications`, nem `jobs`, nem log. Duas horas de
 * investigação para descobrir que a resposta não estava sendo escrita.
 *
 * É a regra que este repositório já tinha para outro caminho: *"disparo que não
 * saiu é gravado com o motivo — 'nada foi enviado' sem motivo transforma toda
 * pergunta do dono numa investigação"*. Ela valia para `notifications.reason` e
 * não valia para a fila.
 *
 * ## O que a guarda cobra
 *
 * Toda negação de `recursoLigado` devolve um `PuloDaTarefa`, nunca `return`
 * puro. Ela é derivada da chamada, então o porteiro que alguém escrever no
 * próximo bloco nasce cobrado — inclusive num recurso novo, porque o que casa é
 * `recursoLigado(`, não o nome de um recurso.
 *
 * Ela lê o fonte e vê o que está **escrito**: um porteiro escondido dentro de
 * uma função auxiliar chamada pelo handler passaria sem ser conferido. Não
 * existe hoje, e o limite fica escrito aqui.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env['PULO_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tira comentário antes de casar: guarda que reprova a frase que a explica é guarda que alguém apaga. */
const semComentario = (texto) =>
  texto
    .replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_todo, antes) => antes);

export function falhasDoPuloComMotivo(raiz = RAIZ) {
  const problemas = [];
  const fonte = semComentario(readFileSync(join(raiz, 'packages/jobs/src/worker.ts'), 'utf8'));

  const linhas = fonte.split('\n');
  linhas.forEach((linha, i) => {
    if (!/recursoLigado\(/.test(linha)) return;
    // A declaração do campo no `Contexto` não é chamada.
    if (/readonly recursoLigado/.test(linha)) return;
    if (!/^\s*if \(!\(await/.test(linha)) return;
    if (/return PULO_/.test(linha)) return;
    problemas.push(
      `packages/jobs/src/worker.ts:${i + 1} nega recursoLigado e volta sem motivo: ` +
        'devolva um `PuloDaTarefa` para o laço publicar `tarefa.pulada`',
    );
  });

  // O laço precisa continuar publicando o motivo: sem isto, o handler devolve
  // e ninguém escuta — o silêncio volta com mais passos.
  if (!/fase: 'pulada'/.test(fonte)) {
    problemas.push('o laço deixou de publicar `fase: pulada`, e o pulo voltou a ser silêncio');
  }
  const worker = semComentario(readFileSync(join(raiz, 'apps/worker/src/main.ts'), 'utf8'));
  if (!/'motivo' in evento/.test(worker)) {
    problemas.push('o log do worker deixou de imprimir o motivo do pulo');
  }

  return problemas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problemas = falhasDoPuloComMotivo();
  if (problemas.length > 0) {
    console.error(`pulo sem motivo: ${problemas.length} problema(s)\n`);
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('pulo com motivo: todo porteiro do worker diz por que não fez nada');
}
