import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { falhasDaCriptografiaDeBackup } from './verificar-criptografia-backup.mjs';
const raiz=resolve(import.meta.dirname,'..');
const fontes={
 crypto:readFileSync(resolve(raiz,'scripts/backup-crypto.mjs'),'utf8'),
 backup:readFileSync(resolve(raiz,'deploy/backup.sh'),'utf8'),
 segredos:readFileSync(resolve(raiz,'deploy/segredos.sh'),'utf8'),
 preflight:readFileSync(resolve(raiz,'scripts/verificar-configuracao-producao.mjs'),'utf8'),
 verify:readFileSync(resolve(raiz,'scripts/verify.sh'),'utf8'),
};
test('estado atual cifra backups de forma autenticada',()=>assert.deepEqual(falhasDaCriptografiaDeBackup(fontes),[]));
const mutacoes=[
 ['GCM',{crypto:fontes.crypto.replace("createCipheriv('aes-256-gcm'","createCipheriv('aes-256-cbc'")}],
 ['IV',{crypto:fontes.crypto.replace('randomBytes(IV_BYTES)','Buffer.alloc(IV_BYTES)')}],
 ['chave',{segredos:fontes.segredos.replace('manter BACKUP_ENCRYPTION_KEY','manter BACKUP_KEY_REMOVIDA')}],
 ['upload plaintext',{backup:fontes.backup.replace('rclone copy "$arquivo_enc"','rclone copy "$arquivo"')}],
 ['cleanup',{backup:fontes.backup.replace('trap limpar_temporarios EXIT','true # sem trap')}],
 ['preflight',{preflight:fontes.preflight.replace("backup criptografado exige BACKUP_ENCRYPTION_KEY","backup sem chave permitido")}],
];
for(const [nome,mudanca] of mutacoes)test(`detecta regressão: ${nome}`,()=>assert.ok(falhasDaCriptografiaDeBackup({...fontes,...mudanca}).length>0));
