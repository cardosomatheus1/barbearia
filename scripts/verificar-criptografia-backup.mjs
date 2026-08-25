#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const raiz=resolve(import.meta.dirname,'..');
const ler=(p)=>readFileSync(resolve(raiz,p),'utf8');
export function falhasDaCriptografiaDeBackup(fontes={}){
  const crypto=fontes.crypto ?? ler('scripts/backup-crypto.mjs');
  const backup=fontes.backup ?? ler('deploy/backup.sh');
  const segredos=fontes.segredos ?? ler('deploy/segredos.sh');
  const preflight=fontes.preflight ?? ler('scripts/verificar-configuracao-producao.mjs');
  const verify=fontes.verify ?? ler('scripts/verify.sh');
  const f=[];
  if(!crypto.includes("createCipheriv('aes-256-gcm'") || !crypto.includes('getAuthTag()') || !crypto.includes('setAuthTag(tag)')) f.push('backup não usa cifra autenticada AES-256-GCM');
  if(!crypto.includes('randomBytes(IV_BYTES)')) f.push('backup não usa IV aleatório por artefato');
  if(!segredos.includes('BACKUP_ENCRYPTION_KEY') || !segredos.includes('openssl rand -base64 32')) f.push('deploy não gera chave própria do backup');
  if(!backup.includes('BACKUP_ENCRYPTION_KEY ausente')) f.push('backup não falha fechado sem a chave');
  // A cifra pode ser invocada por um auxiliar (o host sem `node` cai no contêiner),
  // então o que se cobra é o par encrypt+check sobre CADA artefato, não a grafia da
  // chamada: presa à grafia, a guarda reprovava o legítimo — e guarda que reprova o
  // legítimo é guarda que alguém desliga. Sem o par por artefato, a mídia sairia em
  // claro com o dump cifrado e a guarda antiga aprovaria.
  if(!backup.includes('backup-crypto.mjs')) f.push('backup não cifra pelo backup-crypto.mjs');
  for(const nome of ['arquivo','midia']){
    if(!backup.includes(`"encrypt" "$${nome}" "$${nome}_enc"`)) f.push(`backup não cifra $${nome}`);
    if(!backup.includes(`"check" "$${nome}_enc"`)) f.push(`backup não valida $${nome}_enc`);
  }
  if(/rclone copy "\$arquivo"/.test(backup) || /rclone copy "\$midia"/.test(backup)) f.push('upload remoto ainda pode enviar plaintext');
  if(!backup.includes("barbearia-*.dump.enc") || !backup.includes("barbearia-*-media.tar.gz.enc")) f.push('rotação não está restrita aos backups cifrados');
  if(!backup.includes('trap limpar_temporarios EXIT') || !backup.includes('rm -f "$arquivo" "$midia"')) f.push('plaintext temporário não tem limpeza garantida');
  if(!preflight.includes("backup criptografado exige BACKUP_ENCRYPTION_KEY")) f.push('preflight de produção não exige chave de backup');
  if(!verify.includes('verificar-criptografia-backup')) f.push('verify não protege a criptografia de backup');
  return f;
}
const direto=process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href;
if(direto){const f=falhasDaCriptografiaDeBackup();if(f.length){console.error(f.map(x=>`FAIL: ${x}`).join('\n'));process.exitCode=1}else console.log('criptografia de backup: OK')}
