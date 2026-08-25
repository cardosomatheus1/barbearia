#!/usr/bin/env node
/**
 * Medição pós-`next build` do R5. A guarda estática prova separação de fonte;
 * esta mede o artefato que vai para o navegador.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const raiz = process.cwd();
const next = join(raiz, 'apps/web/.next');
const appPath = join(next, 'app-build-manifest.json');
const buildPath = join(next, 'build-manifest.json');
if (!existsSync(appPath) || !existsSync(buildPath)) {
  console.error('R5 bundle: rode `pnpm --filter @barbearia/web build` antes desta medição');
  process.exit(1);
}
const app = JSON.parse(readFileSync(appPath, 'utf8'));
const build = JSON.parse(readFileSync(buildPath, 'utf8'));

function chave(fragmento) {
  return Object.keys(app.pages ?? {}).find((k) => k === fragmento || k.endsWith(fragmento));
}
const publica = chave('/[slug]/page');
const importar = chave('/admin/importar/page');
if (!publica || !importar) {
  console.error(`R5 bundle: rotas não encontradas no app-build-manifest (${publica}, ${importar})`);
  process.exit(1);
}
const base = [...(build.rootMainFiles ?? [])];
const files = (route) => [...new Set([...base, ...(app.pages[route] ?? [])])].filter((f) => /\.(?:js|css)$/.test(f));
const pubFiles = files(publica);
const admFiles = files(importar);
const pubJs = pubFiles.filter((f) => f.endsWith('.js'));
const pubCss = pubFiles.filter((f) => f.endsWith('.css'));
const admJs = admFiles.filter((f) => f.endsWith('.js'));
const admCss = admFiles.filter((f) => f.endsWith('.css'));
const bytes = (list) => list.reduce((n, f) => {
  const p = join(next, f);
  if (!existsSync(p)) return n;
  return n + gzipSync(readFileSync(p)).length;
}, 0);
const pub = bytes(pubJs);
const pubStyle = bytes(pubCss);
const adm = bytes(admJs);
const admStyle = bytes(admCss);
const exclusivosAdmin = admFiles.filter((f) => !pubFiles.includes(f));
const cssExclusivoAdmin = exclusivosAdmin.filter((f) => f.endsWith('.css'));
if (exclusivosAdmin.length === 0) {
  console.error('R5 bundle: a ilha não gerou chunk exclusivo do admin; confira se foi hoisted para o público');
  process.exit(1);
}
// O histórico do próprio ROADMAP registrou 102 kB para a página pública. Uma
// folga de arredondamento de 2 kB evita falha por metadado do compilador, sem
// permitir que a primeira ilha viaje no pacote anônimo.
if (cssExclusivoAdmin.length === 0) {
  console.error('R5 bundle: o CSS Module da ilha não ficou exclusivo do admin');
  process.exit(1);
}

const tetoPublico = 104 * 1024;
if (pub > tetoPublico) {
  console.error(`R5 bundle: público ${Math.round(pub / 1024)} kB gzip > teto ${Math.round(tetoPublico / 1024)} kB`);
  process.exit(1);
}
console.log(`R5 bundle: público JS ${Math.round(pub/1024)} kB + CSS ${Math.round(pubStyle/1024)} kB gzip; importar JS ${Math.round(adm/1024)} kB + CSS ${Math.round(admStyle/1024)} kB; ${exclusivosAdmin.length} arquivo(s) exclusivos do admin`);
