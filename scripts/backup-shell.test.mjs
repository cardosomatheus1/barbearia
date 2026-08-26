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

/**
 * O backup precisa funcionar com a API fora — é quando ele mais importa.
 *
 * A mídia era empacotada com `exec -T api`, que entra no contêiner **rodando**.
 * Com a API em laço de reinício o backup falhava com "container is restarting",
 * e como `atualizar.sh` fazia backup antes de buscar o código, a correção da
 * API nunca era construída: só dava para consertar a aplicação com ela de pé.
 *
 * O `docker` de mentira aqui **recusa qualquer `exec` na api**, como o daemon
 * recusou em produção. O teste passa se o backup sair mesmo assim — a asserção
 * é sobre o comportamento, não sobre a string `run` estar no script.
 */
test('backup da mídia sai mesmo com o contêiner da API reiniciando', async()=>{
  const d=await mkdtemp(join(tmpdir(),'barberdock-backup-api-fora-'));
  try{
    const destino=join(d,'app'), pasta=join(d,'backups'), bin=join(d,'bin');
    await mkdir(join(destino,'deploy'),{recursive:true}); await mkdir(join(destino,'scripts'),{recursive:true}); await mkdir(bin,{recursive:true});
    await writeFile(join(destino,'deploy','compose.yml'),'services: {}\n');
    const key=Buffer.alloc(32,7).toString('base64');
    await writeFile(join(destino,'.env'),`MEDIA_STORAGE=local\nBACKUP_ENCRYPTION_KEY="${key}"\n`);
    await cp(join(RAIZ,'scripts','backup-crypto.mjs'),join(destino,'scripts','backup-crypto.mjs'));
    const docker=join(bin,'docker');
    await writeFile(docker,[
      '#!/bin/sh',
      'case "$*" in',
      '  *" exec "*" api "*)',
      '    echo "Error response from daemon: Container is restarting" >&2; exit 1 ;;',
      '  *"pg_dump"*) head -c 25000 /dev/zero ;;',
      '  *"pg_restore --list"*) cat >/dev/null; exit 0 ;;',
      // Um tar.gz de verdade: o script valida com `tar -tzf`, e bytes zerados
      // passariam pela existência do arquivo e morreriam na validação.
      '  *" run "*" api "*)',
      '    tmp=$(mktemp -d); echo foto > "$tmp/foto.txt";',
      '    tar -C "$tmp" -czf - .; rm -rf "$tmp" ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n')); await chmod(docker,0o755);
    const r=spawnSync('bash',[join(RAIZ,'deploy','backup.sh')],{encoding:'utf8',env:{...process.env,DESTINO:destino,BACKUP_PASTA:pasta,PATH:`${bin}:${process.env.PATH}`}});
    assert.equal(r.status,0,r.stderr||r.stdout);
    const nomes=await readdir(pasta);
    assert.ok(nomes.find(n=>n.endsWith('.dump.enc')),`sem dump: ${nomes}`);
    const midia=nomes.find(n=>n.endsWith('-media.tar.gz.enc'));
    assert.ok(midia,`sem mídia: ${nomes}`);
    // E ela tem conteúdo: um artefato vazio passaria pelas duas linhas acima e
    // daria a mesma falsa sensação de proteção que o `exec` que não rodou.
    const saida=join(d,'restaurada.tar.gz'); await descriptografar(join(pasta,midia),saida,{BACKUP_ENCRYPTION_KEY:key});
    const listagem=spawnSync('tar',['-tzf',saida],{encoding:'utf8'});
    assert.equal(listagem.status,0,'a mídia restaurada não é um tar.gz válido');
    assert.match(listagem.stdout,/foto\.txt/);
  }finally{await rm(d,{recursive:true,force:true})}
});
