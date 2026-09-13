#!/usr/bin/env node
/**
 * A lista de telas de `scripts/medir-responsividade.js` é escrita à mão, e o
 * registro de navegação é `apps/web/src/app/admin/secoes.ts`. Duas listas do
 * mesmo conjunto, e a segunda muda quando alguém funde ou renomeia uma tela.
 *
 * O bloco 145 fundiu "Avisos ao cliente" em "Mensagens automáticas": o destino
 * saiu do registro, a rota virou redirecionamento, e a medição continuou
 * pedindo `/admin/avisos`. O portão local passou inteiro; quem reprovou foi o
 * navegador, no segundo job do CI, catorze minutos depois — com
 * "desviou para /admin/automacoes" em quatro larguras.
 *
 * Esta guarda faz as duas perguntas estruturais, sem navegador:
 *
 *   A) todo destino registrado em `secoes.ts` é medido em alguma largura;
 *   B) toda tela que a medição abre ainda **desenha** alguma coisa — uma
 *      `page.tsx` sem `return` é redirecionamento puro, e o print sairia da
 *      tela de destino com o nome da tela que foi embora.
 *
 * O corte foi medido antes de a guarda existir, como manda a regra: com a
 * árvore consertada, (A) acusa 0 de 40 e (B) acusa 0 de 56. Com o defeito do
 * bloco 145 de pé, (B) acusa exatamente 1 — que é o que se quer de um corte.
 *
 * A primeira tentativa de (B) era "a página contém `redirect('/admin`": ela
 * acusou **56 de 56**, porque toda tela do painel redireciona para
 * `/admin/entrar` no caminho não autenticado. Guarda que reprova o legítimo é
 * guarda que alguém desliga na primeira semana.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const ler = (arquivo) => readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
const erros = [];

const medicao = ler('scripts/medir-responsividade.js');
const secoes = ler('apps/web/src/app/admin/secoes.ts');

// Aceita `url: '/admin/x'` e `url: `/admin/x?d=${...}`` — o que interessa é o
// caminho, e a query some antes da comparação.
const medidas = [
  ...new Set(
    [...medicao.matchAll(/url:\s*(`[^`]*`|'[^']*')/g)]
      .map((achado) => achado[1].slice(1, -1).split('?')[0])
      .filter((caminho) => caminho.startsWith('/admin')),
  ),
];

const registradas = [...new Set([...secoes.matchAll(/href:\s*'(\/admin[^']*)'/g)].map((a) => a[1]))];

for (const href of registradas) {
  if (!medidas.includes(href)) {
    erros.push(`A) ${href} está no registro de navegação e nenhuma largura o mede`);
  }
}

/** Resolve o caminho de rota para a `page.tsx`, trocando `${x}` pelo segmento dinâmico. */
function paginaDe(caminho) {
  let pasta = 'apps/web/src/app';
  for (const segmento of caminho.split('/').filter(Boolean)) {
    if (segmento.includes('${')) {
      const alvo = new URL(`../${pasta}`, import.meta.url);
      const dinamico = existsSync(alvo) ? readdirSync(alvo).find((nome) => nome.startsWith('[')) : undefined;
      if (!dinamico) return null;
      pasta = `${pasta}/${dinamico}`;
    } else {
      pasta = `${pasta}/${segmento}`;
    }
  }
  const arquivo = `${pasta}/page.tsx`;
  return existsSync(new URL(`../${arquivo}`, import.meta.url)) ? arquivo : null;
}

for (const caminho of medidas) {
  const arquivo = paginaDe(caminho);
  if (!arquivo) {
    erros.push(`B) a medição abre ${caminho} e não existe page.tsx para essa rota`);
    continue;
  }
  if (!/\breturn\b/.test(ler(arquivo))) {
    erros.push(`B) a medição abre ${caminho}, que só redireciona — o print sairia da tela de destino`);
  }
}

if (erros.length) {
  console.error(`Telas medidas reprovado (${erros.length}):`);
  for (const erro of erros) console.error(`- ${erro}`);
  process.exit(1);
}

console.log(
  `Telas medidas ok: ${registradas.length} destinos do registro medidos, ${medidas.length} telas abertas pela medição ainda desenham.`,
);
