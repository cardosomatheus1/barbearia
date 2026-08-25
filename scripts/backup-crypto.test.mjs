import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criptografar, descriptografar, verificar } from './backup-crypto.mjs';
const KEY=Buffer.alloc(32,7).toString('base64');
const ENV={BACKUP_ENCRYPTION_KEY:KEY};
async function pasta(){return mkdtemp(join(tmpdir(),'barberdock-backup-'))}
test('roundtrip preserva bytes e arquivo cifrado não contém plaintext',async()=>{
 const d=await pasta(); try{const a=join(d,'a.dump'),e=join(d,'a.enc'),o=join(d,'o.dump');const conteudo=Buffer.concat([Buffer.from('cliente-secreto-'),Buffer.alloc(256*1024,0x5a)]);await writeFile(a,conteudo);await criptografar(a,e,ENV);await verificar(e,ENV);await descriptografar(e,o,ENV);assert.deepEqual(await readFile(o),conteudo);assert.equal((await readFile(e)).includes(Buffer.from('cliente-secreto-')),false);}finally{await rm(d,{recursive:true,force:true})}
});
test('chave errada reprova autenticação',async()=>{const d=await pasta();try{const a=join(d,'a'),e=join(d,'e');await writeFile(a,'dados');await criptografar(a,e,ENV);await assert.rejects(()=>verificar(e,{BACKUP_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64')}));}finally{await rm(d,{recursive:true,force:true})}});
test('alteração de ciphertext é detectada',async()=>{const d=await pasta();try{const a=join(d,'a'),e=join(d,'e');await writeFile(a,Buffer.alloc(1024,4));await criptografar(a,e,ENV);const b=await readFile(e);b[b.length-1]^=1;await writeFile(e,b);await assert.rejects(()=>verificar(e,ENV));}finally{await rm(d,{recursive:true,force:true})}});
test('chave curta falha alto',async()=>{const d=await pasta();try{const a=join(d,'a'),e=join(d,'e');await writeFile(a,'x');await assert.rejects(()=>criptografar(a,e,{BACKUP_ENCRYPTION_KEY:Buffer.alloc(16).toString('base64')}),/32 bytes/);}finally{await rm(d,{recursive:true,force:true})}});
test('decrypt autenticado não deixa saída parcial em falha',async()=>{const d=await pasta();try{const a=join(d,'a'),e=join(d,'e'),o=join(d,'out');await writeFile(a,Buffer.alloc(4096,9));await criptografar(a,e,ENV);const b=await readFile(e);b[b.length-3]^=3;await writeFile(e,b);await assert.rejects(()=>descriptografar(e,o,ENV));await assert.rejects(()=>readFile(o));}finally{await rm(d,{recursive:true,force:true})}});
