#!/usr/bin/env node
/**
 * Guarda de honestidade do percurso financeiro.
 *
 * O percurso "balcão fecha uma venda" já foi um falso positivo: abria a tela e
 * aceitava `depois === antes`. Esta guarda não tenta substituir o Playwright nem
 * o PostgreSQL; ela impede o teste de voltar a ter um nome maior que a prova.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = process.env['PERCURSO_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const fonte = readFileSync(join(raiz, 'scripts/percorrer.mjs'), 'utf8');
const inicio = fonte.indexOf("await percurso('balcão fecha uma venda'");
const fim = fonte.indexOf("await percurso('dono abre a barbearia e publica'", inicio);
const problemas = [];

if (inicio < 0 || fim < 0) {
  problemas.push('não consegui delimitar o percurso financeiro');
} else {
  const bloco = fonte.slice(inicio, fim);
  const exige = (padrao, msg) => { if (!padrao.test(bloco)) problemas.push(msg); };

  exige(/\/admin\/caixa/, 'percurso não abre/confere o caixa pela tela');
  exige(/openingCents/, 'percurso não sabe abrir um caixa fechado');
  exige(/Abrir comanda avulsa/, 'percurso não cria uma comanda pela tela');
  exige(/Acrescentar item/, 'percurso não acrescenta item pela tela');
  exige(/precoUnitarioCents[^\n]*'37,90'|fill\('input\[name="precoUnitarioCents"\]', '37,90'\)/, 'cenário perdeu o valor conhecido de R$ 37,90');
  exige(/valor0[^\n]*'50,00'|fill\('input\[name="valor0"\]', '50,00'\)/, 'cenário perdeu o dinheiro entregue de R$ 50,00');
  exige(/Receber R\\\$|Receber R\$/, 'percurso não clica no recebimento');
  exige(/order_items/, 'percurso não confere item persistido');
  exige(/order_payments/, 'percurso não confere pagamento persistido');
  exige(/cash_movements/, 'percurso não confere movimento de gaveta');
  exige(/pagamentos__item--troco/, 'percurso não confere o troco renderizado depois do recebimento');
  exige(/12,10/, 'percurso não prende R$ 12,10 também na interface');
  exige(/paid:3790:1210:1/, 'percurso não prende total/troco/sessão da venda');
  exige(/1:5000:cash/, 'percurso não prende o pagamento bruto em dinheiro');
  exige(/1:3790/, 'percurso não prende o líquido que entra na gaveta');
  exige(/Fechar caixa/, 'percurso não fecha o caixa pela tela');
  exige(/closed:0/, 'percurso não exige fechamento com divergência zero');
  exige(/\.item-comanda/, 'passo de item não espera o sinal correto em redirect para a mesma URL');

  if (/depois\s*<\s*antes/.test(bloco) || /count\(\*\).*orders WHERE status = 'paid'/.test(bloco)) {
    problemas.push('voltou a comparação fraca de contagem de vendas sem criar uma venda');
  }
}

if (problemas.length) {
  console.error(`Percurso financeiro E2E: ${problemas.length} problema(s)`);
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('Percurso financeiro E2E: caixa → comanda → item → R$ 50/R$ 37,90 → troco → movimento → fechamento estão presos');
