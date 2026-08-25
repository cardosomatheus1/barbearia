#!/usr/bin/env node
/**
 * Criptografia autenticada dos artefatos de backup.
 *
 * Formato Barberdock v1:
 *   8 bytes  magic `BDENC01\n`
 *   12 bytes IV aleatório
 *   16 bytes tag GCM
 *   N bytes  ciphertext
 *
 * A chave nunca vai em argumento de processo: vem de BACKUP_ENCRYPTION_KEY,
 * 32 bytes em base64. AES-256-GCM dá confidencialidade + integridade; um dump
 * alterado ou chave errada reprova antes de ser aceito como restauração.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename } from 'node:path';

const MAGIC = Buffer.from('BDENC01\n', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

function chave(env = process.env) {
  const bruto = env['BACKUP_ENCRYPTION_KEY']?.trim() ?? '';
  let key;
  try { key = Buffer.from(bruto, 'base64'); } catch { key = Buffer.alloc(0); }
  if (!bruto || key.length !== 32 || key.toString('base64').replace(/=+$/,'') !== bruto.replace(/=+$/,'')) {
    throw new Error('BACKUP_ENCRYPTION_KEY precisa ter exatamente 32 bytes em base64');
  }
  return key;
}

async function cabecalho(arquivo) {
  const f = await open(arquivo, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await f.read(buf, 0, HEADER_BYTES, 0);
    if (bytesRead !== HEADER_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('backup não usa o formato criptografado Barberdock v1');
    }
    return {
      iv: buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES),
      tag: buf.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES),
    };
  } finally { await f.close(); }
}

export async function criptografar(entrada, saida, env = process.env) {
  const key = chave(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const out = createWriteStream(saida, { flags: 'wx' });
  out.write(Buffer.concat([MAGIC, iv, Buffer.alloc(TAG_BYTES)]));
  try {
    await pipeline(createReadStream(entrada), cipher, out);
    const tag = cipher.getAuthTag();
    const f = await open(saida, 'r+');
    try { await f.write(tag, 0, TAG_BYTES, MAGIC.length + IV_BYTES); }
    finally { await f.close(); }
  } catch (erro) {
    await rm(saida, { force: true }).catch(() => {});
    throw erro;
  }
}

async function fluxoDeDecifragem(entrada, destino, env = process.env) {
  const key = chave(env);
  const { iv, tag } = await cabecalho(entrada);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(entrada, { start: HEADER_BYTES }), decipher, destino);
}

export async function verificar(entrada, env = process.env) {
  await fluxoDeDecifragem(entrada, new Writable({ write(_chunk, _enc, cb) { cb(); } }), env);
}

export async function descriptografar(entrada, saida, env = process.env) {
  const temporario = `${saida}.parcial-${process.pid}`;
  await rm(temporario, { force: true }).catch(() => {});
  try {
    await fluxoDeDecifragem(entrada, createWriteStream(temporario, { flags: 'wx' }), env);
    await rename(temporario, saida);
  } catch (erro) {
    await rm(temporario, { force: true }).catch(() => {});
    throw erro;
  }
}

async function main() {
  const [acao, entrada, saida] = process.argv.slice(2);
  if (!acao || !entrada || (acao !== 'check' && !saida)) {
    console.error('uso: backup-crypto.mjs encrypt <entrada> <saida> | decrypt <entrada> <saida> | check <arquivo>');
    process.exitCode = 2; return;
  }
  try {
    if (acao === 'encrypt') await criptografar(entrada, saida);
    else if (acao === 'decrypt') await descriptografar(entrada, saida);
    else if (acao === 'check') await verificar(entrada);
    else throw new Error('ação inválida');
    console.log(`backup ${acao}: OK (${basename(entrada)})`);
  } catch (erro) {
    console.error(`backup ${acao}: FALHOU (${erro instanceof Error ? erro.message : 'erro'})`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('backup-crypto.mjs')) await main();
