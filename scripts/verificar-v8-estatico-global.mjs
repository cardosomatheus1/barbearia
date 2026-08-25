#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function arquivos(dir) {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : [caminho];
  });
}

function semComentarios(fonte) {
  return fonte.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
}

export function avaliarV8Estatico(fontes, cssAgenda) {
  const falhas = [];
  const exigir = (ok, msg) => { if (!ok) falhas.push(msg); };

  for (const [arquivo, original] of Object.entries(fontes)) {
    const fonte = semComentarios(original);

    for (const m of fonte.matchAll(/<img\b[^>]*>/gs)) {
      exigir(/\balt\s*=/.test(m[0]), `${arquivo}: imagem sem alt`);
    }

    for (const m of fonte.matchAll(/<[^>]+target=["']_blank["'][^>]*>/gs)) {
      exigir(/\brel=["'][^"']*noopener[^"']*["']/.test(m[0]), `${arquivo}: target=_blank sem noopener`);
    }

    exigir(!/tabIndex=\{?[1-9]\d*\}?/.test(fonte), `${arquivo}: tabindex positivo altera a ordem natural do teclado`);
    exigir(!/<(?:div|span)\b[^>]*\bonClick=/s.test(fonte), `${arquivo}: div/span clicável sem semântica nativa`);
    exigir(!/\boutline\s*:\s*none\b/.test(fonte), `${arquivo}: outline:none sem substituição local explícita`);

    for (const m of fonte.matchAll(/<button\b[^>]*className=["']([^"']+)["'][^>]*>/gs)) {
      const classes = m[1];
      const permitido = classes.includes('ui-button') ||
        classes.includes('recursos__botao') ||
        classes.includes('agenda-bloqueio__remover') ||
        classes.includes('hora--botao');
      exigir(permitido, `${arquivo}: botão fora do design system sem exceção auditada (${classes})`);
    }

    for (const m of fonte.matchAll(/<summary\b([^>]*)>/gs)) {
      const attrs = m[1];
      exigir(/className=|aria-label=|aria-labelledby=/.test(attrs), `${arquivo}: summary sem classe/nome auditável`);
    }

    for (const m of fonte.matchAll(/<table\b([^>]*)>/gs)) {
      const attrs = m[1];
      if (/className=["']horarios["']/.test(attrs)) continue;
      const antes = fonte.slice(Math.max(0, m.index - 700), m.index);
      exigir(antes.includes('ui-scroll-x'), `${arquivo}: tabela de dados sem recipiente ui-scroll-x`);
    }
  }

  const agendaResumo = cssAgenda.match(/\.agenda-evento__acoes > summary\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(agendaResumo.includes('width: var(--size-touch)'), 'Agenda: summary de ações não respeita 44px');
  exigir(agendaResumo.includes('height: var(--size-touch)'), 'Agenda: summary de ações não respeita 44px');
  const remover = cssAgenda.match(/\.agenda-bloqueio__remover\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(remover.includes('min-height: var(--size-touch)'), 'Agenda: remover bloqueio não respeita 44px quando exibido');

  return falhas;
}

function fontesDoRepositorio() {
  return Object.fromEntries(
    arquivos('apps/web/src/app')
      .filter((arquivo) => arquivo.endsWith('.tsx'))
      .map((arquivo) => [arquivo, readFileSync(arquivo, 'utf8')]),
  );
}

const direto = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (direto) {
  const fontes = fontesDoRepositorio();
  const falhas = avaliarV8Estatico(fontes, readFileSync('apps/web/src/app/styles/120-agenda-timeline.css', 'utf8'));
  if (falhas.length) {
    console.error(`V8 estático global reprovado (${falhas.length})`);
    for (const falha of falhas) console.error(`- ${falha}`);
    process.exit(1);
  }
  console.log(`V8 estático global: ${Object.keys(fontes).length} TSX sem anti-padrões estruturais conhecidos`);
}
