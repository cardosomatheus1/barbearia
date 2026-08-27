#!/usr/bin/env node
/**
 * A guarda da hora com fuso, provada vermelha.
 *
 * Guarda em que se confia mais do que ela alcança é pior que guarda nenhuma, e
 * os casos abaixo são o que ela promete: pega as três formas de escrever hora,
 * multilinha inclusive; não acusa quem já diz o fuso; não acusa quem mostra só
 * data; e **não** aceita um `timeZone` escrito num comentário.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(raiz, 'scripts/verificar-hora-com-fuso.mjs');
const alvo = 'apps/web/src/app/admin/trilha/page.tsx';
let ok = 0;

function rodar(mutar) {
  const t = mkdtempSync(join(tmpdir(), 'barber-hora-'));
  try {
    const destino = join(t, alvo);
    mkdirSync(dirname(destino), { recursive: true });
    cpSync(join(raiz, alvo), destino);
    mutar(destino);
    return spawnSync(process.execPath, [script], {
      env: { ...process.env, HORA_RAIZ: t },
      encoding: 'utf8',
    });
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

function reprova(nome, mutar) {
  const r = rodar(mutar);
  if (r.status === 0) throw new Error(`${nome}: a guarda aceitou a regressão`);
  ok += 1;
}

function aceita(nome, mutar) {
  const r = rodar(mutar);
  if (r.status !== 0) throw new Error(`${nome}: a guarda reprovou o legítimo\n${r.stderr}`);
  ok += 1;
}

const escrever = (destino, corpo) => writeFileSync(destino, `${readFileSync(destino, 'utf8')}\n${corpo}\n`);

reprova('Intl multilinha sem fuso', (d) =>
  escrever(d, "const x = new Intl.DateTimeFormat('pt-BR', {\n  hour: '2-digit',\n  minute: '2-digit',\n});"));
reprova('toLocaleTimeString sem fuso', (d) =>
  escrever(d, "const y = new Date().toLocaleTimeString('pt-BR');"));
reprova('toLocaleString com hora e sem fuso', (d) =>
  escrever(d, "const z = new Date().toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });"));
// O arquivo real conserta a chamada dele: tirar o `timeZone` de volta reprova.
reprova('o conserto sendo desfeito', (d) =>
  writeFileSync(d, readFileSync(d, 'utf8').replace('    timeZone: fuso,\n', '')));
reprova('fuso escrito só no comentário', (d) =>
  escrever(d, "/* timeZone: fuso */\nconst w = new Date().toLocaleTimeString('pt-BR');"));

aceita('quem diz o fuso', (d) =>
  escrever(d, "const a = new Intl.DateTimeFormat('pt-BR', {\n  timeZone: f,\n  hour: '2-digit',\n});"));
aceita('quem mostra só data', (d) =>
  escrever(d, "const b = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });"));

console.log(`hora com fuso — testes: ${ok}/7`);
