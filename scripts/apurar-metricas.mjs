#!/usr/bin/env node
/**
 * Apura um intervalo de dias para todas as barbearias.
 *
 *   node scripts/apurar-metricas.mjs 2026-09-01 2026-09-30
 *
 * ## Por que este comando existe
 *
 * O worker apura o dia anterior, uma vez por dia. Sozinho, isso significa que o
 * painel da plataforma nasce vazio e leva um mês para ficar útil — e que um
 * worker parado por três dias deixa um buraco permanente na série, porque
 * ninguém volta para trás.
 *
 * As duas coisas seriam lacunas declaradas se o motor não aceitasse dia como
 * parâmetro. Ele aceita de propósito: reapurar o mesmo dia dá o mesmo número, e
 * o `ON CONFLICT` corrige em vez de somar. Faltava só a porta.
 *
 * É comando e não rota: apurar noventa dias de mil barbearias enfileira noventa
 * mil tarefas, e isso não é coisa que se dispara de um botão de painel sem
 * querer.
 */
import { agendarApuracaoDeTodas } from '../packages/jobs/dist/index.js';

const [de, ate] = process.argv.slice(2);
const formato = /^\d{4}-\d{2}-\d{2}$/;

if (!formato.test(de ?? '') || !formato.test(ate ?? '')) {
  console.error('uso: node scripts/apurar-metricas.mjs AAAA-MM-DD AAAA-MM-DD');
  process.exit(2);
}

if (!process.env['DATABASE_URL']) {
  console.error('DATABASE_URL é obrigatória.');
  process.exit(2);
}

const inicio = new Date(`${de}T00:00:00Z`);
const fim = new Date(`${ate}T00:00:00Z`);

if (fim < inicio) {
  console.error('o fim é anterior ao começo.');
  process.exit(2);
}

// Teto explícito: um intervalo digitado errado — 2020 em vez de 2026 — viraria
// dois mil dias vezes o tamanho da base, e a fila levaria dias para vazar.
const dias = Math.round((fim - inicio) / 86_400_000) + 1;
if (dias > 400) {
  console.error(`${dias} dias é mais do que este comando aceita de uma vez (400).`);
  process.exit(2);
}

let enfileiradas = 0;
for (let i = 0; i < dias; i++) {
  const dia = new Date(inicio.getTime() + i * 86_400_000).toISOString().slice(0, 10);
  enfileiradas += await agendarApuracaoDeTodas({ dia });
}

console.log(`${enfileiradas} apuração(ões) enfileirada(s) para ${dias} dia(s).`);
console.log('O worker consome a fila; acompanhe em /plataforma/metricas.');
process.exit(0);
