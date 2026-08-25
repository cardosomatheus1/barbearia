import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { descriptografar } from './backup-crypto.mjs';

const RAIZ=resolve(import.meta.dirname,'..');

test('backup.sh não deixa dump plaintext e produz artefato GCM restaurável', async()=>{
  const d=await mkdtemp(join(tmpdir(),'barberdock-backup-shell-'));
  try{
    const destino=join(d,'app'), pasta=join(d,'backups'), bin=join(d,'bin');
    await mkdir(join(destino,'deploy'),{recursive:true}); await mkdir(join(destino,'scripts'),{recursive:true}); await mkdir(bin,{recursive:true});
    await writeFile(join(destino,'deploy','compose.yml'),'services: {}\n');
    const key=Buffer.alloc(32,11).toString('base64');
    await writeFile(join(destino,'.env'),`MEDIA_STORAGE=s3\nBACKUP_ENCRYPTION_KEY="${key}"\n`);
    await cp(join(RAIZ,'scripts','backup-crypto.mjs'),join(destino,'scripts','backup-crypto.mjs'));
    const docker=join(bin,'docker');
    await writeFile(docker,`#!/bin/sh\ncase "$*" in\n  *"pg_dump"*) head -c 25000 /dev/zero ;;\n  *"pg_restore --list"*) cat >/dev/null; exit 0 ;;\n  *) exit 0 ;;\nesac\n`); await chmod(docker,0o755);
    const r=spawnSync('bash',[join(RAIZ,'deploy','backup.sh')],{encoding:'utf8',env:{...process.env,DESTINO:destino,BACKUP_PASTA:pasta,PATH:`${bin}:${process.env.PATH}`}});
    assert.equal(r.status,0,r.stderr||r.stdout);
    const nomes=await readdir(pasta);
    const enc=nomes.find(n=>n.endsWith('.dump.enc')); assert.ok(enc,`sem .dump.enc: ${nomes}`);
    assert.equal(nomes.some(n=>n.endsWith('.dump')),false,`plaintext permaneceu: ${nomes}`);
    const saida=join(d,'restaurado.dump'); await descriptografar(join(pasta,enc),saida,{BACKUP_ENCRYPTION_KEY:key});
    assert.equal((await readFile(saida)).length,25000);
  }finally{await rm(d,{recursive:true,force:true})}
});
