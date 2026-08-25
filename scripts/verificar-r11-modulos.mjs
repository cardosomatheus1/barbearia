#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };
const ler = (p) => readFileSync(p, 'utf8');
const linhas = (p) => ler(p).split('\n').length;

const apiFacade = 'apps/web/src/lib/admin-api.ts';
const apiDir = 'apps/web/src/lib/admin-api';
const acoesFacade = 'apps/web/src/app/admin/acoes.ts';
const acoesDir = 'apps/web/src/app/admin/acoes';
const apiMods = readdirSync(apiDir).filter((n) => n.endsWith('.ts')).sort();
const acaoMods = readdirSync(acoesDir).filter((n) => n.endsWith('.ts')).sort();

exigir(linhas(apiFacade) <= 80, `admin-api.ts voltou a concentrar lógica (${linhas(apiFacade)} linhas)`);
exigir(linhas(acoesFacade) <= 260, `acoes.ts voltou a concentrar lógica (${linhas(acoesFacade)} linhas)`);
exigir(apiMods.length >= 8, `admin-api tem só ${apiMods.length} módulos; domínios voltaram a se misturar`);
exigir(acaoMods.length >= 5, `ações têm só ${acaoMods.length} módulos; domínios voltaram a se misturar`);

let maior = { nome: '', linhas: 0 };
for (const [dir, mods] of [[apiDir, apiMods], [acoesDir, acaoMods]]) {
  for (const nome of mods) {
    const n = linhas(join(dir, nome));
    if (n > maior.linhas) maior = { nome, linhas: n };
    // Alarme, não definição de arquitetura: a responsabilidade continua sendo
    // o critério primário. O teto só impede recriar silenciosamente 4 mil linhas.
    exigir(n <= 1400, `${nome} cresceu para ${n} linhas; reveja a fronteira de domínio`);
  }
}

const apiFacadeSrc = ler(apiFacade);
exigir(!apiFacadeSrc.includes('function chamar'), 'fachada admin-api voltou a implementar HTTP');
exigir(!apiFacadeSrc.includes('const BASE'), 'fachada admin-api voltou a conhecer endereço da API');
exigir(!apiFacadeSrc.includes("export * from './admin-api/core'"), 'fachada expôs BASE/chamar como API pública');
for (const nome of apiMods.filter((n) => n !== 'core.ts')) {
  exigir(apiFacadeSrc.includes(`'./admin-api/${nome.replace(/\.ts$/, '')}'`), `módulo ${nome} não está reexportado pela fachada`);
}


// Nomes públicos não podem colidir entre domínios: `export *` tornaria o símbolo
// ambíguo e a tela descobriria só no build. Tipos reexportados de @barbearia/core
// são ignorados aqui porque já tinham uma única declaração no arquivo original.
const publicos = new Map();
for (const nome of apiMods.filter((n) => n !== 'core.ts')) {
  const src = ler(join(apiDir, nome));
  const nomes = [
    ...src.matchAll(/^export interface (\w+)/gm),
    ...src.matchAll(/^export type (?!\{)(\w+)/gm),
    ...src.matchAll(/^export const (\w+)/gm),
    ...src.matchAll(/^export async function (\w+)/gm),
    ...src.matchAll(/^export function (\w+)/gm),
  ].map((m) => m[1]);
  for (const simbolo of nomes) publicos.set(simbolo, [...(publicos.get(simbolo) ?? []), nome]);
}
for (const [simbolo, onde] of publicos) exigir(onde.length === 1, `símbolo ${simbolo} colide em ${onde.join(', ')}`);
exigir(publicos.size >= 440, `admin-api expõe só ${publicos.size} declarações; superfície pública encolheu sem migração`);

const acoesFacadeSrc = ler(acoesFacade);
exigir(!acoesFacadeSrc.includes('redirect('), 'fachada de ações voltou a conter fluxo/redirect');
const implementadas = new Map();
for (const nome of acaoMods) {
  const src = ler(join(acoesDir, nome));
  for (const m of src.matchAll(/^export async function (\w+)/gm)) {
    const acao = m[1];
    implementadas.set(acao, [...(implementadas.get(acao) ?? []), nome]);
  }
}
for (const [acao, onde] of implementadas) {
  exigir(onde.length === 1, `${acao} foi implementada em ${onde.join(', ')}`);
  exigir(new RegExp(`\\b${acao}\\b`).test(acoesFacadeSrc), `${acao} não está reexportada pela fachada`);
}
exigir(implementadas.size >= 150, `só ${implementadas.size} Server Actions encontradas; alguma superfície sumiu`);

// UI depende das fachadas, não da topologia interna. Se uma página importar um
// módulo de domínio diretamente, renomear a pasta vira mudança de produto.
const caminhar = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? caminhar(p) : [p];
});
for (const arquivo of caminhar('apps/web/src').filter((p) => /\.(ts|tsx)$/.test(p))) {
  if (arquivo.startsWith(`${apiDir}/`) || arquivo.startsWith(`${acoesDir}/`)) continue;
  const src = ler(arquivo);
  exigir(!src.includes('@/lib/admin-api/'), `${arquivo} acoplou UI ao módulo interno de admin-api`);
  exigir(!src.includes('/admin/acoes/'), `${arquivo} acoplou UI ao módulo interno de Server Actions`);
}

if (falhas.length) {
  console.error(`R11 reprovado (${falhas.length})`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log(`R11 ok: admin-api ${apiMods.length} módulos; ações ${acaoMods.length}; ${implementadas.size} Server Actions; maior ${maior.nome} ${maior.linhas} linhas.`);
